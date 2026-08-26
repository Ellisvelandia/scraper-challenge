/**
 * Phase 1 — discovery: enumerate every process of the portal.
 *
 * THE PORTAL HAS NO PAGER. Every filtered search returns at most 30 rows; when
 * the query matched more, the response carries an explicit overflow banner
 * ("…somente os 30 primeiros serão exibidos"). So "navigating all the pages"
 * means partitioning the search space until every partition fits under the cap:
 *
 *   [DATE_FROM, DATE_TO]  →  search by dataAutuacao range
 *        not capped → every process of the range is in the response: store
 *                     them, mark the range completed.
 *        capped     → split the range in two halves and recurse.
 *        1 day and still capped → secondary split by the class names visible in
 *                     the capped response itself; whatever provably remains
 *                     unreachable is flagged in state.json.saturatedDays.
 *
 * A response that carries a portal message (validation or error) instead of a
 * result table NEVER completes a range: it is recorded in failed.json so a
 * later run retries it. Ranges already completed are skipped, which is what
 * makes the phase resumable.
 */
import { CONFIG } from '../config';
import { PjeSession } from '../pje/session';
import { ListPage, ListRow } from '../pje/listParser';
import { Store } from '../storage/store';
import { DateRange, ProcessRecord } from '../types';
import { daysInRange, isoToBr, splitRange } from '../util/dates';
import { log, describeError } from '../util/logger';
import { SessionExpiredError, WafBlockedError, withRetry } from '../util/retry';
import { processId, SOURCE } from '../util/text';

export interface DiscoverStats {
  searches: number;
  newProcesses: number;
  seenProcesses: number;
  completedRanges: number;
  saturatedDays: number;
  failedRanges: number;
  stoppedByLimit: boolean;
}

type RangeOutcome = { kind: 'done' } | { kind: 'capped'; page: ListPage } | { kind: 'failed' };

export class Discoverer {
  private readonly stats: DiscoverStats = { searches: 0, newProcesses: 0, seenProcesses: 0, completedRanges: 0, saturatedDays: 0, failedRanges: 0, stoppedByLimit: false };
  private session: PjeSession;

  constructor(private readonly store: Store, session?: PjeSession) {
    this.session = session ?? new PjeSession();
  }

  /** Walks the configured date window. Returns run statistics. */
  async run(window: DateRange = { from: CONFIG.dateFrom, to: CONFIG.dateTo }): Promise<DiscoverStats> {
    log.info(`discovery window ${window.from}..${window.to} (${daysInRange(window)} days), result cap ${CONFIG.resultCap}`);
    if (!this.session.isOpen) await this.session.open();
    await this.measureTotal();
    const stack: DateRange[] = [window];
    while (stack.length > 0) {
      if (this.limitReached()) {
        this.stats.stoppedByLimit = true;
        log.info(`search limit reached (${CONFIG.limits.maxSearches}): stopping discovery, progress is saved`);
        break;
      }
      const range = stack.pop()!;
      if (this.store.isRangeCompleted(range)) continue;
      const outcome = await this.searchRange(range);
      if (outcome.kind === 'capped') {
        if (daysInRange(range) > 1) {
          const [a, b] = splitRange(range);
          // Push the later half first so the earlier one is processed next (chronological order).
          stack.push(b, a);
        } else {
          await this.splitDayByClass(range.from, outcome.page);
        }
      }
      this.store.save();
    }
    this.store.save(true);
    this.store.exportCsv();
    return this.stats;
  }

  private limitReached(): boolean {
    return CONFIG.limits.maxSearches > 0 && this.stats.searches >= CONFIG.limits.maxSearches;
  }

  /**
   * The unfiltered total. The form rejects an empty search, but a syntactically
   * valid, non-existent date passes validation and is ignored by the query,
   * which then reports the real corpus size. Purely informational.
   */
  private async measureTotal(): Promise<void> {
    const state = this.store.getState();
    if (state.measuredTotal && state.measuredAt && Date.now() - Date.parse(state.measuredAt) < 24 * 3600 * 1000) {
      log.info(`portal total (measured ${state.measuredAt}): ${state.measuredTotal} processes`);
      return;
    }
    try {
      const page = await this.session.search({ dateFrom: '31/02/2000', dateTo: '31/02/2000' });
      this.stats.searches++;
      if (page.announcedTotal > CONFIG.resultCap) {
        this.store.setMeasuredTotal(page.announcedTotal);
        log.info(`portal total: ${page.announcedTotal} processes (unfiltered count)`);
      } else {
        log.info(`portal did not reveal an unfiltered total (got ${page.announcedTotal})`);
      }
    } catch (err) {
      log.warn(`could not measure the unfiltered total: ${describeError(err)}`);
    }
  }

  /** Searches one range; stores rows; reports whether the range was capped, done or failed. */
  private async searchRange(range: DateRange, className?: string): Promise<RangeOutcome> {
    const label = `${range.from}..${range.to}${className ? ` class="${className}"` : ''}`;
    const failureKey = `range:${range.from}:${range.to}${className ? `:${className}` : ''}`;
    let page: ListPage;
    try {
      page = await withRetry(
        async () => {
          if (!this.session.isOpen || this.session.requestCount >= CONFIG.sessionMaxRequests) await this.session.open();
          return this.session.search({ dateFrom: isoToBr(range.from), dateTo: isoToBr(range.to), className });
        },
        {
          label: `search ${label}`,
          onRetry: async (err) => {
            // Reopen only when the session itself is the problem; a plain 429
            // must not cost an extra landing request against a throttled server.
            if (err instanceof SessionExpiredError || err instanceof WafBlockedError) await this.session.open();
          },
        },
      );
    } catch (err) {
      this.stats.failedRanges++;
      this.store.recordFailure(failureKey, 'search', describeError(err));
      log.error(`search ${label} failed permanently: ${describeError(err)}`);
      return { kind: 'failed' };
    }
    this.stats.searches++;
    if (page.message && page.rows.length === 0) {
      // A message with zero rows means the portal did NOT run this query:
      // completing the range here would silently write the whole partition off.
      // A message alongside rows is informational and the rows are kept.
      this.stats.failedRanges++;
      this.store.recordFailure(failureKey, 'search', `portal message: ${page.message}`);
      log.warn(`search ${label}: portal message "${page.message}" -> range NOT completed`);
      return { kind: 'failed' };
    }
    if (page.message) log.warn(`search ${label}: portal message alongside ${page.rows.length} rows: "${page.message}"`);
    let fresh = 0;
    for (const row of page.rows) {
      if (this.storeRow(row, range)) fresh++;
    }
    this.stats.newProcesses += fresh;
    this.stats.seenProcesses += page.rows.length;
    this.store.clearFailure(failureKey);
    log.info(`search ${label}: ${page.rows.length} rows (${fresh} new)${page.isCapped ? ' CAPPED -> split' : ''} | total stored ${this.store.count()}`);
    if (!page.isCapped && !className) {
      this.store.markRangeCompleted(range);
      this.stats.completedRanges++;
    }
    return page.isCapped ? { kind: 'capped', page } : { kind: 'done' };
  }

  /**
   * Secondary split for a day that still returns the cap. The class names come
   * from the capped response itself (they are printed in every row), so this
   * always has something to query. Whatever the class sub-queries cannot prove
   * complete is recorded as a saturated day: an explicit gap, never a silent one.
   */
  private async splitDayByClass(day: string, cappedPage: ListPage): Promise<void> {
    const range: DateRange = { from: day, to: day };
    const classes = [...new Set(cappedPage.rows.map((r) => r.className).filter((c): c is string => !!c))];
    log.warn(`day ${day} is capped at ${CONFIG.resultCap}: splitting by ${classes.length} class name(s) seen in the capped response`);
    let residual = classes.length === 0;
    for (const className of classes) {
      const outcome = await this.searchRange(range, className);
      if (outcome.kind !== 'done') residual = true;
    }
    // The overflow banner is the portal's own statement that rows were hidden;
    // only then is the day's coverage genuinely partial (classes we never saw
    // cannot be queried). Without the banner a 30-row day is simply complete.
    if (cappedPage.overflowBanner) {
      this.store.markSaturatedDay(day, true, residual ? 'some class sub-queries failed or were still capped' : 'all classes seen in the response are covered; classes hidden past the cap cannot be queried');
      this.stats.saturatedDays++;
    }
    this.store.markRangeCompleted(range);
  }

  private storeRow(row: ListRow, range: DateRange): boolean {
    const id = processId(row.number, row.ca);
    const now = new Date().toISOString();
    const record: ProcessRecord = {
      id,
      source: SOURCE,
      number: row.number,
      ca: row.ca,
      classAcronym: row.classAcronym,
      className: row.className,
      subject: row.subject,
      activePoleSummary: row.activePoleSummary,
      passivePoleSummary: row.passivePoleSummary,
      lastMovement: row.lastMovement,
      lastMovementDate: row.lastMovementDate,
      foundInRange: range,
      detailFetched: false,
      firstSeenAt: now,
      updatedAt: now,
    };
    // Re-listing an already-known process must not undo its enrichment: keep
    // the detailFetched flag (else every overlapping split forces a full
    // re-enrichment) and the range of the first sighting.
    const existing = this.store.get(id);
    if (existing) {
      record.detailFetched = existing.detailFetched;
      record.foundInRange = existing.foundInRange ?? range;
    }
    return this.store.upsert(record);
  }
}
