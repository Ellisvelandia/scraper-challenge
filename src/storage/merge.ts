/**
 * Pure merge logic for persisted records. No I/O: everything here is a
 * deterministic function of its inputs, which is what lets records written by
 * different runs (or different phases of one run) converge without loss.
 */
import { DateRange, DocumentRecord } from '../types';
import { addDays } from '../util/dates';

/** Copy of `obj` without the keys whose value is `undefined`, so a sparse incoming record cannot blank fields an earlier run filled. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
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
    if (last && r.from <= addDays(last.to, 1)) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
