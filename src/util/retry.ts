/**
 * Error classification and retry policy.
 *
 * The rule is: classify first, react second. A 429 or a dropped connection is
 * worth waiting for; a 404 or a malformed page is not, and retrying it only
 * adds load to a server that already said no.
 */
import { CONFIG } from '../config';
import { log, describeError } from './logger';

/** Raised when the portal answers with the F5 WAF block page ("Requisição - Rejeitada"). */
export class WafBlockedError extends Error {
  constructor(message = 'The WAF rejected the request (Requisição - Rejeitada)') {
    super(message);
    this.name = 'WafBlockedError';
  }
}

/** Raised on HTTP statuses that deserve a retry (429, 5xx, 408). */
export class HttpRetryableError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs?: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpRetryableError';
  }
}

/** Raised on HTTP statuses that must not be retried (4xx other than 408/429). */
export class HttpFatalError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpFatalError';
  }
}

/** Raised when the JSF view / session is gone (ViewExpired, redirect to the landing page). */
export class SessionExpiredError extends Error {
  constructor(message = 'The JSF session or view state expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Raised when a page does not have the structure the parser expects. Never retried. */
export class UnexpectedStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedStructureError';
  }
}

/** Network-level failures (ECONNRESET, timeouts...) are retryable. */
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED']);

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpRetryableError) return true;
  if (err instanceof WafBlockedError) return true;
  if (err instanceof SessionExpiredError) return true;
  if (err instanceof HttpFatalError) return false;
  if (err instanceof UnexpectedStructureError) return false;
  const code = (err as { code?: string } | undefined)?.code;
  if (code && NETWORK_CODES.has(code)) return true;
  return false;
}

/**
 * An explicit Retry-After is a server instruction, so it is honoured beyond the
 * exponential-backoff cap; this ceiling only guards against absurd values.
 */
const RETRY_AFTER_HARD_CAP_MS = 15 * 60 * 1000;

/** Exponential backoff with full jitter, honouring Retry-After when the server sent one. */
export function backoffMs(attempt: number, err?: unknown): number {
  if (err instanceof HttpRetryableError && err.retryAfterMs !== undefined) {
    return Math.min(err.retryAfterMs, RETRY_AFTER_HARD_CAP_MS);
  }
  if (err instanceof WafBlockedError) return CONFIG.retry.wafCooldownMs;
  const exp = CONFIG.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, CONFIG.retry.maxDelayMs);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Label used in log lines. */
  label: string;
  maxAttempts?: number;
  /** Called before each retry (e.g. to reopen a session). */
  onRetry?: (err: unknown, attempt: number) => Promise<void> | void;
  /** Extra veto on top of the taxonomy: return false to stop retrying this error. */
  retryIf?: (err: unknown) => boolean;
}

/**
 * Runs `fn` until it succeeds, a non-retryable error is thrown, or the attempts
 * are exhausted. The last error is rethrown so the caller can record it.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const max = opts.maxAttempts ?? CONFIG.retry.maxAttempts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || (opts.retryIf && !opts.retryIf(err)) || attempt === max) break;
      const wait = backoffMs(attempt, err);
      const status = err instanceof HttpRetryableError ? ` (HTTP ${err.status})` : '';
      log.warn(`${opts.label}: attempt ${attempt}/${max} failed${status}: ${describeError(err)} -> waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      if (opts.onRetry) {
        try {
          await opts.onRetry(err, attempt + 1);
        } catch (hookErr) {
          // The recovery hook does network I/O (reopening the session) and can
          // itself hit the throttle. That must consume this retry's budget, not
          // abort the whole loop and misattribute the failure.
          log.warn(`${opts.label}: recovery before attempt ${attempt + 1} failed too: ${describeError(hookErr)}`);
        }
      }
    }
  }
  throw lastErr;
}

/** Parses a Retry-After header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}
