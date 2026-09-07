/**
 * JSON file primitives shared by the store.
 *
 * Every write is atomic (temp file + rename) so a crash mid-write can corrupt
 * nothing; the rename is retried because on Windows a transient share lock
 * (indexer, antivirus) fails it with EPERM/EBUSY for a few milliseconds.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renameSyncWithRetry } from '../util/fs';

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSyncWithRetry(tmp, file);
}

/**
 * Reads a JSON file that CANNOT be rebuilt (state.json, failed.json). A
 * missing file returns the fallback; an unreadable one is moved aside and the
 * run aborts — silently starting from scratch would first lose the resume
 * point and then overwrite the evidence.
 */
export function readJsonOrAbort<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      /* keep the original if even the rename fails */
    }
    throw new Error(
      `${path.basename(file)} exists but could not be read (${(err as Error).message}). ` +
        `It was moved to ${aside}; inspect or delete it before running again.`,
    );
  }
}
