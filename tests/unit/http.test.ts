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

  it('reads an expired credential a provider reports as a plain 400', () => {
    // Meta's Graph API answers an expired or invalidated token with HTTP 400
    // and OAuthException code 190. Classified by status alone that is
    // `invalid_request`: not retryable, and never enough to flip the
    // connection to invalid_credentials, so the integration keeps reading
    // "connected" while every sync fails.
    expect(
      classifyHttpStatus(
        400,
        '{"error":{"message":"Error validating access token: Session has expired","type":"OAuthException","code":190}}',
      ),
    ).toBe('expired_credential');
    expect(
      classifyHttpStatus(400, '{"error":{"message":"Invalid OAuth access token.","code":190}}'),
    ).toBe('authentication_error');
  });

  it('reads a throttle a provider reports as a plain 400, so the window is retried', () => {
    // The same status carries Meta's throttling codes. Read as
    // `invalid_request` the window is abandoned with no backoff, and the run
    // still ends partially_completed - which advances the incremental cursor
    // past data that never loaded.
    const throttle = classifyHttpStatus(
      400,
      '{"error":{"message":"(#17) User request limit reached","type":"OAuthException","code":17}}',
    );
    expect(throttle).toBe('rate_limited');
    expect(isRetryableClass(throttle)).toBe(true);
    expect(
      classifyHttpStatus(400, '{"error":{"message":"Application request limit reached","code":4}}'),
    ).toBe('rate_limited');
  });

  it('does not mistake Meta\'s "OAuthException" label for a credential problem', () => {
    // Meta stamps type: "OAuthException" on nearly every Graph API error,
    // including a malformed breakdown (code 100) and a missing permission (code
    // 10). Reading the label as a credential signal reported a rejected QUERY
    // as a rejected TOKEN, flipped a working connection to invalid_credentials,
    // and stopped the adapter's own fallback from ever running.
    expect(
      classifyHttpStatus(
        400,
        '{"error":{"message":"(#100) impression_device is not compatible with country","type":"OAuthException","code":100}}',
      ),
    ).toBe('invalid_request');
    expect(
      classifyHttpStatus(
        400,
        '{"error":{"message":"(#10) Application does not have permission for this action","type":"OAuthException","code":10}}',
      ),
    ).not.toBe('authentication_error');
  });

  it('still calls a genuinely malformed request invalid, whatever the status carries', () => {
    expect(classifyHttpStatus(400, '{"error":{"message":"Unknown field: nonsense"}}')).toBe(
      'invalid_request',
    );
    expect(classifyHttpStatus(404, 'not found')).toBe('invalid_request');
  });

  it('lets the status win when the provider is the thing that failed', () => {
    // A gateway page may echo anything; a 5xx is an outage, not a verdict on
    // the credential.
    expect(classifyHttpStatus(503, 'rate limit exceeded')).toBe('provider_unavailable');
    expect(classifyHttpStatus(500, 'invalid access token')).toBe('provider_unavailable');
    // A 401 is about the credential even when the body talks about limits.
    expect(classifyHttpStatus(401, 'too many requests')).toBe('authentication_error');
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
