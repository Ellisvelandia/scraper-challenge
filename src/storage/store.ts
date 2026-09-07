/**
 * Persistence.
 *
 * The corpus is ~106,000 processes and a fully enriched record weighs tens of
 * kilobytes, so a single processes.json cannot work: rewriting it after every
 * process is O(n²) and its serialized form would exceed Node's maximum string
 * length long before the crawl ends. Instead:
 *
 *   output/processes/<id>.json   one file per process, written atomically the
 *                                moment the record changes (O(1) per update);
 *   output/index.json            a light per-process summary for dedupe,
 *                                iteration and progress; rebuilt from the
 *                                shards when missing, so it can't lose data;
 *   output/state.json            crawl state (completed ranges, saturated days);
 *   output/failed.json           what failed, why, and how many times.
 *
 * state.json and failed.json are NOT rebuildable, so an existing-but-unreadable
 * copy aborts the run after being moved aside (see readJsonOrAbort). This file
 * owns the in-memory state and the write paths; the rest of the directory:
 * jsonFile.ts (I/O), merge.ts (pure merging), csv.ts (export), shards.ts
 * (shard layout, start-up reconciliation), indexEntry.ts (index projection).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';
import { CrawlState, DateRange, DocumentRecord, FailedItem, ProcessRecord } from '../types';
import { rangeContains } from '../util/dates';
import { log } from '../util/logger';
import { exportCsv } from './csv';
import { IndexEntry, toIndexEntry } from './indexEntry';
import { readJsonOrAbort, writeJsonAtomic } from './jsonFile';
import { mergeDocuments, mergeRanges, stripUndefined } from './merge';
import { migrateLegacyMonolith, readShards, reconcileShards, shardFileName } from './shards';

export class Store {
  private index = new Map<string, IndexEntry>();
  private state: CrawlState;
  private failed: Record<string, FailedItem>;
  private dirty = { index: false, state: false, failed: false };
  private dirtyIndexCount = 0;
  private lastIndexWriteAt = 0;
  private readonly processesDir: string;
  private readonly indexFile: string;

  constructor() {
    fs.mkdirSync(CONFIG.output.dir, { recursive: true });
    this.processesDir = path.join(CONFIG.output.dir, 'processes');
    this.indexFile = path.join(CONFIG.output.dir, 'index.json');
    fs.mkdirSync(this.processesDir, { recursive: true });
    this.state = readJsonOrAbort<CrawlState>(CONFIG.output.state, { completedRanges: [], saturatedDays: [], updatedAt: new Date().toISOString() });
    this.failed = readJsonOrAbort<Record<string, FailedItem>>(CONFIG.output.failed, {});
    migrateLegacyMonolith(CONFIG.output.processes, this.processesDir);
    this.loadIndex();
  }

  // ------------------------------------------------------------ processes

  count(): number {
    return this.index.size;
  }

  entries(): IndexEntry[] {
    return [...this.index.values()];
  }

  /**
   * Full record, read from its shard file (the source of truth). When the
   * index does not know the id but the shard exists (stale index.json from an
   * aborted run), the record is read anyway and the index heals itself, so a
   * stale index can never cause a shard to be overwritten instead of merged.
   */
  get(id: string): ProcessRecord | undefined {
    const file = this.shardFile(id);
    if (!this.index.has(id) && !fs.existsSync(file)) return undefined;
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessRecord;
      if (!this.index.has(id)) this.setIndexEntry(rec);
      return rec;
    } catch (err) {
      log.warn(`shard ${path.basename(file)} unreadable (${(err as Error).message})`);
      return undefined;
    }
  }

  /** Inserts or merges a record and writes its shard; returns true when new. */
  upsert(record: ProcessRecord): boolean {
    const existing = this.get(record.id);
    const now = new Date().toISOString();
    let merged: ProcessRecord;
    if (existing) {
      merged = {
        ...existing,
        ...stripUndefined(record),
        documents: mergeDocuments(existing.documents, record.documents),
        firstSeenAt: existing.firstSeenAt,
        updatedAt: now,
      };
    } else {
      merged = { ...record, firstSeenAt: record.firstSeenAt || now, updatedAt: now };
    }
    writeJsonAtomic(this.shardFile(record.id), merged);
    this.setIndexEntry(merged);
    return !existing;
  }

  updateDocument(processId: string, doc: DocumentRecord): void {
    const rec = this.get(processId);
    if (!rec) return;
    rec.documents = mergeDocuments(rec.documents, [doc]);
    rec.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.shardFile(processId), rec);
    this.setIndexEntry(rec);
  }

  private shardFile(id: string): string {
    return path.join(this.processesDir, shardFileName(id));
  }

  private setIndexEntry(rec: ProcessRecord): void {
    this.index.set(rec.id, toIndexEntry(rec));
    this.dirty.index = true;
    this.dirtyIndexCount++;
  }

  // ----------------------------------------------------------------- state

  getState(): CrawlState {
    return this.state;
  }

  isRangeCompleted(range: DateRange): boolean {
    return this.state.completedRanges.some((r) => rangeContains(r, range));
  }

  markRangeCompleted(range: DateRange): void {
    if (this.isRangeCompleted(range)) return;
    this.state.completedRanges.push(range);
    this.state.completedRanges = mergeRanges(this.state.completedRanges);
    this.touchState();
  }

  markSaturatedDay(day: string, classSplitDone: boolean, note?: string): void {
    const existing = this.state.saturatedDays.find((s) => s.day === day);
    if (existing) {
      existing.classSplitDone = existing.classSplitDone || classSplitDone;
      if (note) existing.note = note;
    } else {
      this.state.saturatedDays.push({ day, classSplitDone, note });
    }
    this.touchState();
  }

  setMeasuredTotal(total: number): void {
    this.state.measuredTotal = total;
    this.state.measuredAt = new Date().toISOString();
    this.state.updatedAt = this.state.measuredAt;
    this.dirty.state = true;
  }

  private touchState(): void {
    this.state.updatedAt = new Date().toISOString();
    this.dirty.state = true;
  }

  // ---------------------------------------------------------------- failed

  recordFailure(key: string, stage: FailedItem['stage'], reason: string, httpStatus?: number): void {
    const prev = this.failed[key];
    this.failed[key] = {
      key,
      stage,
      reason,
      attempts: (prev?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      httpStatus,
    };
    this.dirty.failed = true;
  }

  clearFailure(key: string): void {
    if (this.failed[key]) {
      delete this.failed[key];
      this.dirty.failed = true;
    }
  }

  failures(): FailedItem[] {
    return Object.values(this.failed);
  }

  // ------------------------------------------------------------------ disk

  /**
   * Writes state/failed if they changed (shards are written on the spot).
   * index.json grows with the corpus (~40 MB at full size), so it is only
   * flushed every 60 s / 500 updates — rewriting it on every save would
   * reintroduce O(n²) I/O — and always on `force` (end of a phase, SIGINT).
   */
  save(force = false): void {
    if (this.dirty.index && (force || this.dirtyIndexCount >= 500 || Date.now() - this.lastIndexWriteAt > 60_000)) {
      writeJsonAtomic(this.indexFile, [...this.index.values()]);
      this.dirty.index = false;
      this.dirtyIndexCount = 0;
      this.lastIndexWriteAt = Date.now();
    }
    if (this.dirty.state) {
      writeJsonAtomic(CONFIG.output.state, this.state);
      this.dirty.state = false;
    }
    if (this.dirty.failed) {
      writeJsonAtomic(CONFIG.output.failed, this.failed);
      this.dirty.failed = false;
    }
  }

  /** Exports processes.csv and documents.csv (see csv.ts), one shard in memory at a time, in id order. */
  exportCsv(): void {
    const store = this;
    exportCsv((function* () {
      for (const id of [...store.index.keys()].sort()) {
        const rec = store.get(id);
        if (rec) yield rec;
      }
    })());
  }

  // ------------------------------------------------------------- start-up

  /** Loads index.json, or rebuilds it from the shard files (source of truth), then reconciles (see shards.ts). */
  private loadIndex(): void {
    let entries: IndexEntry[] | undefined;
    if (fs.existsSync(this.indexFile)) {
      try {
        entries = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as IndexEntry[];
      } catch (err) {
        log.warn(`index.json unreadable (${(err as Error).message}): rebuilding from shards`);
      }
    }
    if (!entries) {
      entries = [...readShards(this.processesDir, 'rebuilding the index')].map((s) => s.entry);
      if (entries.length > 0) this.dirty.index = true;
    }
    for (const e of entries) this.index.set(e.id, e);
    const added = reconcileShards(this.processesDir, this.index);
    if (added > 0) {
      this.dirty.index = true;
      this.dirtyIndexCount += added;
    }
  }
}
