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

/**
 * A reporting period, and the calendar it is expressed in.
 *
 * The dates travel with their timezone because a date without one is not a
 * point in time anybody can agree on: "2026-09-01" in UTC and in
 * America/Los_Angeles name overlapping but different spans, and an app whose
 * reporting day rolls over at local midnight will disagree with a UTC "today"
 * for seven hours out of every twenty-four.
 *
 * MART's storage rule, which this type exists to make explicit:
 *
 *  - Timestamps (observed_at, occurred_at, sync times) are stored in UTC.
 *  - Provider-reported daily facts keep the PROVIDER's reporting date exactly
 *    as supplied. They are not re-bucketed into another calendar: a network's
 *    "spend on 2026-09-01" is a statement about that network's reporting day,
 *    and shifting it would invent numbers the provider never reported.
 *  - The app's reporting timezone decides what "today" and "yesterday" mean
 *    when MART chooses a window on the user's behalf.
 *
 * So a window is compared against provider dates as written, and the timezone
 * is metadata that says whose calendar produced the bounds - not an instruction
 * to convert the facts.
 */
export type ReportingWindow = {
  startDate: IsoDate;
  endDate: IsoDate;
  /** IANA zone name, e.g. 'UTC' or 'America/Los_Angeles'. */
  timezone: string;
};

/**
 * Today's calendar date in a given zone.
 *
 * `new Date().toISOString().slice(0,10)` is UTC today, which is the wrong day
 * for a good part of the world for a good part of the day. An app in
 * America/Los_Angeles asking for "the last 7 days" at 17:00 local would
 * otherwise be handed a window ending tomorrow.
 */
export function todayInTimezone(timezone: string, now: Date = new Date()): IsoDate {
  try {
    // en-CA renders as YYYY-MM-DD, which is the format MART stores.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An unknown zone must not take the request down; UTC is the documented
    // fallback and the window still states which calendar it used.
    return toIsoDate(now);
  }
}

/**
 * Resolve an explicit or defaulted window in the app's reporting calendar.
 *
 * Bounds are inclusive, unchanged: every query compares with BETWEEN, and the
 * end date is a day that is in the report, not a boundary before it.
 */
export function resolveReportingWindow(
  input: { from?: string | undefined; to?: string | undefined },
  timezone: string,
  now: Date = new Date(),
): ReportingWindow {
  const endDate = input.to ?? todayInTimezone(timezone, now);
  const startDate = input.from ?? addDays(endDate, -6);
  return { startDate, endDate, timezone };
}
