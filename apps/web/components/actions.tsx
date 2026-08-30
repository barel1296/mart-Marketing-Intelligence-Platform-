'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiMutate } from '../lib/client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await apiMutate('/api/v1/auth/logout', {});
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

export function CreateAppForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [platform, setPlatform] = useState('ios');
  const [timezone, setTimezone] = useState('UTC');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="primary" type="button" onClick={() => setOpen(true)}>
        Create app
      </button>
    );
  }

  return (
    <form
      className="form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await apiMutate(`/api/v1/organizations/${organizationId}/apps`, {
          name,
          bundleId,
          platform,
          timezone,
          defaultCurrency: currency,
        });
        setBusy(false);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        setName('');
        setBundleId('');
        router.refresh();
      }}
    >
      <div className="field">
        <label htmlFor="app-name">App name</label>
        <input id="app-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="bundle-id">Bundle ID</label>
        <input
          id="bundle-id"
          value={bundleId}
          onChange={(e) => setBundleId(e.target.value)}
          placeholder="com.example.game"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="platform">Platform</label>
        <select id="platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="ios">iOS</option>
          <option value="android">Android</option>
          <option value="cross_platform">Cross-platform</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="timezone">Reporting timezone</label>
        <input id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        <span className="help">
          Provider reports are requested in this timezone, so dates line up across sources.
        </span>
      </div>
      <div className="field">
        <label htmlFor="currency">Default currency</label>
        <input
          id="currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          maxLength={3}
        />
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="button-row">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create app'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SyncButton({
  organizationId,
  appId,
  backfill = false,
  label,
}: {
  organizationId: string;
  appId: string;
  backfill?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="button-row">
      <button
        type="button"
        className={backfill ? '' : 'primary'}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setMessage(null);
          const result = await apiMutate<{
            enqueued: Array<{ dataType: string; from: string; to: string }>;
            skipped: Array<{ dataType: string; reason: string }>;
          }>(`/api/v1/organizations/${organizationId}/apps/${appId}/sync`, { backfill });
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          const { enqueued, skipped } = result.data;
          setMessage(
            `Queued ${enqueued.length} sync${enqueued.length === 1 ? '' : 's'}` +
              (skipped.length > 0 ? `, ${skipped.length} already running` : '') +
              '. The worker picks them up within seconds.',
          );
          router.refresh();
        }}
      >
        {busy ? 'Queueing…' : (label ?? (backfill ? 'Backfill history' : 'Sync now'))}
      </button>
      {message ? <span className="success-text">{message}</span> : null}
      {error ? <span className="error-text">{error}</span> : null}
    </span>
  );
}

export function RecomputeReconciliationButton({
  organizationId,
  appId,
}: {
  organizationId: string;
  appId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="button-row">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await apiMutate(
            `/api/v1/organizations/${organizationId}/apps/${appId}/reconciliation/recompute`,
            {},
          );
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          router.refresh();
        }}
      >
        {busy ? 'Recomputing…' : 'Recompute mappings'}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
    </span>
  );
}

/**
 * Resolve one ambiguous mapping by hand.
 *
 * MART refuses to pick between candidates it cannot tell apart. A person can,
 * and their decision is recorded as `manually_verified`: it survives every
 * later reconciliation, overrides any computed fallback, is written to the
 * audit log with who and when, and can be undone here.
 *
 * Nothing is preselected. A default choice is a guess wearing a person's name.
 */
export function ResolveAmbiguousMapping({
  organizationId,
  appId,
  mapping,
}: {
  organizationId: string;
  appId: string;
  mapping: {
    id: string;
    sourceName: string | null;
    sourceExternalId: string;
    candidates: Array<{ externalCampaignId?: string | null; campaignName?: string | null }>;
    reason: string | null;
  };
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: 'verify' | 'reject'): Promise<void> => {
    setBusy(true);
    setError(null);
    const candidate = mapping.candidates.find((c) => c.externalCampaignId === choice);
    const result = await apiMutate(
      `/api/v1/organizations/${organizationId}/apps/${appId}/mappings/${mapping.id}/verify`,
      decision === 'verify'
        ? {
            decision,
            targetExternalId: choice,
            ...(candidate?.campaignName ? { targetName: candidate.campaignName } : {}),
          }
        : { decision },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div>
        <strong>{mapping.sourceName ?? mapping.sourceExternalId}</strong>
      </div>
      {mapping.reason ? <div className="muted">{mapping.reason}</div> : null}
      <label className="muted" htmlFor={`resolve-${mapping.id}`}>
        Which attribution campaign is this?
      </label>
      <select
        id={`resolve-${mapping.id}`}
        value={choice}
        disabled={busy}
        onChange={(event) => setChoice(event.target.value)}
      >
        <option value="">Select a candidate…</option>
        {mapping.candidates.map((candidate, index) => (
          <option
            key={candidate.externalCampaignId ?? index}
            value={candidate.externalCampaignId ?? ''}
          >
            {candidate.campaignName ?? candidate.externalCampaignId ?? 'unnamed'}
            {candidate.externalCampaignId ? ` — ${candidate.externalCampaignId}` : ''}
          </option>
        ))}
      </select>
      <div className="inline-meta">
        <button
          type="button"
          className="button"
          disabled={busy || choice === ''}
          onClick={() => void submit('verify')}
        >
          {busy ? 'Saving…' : 'Save verified mapping'}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void submit('reject')}
        >
          None of these
        </button>
      </div>
      {error ? <span className="error-text">{error}</span> : null}
    </div>
  );
}
