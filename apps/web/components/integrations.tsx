'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiMutate, apiRead } from '../lib/client';
import { StatusChip } from './primitives';
import { formatDateTime } from '../lib/format';

export type CredentialField = {
  name: string;
  label: string;
  help?: string;
  secret: boolean;
};

export type ProviderCatalogueEntry = {
  providerKey: string;
  category: string;
  displayName: string;
  status: string;
  authKind: string;
  implemented: boolean;
  supportsAccountDiscovery: boolean;
  credentialFields: CredentialField[];
};

export type AccountRow = {
  id: string;
  external_account_id: string;
  name: string;
  account_type: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
};

export type ConnectionRow = {
  id: string;
  provider_key: string;
  category: string;
  display_name: string;
  status: string;
  last_validated_at: string | null;
  last_validation_ok: boolean | null;
  last_validation_error_class: string | null;
  last_validation_message: string | null;
  accounts: AccountRow[];
  credential: { fingerprint: string; expiresAt: string | null; rotatedAt: string | null } | null;
};

type Health = { ok: boolean; status: string; message: string; errorClass?: string | null };

function HealthLine({ health }: { health: Health | null }) {
  if (!health) return null;
  return (
    <p className={health.ok ? 'success-text' : 'error-text'}>
      {health.message}
      {health.errorClass ? ` (${health.errorClass})` : ''}
    </p>
  );
}

/**
 * Credential entry.
 *
 * Secrets are typed here and posted straight to MART's API, which encrypts them
 * before they reach the database. They are never echoed back, never placed in a
 * URL, and never held in this component after a successful submit.
 */
function CredentialFields({
  fields,
  values,
  onChange,
  idPrefix,
}: {
  fields: CredentialField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`${idPrefix}-${field.name}`}>{field.label}</label>
          <input
            id={`${idPrefix}-${field.name}`}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            value={values[field.name] ?? ''}
            onChange={(event) => onChange(field.name, event.target.value)}
            required
          />
          {field.help ? <span className="help">{field.help}</span> : null}
        </div>
      ))}
    </>
  );
}

export function ConnectProviderCard({
  organizationId,
  provider,
}: {
  organizationId: string;
  provider: ProviderCatalogueEntry;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  if (!provider.implemented) {
    return (
      <article className="integration-card future">
        <div className="row-between">
          <div>
            <h3>{provider.displayName}</h3>
            <div className="provider-key mono">{provider.providerKey}</div>
          </div>
          <StatusChip status="planned" label="Not implemented" />
        </div>
        <p className="hint" style={{ fontSize: 12, margin: 0 }}>
          Listed so the roadmap is visible. There is no connector for this provider in Phase 0A, so
          it cannot be connected and produces no data.
        </p>
      </article>
    );
  }

  return (
    <article className="integration-card">
      <div className="row-between">
        <div>
          <h3>{provider.displayName}</h3>
          <div className="provider-key mono">
            {provider.providerKey} · {provider.authKind}
          </div>
        </div>
        <StatusChip status="available" label="Available" />
      </div>

      {open ? (
        <form
          className="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            setHealth(null);
            const result = await apiMutate<{ health: Health }>(
              `/api/v1/organizations/${organizationId}/connections`,
              { providerKey: provider.providerKey, credentials: values },
            );
            setBusy(false);
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            // Drop the secrets from component state as soon as they are stored.
            setValues({});
            setHealth(result.data.health);
            setOpen(false);
            router.refresh();
          }}
        >
          <CredentialFields
            fields={provider.credentialFields}
            values={values}
            idPrefix={`connect-${provider.providerKey}`}
            onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
          />
          <p className="hint" style={{ fontSize: 11, margin: 0 }}>
            Credentials are sent to the MART API over the same origin, encrypted with AES-256-GCM
            before storage, and never returned to the browser. MART only ever reads from this
            provider.
          </p>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Connecting and validating…' : 'Connect and validate'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValues({});
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <HealthLine health={health} />
          <div className="button-row">
            <button className="primary" type="button" onClick={() => setOpen(true)}>
              Connect {provider.displayName}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * Everything you can do with one stored connection: prove it still works,
 * replace its credential, choose which provider account it reads, bind that
 * account to this app, or disconnect it.
 */
export function ConnectionPanel({
  organizationId,
  appId,
  connection,
  provider,
  boundAccountId,
  role,
}: {
  organizationId: string;
  appId: string;
  connection: ConnectionRow;
  provider: ProviderCatalogueEntry | undefined;
  boundAccountId: string | null;
  role: 'marketing_network' | 'primary_attribution';
}) {
  const router = useRouter();
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [selected, setSelected] = useState(boundAccountId ?? '');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const disconnected = connection.status === 'disconnected';
  const base = `/api/v1/organizations/${organizationId}/connections/${connection.id}`;

  async function run<T>(
    key: string,
    fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>,
    onSuccess: (data: T) => void,
  ): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    const result = await fn();
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSuccess(result.data);
    router.refresh();
  }

  return (
    <div className="stack">
      <dl className="detail-grid">
        <dt>Connection</dt>
        <dd>
          {connection.display_name} <span className="mono">({connection.provider_key})</span>
        </dd>
        <dt>Status</dt>
        <dd>
          <StatusChip status={connection.status} />
        </dd>
        <dt>Last validated</dt>
        <dd>
          {formatDateTime(connection.last_validated_at)}
          {connection.last_validation_message ? ` — ${connection.last_validation_message}` : ''}
        </dd>
        <dt>Credential</dt>
        <dd>
          {connection.credential ? (
            <>
              stored, fingerprint <span className="mono">{connection.credential.fingerprint}</span>
              {connection.credential.rotatedAt
                ? ` · rotated ${formatDateTime(connection.credential.rotatedAt)}`
                : ''}
            </>
          ) : (
            'none stored'
          )}
        </dd>
      </dl>

      {/* Account selection ------------------------------------------------- */}
      <div className="stack">
        <strong style={{ fontSize: 12 }}>
          {role === 'primary_attribution' ? 'Provider app' : 'Ad account'}
        </strong>
        {connection.accounts.length > 0 ? (
          <div className="button-row">
            <select
              aria-label="Select account"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose…</option>
              {connection.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.external_account_id})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary"
              disabled={!selected || busy !== null || disconnected}
              onClick={() =>
                run(
                  'bind',
                  () =>
                    apiMutate(`/api/v1/organizations/${organizationId}/apps/${appId}/bindings`, {
                      connectionId: connection.id,
                      integrationAccountId: selected,
                      role,
                    }),
                  () =>
                    setNotice(
                      'Account bound to this app. Scheduled sync jobs were created for it.',
                    ),
                )
              }
            >
              {busy === 'bind'
                ? 'Binding…'
                : boundAccountId
                  ? 'Change bound account'
                  : 'Use for this app'}
            </button>
          </div>
        ) : (
          <p className="hint" style={{ fontSize: 12, margin: 0 }}>
            No accounts registered for this connection yet.
          </p>
        )}

        {provider?.supportsAccountDiscovery ? (
          <div className="button-row">
            <button
              type="button"
              disabled={busy !== null || disconnected}
              onClick={() =>
                run(
                  'discover',
                  () => apiRead<{ accounts: AccountRow[] }>(`${base}/accounts?refresh=true`),
                  (data) =>
                    setNotice(
                      `Discovered ${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'} from the provider.`,
                    ),
                )
              }
            >
              {busy === 'discover' ? 'Asking provider…' : 'Discover accounts'}
            </button>
          </div>
        ) : (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                'manual',
                () =>
                  apiMutate(`${base}/accounts`, {
                    externalAccountId: manualId,
                    ...(manualName ? { name: manualName } : {}),
                  }),
                () => {
                  setManualId('');
                  setManualName('');
                  setNotice('App id validated against the provider and registered.');
                },
              );
            }}
          >
            <p className="hint" style={{ fontSize: 11, margin: 0 }}>
              {provider?.displayName ?? 'This provider'} has no endpoint that lists the apps a key
              can read, so MART asks for the id instead of guessing. It is validated against the
              provider before it is stored.
            </p>
            <div className="field">
              <label htmlFor={`manual-${connection.id}`}>App id</label>
              <input
                id={`manual-${connection.id}`}
                value={manualId}
                onChange={(event) => setManualId(event.target.value)}
                placeholder="id1234567890 or com.example.game"
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`manual-name-${connection.id}`}>Label (optional)</label>
              <input
                id={`manual-name-${connection.id}`}
                value={manualName}
                onChange={(event) => setManualName(event.target.value)}
              />
            </div>
            <div className="button-row">
              <button type="submit" disabled={busy !== null || disconnected}>
                {busy === 'manual' ? 'Validating…' : 'Validate and add app'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Credential rotation ------------------------------------------------ */}
      {rotating && provider ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void run<{ health: Health }>(
              'rotate',
              () => apiMutate(`${base}/credentials`, { credentials: values }),
              (data) => {
                setValues({});
                setRotating(false);
                setHealth(data.health);
              },
            );
          }}
        >
          <CredentialFields
            fields={provider.credentialFields}
            values={values}
            idPrefix={`rotate-${connection.id}`}
            onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
          />
          <div className="button-row">
            <button className="primary" type="submit" disabled={busy !== null}>
              {busy === 'rotate' ? 'Replacing…' : 'Replace credential'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRotating(false);
                setValues({});
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {confirmDisconnect ? (
        <div className="notice">
          <strong>Disconnect {connection.display_name}?</strong> The stored credential is deleted
          immediately and this app stops syncing from it. Data already imported is kept, with its
          original provider provenance — nothing is deleted from history.
          <div className="button-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() =>
                run<{ notice: string }>(
                  'disconnect',
                  () => apiMutate(`${base}/disconnect`, {}),
                  (data) => {
                    setConfirmDisconnect(false);
                    setNotice(data.notice);
                  },
                )
              }
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Yes, disconnect'}
            </button>
            <button type="button" onClick={() => setConfirmDisconnect(false)}>
              Keep connected
            </button>
          </div>
        </div>
      ) : null}

      <HealthLine health={health} />
      {notice ? <p className="success-text">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <div className="button-row">
        <button
          type="button"
          disabled={busy !== null || disconnected}
          onClick={() =>
            run<{ health: Health }>(
              'validate',
              () => apiMutate(`${base}/validate`, {}),
              (data) => setHealth(data.health),
            )
          }
        >
          {busy === 'validate' ? 'Checking…' : 'Re-check connection'}
        </button>
        {!disconnected ? (
          <button type="button" onClick={() => setRotating((value) => !value)}>
            Reconnect (replace credential)
          </button>
        ) : null}
        {!disconnected ? (
          <button type="button" className="danger" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Choosing the primary attribution provider.
 *
 * This is the single decision that defines what "attributed" means for an app,
 * so it is never a silent side effect of connecting something. Changing it
 * requires reading what changes and confirming it explicitly.
 */
export function AttributionProviderChooser({
  organizationId,
  appId,
  current,
  options,
}: {
  organizationId: string;
  appId: string;
  current: string | null;
  options: Array<{ providerKey: string; displayName: string; implemented: boolean }>;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(current ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changing = current !== null && choice !== current;

  return (
    <div className="stack">
      <div className="button-row">
        {options.map((option) => (
          <label key={option.providerKey} className="choice">
            <input
              type="radio"
              name="mmp"
              value={option.providerKey}
              checked={choice === option.providerKey}
              disabled={!option.implemented}
              onChange={() => {
                setChoice(option.providerKey);
                setConfirming(false);
                setNotice(null);
              }}
            />
            <span>{option.displayName}</span>
            {option.implemented ? null : <StatusChip status="planned" label="not implemented" />}
          </label>
        ))}
      </div>

      {choice && choice !== current ? (
        confirming ? (
          <div className="notice">
            <strong>
              {changing
                ? `Change the primary attribution provider from ${current} to ${choice}?`
                : `Set ${choice} as the primary attribution provider for this app?`}
            </strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>
                Attribution metrics (installs, attributed revenue) will be read from {choice} going
                forward.
              </li>
              {changing ? (
                <li>
                  Historical {current} data is <strong>retained</strong> with its original
                  provenance. It is not deleted and it is not merged with {choice} data — the two
                  MMPs count and de-duplicate installs differently, so the numbers will not agree.
                </li>
              ) : null}
              {changing ? (
                <li>
                  Campaign-to-source mappings are provider-scoped, so reconciliation coverage will
                  be rebuilt for {choice} and may start at zero.
                </li>
              ) : null}
              <li>This change is written to the organization audit log.</li>
            </ul>
            <div className="button-row" style={{ marginTop: 8 }}>
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  const result = await apiMutate<{ notice?: string }>(
                    `/api/v1/organizations/${organizationId}/apps/${appId}/attribution-provider`,
                    { provider: choice, confirmSwitch: true },
                  );
                  setBusy(false);
                  if (!result.ok) {
                    setError(result.error.message);
                    return;
                  }
                  setConfirming(false);
                  setNotice(result.data.notice ?? 'Primary attribution provider updated.');
                  router.refresh();
                }}
              >
                {busy ? 'Saving…' : 'I understand, apply'}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button type="button" className="primary" onClick={() => setConfirming(true)}>
              {changing ? `Switch to ${choice}…` : `Set ${choice} as primary MMP…`}
            </button>
          </div>
        )
      ) : null}

      {notice ? <p className="success-text">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}
