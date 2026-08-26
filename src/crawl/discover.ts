/**
 * Phase 1 — discovery: enumerate every process of the portal.
 *
 * THE PORTAL HAS NO PAGER. Every filtered search returns at most 30 rows and
 * announces min(total, 30); the "Paginação" slot in the footer is rendered
 * empty. Measured on 2026-08-25: an unfiltered count says 106,763 processes,
 * a whole year says "30", a single day says its real number (0–12 in the
 * sampled month). So "navigating all the pages" means partitioning the search
 * space until every partition fits under the cap:
 *
 *   [DATE_FROM, DATE_TO]  →  search by dataAutuacao range
 *        n < 30  → every process of the range is in the response: store them,
 *                  mark the range completed.
 *        n == 30 → capped: split the range in two halves and recurse.
 *        1 day and still capped → secondary split by class name (the class of
 *                  each of the 30 visible rows, then "everything else" cannot be
 *                  expressed, so the day is flagged in state.json as saturated).
 *
 * Ranges already completed in a previous run are skipped, so the phase resumes
 * where it stopped. The result of each search is written straight into the
 * store; the detail page is fetched in phase 2.
 */
import { CONFIG } from '../config';
import { PjeSession } from '../pje/session';
import { ListRow } from '../pje/listParser';
import { Store } from '../storage/store';
import { DateRange, ProcessRecord } from '../types';
import { daysInRange, isoToBr, splitRange } from '../util/dates';
import { log, describeError } from '../util/logger';
import { isRetryable, SessionExpiredError, sleep, withRetry } from '../util/retry';
import { processId, SOURCE } from '../util/text';

export interface DiscoverStats {
  searches: number;
  newProcesses: number;
  seenProcesses: number;
  completedRanges: number;
  saturatedDays: number;
  stoppedByLimit: boolean;
}

export class Discoverer {
  private readonly stats: DiscoverStats = { searches: 0, newProcesses: 0, seenProcesses: 0, completedRanges: 0, saturatedDays: 0, stoppedByLimit: false };
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
      if (outcome === 'capped') {
        if (daysInRange(range) > 1) {
          const [a, b] = splitRange(range);
          // Push the later half first so the earlier one is processed next (chronological order).
          stack.push(b, a);
        } else {
          await this.splitDayByClass(range.from);
        }
      }
      this.store.save();
    }
    this.store.save();
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

  /** Searches one range; stores rows; returns whether the range hit the cap. */
  private async searchRange(range: DateRange, className?: string): Promise<'done' | 'capped'> {
    const label = `${range.from}..${range.to}${className ? ` class="${className}"` : ''}`;
    let page;
    try {
      page = await withRetry(
        async () => {
          if (!this.session.isOpen || this.session.requestCount >= CONFIG.sessionMaxRequests) await this.session.open();
          return this.session.search({ dateFrom: isoToBr(range.from), dateTo: isoToBr(range.to), className });
        },
        {
          label: `search ${label}`,
          onRetry: async (err) => {
            if (err instanceof SessionExpiredError || !isRetryable(err)) await this.session.open();
            else this.session.http.resetSession(), await this.session.open();
          },
        },
      );
    } catch (err) {
      this.store.recordFailure(`range:${range.from}:${range.to}${className ? `:${className}` : ''}`, 'search', describeError(err));
      log.error(`search ${label} failed permanently: ${describeError(err)}`);
      return 'done';
    }
    this.stats.searches++;
    if (page.message) {
      log.warn(`search ${label}: portal message "${page.message}"`);
    }
    let fresh = 0;
    for (const row of page.rows) {
      if (this.storeRow(row, range)) fresh++;
    }
    this.stats.newProcesses += fresh;
    this.stats.seenProcesses += page.rows.length;
    const capped = page.isCapped;
    log.info(`search ${label}: ${page.rows.length} rows (${fresh} new)${capped ? ' CAPPED → split' : ''} | total stored ${this.store.count()}`);
    if (!capped && !className) {
      this.store.markRangeCompleted(range);
      this.stats.completedRanges++;
    }
    return capped ? 'capped' : 'done';
  }

  /**
   * Secondary split for a day that still returns 30 rows. The class name field
   * is a LIKE filter, so each distinct class seen in the capped answer becomes a
   * sub-query. Rows whose class never surfaced cannot be reached; the day is
   * recorded as saturated so the gap is explicit rather than silent.
   */
  private async splitDayByClass(day: string): Promise<void> {
    const range: DateRange = { from: day, to: day };
    const known = new Set<string>();
    for (const p of this.store.all()) {
      if (p.foundInRange?.from === day && p.className) known.add(p.className);
    }
    log.warn(`day ${day} is capped at ${CONFIG.resultCap}: splitting by ${known.size} class name(s)`);
    let residual = false;
    for (const className of known) {
      const outcome = await this.searchRange(range, className);
      if (outcome === 'capped') residual = true;
      await sleep(0);
    }
    this.store.markSaturatedDay(day, true, residual ? 'some classes still capped' : 'all known classes below the cap; unseen classes cannot be queried');
    this.store.markRangeCompleted(range);
    this.stats.saturatedDays++;
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
    const existing = this.store.get(id);
    if (existing) {
      // Keep the detail data; refresh only what the list publishes.
      record.detailFetched = existing.detailFetched;
      record.foundInRange = existing.foundInRange ?? range;
    }
    return this.store.upsert(record);
  }
}
