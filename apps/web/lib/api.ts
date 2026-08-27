import { cookies } from 'next/headers';

const BASE = process.env.MART_API_INTERNAL_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Server-side API call.
 *
 * The dashboard never talks to a provider: it reads MART's own storage through
 * this API. The session cookie is forwarded so authorization is evaluated
 * server-side on every request.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const header = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie: header, accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'internal_error';
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    await apiGet('/api/v1/auth/me');
    return true;
  } catch {
    return false;
  }
}
