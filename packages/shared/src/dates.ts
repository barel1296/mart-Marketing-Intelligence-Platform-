import type { IsoDate } from './types.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: unknown, field = 'date'): IsoDate {
  if (!isIsoDate(value)) throw new TypeError(`${field} must be an ISO date (YYYY-MM-DD)`);
  return value;
}

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${assertIsoDate(date)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${assertIsoDate(from)}T00:00:00.000Z`);
  const b = Date.parse(`${assertIsoDate(to)}T00:00:00.000Z`);
  return Math.round((b - a) / 86400000);
}

export function eachDate(from: IsoDate, to: IsoDate): IsoDate[] {
  if (daysBetween(from, to) < 0) return [];
  const out: IsoDate[] = [];
  for (let cur = from; daysBetween(cur, to) >= 0; cur = addDays(cur, 1)) out.push(cur);
  return out;
}

/**
 * Split an inclusive date range into contiguous chunks.
 * Sync windows are chunked so a failure late in a large backfill does not
 * discard the windows that already succeeded.
 */
export function chunkDateRange(
  from: IsoDate,
  to: IsoDate,
  chunkDays: number,
): Array<{ from: IsoDate; to: IsoDate }> {
  if (chunkDays < 1) throw new RangeError('chunkDays must be >= 1');
  if (daysBetween(from, to) < 0) return [];
  const chunks: Array<{ from: IsoDate; to: IsoDate }> = [];
  let cursor = from;
  while (daysBetween(cursor, to) >= 0) {
    const end = addDays(cursor, chunkDays - 1);
    // Clamp the final chunk: a chunk must never extend past the requested end,
    // or the sync would ask a provider for days the caller did not request.
    chunks.push({ from: cursor, to: daysBetween(end, to) < 0 ? to : end });
    cursor = addDays(end, 1);
  }
  return chunks;
}

export function minutesSince(
  iso: Date | string | null | undefined,
  now = new Date(),
): number | null {
  if (!iso) return null;
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 60000;
}
