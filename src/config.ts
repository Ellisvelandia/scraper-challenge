/**
 * Runtime configuration. Every value can be overridden with an environment
 * variable (documented in README.md); defaults are conservative towards the
 * portal, which sits behind an F5 WAF and throttles aggressive clients.
 */
import * as path from 'path';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name}="${raw}" is not a non-negative number`);
  }
  return n;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

const outputDir = path.resolve(envStr('OUTPUT_DIR', 'output'));

export const CONFIG = {
  /** Portal origin. The same PJe build runs in other courts; point here to scrape another instance. */
  baseUrl: envStr('PJE_BASE_URL', 'https://pjett.trf5.jus.br'),
  paths: {
    list: '/pjeconsulta/ConsultaPublica/listView.seam',
    detailDir: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/',
    detail: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam',
    viewer: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam',
  },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',

  /** Maximum rows the portal returns for any search: the public list has no pager. */
  resultCap: 30,

  /** Inclusive date window (ISO) that the discovery phase partitions. Data starts in 1986 on the target instance. */
  dateFrom: envStr('DATE_FROM', '1985-01-01'),
  dateTo: envStr('DATE_TO', todayIso()),

  /** Politeness: minimum pause between two consecutive requests, plus random jitter. */
  minDelayMs: envInt('MIN_DELAY_MS', 700),
  jitterMs: envInt('JITTER_MS', 300),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 60_000),

  retry: {
    /** Attempts per request before the item is recorded in failed.json and skipped. */
    maxAttempts: envInt('MAX_ATTEMPTS', 3),
    /** Exponential backoff: base * 2^(attempt-1), capped, with jitter. Retry-After wins when present. */
    baseDelayMs: envInt('RETRY_BASE_MS', 2_000),
    maxDelayMs: envInt('RETRY_MAX_MS', 120_000),
    /** Pause after the WAF block page before opening a new session. */
    wafCooldownMs: envInt('WAF_COOLDOWN_MS', 90_000),
    /**
     * Pause after the portal's errorUnexpected.seam redirect. Observed live
     * (2026-08-26): it is deterministic per process (same 302 in a fresh session
     * 15 min later, neighbours fine), so a long pause only delays the run; 5 s
     * still covers a genuinely transient pool exhaustion.
     */
    errorPagePauseMs: envInt('ERROR_PAGE_PAUSE_MS', 5_000),
  },

  /** Per-run limits so a demo can stop early. 0 means no limit. */
  limits: {
    maxProcesses: envInt('MAX_PROCESSES', 0),
    maxDocuments: envInt('MAX_DOCUMENTS', 0),
    maxSearches: envInt('MAX_SEARCHES', 0),
    /** Stop phase 1 once this many processes are stored (counts what earlier runs stored too). */
    maxDiscovered: envInt('MAX_DISCOVERED', 0),
  },

  /** Phase 2 without PDFs: fetch every detail page (parties, movements, document list) but download nothing. */
  skipDownloads: envBool('SKIP_DOWNLOADS', false),

  /** Requests sent through one JSF session before it is recycled (the portal keeps view state per session). */
  sessionMaxRequests: envInt('SESSION_MAX_REQUESTS', 400),

  /** Also download the receipt PDFs (`reportReciboPDF`) that accompany some documents. */
  includeReceipts: envBool('INCLUDE_RECEIPTS', false),

  /** Verbose HTTP tracing. */
  debug: envBool('DEBUG', false),

  output: {
    dir: outputDir,
    processes: path.join(outputDir, 'processes.json'),
    processesCsv: path.join(outputDir, 'processes.csv'),
    documentsCsv: path.join(outputDir, 'documents.csv'),
    state: path.join(outputDir, 'state.json'),
    failed: path.join(outputDir, 'failed.json'),
    pdfs: path.join(outputDir, 'pdfs'),
    raw: path.join(outputDir, 'raw'),
    log: path.join(outputDir, 'scraper.log'),
  },
  /** Save every raw response under output/raw (diagnostics). */
  saveRaw: envBool('SAVE_RAW', false),
} as const;

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type Config = typeof CONFIG;
