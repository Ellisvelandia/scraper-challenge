/**
 * Date helpers. The portal speaks `dd/MM/yyyy` (and `dd/MM/yyyy HH:mm:ss`);
 * everything persisted by the scraper is ISO-8601 so it sorts and diffs cleanly.
 * All arithmetic is done on UTC calendar days to stay independent of the local
 * time zone and daylight-saving changes.
 */
import { DateRange } from '../types';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR_DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const BR_DATETIME = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** `yyyy-MM-dd` → UTC Date at midnight. Throws on malformed input. */
export function parseIsoDay(iso: string): Date {
  const m = ISO_DAY.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || toIsoDay(d) !== iso) throw new Error(`Invalid calendar date: ${iso}`);
  return d;
}

/** UTC Date → `yyyy-MM-dd`. */
export function toIsoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** `yyyy-MM-dd` → `dd/MM/yyyy` (the portal's input format). */
export function isoToBr(iso: string): string {
  const m = ISO_DAY.exec(iso);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** `dd/MM/yyyy` → `yyyy-MM-dd`, or undefined when the text is not a date. */
export function brToIso(br: string | undefined): string | undefined {
  if (!br) return undefined;
  const m = BR_DAY.exec(br.trim());
  if (!m) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Extracts the first `dd/MM/yyyy[ HH:mm[:ss]]` in `text` as an ISO-8601 local
 * timestamp (no zone suffix: the portal publishes Brasília wall-clock time).
 */
export function brDateTimeToIso(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = BR_DATETIME.exec(text);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  if (hh === undefined) return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? '00'}`;
}

/** Number of calendar days in the closed range (1 for a single day). */
export function daysInRange(range: DateRange): number {
  const a = parseIsoDay(range.from).getTime();
  const b = parseIsoDay(range.to).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Adds `days` calendar days to an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = parseIsoDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDay(d);
}

/**
 * Splits a range into two halves of consecutive days. The caller must ensure the
 * range spans at least two days.
 */
export function splitRange(range: DateRange): [DateRange, DateRange] {
  const n = daysInRange(range);
  if (n < 2) throw new Error(`Cannot split a single day: ${range.from}`);
  const mid = addDays(range.from, Math.floor(n / 2) - 1);
  return [
    { from: range.from, to: mid },
    { from: addDays(mid, 1), to: range.to },
  ];
}

/** Ordered, non-overlapping check used when merging completed ranges. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** True when `outer` fully contains `inner`. */
export function rangeContains(outer: DateRange, inner: DateRange): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}
