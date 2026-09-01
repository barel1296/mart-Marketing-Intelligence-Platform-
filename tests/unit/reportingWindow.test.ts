import { describe, expect, it } from 'vitest';
import { resolveReportingWindow, todayInTimezone } from '@mart/shared';

/**
 * A date without a calendar is not a point in time anybody can agree on.
 *
 * "2026-09-01" in UTC and in America/Los_Angeles name overlapping but different
 * spans, and an app whose reporting day rolls over at local midnight disagrees
 * with a UTC "today" for seven hours out of every twenty-four.
 */
describe('reporting window', () => {
  // 2026-09-01 03:00 UTC is still 2026-08-31 in the Americas.
  const earlyUtcMorning = new Date('2026-09-01T03:00:00.000Z');
  // 2026-08-31 17:00 UTC is already 2026-09-01 in Asia/Tokyo.
  const lateUtcAfternoon = new Date('2026-08-31T17:00:00.000Z');

  it("reads today in the app's calendar, not the server's", () => {
    expect(todayInTimezone('UTC', earlyUtcMorning)).toBe('2026-09-01');
    expect(todayInTimezone('America/Los_Angeles', earlyUtcMorning)).toBe('2026-08-31');
    expect(todayInTimezone('Asia/Tokyo', lateUtcAfternoon)).toBe('2026-09-01');
    expect(todayInTimezone('UTC', lateUtcAfternoon)).toBe('2026-08-31');
  });

  it('defaults the window in that calendar too', () => {
    // The bug this pins: an app in Los Angeles asking for "the last 7 days"
    // used to be handed a window ending tomorrow - a day with no data in it,
    // quietly diluting every average across the period.
    const utc = resolveReportingWindow({}, 'UTC', earlyUtcMorning);
    expect(utc.endDate).toBe('2026-09-01');
    expect(utc.startDate).toBe('2026-08-26');

    const la = resolveReportingWindow({}, 'America/Los_Angeles', earlyUtcMorning);
    expect(la.endDate).toBe('2026-08-31');
    expect(la.startDate).toBe('2026-08-25');
  });

  it('carries the calendar with the dates', () => {
    const window = resolveReportingWindow({}, 'Asia/Tokyo', lateUtcAfternoon);
    expect(window.timezone).toBe('Asia/Tokyo');
  });

  it('leaves an explicit window exactly as asked', () => {
    // An explicit window is the caller's statement about which provider
    // reporting dates they want. Shifting it into another calendar would ask
    // for days they did not request.
    const window = resolveReportingWindow(
      { from: '2026-08-01', to: '2026-08-31' },
      'America/Los_Angeles',
      earlyUtcMorning,
    );
    expect(window.startDate).toBe('2026-08-01');
    expect(window.endDate).toBe('2026-08-31');
  });

  it('keeps bounds inclusive', () => {
    // Both ends are days that appear in the report, never a boundary before it.
    const window = resolveReportingWindow({ from: '2026-08-20', to: '2026-08-20' }, 'UTC');
    expect(window.startDate).toBe(window.endDate);
  });

  it('falls back to UTC for an unknown zone rather than failing the request', () => {
    // And the window still states which calendar it used.
    expect(todayInTimezone('Not/AZone', earlyUtcMorning)).toBe('2026-09-01');
  });
});
