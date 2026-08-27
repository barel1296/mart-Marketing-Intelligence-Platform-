'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiMutate } from '../../lib/client';

type Mode = 'signin' | 'register';

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result =
      mode === 'signin'
        ? await apiMutate('/api/v1/auth/login', { email, password })
        : await apiMutate('/api/v1/auth/register', {
            email,
            password,
            displayName,
            organizationName,
          });

    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.push('/apps');
    router.refresh();
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>{mode === 'signin' ? 'Sign in' : 'Create your workspace'}</h2>
          <div className="hint">
            {mode === 'signin'
              ? 'Sign in to your MART organization.'
              : 'Creates a user, an organization and an owner membership.'}
          </div>
        </div>
      </div>

      <form className="form" onSubmit={submit}>
        {mode === 'register' ? (
          <>
            <div className="field">
              <label htmlFor="displayName">Your name</label>
              <input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="field">
              <label htmlFor="organizationName">Organization</label>
              <input
                id="organizationName"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                required
                autoComplete="organization"
              />
            </div>
          </>
        ) : null}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          {mode === 'register' ? (
            <span className="help">
              At least 12 characters, with upper and lower case letters and a digit.
            </span>
          ) : null}
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="button-row">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create workspace'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'register' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin' ? 'Create a workspace' : 'I already have an account'}
          </button>
        </div>
      </form>
    </section>
  );
}
