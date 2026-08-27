import type { FreshnessStatus, IsoDate } from '@mart/shared';
import { minutesSince } from '@mart/shared';

export type FreshnessInput = {
  lastSuccessAt: Date | string | null;
  latestProviderDataDate: IsoDate | null;
  expectedFreshnessMinutes: number;
  hasError?: boolean;
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

/** Worst state across a set, used to summarize an app's overall data health. */
export function worstFreshness(statuses: readonly FreshnessStatus[]): FreshnessStatus {
  const order: FreshnessStatus[] = ['error', 'stale', 'unknown', 'delayed', 'fresh'];
  for (const candidate of order) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'unknown';
}
