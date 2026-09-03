'use client';

/** Read the double-submit CSRF token the API set as a readable cookie. */
export function csrfToken(): string {
  const match = /(?:^|;\s*)mart_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export type ApiFailure = { code: string; message: string; details?: unknown };

/**
 * Browser-side mutation.
 *
 * Same-origin (Next rewrites /api to the API service), so the HttpOnly session
 * cookie travels automatically and the CSRF token is echoed in a header.
 */
export async function apiMutate<T>(
  path: string,
  body?: unknown,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
): Promise<{ ok: true; data: T } | { ok: false; error: ApiFailure }> {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-mart-csrf': csrfToken(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = (payload as { error?: ApiFailure } | null)?.error;
    return {
      ok: false,
      error: error ?? { code: 'internal_error', message: `Request failed (${response.status})` },
    };
  }
  return { ok: true, data: payload as T };
}

/**
 * Browser-side read.
 *
 * Used for the few interactions that fetch fresh data without mutating, such as
 * asking a provider to re-list its ad accounts.
 */
export async function apiRead<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: ApiFailure }> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as { error?: ApiFailure } | null)?.error;
    return {
      ok: false,
      error: error ?? { code: 'internal_error', message: `Request failed (${response.status})` },
    };
  }
  return { ok: true, data: payload as T };
}
