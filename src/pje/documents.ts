/**
 * PDF download service.
 *
 * Two routes, both verified live on 2026-08-25 (see docs/protocolo.md):
 *
 *  binary  GET <binaryHref>                           → 302 Location: /pjeconsulta/download.seam?cid=N
 *          GET /pjeconsulta/download.seam?cid=N       → 200 application/pdf, Content-Disposition: filename="<nome>"
 *
 *  viewer  GET  documentoSemLoginHTML.seam?ca=<hash96>&idProcessoDoc=N   → 200 text/html (the document rendered as HTML)
 *          POST documentoSemLoginHTML.seam  body = form fields + <form>:downloadPDF=<form>:downloadPDF + ca=<hash96> + idProcDocBin=N
 *                                                                        → 200 application/pdf, attachment; filename="<numero>_<idDoc>.pdf"
 *
 * Both need the session that fetched the detail page (viewer hashes are bound
 * to it; the binary route redirects to a conversation-scoped `cid`).
 *
 * Every download is validated before it is kept: content type, `%PDF-` magic
 * bytes and a non-trivial size. The file is written to `<name>.part` and
 * renamed only after validation, so a crash never leaves a half PDF that looks
 * complete. HTTP 429 is raised by the client as HttpRetryableError and handled
 * by `withRetry` with exponential backoff and Retry-After; after the last
 * attempt the caller records the document in failed.json and moves on.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';
import { HttpClient, HttpResponse } from '../http/client';
import { DocumentRecord, ProcessRecord } from '../types';
import { log } from '../util/logger';
import { HttpFatalError, HttpRetryableError, SessionExpiredError, UnexpectedStructureError } from '../util/retry';
import { safeFileName } from '../util/text';
import { renameSyncWithRetry } from '../util/fs';
import { byId, serializeForm } from './a4j';
import { DetailDocument } from './detailParser';

export class InvalidDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDownloadError';
  }
}

export interface DownloadResult {
  file: string;
  bytes: number;
}

const MIN_PDF_BYTES = 200;

export class DocumentDownloader {
  constructor(private readonly http: HttpClient) {}

  /** Path (relative to the output dir) where a document is stored. */
  static fileFor(process: ProcessRecord, doc: DocumentRecord): string {
    const stem = [process.id, doc.idProcessoDocumento, doc.date ? doc.date.slice(0, 10) : undefined, safeFileName(doc.title, 60)]
      .filter(Boolean)
      .join('_');
    return path.join('pdfs', safeFileName(process.id, 80), `${stem}.pdf`);
  }

  /**
   * Downloads one document using the route published by the (session-fresh)
   * detail row. Returns the relative path and size of the saved file.
   */
  async download(process: ProcessRecord, doc: DocumentRecord, fresh: DetailDocument, detailUrl: string): Promise<DownloadResult> {
    const relative = DocumentDownloader.fileFor(process, doc);
    const target = path.join(CONFIG.output.dir, relative);
    if (fs.existsSync(target) && fs.statSync(target).size > MIN_PDF_BYTES) {
      return { file: relative, bytes: fs.statSync(target).size };
    }
    let res: HttpResponse;
    if (fresh.binaryHref) res = await this.fetchBinary(fresh.binaryHref, detailUrl);
    else if (fresh.viewerUrl) res = await this.fetchViaViewer(fresh.viewerUrl, detailUrl);
    else throw new UnexpectedStructureError('document has no download route');
    validatePdf(res);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    fs.writeFileSync(part, res.body);
    renameSyncWithRetry(part, target);
    log.info(`PDF ${relative} (${res.body.length} B)`);
    return { file: relative, bytes: res.body.length };
  }

  /** Receipt PDF (`reportReciboPDF.seam`), optional companion of some documents. */
  async downloadReceipt(process: ProcessRecord, doc: DocumentRecord, detailUrl: string): Promise<DownloadResult> {
    if (!doc.receiptUrl) throw new UnexpectedStructureError('document has no receipt URL');
    const relative = DocumentDownloader.fileFor(process, doc).replace(/\.pdf$/, '_comprovante.pdf');
    const target = path.join(CONFIG.output.dir, relative);
    if (fs.existsSync(target) && fs.statSync(target).size > MIN_PDF_BYTES) return { file: relative, bytes: fs.statSync(target).size };
    const res = await this.http.get(doc.receiptUrl, { headers: { Referer: CONFIG.baseUrl + detailUrl } });
    validatePdf(res);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, res.body);
    renameSyncWithRetry(`${target}.part`, target);
    return { file: relative, bytes: res.body.length };
  }

  private async fetchBinary(href: string, detailUrl: string): Promise<HttpResponse> {
    const first = await this.http.get(href, { headers: { Referer: CONFIG.baseUrl + detailUrl } });
    if (first.status === 302) {
      const location = first.headers['location'];
      if (!location) throw new UnexpectedStructureError('binary download redirected without Location');
      if (/errorUnexpected\.seam/i.test(location)) {
        // The portal's "pool exhausted" page: the session is fine, the server needs a pause (same as getDetail).
        throw new HttpRetryableError(503, CONFIG.retry.errorPagePauseMs, 'portal error page (errorUnexpected) on the binary download');
      }
      if (/ConsultaPublica\/listView\.seam/.test(location) && !/download\.seam/.test(location)) {
        throw new SessionExpiredError('binary download redirected to the landing page');
      }
      return this.http.get(location, { headers: { Referer: CONFIG.baseUrl + detailUrl }, noDelay: true });
    }
    return first;
  }

  private async fetchViaViewer(viewerUrl: string, detailUrl: string): Promise<HttpResponse> {
    const url = viewerUrl.startsWith('/') ? viewerUrl : CONFIG.paths.detailDir + viewerUrl;
    const page = await this.http.get(url, { headers: { Referer: CONFIG.baseUrl + detailUrl } });
    if (page.status === 302) {
      if (/errorUnexpected\.seam/i.test(page.headers['location'] ?? '')) {
        throw new HttpRetryableError(503, CONFIG.retry.errorPagePauseMs, 'portal error page (errorUnexpected) on the document viewer');
      }
      throw new SessionExpiredError('document viewer redirected: the hash is not valid for this session');
    }
    if (page.status !== 200) throw new HttpFatalError(page.status, `viewer returned HTTP ${page.status}`);
    const $ = cheerio.load(page.text);
    const button = $('[id$=":downloadPDF"]').first();
    const onclick = button.attr('onclick') ?? '';
    const form = button.closest('form');
    const formId = form.attr('id');
    const action = form.attr('action');
    if (!formId || !action || !onclick) throw new UnexpectedStructureError('viewer page has no downloadPDF form');
    // jsfcljs(form, {'<form>:downloadPDF':'<form>:downloadPDF','ca':'<hash>','idProcDocBin':'N'}, '')
    const params = [...onclick.matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
    if (params.length === 0) throw new UnexpectedStructureError('downloadPDF parameters not found');
    const body = [...serializeForm($, formId), ...params];
    return this.http.post(action, body, { headers: { Referer: CONFIG.baseUrl + url } });
  }
}

/** Throws InvalidDownloadError unless the response is a real PDF. */
export function validatePdf(res: HttpResponse): void {
  if (res.status !== 200) throw new InvalidDownloadError(`HTTP ${res.status} instead of a PDF`);
  const magic = res.body.subarray(0, 5).toString('latin1');
  if (magic !== '%PDF-') {
    const kind = /text\/html/i.test(res.contentType) ? 'an HTML page' : `content-type ${res.contentType || 'unknown'}`;
    throw new InvalidDownloadError(`server returned ${kind} instead of a PDF (${res.body.length} B)`);
  }
  if (res.body.length < MIN_PDF_BYTES) throw new InvalidDownloadError(`PDF too small (${res.body.length} B)`);
}

/** Re-exported for callers that only need the id selector helper. */
export { byId };
