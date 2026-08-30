import type { FreshnessStatus, IsoDate, StreamSupport } from '@mart/shared';
import { minutesSince } from '@mart/shared';

export type FreshnessInput = {
  lastSuccessAt: Date | string | null;
  latestProviderDataDate: IsoDate | null;
  expectedFreshnessMinutes: number;
  hasError?: boolean;
  /**
   * What the adapter said about this stream. A stream MART never fetched is
   * neither fresh nor stale - it has no data age at all - so this decides the
   * state before any timing is considered.
   */
  support?: StreamSupport;
  now?: Date;
};

/**
 * Derive a freshness state.
 *
 * Two independent signals matter and are deliberately combined:
 *  - when MART last succeeded in talking to the provider, and
 *  - how recent the newest provider-reported date actually is.
 *
 * A sync that succeeds every hour but only ever returns week-old data is stale,
 * and a dashboard must never present that as live.
 */
export function computeFreshnessStatus(input: FreshnessInput): FreshnessStatus {
  const now = input.now ?? new Date();
  // Checked before the error and success branches: a no-op that "succeeded"
  // must never be recorded as fresh, which is what made an unimplemented
  // stream look like live data.
  if (input.support && input.support !== 'supported') return input.support;
  if (input.hasError) return 'error';
  if (!input.lastSuccessAt) return 'unknown';

  const sinceSuccess = minutesSince(input.lastSuccessAt, now);
  if (sinceSuccess === null) return 'unknown';

  const expected = input.expectedFreshnessMinutes;
  if (sinceSuccess > expected * 3) return 'stale';

  if (input.latestProviderDataDate) {
    const ageDays = Math.floor(
      (Date.parse(`${todayIso(now)}T00:00:00.000Z`) -
        Date.parse(`${input.latestProviderDataDate}T00:00:00.000Z`)) /
        86400000,
    );
    // Yesterday is normal for daily reporting; three days behind is not.
    if (ageDays >= 3) return 'stale';
    if (ageDays === 2) return 'delayed';
  }

  if (sinceSuccess > expected) return 'delayed';
  return 'fresh';
}

function todayIso(now: Date): IsoDate {
  return now.toISOString().slice(0, 10);
}

/** States that describe a stream nobody expects data from. */
const NOT_APPLICABLE: readonly FreshnessStatus[] = ['unsupported', 'not_implemented'];

/**
 * Worst state across a set, used to summarize an app's overall data health.
 *
 * Streams that were never meant to be fetched are excluded rather than ranked:
 * a Tenjin event stream MART does not implement says nothing about whether the
 * install data is current, and letting it dominate would either hide a real
 * problem or invent one. If every stream is in that category, that is the
 * answer.
 */
export function worstFreshness(statuses: readonly FreshnessStatus[]): FreshnessStatus {
  const applicable = statuses.filter((status) => !NOT_APPLICABLE.includes(status));
  if (applicable.length === 0) return statuses[0] ?? 'unknown';
  const order: FreshnessStatus[] = ['error', 'stale', 'unknown', 'delayed', 'fresh'];
  for (const candidate of order) {
    if (applicable.includes(candidate)) return candidate;
  }
  return 'unknown';
}
