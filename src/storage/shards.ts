/**
 * The shard directory (output/processes/): file naming, scanning, start-up
 * reconciliation and the one-time migration from the old single-file layout.
 * The shards are the source of truth; index.json is a rebuildable cache.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProcessRecord } from '../types';
import { log } from '../util/logger';
import { safeFileName } from '../util/text';
import { IndexEntry, toIndexEntry } from './indexEntry';
import { writeJsonAtomic } from './jsonFile';

/** Basename of a process shard file — the single place the naming rule lives. */
export function shardFileName(id: string): string {
  return `${safeFileName(id, 120)}.json`;
}

/**
 * Yields every readable shard record with its index entry, skipping (with a
 * warning) unreadable ones and the file names in `skip`. The entry is built
 * INSIDE the try so a shard whose content is valid JSON but not a record
 * (e.g. a literal `null`) is also warned about and skipped, not thrown.
 */
export function* readShards(processesDir: string, activity: string, skip?: Set<string>): Generator<{ rec: ProcessRecord; entry: IndexEntry }> {
  for (const file of fs.readdirSync(processesDir)) {
    if (!file.endsWith('.json') || skip?.has(file)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(processesDir, file), 'utf8')) as ProcessRecord;
      yield { rec, entry: toIndexEntry(rec) };
    } catch (err) {
      log.warn(`shard ${file} unreadable while ${activity}: ${(err as Error).message}`);
    }
  }
}

/**
 * Shards are written the moment a record changes; index.json only every
 * 60 s / 500 updates. After a hard kill (no SIGINT: taskkill, power loss)
 * the index can lag the shards, and an entry missing from it is invisible to
 * phase 2, the CSV export and `status`. So the shard directory is the
 * authority at start-up: whatever it holds that `index` lacks is added.
 * Returns how many entries were recovered.
 */
export function reconcileShards(processesDir: string, index: Map<string, IndexEntry>): number {
  const known = new Set([...index.keys()].map(shardFileName));
  let added = 0;
  for (const { rec, entry } of readShards(processesDir, 'reconciling the index', known)) {
    index.set(rec.id, entry);
    added++;
  }
  if (added > 0) log.info(`index.json was behind the shard files: ${added} process(es) recovered`);
  return added;
}

/** One-time migration from the old single-file layout to one shard per process. */
export function migrateLegacyMonolith(legacyFile: string, processesDir: string): void {
  if (!fs.existsSync(legacyFile)) return;
  try {
    const map = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as Record<string, ProcessRecord>;
    let n = 0;
    for (const rec of Object.values(map)) {
      const file = path.join(processesDir, shardFileName(rec.id));
      if (!fs.existsSync(file)) {
        writeJsonAtomic(file, rec);
        n++;
      }
    }
    fs.renameSync(legacyFile, `${legacyFile}.migrated`);
    log.info(`migrated ${n} record(s) from processes.json to output/processes/`);
  } catch (err) {
    throw new Error(`legacy processes.json exists but could not be migrated: ${(err as Error).message}`);
  }
}
