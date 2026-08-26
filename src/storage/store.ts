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
 *   output/index.json            a light index (one small entry per process)
 *                                used for dedupe, iteration and progress. It is
 *                                rebuilt from the shard files when missing or
 *                                unreadable, so it can never lose data;
 *   output/state.json            crawl state (completed ranges, saturated days);
 *   output/failed.json           what failed, why, and how many times.
 *
 * state.json and failed.json are NOT rebuildable, so an existing-but-unreadable
 * copy aborts the run after being moved aside — silently starting from scratch
 * would first lose the resume point and then overwrite the evidence.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';
import { CrawlState, DateRange, DocumentRecord, FailedItem, ProcessRecord } from '../types';
import { log } from '../util/logger';
import { safeFileName } from '../util/text';

/** Small per-process summary kept in memory and in index.json. */
export interface IndexEntry {
  id: string;
  number?: string;
  ca: string;
  className?: string;
  detailFetched: boolean;
  docsTotal: number;
  docsDownloaded: number;
  docsPending: number;
  docsFailed: number;
  docsUnavailable: number;
  updatedAt: string;
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Reads a JSON file that CANNOT be rebuilt. A missing file returns the
 * fallback; an unreadable one is moved aside and the run aborts.
 */
function readJsonOrAbort<T>(file: string, fallback: T): T {
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

export class Store {
  private index = new Map<string, IndexEntry>();
  private state: CrawlState;
  private failed: Record<string, FailedItem>;
  private dirty = { index: false, state: false, failed: false };
  private readonly processesDir: string;
  private readonly indexFile: string;

  constructor() {
    fs.mkdirSync(CONFIG.output.dir, { recursive: true });
    this.processesDir = path.join(CONFIG.output.dir, 'processes');
    this.indexFile = path.join(CONFIG.output.dir, 'index.json');
    fs.mkdirSync(this.processesDir, { recursive: true });
    this.state = readJsonOrAbort<CrawlState>(CONFIG.output.state, { completedRanges: [], saturatedDays: [], updatedAt: new Date().toISOString() });
    this.failed = readJsonOrAbort<Record<string, FailedItem>>(CONFIG.output.failed, {});
    this.migrateLegacyMonolith();
    this.loadIndex();
  }

  // ------------------------------------------------------------ processes

  has(id: string): boolean {
    return this.index.has(id);
  }

  count(): number {
    return this.index.size;
  }

  entries(): IndexEntry[] {
    return [...this.index.values()];
  }

  ids(): string[] {
    return [...this.index.keys()];
  }

  /** Full record, read from its shard file. */
  get(id: string): ProcessRecord | undefined {
    if (!this.index.has(id)) return undefined;
    const file = this.shardFile(id);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessRecord;
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
    this.index.set(record.id, toIndexEntry(merged));
    this.dirty.index = true;
    return !existing;
  }

  updateDocument(processId: string, doc: DocumentRecord): void {
    const rec = this.get(processId);
    if (!rec) return;
    rec.documents = mergeDocuments(rec.documents, [doc]);
    rec.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.shardFile(processId), rec);
    this.index.set(processId, toIndexEntry(rec));
    this.dirty.index = true;
  }

  private shardFile(id: string): string {
    return path.join(this.processesDir, `${safeFileName(id, 120)}.json`);
  }

  // ----------------------------------------------------------------- state

  getState(): CrawlState {
    return this.state;
  }

  isRangeCompleted(range: DateRange): boolean {
    return this.state.completedRanges.some((r) => r.from <= range.from && range.to <= r.to);
  }

  markRangeCompleted(range: DateRange): void {
    if (this.isRangeCompleted(range)) return;
    this.state.completedRanges.push(range);
    this.state.completedRanges = mergeRanges(this.state.completedRanges);
    this.state.updatedAt = new Date().toISOString();
    this.dirty.state = true;
  }

  markSaturatedDay(day: string, classSplitDone: boolean, note?: string): void {
    const existing = this.state.saturatedDays.find((s) => s.day === day);
    if (existing) {
      existing.classSplitDone = existing.classSplitDone || classSplitDone;
      if (note) existing.note = note;
    } else {
      this.state.saturatedDays.push({ day, classSplitDone, note });
    }
    this.state.updatedAt = new Date().toISOString();
    this.dirty.state = true;
  }

  setMeasuredTotal(total: number): void {
    this.state.measuredTotal = total;
    this.state.measuredAt = new Date().toISOString();
    this.state.updatedAt = this.state.measuredAt;
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

  /** Writes index/state/failed if they changed (shards are written on the spot). */
  save(): void {
    if (this.dirty.index) {
      writeJsonAtomic(this.indexFile, [...this.index.values()]);
      this.dirty.index = false;
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

  /**
   * Exports processes.csv and documents.csv (UTF-8 with BOM so Excel keeps the
   * accents), streaming shard by shard so memory stays flat.
   */
  exportCsv(): void {
    const pCols = [
      'id', 'number', 'classAcronym', 'className', 'subject', 'distributionDate', 'activePoleSummary', 'passivePoleSummary',
      'lastMovement', 'lastMovementDate', 'detailFetched', 'parties', 'movements', 'movementsTotal', 'documents', 'documentsDownloaded', 'ca', 'detailUrl',
    ];
    const dCols = ['id', 'processId', 'processNumber', 'idProcessoDocumento', 'idBin', 'date', 'title', 'type', 'download', 'status', 'file', 'bytes', 'error'];
    const pOut = fs.createWriteStream(`${CONFIG.output.processesCsv}.tmp`);
    const dOut = fs.createWriteStream(`${CONFIG.output.documentsCsv}.tmp`);
    pOut.write('﻿' + pCols.join(',') + '\r\n');
    dOut.write('﻿' + dCols.join(',') + '\r\n');
    const ids = this.ids().sort();
    for (const id of ids) {
      const p = this.get(id);
      if (!p) continue;
      pOut.write(csvLine([
        p.id, p.number ?? '', p.classAcronym ?? '', p.className ?? '', p.subject ?? p.details?.['Assunto'] ?? '', p.distributionDate ?? '',
        p.activePoleSummary ?? '', p.passivePoleSummary ?? '', p.lastMovement ?? '', p.lastMovementDate ?? '', String(p.detailFetched),
        String(p.parties?.length ?? ''), String(p.movements?.length ?? ''), p.movementsTotal !== undefined ? String(p.movementsTotal) : '',
        String(p.documents?.length ?? ''), String(p.documents?.filter((d) => d.status === 'downloaded').length ?? ''),
        p.ca, `${CONFIG.baseUrl}${CONFIG.paths.detail}?ca=${p.ca}`,
      ]));
      for (const d of p.documents ?? []) {
        dOut.write(csvLine([
          d.id, p.id, p.number ?? '', d.idProcessoDocumento, d.idBin ?? '', d.date ?? '', d.title, d.type ?? '',
          d.download, d.status, d.file ?? '', d.bytes !== undefined ? String(d.bytes) : '', d.error ?? '',
        ]));
      }
    }
    pOut.end();
    dOut.end();
    pOut.on('close', () => fs.renameSync(`${CONFIG.output.processesCsv}.tmp`, CONFIG.output.processesCsv));
    dOut.on('close', () => fs.renameSync(`${CONFIG.output.documentsCsv}.tmp`, CONFIG.output.documentsCsv));
  }

  // ------------------------------------------------------------- start-up

  /** Loads index.json, or rebuilds it from the shard files (source of truth). */
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
      entries = [];
      for (const file of fs.readdirSync(this.processesDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(this.processesDir, file), 'utf8')) as ProcessRecord;
          entries.push(toIndexEntry(rec));
        } catch (err) {
          log.warn(`shard ${file} unreadable while rebuilding the index: ${(err as Error).message}`);
        }
      }
      if (entries.length > 0) this.dirty.index = true;
    }
    for (const e of entries) this.index.set(e.id, e);
  }

  /** One-time migration from the old single-file layout. */
  private migrateLegacyMonolith(): void {
    const legacy = CONFIG.output.processes;
    if (!fs.existsSync(legacy)) return;
    try {
      const map = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Record<string, ProcessRecord>;
      let n = 0;
      for (const rec of Object.values(map)) {
        const file = this.shardFile(rec.id);
        if (!fs.existsSync(file)) {
          writeJsonAtomic(file, rec);
          n++;
        }
      }
      fs.renameSync(legacy, `${legacy}.migrated`);
      log.info(`migrated ${n} record(s) from processes.json to output/processes/`);
    } catch (err) {
      throw new Error(`legacy processes.json exists but could not be migrated: ${(err as Error).message}`);
    }
  }
}

function toIndexEntry(p: ProcessRecord): IndexEntry {
  const docs = p.documents ?? [];
  const by = (s: DocumentRecord['status']) => docs.filter((d) => d.status === s).length;
  return {
    id: p.id,
    number: p.number,
    ca: p.ca,
    className: p.className,
    detailFetched: p.detailFetched,
    docsTotal: docs.length,
    docsDownloaded: by('downloaded'),
    docsPending: by('pending'),
    docsFailed: by('failed'),
    docsUnavailable: by('unavailable'),
    updatedAt: p.updatedAt,
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Merges document lists by id; incoming defined fields win, but a completed download is never downgraded and a success clears old errors. */
export function mergeDocuments(current: DocumentRecord[] | undefined, incoming: DocumentRecord[] | undefined): DocumentRecord[] | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  const byId = new Map(current.map((d) => [d.id, d]));
  for (const d of incoming) {
    const prev = byId.get(d.id);
    if (!prev) {
      byId.set(d.id, d);
      continue;
    }
    const merged: DocumentRecord = { ...prev, ...stripUndefined(d) };
    if (prev.status === 'downloaded' && d.status !== 'downloaded') {
      merged.status = prev.status;
      merged.file = prev.file;
      merged.bytes = prev.bytes;
    }
    if (merged.status === 'downloaded') merged.error = undefined;
    byId.set(d.id, merged);
  }
  return [...byId.values()];
}

/** Sorts and coalesces adjacent/overlapping ISO day ranges. */
export function mergeRanges(ranges: DateRange[]): DateRange[] {
  const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from));
  const out: DateRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= nextDay(last.to)) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function csvLine(values: string[]): string {
  const esc = (v: string) => (/[",\r\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return values.map(esc).join(',') + '\r\n';
}
