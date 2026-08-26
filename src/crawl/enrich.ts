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
 * Failures are isolated per document: a 429 that survives every retry marks
 * that document as failed in failed.json and the run moves to the next one.
 */
import * as cheerio from 'cheerio';
import { CONFIG } from '../config';
import { DetailDocument, parseDetail, parseMovementRows, toDocumentRecord } from '../pje/detailParser';
import { DocumentDownloader, InvalidDownloadError } from '../pje/documents';
import { PjeSession } from '../pje/session';
import { Store } from '../storage/store';
import { DocumentRecord, Movement, ProcessRecord } from '../types';
import { log, describeError } from '../util/logger';
import { HttpFatalError, HttpRetryableError, SessionExpiredError, UnexpectedStructureError, withRetry } from '../util/retry';

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
    const pending = this.store
      .all()
      .filter((p) => (opts.onlyIds ? opts.onlyIds.has(p.id) : true))
      .filter((p) => opts.refresh || !p.detailFetched || hasPendingDocuments(p))
      .sort((a, b) => a.id.localeCompare(b.id));
    log.info(`enrichment: ${pending.length} process(es) pending of ${this.store.count()}`);
    if (!this.session.isOpen) await this.session.open();
    let processed = 0;
    for (const process of pending) {
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
      processed++;
      this.stats.processes++;
      await this.enrichOne(process, opts);
      this.store.save();
    }
    this.store.save();
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
        { label: `detail ${process.id}`, onRetry: async () => this.session.open() },
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
    this.store.clearFailure(process.id);
    this.stats.detailsFetched++;

    const movements = await this.collectMovements(html, parsed.movements, parsed.movementsPager, parsed.movementsTotal, process);
    const documents = parsed.documents.map((d) => toDocumentRecord(process.id, d));
    const updated: ProcessRecord = {
      ...process,
      number: process.number ?? parsed.number,
      className: parsed.className ?? process.className,
      distributionDate: parsed.distributionDate,
      details: parsed.details,
      parties: parsed.parties,
      movements,
      documents,
      detailFetched: true,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsert(updated);
    const record = this.store.get(process.id)!;
    log.info(`detail ${process.id}: ${parsed.parties.length} parties, ${movements.length}/${parsed.movementsTotal} movements, ${documents.length} documents`);

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

  /** Every page of the movements table, using the slider pager when there is more than one. */
  private async collectMovements(html: string, firstPage: Movement[], pager: ReturnType<typeof parseDetail>['movementsPager'], total: number, process: ProcessRecord): Promise<Movement[]> {
    const all = [...firstPage];
    if (!pager || pager.pages <= 1 || total <= firstPage.length) return all;
    const $detail = cheerio.load(html);
    for (let page = 2; page <= pager.pages; page++) {
      try {
        await withRetry(() => this.session.getMovementsPage($detail, pager, page, process.ca), { label: `movements ${process.id} p${page}`, maxAttempts: 3 });
        const rows = parseMovementRows($detail);
        if (rows.length === 0) break;
        all.push(...rows);
      } catch (err) {
        log.warn(`movements ${process.id} page ${page}: ${describeError(err)} (keeping ${all.length} of ${total})`);
        break;
      }
    }
    return all;
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
            if (err instanceof SessionExpiredError) await this.session.open();
          },
        },
      );
      this.store.updateDocument(process.id, { ...doc, status: 'downloaded', file: result.file, bytes: result.bytes, error: undefined });
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

function hasPendingDocuments(p: ProcessRecord): boolean {
  return (p.documents ?? []).some((d) => d.status === 'pending' || d.status === 'failed');
}

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof HttpRetryableError || err instanceof HttpFatalError) return err.status;
  return undefined;
}
