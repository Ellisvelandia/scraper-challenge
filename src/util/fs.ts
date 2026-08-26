/**
 * File-system helper for the one Windows-specific hazard of a long run: a
 * rename onto a file that another process (indexer, antivirus, a `cat`) has
 * open for a few milliseconds fails with EPERM/EBUSY/EACCES. Every atomic
 * write in the scraper ends in such a rename, and a 19-minute discovery died
 * on exactly that. The lock is transient, so the rename is retried briefly;
 * any other error, or the lock outliving the retries, still propagates.
 */
import * as fs from 'fs';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Blocks the thread for `ms` (used only in synchronous write paths). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `fs.renameSync` with up to `attempts` tries against a transient share lock (25 ms, 50 ms, 100 ms…). */
export function renameSyncWithRetry(from: string, to: string, attempts = 6): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT.has(code) || attempt >= attempts) throw err;
      sleepSync(25 * 2 ** (attempt - 1));
    }
  }
}
