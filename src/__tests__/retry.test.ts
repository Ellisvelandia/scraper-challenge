/**
 * Tests for the retry policy: error classification, exponential backoff with
 * jitter, Retry-After handling and the withRetry loop itself. Timers are faked,
 * so the multi-second waits the policy prescribes complete instantly.
 */
import assert from 'node:assert/strict';
import { CONFIG } from '../config';
import {
  backoffMs,
  HttpFatalError,
  HttpRetryableError,
  isRetryable,
  parseRetryAfter,
  SessionExpiredError,
  UnexpectedStructureError,
  WafBlockedError,
  withRetry,
} from '../util/retry';

const { baseDelayMs, maxDelayMs, wafCooldownMs } = CONFIG.retry;

describe('isRetryable', () => {
  test('429, 5xx and 408 are retryable; other 4xx are fatal', () => {
    assert.equal(isRetryable(new HttpRetryableError(429)), true);
    assert.equal(isRetryable(new HttpRetryableError(503)), true);
    assert.equal(isRetryable(new HttpRetryableError(408)), true);
    assert.equal(isRetryable(new HttpFatalError(404)), false);
    assert.equal(isRetryable(new HttpFatalError(403)), false);
  });

  test('WAF block and expired session are retryable (with a new session); broken pages are not', () => {
    assert.equal(isRetryable(new WafBlockedError()), true);
    assert.equal(isRetryable(new SessionExpiredError()), true);
    assert.equal(isRetryable(new UnexpectedStructureError('no result table')), false);
  });

  test('network drops are retryable; unknown errors are not', () => {
    assert.equal(isRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
    assert.equal(isRetryable(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true);
    assert.equal(isRetryable(new Error('something else')), false);
    assert.equal(isRetryable(undefined), false);
  });
});

describe('backoffMs', () => {
  test('grows exponentially, with full jitter inside [cap/2, cap]', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const cap = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      for (let i = 0; i < 20; i++) {
        const ms = backoffMs(attempt, new HttpRetryableError(429));
        assert.ok(ms >= cap / 2 && ms <= cap, `attempt ${attempt}: ${ms} outside [${cap / 2}, ${cap}]`);
      }
    }
  });

  test('never exceeds RETRY_MAX_MS', () => {
    for (let i = 0; i < 20; i++) assert.ok(backoffMs(30, new HttpRetryableError(503)) <= maxDelayMs);
  });

  test('Retry-After wins over the exponential schedule, capped at 15 minutes', () => {
    assert.equal(backoffMs(1, new HttpRetryableError(429, 30_000)), 30_000);
    assert.equal(backoffMs(1, new HttpRetryableError(429, 3_600_000)), 15 * 60 * 1000);
  });

  test('a WAF block waits the cooldown instead of the exponential schedule', () => {
    assert.equal(backoffMs(1, new WafBlockedError()), wafCooldownMs);
  });
});

describe('parseRetryAfter', () => {
  test('accepts seconds and HTTP dates, rejects garbage and absence', () => {
    assert.equal(parseRetryAfter('120'), 120_000);
    assert.equal(parseRetryAfter(' 7 '), 7_000);
    const inFuture = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());
    assert.ok(inFuture !== undefined && inFuture > 50_000 && inFuture <= 60_000, `got ${inFuture}`);
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter(undefined), undefined);
  });
});

describe('withRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Awaits `promise` while draining every fake timer it schedules along the way. */
  async function drain<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await jest.runAllTimersAsync();
    const result = await settled;
    if (result.ok) return result.value;
    throw result.error;
  }

  test('retries a 429 and returns the first success, calling the recovery hook before each retry', async () => {
    const fn = jest.fn(async (attempt: number) => {
      if (attempt < 3) throw new HttpRetryableError(429);
      return 'ok';
    });
    const onRetry = jest.fn();
    const result = await drain(withRetry(fn, { label: 'test', onRetry }));
    assert.equal(result, 'ok');
    assert.equal(fn.mock.calls.length, 3);
    assert.deepEqual(Array.from(fn.mock.calls, (c) => c[0]), [1, 2, 3]);
    assert.deepEqual(Array.from(onRetry.mock.calls, (c) => c[1]), [2, 3]);
  });

  test('honours Retry-After on a 429 before the next attempt', async () => {
    const started = Date.now();
    const fn = jest.fn(async (attempt: number) => {
      if (attempt === 1) throw new HttpRetryableError(429, 30_000);
      return 'ok';
    });
    await drain(withRetry(fn, { label: 'test' }));
    assert.equal(Date.now() - started, 30_000);
  });

  test('waits the exponential schedule between transient failures', async () => {
    const started = Date.now();
    const fn = jest.fn(async (attempt: number) => {
      if (attempt <= 3) throw new HttpRetryableError(503);
      return 'ok';
    });
    await drain(withRetry(fn, { label: 'test', maxAttempts: 5 }));
    const elapsed = Date.now() - started;
    const caps = [1, 2, 3].map((a) => Math.min(baseDelayMs * 2 ** (a - 1), maxDelayMs));
    const min = caps.reduce((s, c) => s + c / 2, 0);
    const max = caps.reduce((s, c) => s + c, 0);
    assert.ok(elapsed >= min && elapsed <= max, `${elapsed}ms outside [${min}, ${max}]`);
  });

  test('gives up after maxAttempts and rethrows the last error', async () => {
    const fn = jest.fn(async () => {
      throw new HttpRetryableError(503);
    });
    await assert.rejects(drain(withRetry(fn, { label: 'test', maxAttempts: 3 })), HttpRetryableError);
    assert.equal(fn.mock.calls.length, 3);
  });

  test('a fatal 4xx is thrown at once, without retrying', async () => {
    const fn = jest.fn(async () => {
      throw new HttpFatalError(404);
    });
    await assert.rejects(drain(withRetry(fn, { label: 'test' })), HttpFatalError);
    assert.equal(fn.mock.calls.length, 1);
  });

  test('retryIf can veto a retry the taxonomy would allow', async () => {
    const fn = jest.fn(async () => {
      throw new HttpRetryableError(429);
    });
    await assert.rejects(drain(withRetry(fn, { label: 'test', retryIf: () => false })), HttpRetryableError);
    assert.equal(fn.mock.calls.length, 1);
  });

  test('a failing recovery hook consumes the attempt instead of aborting the loop', async () => {
    const fn = jest.fn(async (attempt: number) => {
      if (attempt === 1) throw new SessionExpiredError();
      return 'ok';
    });
    const onRetry = jest.fn(async () => {
      throw new HttpRetryableError(429);
    });
    const result = await drain(withRetry(fn, { label: 'test', onRetry }));
    assert.equal(result, 'ok');
    assert.equal(fn.mock.calls.length, 2);
    assert.equal(onRetry.mock.calls.length, 1);
  });
});
