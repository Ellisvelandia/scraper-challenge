/**
 * HTTP client for the portal, on top of axios.
 *
 * What it adds over a bare axios instance:
 *  - a cookie jar (Node has none): JSESSIONID, ROUTER_ID and the F5 WAF cookies
 *    are captured from every response and sent back. The `Cookie` header is only
 *    sent when there is something to send: an empty `Cookie:` header is one of
 *    the signals that makes the WAF serve its block page;
 *  - charset-aware decoding: the portal serves ISO-8859-1 HTML and UTF-8 XML;
 *  - politeness: a minimum pause (with jitter) between consecutive requests;
 *  - error typing: 429/5xx → HttpRetryableError (with Retry-After), other 4xx →
 *    HttpFatalError, and the two error pages the portal serves with HTTP 200
 *    (WAF block, "erro inesperado") → typed errors before anyone parses them;
 *  - redirects are NOT followed automatically: a 302 is meaningful here (the
 *    binary download route redirects to `download.seam`, and an expired session
 *    redirects to the landing page), so callers decide.
 */
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';
import { log } from '../util/logger';
import { HttpFatalError, HttpRetryableError, parseRetryAfter, sleep, WafBlockedError } from '../util/retry';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Raw bytes. */
  body: Buffer;
  /** Body decoded with the charset declared by the server (default ISO-8859-1). */
  text: string;
  contentType: string;
  /** Final URL requested (redirects are not followed). */
  url: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Form body, sent as application/x-www-form-urlencoded. */
  form?: Array<[string, string]>;
  /** Skip the politeness delay (used for the follow-up GET of a 302). */
  noDelay?: boolean;
  /** Override the per-request timeout. */
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Serialises `[name, value]` pairs preserving order and repeated names. */
export function encodeForm(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly jar = new Map<string, string>();
  private lastRequestAt = 0;
  private counter = 0;
  public requestCount = 0;

  constructor(private readonly baseUrl: string = CONFIG.baseUrl) {
    this.axios = axios.create({
      baseURL: baseUrl,
      timeout: CONFIG.requestTimeoutMs,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      decompress: true,
      validateStatus: () => true,
      headers: {
        'User-Agent': CONFIG.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
      },
    });
  }

  /** Cookie names currently held (for diagnostics). */
  cookieNames(): string[] {
    return [...this.jar.keys()];
  }

  /** Drops every cookie: the next request starts a new server session. */
  resetSession(): void {
    this.jar.clear();
  }

  get(pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request('GET', pathOrUrl, opts);
  }

  post(pathOrUrl: string, form: Array<[string, string]>, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request('POST', pathOrUrl, { ...opts, form });
  }

  private async request(method: 'GET' | 'POST', pathOrUrl: string, opts: RequestOptions): Promise<HttpResponse> {
    if (!opts.noDelay) await this.politeDelay();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers['Cookie'] = cookie;
    let data: string | undefined;
    if (opts.form) {
      data = encodeForm(opts.form);
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    const url = this.resolve(pathOrUrl);
    const seq = ++this.counter;
    this.requestCount++;
    const started = Date.now();
    let res: AxiosResponse<ArrayBuffer>;
    try {
      res = await this.axios.request<ArrayBuffer>({ method, url, headers, data, timeout: opts.timeoutMs ?? CONFIG.requestTimeoutMs });
    } catch (err) {
      log.debug(`#${seq} ${method} ${url} -> network error: ${(err as Error).message}`);
      throw err;
    }
    this.absorbCookies(res.headers['set-cookie'] as string[] | string | undefined);
    const body = Buffer.from(res.data ?? new ArrayBuffer(0));
    const contentType = String(res.headers['content-type'] ?? '');
    const text = decodeBody(body, contentType);
    const out: HttpResponse = { status: res.status, headers: flattenHeaders(res.headers as Record<string, unknown>), body, text, contentType, url };
    log.debug(`#${seq} ${method} ${url} -> ${res.status} ${contentType} ${body.length}B ${Date.now() - started}ms`);
    if (CONFIG.saveRaw) this.saveRaw(seq, method, url, out);
    this.classify(out);
    return out;
  }

  /** Turns HTTP statuses and disguised error pages into typed errors. */
  private classify(res: HttpResponse): void {
    if (RETRYABLE_STATUS.has(res.status)) {
      throw new HttpRetryableError(res.status, parseRetryAfter(res.headers['retry-after']), `HTTP ${res.status} from ${res.url}`);
    }
    if (res.status >= 400) {
      throw new HttpFatalError(res.status, `HTTP ${res.status} from ${res.url}`);
    }
    if (/text\/html/i.test(res.contentType)) {
      const head = res.text.slice(0, 4000);
      if (/Requisi[cç][aã]o\s*-\s*Rejeitada|seu acesso ao servi[cç]o foi bloqueado/i.test(head)) {
        throw new WafBlockedError();
      }
    }
  }

  private async politeDelay(): Promise<void> {
    const wait = CONFIG.minDelayMs + Math.random() * CONFIG.jitterMs;
    const due = this.lastRequestAt + wait;
    const now = Date.now();
    if (due > now) await sleep(due - now);
    this.lastRequestAt = Date.now();
  }

  private resolve(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      // Keep same-origin absolute URLs relative so the base URL setting still applies.
      const u = new URL(pathOrUrl);
      const base = new URL(this.baseUrl);
      return u.host === base.host ? u.pathname + u.search : pathOrUrl;
    }
    return pathOrUrl;
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorbCookies(setCookie: string[] | string | undefined): void {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      const first = raw.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private saveRaw(seq: number, method: string, url: string, res: HttpResponse): void {
    try {
      fs.mkdirSync(CONFIG.output.raw, { recursive: true });
      const name = `${String(seq).padStart(5, '0')}_${method}_${url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}_${res.status}`;
      const ext = /pdf/i.test(res.contentType) ? 'pdf' : /xml/i.test(res.contentType) ? 'xml' : 'html';
      fs.writeFileSync(path.join(CONFIG.output.raw, `${name}.${ext}`), res.body);
    } catch (err) {
      log.debug(`could not save raw response: ${(err as Error).message}`);
    }
  }
}

/** Decodes a body with the charset in Content-Type (ISO-8859-1 when absent, as the portal does). */
export function decodeBody(body: Buffer, contentType: string): string {
  if (/application\/pdf|octet-stream|image\//i.test(contentType)) return '';
  const m = /charset=([\w-]+)/i.exec(contentType);
  const charset = (m?.[1] ?? 'iso-8859-1').toLowerCase();
  const label = charset === 'utf8' ? 'utf-8' : charset;
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return body.toString('latin1');
  }
}

function flattenHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}
