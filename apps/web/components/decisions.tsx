'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiMutate } from '../lib/client';

export type PolicySnapshot = {
  configured: boolean;
  targetRoasD7: number | null;
  targetRoasD1: number | null;
  maxCpi: number | null;
  currency: string | null;
  thresholds: {
    minimumSpend: number;
    minimumInstalls: number;
    minimumMatureDays: number;
    tolerancePct: number;
    trendWindowDays: number;
    trendMaterialChangePct: number;
  };
  updatedAt: string | null;
};

/**
 * The operator's targets.
 *
 * Every field is optional and a blank field clears the target. What is saved
 * is exactly what was typed: MART never derives a target from the data,
 * because the data cannot know the margin the return has to clear.
 */
export function DecisionPolicyForm({
  organizationId,
  appId,
  policy,
  defaultCurrency,
  canEdit,
}: {
  organizationId: string;
  appId: string;
  policy: PolicySnapshot;
  defaultCurrency: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [targetRoasD7, setTargetRoasD7] = useState(
    policy.targetRoasD7 === null ? '' : String(policy.targetRoasD7),
  );
  const [targetRoasD1, setTargetRoasD1] = useState(
    policy.targetRoasD1 === null ? '' : String(policy.targetRoasD1),
  );
  const [maxCpi, setMaxCpi] = useState(policy.maxCpi === null ? '' : String(policy.maxCpi));
  const [currency, setCurrency] = useState(policy.currency ?? defaultCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const parse = (value: string): number | null => {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.NaN;
  };

  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        const body = {
          targetRoasD7: parse(targetRoasD7),
          targetRoasD1: parse(targetRoasD1),
          maxCpi: parse(maxCpi),
          currency: currency.trim() === '' ? null : currency.trim().toUpperCase(),
        };
        if ([body.targetRoasD7, body.targetRoasD1, body.maxCpi].some((v) => Number.isNaN(v))) {
          setError('Targets must be numbers.');
          return;
        }
        setBusy(true);
        const result = await apiMutate<{ policy: PolicySnapshot }>(
          `/api/v1/organizations/${organizationId}/apps/${appId}/decision-policy`,
          body,
          'PUT',
        );
        setBusy(false);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setSaved(result.data.policy.configured ? 'Targets saved.' : 'Targets cleared.');
        router.refresh();
      }}
    >
      <div className="detail-grid">
        <div className="field">
          <label htmlFor="target-roas-d7">D7 cohort ROAS target</label>
          <input
            id="target-roas-d7"
            inputMode="decimal"
            value={targetRoasD7}
            onChange={(e) => setTargetRoasD7(e.target.value)}
            placeholder="e.g. 0.5"
            disabled={!canEdit}
          />
          <span className="help">
            Ratio of D7 cohort revenue to the spend that bought the cohort.
          </span>
        </div>
        <div className="field">
          <label htmlFor="target-roas-d1">D1 cohort ROAS target</label>
          <input
            id="target-roas-d1"
            inputMode="decimal"
            value={targetRoasD1}
            onChange={(e) => setTargetRoasD1(e.target.value)}
            placeholder="optional"
            disabled={!canEdit}
          />
          <span className="help">Read only when no D7 target can be read.</span>
        </div>
        <div className="field">
          <label htmlFor="max-cpi">CPI ceiling</label>
          <input
            id="max-cpi"
            inputMode="decimal"
            value={maxCpi}
            onChange={(e) => setMaxCpi(e.target.value)}
            placeholder="optional"
            disabled={!canEdit}
          />
          <span className="help">Read only when no cohort return target can be read.</span>
        </div>
        <div className="field">
          <label htmlFor="policy-currency">Currency of the CPI ceiling</label>
          <input
            id="policy-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            disabled={!canEdit}
          />
          <span className="help">Must match the spend currency; MART never converts.</span>
        </div>
      </div>
      <p className="hint">
        A scale or reduce signal needs at least {policy.thresholds.minimumMatureDays} mature
        delivered days, {policy.thresholds.minimumSpend} spend and{' '}
        {policy.thresholds.minimumInstalls} mapped installs, and a figure outside a ±
        {policy.thresholds.tolerancePct}% band around the target. Those floors are not per-app
        settings.
      </p>
      {error ? <p className="error-text">{error}</p> : null}
      {saved ? <p className="success-text">{saved}</p> : null}
      {canEdit ? (
        <div className="button-row">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save targets'}
          </button>
        </div>
      ) : (
        <p className="hint">Your role can read targets but not change them.</p>
      )}
    </form>
  );
}
