/**
 * Phase 2 — enrichment and download: for every discovered process, fetch its
 * detail page (Dados do Processo, parties, every page of movements, documents)
 * and download each document's PDF.
 *
 * The detail page is opened by its `ca` hash, which is stable across sessions,
 * so this phase never needs to redo a search. The document links inside the
 * page are bound to the session that fetched it, which is why the download of
 * a document always starts from a detail page fetched in the same session and
 * never from a URL stored in a previous run.
 *
 * Failures are isolated per item: a 429 that survives every retry marks that
 * document (or process) as failed in failed.json and the run moves on. A
 * movements table that could not be paged to the end leaves the process with
 * `detailFetched: false` and a failure entry, so a later run finishes it —
 * a truncated history is never silently recorded as complete.
 */
import * as cheerio from 'cheerio';
import { CONFIG } from '../config';
import { DetailDocument, parseDetail, parseMovementRows, toDocumentRecord } from '../pje/detailParser';
import { DocumentDownloader, InvalidDownloadError } from '../pje/documents';
import { PjeSession } from '../pje/session';
import { Store } from '../storage/store';
import { DocumentRecord, Movement, ProcessRecord } from '../types';
import { log, describeError } from '../util/logger';
import { HttpFatalError, HttpRetryableError, SessionExpiredError, UnexpectedStructureError, WafBlockedError, withRetry } from '../util/retry';

export interface EnrichStats {
  processes: number;
  detailsFetched: number;
  detailsFailed: number;
  documentsDownloaded: number;
  documentsFailed: number;
  documentsUnavailable: number;
  documentsSkipped: number;
  stoppedByLimit: boolean;
}

export interface EnrichOptions {
  /** Only these process ids (default: every process not yet complete). */
  onlyIds?: Set<string>;
  /** Fetch detail pages but do not download PDFs. */
  skipDownloads?: boolean;
  /** Re-fetch details even when already fetched. */
  refresh?: boolean;
}

export class Enricher {
  private readonly stats: EnrichStats = { processes: 0, detailsFetched: 0, detailsFailed: 0, documentsDownloaded: 0, documentsFailed: 0, documentsUnavailable: 0, documentsSkipped: 0, stoppedByLimit: false };
  private readonly session: PjeSession;
  private readonly downloader: DocumentDownloader;

  constructor(private readonly store: Store, session?: PjeSession) {
    this.session = session ?? new PjeSession();
    this.downloader = new DocumentDownloader(this.session.http);
  }

  async run(opts: EnrichOptions = {}): Promise<EnrichStats> {
    // A process whose detail already exhausted its attempts is left to
    // `retry-failed`: retrying it on every resume costs the full backoff
    // schedule each time (3 x 20 s for the portal's errorUnexpected page).
    const knownFailed = new Set(opts.refresh ? [] : this.store.failures().filter((f) => f.stage === 'detail').map((f) => f.key));
    const pendingIds = this.store
      .entries()
      .filter((e) => (opts.onlyIds ? opts.onlyIds.has(e.id) : true))
      .filter((e) => !knownFailed.has(e.id))
      // Without downloads a process is done once its detail is complete; its
      // pending documents are for a later run without SKIP_DOWNLOADS.
      .filter((e) => opts.refresh || !e.detailFetched || (!opts.skipDownloads && (e.docsPending > 0 || e.docsFailed > 0)))
      .map((e) => e.id)
      .sort();
    log.info(`enrichment: ${pendingIds.length} process(es) pending of ${this.store.count()}${opts.skipDownloads ? ' (details only, no PDF)' : ''}${knownFailed.size ? `, ${knownFailed.size} with a recorded detail failure left to retry-failed` : ''}`);
    // The session is opened lazily inside enrichOne's retry loop, so a 429 or
    // a WAF page on the landing GET is backed off instead of ending the run.
    let processed = 0;
    for (const id of pendingIds) {
      if (CONFIG.limits.maxProcesses > 0 && processed >= CONFIG.limits.maxProcesses) {
        this.stats.stoppedByLimit = true;
        log.info(`process limit reached (${CONFIG.limits.maxProcesses}): stopping, progress is saved`);
        break;
      }
      if (CONFIG.limits.maxDocuments > 0 && this.stats.documentsDownloaded >= CONFIG.limits.maxDocuments) {
        this.stats.stoppedByLimit = true;
        log.info(`document limit reached (${CONFIG.limits.maxDocuments}): stopping, progress is saved`);
        break;
      }
      const process = this.store.get(id);
      if (!process) continue;
      processed++;
      this.stats.processes++;
      await this.enrichOne(process, opts);
      this.store.save();
    }
    this.store.save(true);
    this.store.exportCsv();
    return this.stats;
  }

  private async enrichOne(process: ProcessRecord, opts: EnrichOptions): Promise<void> {
    let html: string;
    try {
      html = await withRetry(
        async () => {
          if (!this.session.isOpen || this.session.requestCount >= CONFIG.sessionMaxRequests) await this.session.open();
          return this.session.getDetail(process.ca);
        },
        { label: `detail ${process.id}`, onRetry: async (err) => {
          if (err instanceof SessionExpiredError || err instanceof WafBlockedError) await this.session.open();
        } },
      );
    } catch (err) {
      this.stats.detailsFailed++;
      this.store.recordFailure(process.id, 'detail', describeError(err), httpStatusOf(err));
      log.error(`detail ${process.id} failed permanently: ${describeError(err)}`);
      return;
    }
    let parsed;
    try {
      parsed = parseDetail(html);
    } catch (err) {
      this.stats.detailsFailed++;
      this.store.recordFailure(process.id, 'detail', describeError(err));
      log.error(`detail ${process.id}: ${describeError(err)}`);
      return;
    }

    // The detail HTML must be re-fetched on every pass (document links are
    // session-bound), but a movement history already collected in full is not
    // re-paged: that is one A4J POST per 15 movements saved on the PDF pass.
    const historyKept = process.detailFetched && process.movements !== undefined && process.movements.length >= parsed.movementsTotal;
    const { movements, complete } = historyKept
      ? { movements: process.movements!, complete: true }
      : await this.collectMovements(html, parsed.movements, parsed.movementsPager, parsed.movementsTotal, process);
    const documents = parsed.documents.map((d) => toDocumentRecord(process.id, d));
    const updated: ProcessRecord = {
      ...process,
      number: process.number ?? parsed.number,
      className: parsed.className ?? process.className,
      distributionDate: parsed.distributionDate,
      details: parsed.details,
      parties: parsed.parties,
      movements,
      movementsTotal: parsed.movementsTotal,
      documents,
      // A truncated movement history is not a fetched detail: the next run redoes it.
      detailFetched: complete,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsert(updated);
    if (complete) {
      this.store.clearFailure(process.id);
      this.stats.detailsFetched++;
    } else {
      this.stats.detailsFailed++;
      this.store.recordFailure(process.id, 'detail', `movements truncated: ${movements.length} of ${parsed.movementsTotal} collected`);
    }
    const record = this.store.get(process.id) ?? updated;
    log.info(`detail ${process.id}: ${parsed.parties.length} parties, ${movements.length}/${parsed.movementsTotal} movements, ${documents.length} documents${complete ? '' : ' (INCOMPLETE, will retry)'}`);

    if (opts.skipDownloads) return;
    const detailUrl = `${CONFIG.paths.detail}?ca=${process.ca}`;
    const freshById = new Map(parsed.documents.map((d) => [d.idProcessoDocumento, d]));
    for (const doc of record.documents ?? []) {
      if (CONFIG.limits.maxDocuments > 0 && this.stats.documentsDownloaded >= CONFIG.limits.maxDocuments) return;
      if (doc.status === 'downloaded') {
        this.stats.documentsSkipped++;
        continue;
      }
      if (doc.download === 'none') {
        this.stats.documentsUnavailable++;
        continue;
      }
      const fresh = freshById.get(doc.idProcessoDocumento);
      if (!fresh) continue;
      await this.downloadOne(record, doc, fresh, detailUrl);
    }
  }

  /**
   * Every page of the movements table. Returns whether the full history was
   * collected. A SessionExpiredError aborts immediately: later pages need the
   * very view state that just died, so retrying against the same document is
   * futile — the process is refetched whole on the next run.
   */
  private async collectMovements(
    html: string,
    firstPage: Movement[],
    pager: ReturnType<typeof parseDetail>['movementsPager'],
    total: number,
    process: ProcessRecord,
  ): Promise<{ movements: Movement[]; complete: boolean }> {
    const all = [...firstPage];
    if (total <= firstPage.length) return { movements: all, complete: true };
    if (!pager || pager.pages <= 1) {
      log.warn(`movements ${process.id}: portal announces ${total} but no pager is present`);
      return { movements: all, complete: false };
    }
    const $detail = cheerio.load(html);
    for (let page = 2; page <= pager.pages; page++) {
      try {
        await withRetry(() => this.session.getMovementsPage($detail, pager, page, process.ca), {
          label: `movements ${process.id} p${page}`,
          maxAttempts: 3,
          // A dead view state cannot come back for this document: re-posting it is futile.
          retryIf: (err) => !(err instanceof SessionExpiredError),
        });
      } catch (err) {
        log.warn(`movements ${process.id} page ${page}/${pager.pages}: ${describeError(err)} (collected ${all.length} of ${total})`);
        return { movements: all, complete: false };
      }
      const rows = parseMovementRows($detail);
      if (rows.length === 0) {
        log.warn(`movements ${process.id} page ${page}/${pager.pages} came back empty (collected ${all.length} of ${total})`);
        return { movements: all, complete: false };
      }
      all.push(...rows);
    }
    return { movements: all, complete: all.length >= total };
  }

  private async downloadOne(process: ProcessRecord, doc: DocumentRecord, fresh: DetailDocument, detailUrl: string): Promise<void> {
    try {
      const result = await withRetry(
        async (attempt) => {
          if (attempt > 1) {
            // A retry after a session-level failure must re-read the session-bound links.
            const html = await this.session.getDetail(process.ca);
            const again = parseDetail(html).documents.find((d) => d.idProcessoDocumento === doc.idProcessoDocumento);
            if (again) fresh = again;
          }
          return this.downloader.download(process, doc, fresh, detailUrl);
        },
        {
          label: `document ${doc.id}`,
          onRetry: async (err) => {
            if (err instanceof SessionExpiredError || err instanceof WafBlockedError) await this.session.open();
          },
        },
      );
      this.store.updateDocument(process.id, { ...doc, status: 'downloaded', file: result.file, bytes: result.bytes });
      this.store.clearFailure(doc.id);
      this.stats.documentsDownloaded++;
      if (CONFIG.includeReceipts && doc.receiptUrl) {
        try {
          await this.downloader.downloadReceipt(process, doc, detailUrl);
        } catch (err) {
          log.warn(`receipt of ${doc.id}: ${describeError(err)}`);
        }
      }
    } catch (err) {
      const status = httpStatusOf(err);
      const reason = describeError(err);
      this.stats.documentsFailed++;
      this.store.updateDocument(process.id, { ...doc, status: 'failed', error: reason });
      this.store.recordFailure(doc.id, 'document', reason, status);
      if (err instanceof InvalidDownloadError || err instanceof UnexpectedStructureError) log.warn(`document ${doc.id}: ${reason}`);
      else log.error(`document ${doc.id} failed after retries${status ? ` (HTTP ${status})` : ''}: ${reason}`);
    }
  }
}

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof HttpRetryableError || err instanceof HttpFatalError) return err.status;
  return undefined;
}
