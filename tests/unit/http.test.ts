import { describe, expect, it, vi } from 'vitest';
import { isProviderError } from '@mart/shared';
import {
  ProviderHttpClient,
  backoffDelayMs,
  classifyHttpStatus,
  isRetryableClass,
  userMessageFor,
} from '@mart/integrations';

function makeClient(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: {
    maxAttempts?: number;
    minIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  return new ProviderHttpClient({
    provider: 'meta_ads',
    fetchImpl,
    maxAttempts: options.maxAttempts ?? 3,
    minIntervalMs: options.minIntervalMs ?? 0,
    sleep: options.sleep ?? (async () => undefined),
  });
}

describe('error classification', () => {
  it('maps HTTP statuses to actionable classes', () => {
    expect(classifyHttpStatus(401, '')).toBe('authentication_error');
    expect(classifyHttpStatus(403, 'permission denied')).toBe('authorization_error');
    expect(classifyHttpStatus(403, 'Session has expired')).toBe('expired_credential');
    expect(classifyHttpStatus(400, '')).toBe('invalid_request');
    expect(classifyHttpStatus(429, '')).toBe('rate_limited');
    expect(classifyHttpStatus(500, '')).toBe('provider_unavailable');
    expect(classifyHttpStatus(504, '')).toBe('timeout');
  });

  it('marks only transient classes retryable', () => {
    expect(isRetryableClass('rate_limited')).toBe(true);
    expect(isRetryableClass('provider_unavailable')).toBe(true);
    expect(isRetryableClass('timeout')).toBe(true);
    expect(isRetryableClass('authentication_error')).toBe(false);
    expect(isRetryableClass('invalid_request')).toBe(false);
  });

  it('produces user messages that are actionable and free of API internals', () => {
    const expired = userMessageFor('meta_ads', 'expired_credential');
    expect(expired).toMatch(/Meta Ads/);
    expect(expired).toMatch(/expired/i);
    expect(expired).not.toMatch(/HTTP|token=|Bearer/);
    expect(userMessageFor('appsflyer', 'rate_limited')).toMatch(/retry automatically/i);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter and honours Retry-After', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, undefined, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, undefined, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, undefined, noJitter)).toBe(4000);
    expect(backoffDelayMs(10, undefined, noJitter)).toBe(30_000);
    expect(backoffDelayMs(1, 5_000)).toBe(5_000);
    // Jitter keeps the delay in [base/2, base].
    const jittered = backoffDelayMs(3, undefined, () => 0);
    expect(jittered).toBe(2000);
  });
});

describe('ProviderHttpClient', () => {
  it('retries a rate-limited response and succeeds', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1)
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const response = await client.request<{ ok: boolean }>({ url: 'https://example.com/x' });
    expect(response.body.ok).toBe(true);
    expect(response.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return new Response('bad token', { status: 401 });
    });
    await expect(client.request({ url: 'https://example.com/x' })).rejects.toMatchObject({
      errorClass: 'authentication_error',
    });
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget and reports the last classified error', async () => {
    let calls = 0;
    const client = makeClient(
      async () => {
        calls += 1;
        return new Response('boom', { status: 503 });
      },
      { maxAttempts: 3 },
    );
    const error = await client.request({ url: 'https://example.com/x' }).catch((e: unknown) => e);
    expect(isProviderError(error)).toBe(true);
    expect(calls).toBe(3);
  });

  it('spaces requests to respect a provider rate limit', async () => {
    const sleeps: number[] = [];
    let now = 0;
    const client = new ProviderHttpClient({
      provider: 'appsflyer',
      fetchImpl: async () => new Response('{}'),
      minIntervalMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    });
    await client.request({ url: 'https://example.com/a' });
    await client.request({ url: 'https://example.com/b' });
    expect(sleeps).toContain(250);
  });

  it('truncates the provider body in error context and never echoes headers', async () => {
    const client = makeClient(async () => new Response('x'.repeat(5000), { status: 400 }));
    const error = await client.request({ url: 'https://example.com/x' }).catch((e: unknown) => e);
    if (!isProviderError(error)) throw new Error('expected ProviderError');
    const preview = String(error.context?.['bodyPreview'] ?? '');
    expect(preview.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(error.context)).not.toMatch(/authorization/i);
  });

  it('classifies an aborted request as a timeout', async () => {
    const client = makeClient(
      async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      { maxAttempts: 1 },
    );
    await expect(client.request({ url: 'https://example.com/x' })).rejects.toMatchObject({
      errorClass: 'timeout',
    });
  });

  it('parses text responses without attempting JSON parsing', async () => {
    const client = makeClient(async () => new Response('a,b\n1,2'));
    const response = await client.request<string>({
      url: 'https://example.com/x',
      responseType: 'text',
    });
    expect(response.body).toBe('a,b\n1,2');
  });

  it('builds query strings without mutating the caller object', async () => {
    const seen: string[] = [];
    const client = makeClient(async (url) => {
      seen.push(url);
      return new Response('{}');
    });
    const query = { from: '2026-08-01', to: '2026-08-07', empty: undefined };
    await client.request({ url: 'https://example.com/report', query });
    expect(seen[0]).toContain('from=2026-08-01');
    expect(seen[0]).toContain('to=2026-08-07');
    expect(seen[0]).not.toContain('empty');
    expect(Object.keys(query)).toHaveLength(3);
  });

  it('surfaces a retry-after header as the wait hint', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const client = makeClient(
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('wait', { status: 429, headers: { 'retry-after': '2' } });
        }
        return new Response('{}');
      },
      { sleep },
    );
    await client.request({ url: 'https://example.com/x' });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});
