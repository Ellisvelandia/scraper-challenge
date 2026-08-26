/**
 * Persistence: processes.json (map keyed by process id), state.json (crawl
 * progress), failed.json (what to retry) and the two CSV exports.
 *
 * Writes are atomic (temp file + rename) so a crash never leaves a truncated
 * JSON behind, and they are throttled: the crawler calls `save()` often and the
 * store only touches disk when something changed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from '../config';
import { CrawlState, DateRange, DocumentRecord, FailedItem, ProcessRecord } from '../types';
import { log } from '../util/logger';

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    log.warn(`could not read ${file} (${(err as Error).message}): starting from scratch`);
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export class Store {
  private processes: Record<string, ProcessRecord>;
  private state: CrawlState;
  private failed: Record<string, FailedItem>;
  private dirty = { processes: false, state: false, failed: false };

  constructor() {
    fs.mkdirSync(CONFIG.output.dir, { recursive: true });
    this.processes = readJson<Record<string, ProcessRecord>>(CONFIG.output.processes, {});
    this.state = readJson<CrawlState>(CONFIG.output.state, { completedRanges: [], saturatedDays: [], updatedAt: new Date().toISOString() });
    this.failed = readJson<Record<string, FailedItem>>(CONFIG.output.failed, {});
  }

  // ------------------------------------------------------------ processes

  get(id: string): ProcessRecord | undefined {
    return this.processes[id];
  }

  all(): ProcessRecord[] {
    return Object.values(this.processes);
  }

  count(): number {
    return Object.keys(this.processes).length;
  }

  /** Inserts or merges a record; returns true when it was new. */
  upsert(record: ProcessRecord): boolean {
    const existing = this.processes[record.id];
    const now = new Date().toISOString();
    if (!existing) {
      this.processes[record.id] = { ...record, firstSeenAt: record.firstSeenAt || now, updatedAt: now };
      this.dirty.processes = true;
      return true;
    }
    this.processes[record.id] = {
      ...existing,
      ...stripUndefined(record),
      documents: mergeDocuments(existing.documents, record.documents),
      firstSeenAt: existing.firstSeenAt,
      updatedAt: now,
    };
    this.dirty.processes = true;
    return false;
  }

  updateDocument(processId: string, doc: DocumentRecord): void {
    const rec = this.processes[processId];
    if (!rec) return;
    rec.documents = mergeDocuments(rec.documents, [doc]);
    rec.updatedAt = new Date().toISOString();
    this.dirty.processes = true;
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

  /** Writes whatever changed since the last save. */
  save(): void {
    if (this.dirty.processes) {
      writeJsonAtomic(CONFIG.output.processes, this.processes);
      this.dirty.processes = false;
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

  /** Exports processes.csv and documents.csv (UTF-8 with BOM so Excel keeps the accents). */
  exportCsv(): void {
    const processes = this.all().sort((a, b) => a.id.localeCompare(b.id));
    const pCols = [
      'id', 'number', 'classAcronym', 'className', 'subject', 'distributionDate', 'activePoleSummary', 'passivePoleSummary',
      'lastMovement', 'lastMovementDate', 'detailFetched', 'parties', 'movements', 'documents', 'documentsDownloaded', 'ca', 'detailUrl',
    ];
    const pRows = processes.map((p) => [
      p.id, p.number ?? '', p.classAcronym ?? '', p.className ?? '', p.subject ?? p.details?.['Assunto'] ?? '', p.distributionDate ?? '',
      p.activePoleSummary ?? '', p.passivePoleSummary ?? '', p.lastMovement ?? '', p.lastMovementDate ?? '', String(p.detailFetched),
      String(p.parties?.length ?? ''), String(p.movements?.length ?? ''), String(p.documents?.length ?? ''),
      String(p.documents?.filter((d) => d.status === 'downloaded').length ?? ''), p.ca, `${CONFIG.baseUrl}${CONFIG.paths.detail}?ca=${p.ca}`,
    ]);
    writeCsv(CONFIG.output.processesCsv, pCols, pRows);

    const dCols = ['id', 'processId', 'processNumber', 'idProcessoDocumento', 'idBin', 'date', 'title', 'type', 'download', 'status', 'file', 'bytes', 'error'];
    const dRows: string[][] = [];
    for (const p of processes) {
      for (const d of p.documents ?? []) {
        dRows.push([d.id, p.id, p.number ?? '', d.idProcessoDocumento, d.idBin ?? '', d.date ?? '', d.title, d.type ?? '', d.download, d.status, d.file ?? '', d.bytes !== undefined ? String(d.bytes) : '', d.error ?? '']);
      }
    }
    writeCsv(CONFIG.output.documentsCsv, dCols, dRows);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Merges document lists by id; the incoming record wins for defined fields but never downgrades a completed download. */
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
      merged.error = undefined;
    }
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

function writeCsv(file: string, columns: string[], rows: string[][]): void {
  const esc = (v: string) => (/[",\r\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.join(','), ...rows.map((r) => r.map(esc).join(','))];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n');
}
