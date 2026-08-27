import { AppError, type ProviderCategory, type ProviderKey } from '@mart/shared';
import { getConfig } from '@mart/config';
import { MetaAdsProvider } from './providers/meta.js';
import { AppsFlyerAttributionProvider } from './providers/appsflyer.js';
import { TenjinAttributionProvider } from './providers/tenjin.js';
import type { AnyProvider, AttributionProvider, MarketingNetworkProvider } from './types.js';
import type { ProviderCredentials } from './credentials.js';
import type { ProviderHttpClient } from './http.js';

/**
 * Provider registry.
 *
 * Adding a provider means adding an adapter and one entry here. Nothing else in
 * MART - not the sync engine, not the API, not the dashboard - branches on a
 * provider key.
 */
export type ProviderDescriptor = {
  providerKey: ProviderKey;
  category: ProviderCategory;
  displayName: string;
  credentialKind: ProviderCredentials['kind'];
  /** Fields the connect form must collect, so the UI stays provider-agnostic. */
  credentialFields: Array<{
    name: string;
    label: string;
    help?: string;
    secret: boolean;
  }>;
  /** Whether the provider can enumerate accounts/apps for the user. */
  supportsAccountDiscovery: boolean;
  create(input: { credentials: ProviderCredentials; http?: ProviderHttpClient }): AnyProvider;
};

const META: ProviderDescriptor = {
  providerKey: 'meta_ads',
  category: 'marketing_network',
  displayName: 'Meta Ads',
  credentialKind: 'meta_ads',
  credentialFields: [
    {
      name: 'accessToken',
      label: 'Access token',
      help: 'A Marketing API access token with ads_read on the ad accounts you want to import.',
      secret: true,
    },
  ],
  supportsAccountDiscovery: true,
  create: ({ credentials, http }) => {
    if (credentials.kind !== 'meta_ads') throw credentialMismatch('meta_ads');
    const config = getConfig();
    return new MetaAdsProvider({
      credentials,
      baseUrl: config.META_GRAPH_BASE_URL,
      apiVersion: config.META_GRAPH_API_VERSION,
      ...(http ? { http } : {}),
    });
  },
};

const APPSFLYER: ProviderDescriptor = {
  providerKey: 'appsflyer',
  category: 'attribution_mmp',
  displayName: 'AppsFlyer',
  credentialKind: 'appsflyer',
  credentialFields: [
    {
      name: 'apiToken',
      label: 'API token (V2)',
      help: 'AppsFlyer V2 API token. MART uses it for read-only Pull API requests.',
      secret: true,
    },
  ],
  // The Pull API is per-app and exposes no account-wide app listing.
  supportsAccountDiscovery: false,
  create: ({ credentials, http }) => {
    if (credentials.kind !== 'appsflyer') throw credentialMismatch('appsflyer');
    return new AppsFlyerAttributionProvider({
      credentials,
      baseUrl: getConfig().APPSFLYER_BASE_URL,
      ...(http ? { http } : {}),
    });
  },
};

const TENJIN: ProviderDescriptor = {
  providerKey: 'tenjin',
  category: 'attribution_mmp',
  displayName: 'Tenjin',
  credentialKind: 'tenjin',
  credentialFields: [
    {
      name: 'apiKey',
      label: 'API key',
      help: 'Tenjin reporting API key. MART uses it for read-only report requests.',
      secret: true,
    },
  ],
  supportsAccountDiscovery: true,
  create: ({ credentials, http }) => {
    if (credentials.kind !== 'tenjin') throw credentialMismatch('tenjin');
    return new TenjinAttributionProvider({
      credentials,
      baseUrl: getConfig().TENJIN_BASE_URL,
      ...(http ? { http } : {}),
    });
  },
};

const DESCRIPTORS = new Map<ProviderKey, ProviderDescriptor>([
  [META.providerKey, META],
  [APPSFLYER.providerKey, APPSFLYER],
  [TENJIN.providerKey, TENJIN],
]);

function credentialMismatch(expected: string): AppError {
  return new AppError('internal_error', `Credential kind does not match provider '${expected}'`);
}

export function listImplementedProviders(): ProviderDescriptor[] {
  return [...DESCRIPTORS.values()];
}

export function getProviderDescriptor(providerKey: string): ProviderDescriptor {
  const descriptor = DESCRIPTORS.get(providerKey as ProviderKey);
  if (!descriptor) {
    throw new AppError('validation_failed', `Provider '${providerKey}' is not implemented`, {
      details: { providerKey },
    });
  }
  return descriptor;
}

export function isImplemented(providerKey: string): boolean {
  return DESCRIPTORS.has(providerKey as ProviderKey);
}

/**
 * Test seam.
 *
 * Lets a test substitute an adapter without reaching into the sync engine or
 * monkey-patching global fetch. Overrides are keyed by provider so a test can
 * replace one provider and leave the rest real.
 */
const overrides = new Map<string, (input: { credentials: ProviderCredentials }) => AnyProvider>();

export function setProviderOverride(
  providerKey: string,
  factory: ((input: { credentials: ProviderCredentials }) => AnyProvider) | null,
): void {
  if (factory) overrides.set(providerKey, factory);
  else overrides.delete(providerKey);
}

export function clearProviderOverrides(): void {
  overrides.clear();
}

export function createProvider(input: {
  providerKey: string;
  credentials: ProviderCredentials;
  http?: ProviderHttpClient;
}): AnyProvider {
  const override = overrides.get(input.providerKey);
  if (override) return override({ credentials: input.credentials });
  const descriptor = getProviderDescriptor(input.providerKey);
  return descriptor.create({
    credentials: input.credentials,
    ...(input.http ? { http: input.http } : {}),
  });
}

export function createMarketingProvider(input: {
  providerKey: string;
  credentials: ProviderCredentials;
  http?: ProviderHttpClient;
}): MarketingNetworkProvider {
  const provider = createProvider(input);
  if (provider.category !== 'marketing_network') {
    throw new AppError(
      'validation_failed',
      `Provider '${input.providerKey}' is not a marketing network`,
    );
  }
  return provider;
}

export function createAttributionProvider(input: {
  providerKey: string;
  credentials: ProviderCredentials;
  http?: ProviderHttpClient;
}): AttributionProvider {
  const provider = createProvider(input);
  if (provider.category !== 'attribution_mmp') {
    throw new AppError(
      'validation_failed',
      `Provider '${input.providerKey}' is not an attribution provider`,
    );
  }
  return provider;
}

/**
 * Build the credential object for a provider from untyped form input.
 * Validation lives with the descriptor so routes never special-case a provider.
 */
export function buildCredentials(
  providerKey: string,
  input: Record<string, unknown>,
): ProviderCredentials {
  const descriptor = getProviderDescriptor(providerKey);
  const values: Record<string, string> = {};
  for (const field of descriptor.credentialFields) {
    const raw = input[field.name];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new AppError('validation_failed', `Missing credential field '${field.name}'`, {
        details: { field: field.name },
      });
    }
    values[field.name] = raw.trim();
  }
  switch (descriptor.credentialKind) {
    case 'meta_ads':
      return { kind: 'meta_ads', accessToken: values['accessToken'] as string };
    case 'appsflyer':
      return { kind: 'appsflyer', apiToken: values['apiToken'] as string };
    case 'tenjin':
      return { kind: 'tenjin', apiKey: values['apiKey'] as string };
    default:
      throw new AppError('validation_failed', 'Unsupported credential kind');
  }
}

/**
 * Where MART will actually send this provider's requests.
 *
 * Base URLs are configurable so a developer can point an adapter at the local
 * fixture server. That is exactly why the dashboard needs to be able to say so:
 * a number fetched from a fixture endpoint must never be presented as if it came
 * from the provider. `isProduction` compares the configured origin against the
 * provider's real one, so the answer is derived from configuration rather than
 * from a flag someone could forget to set.
 */
export type ProviderEndpointInfo = {
  providerKey: string;
  configuredBaseUrl: string;
  productionBaseUrl: string;
  isProduction: boolean;
};

const PRODUCTION_BASE_URLS: Partial<Record<ProviderKey, string>> = {
  meta_ads: 'https://graph.facebook.com',
  appsflyer: 'https://hq1.appsflyer.com',
  tenjin: 'https://reporting.tenjin.com',
};

function originOf(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function providerEndpointInfo(providerKey: string): ProviderEndpointInfo | null {
  const production = PRODUCTION_BASE_URLS[providerKey as ProviderKey];
  if (!production) return null;
  const config = getConfig();
  const configured =
    providerKey === 'meta_ads'
      ? config.META_GRAPH_BASE_URL
      : providerKey === 'appsflyer'
        ? config.APPSFLYER_BASE_URL
        : config.TENJIN_BASE_URL;
  return {
    providerKey,
    configuredBaseUrl: configured,
    productionBaseUrl: production,
    isProduction: originOf(configured) === originOf(production),
  };
}
