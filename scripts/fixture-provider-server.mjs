#!/usr/bin/env node
/*
 * Local fixture provider server — DEVELOPMENT ONLY.
 *
 * WHAT THIS IS
 * ------------
 * A tiny HTTP server that speaks the request shapes MART's connectors send, so
 * the whole pipeline (connect -> validate -> ingest -> normalize -> reconcile ->
 * display) can be exercised on a laptop with no provider account.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not evidence that MART's connectors work against the real providers,
 * and it is not a specification of those providers' behaviour. Fixture data is
 * synthetic and labelled as such: every account, campaign and app id here starts
 * with `FIXTURE`, so a fixture row is recognisable anywhere it turns up — in the
 * database, in the dashboard, or in a screenshot.
 *
 * Nothing in MART's production code path reads this server. It is reached only
 * because an operator deliberately repoints META_GRAPH_BASE_URL /
 * APPSFLYER_BASE_URL / TENJIN_BASE_URL at it. Production code never falls back
 * to fixtures when provider data is missing: it shows an empty state.
 *
 * Response-shape fidelity, honestly stated:
 *   - Meta Graph v21.0 and AppsFlyer Pull API v5 shapes here follow those
 *     providers' published contracts, which MART's adapters were written from.
 *   - The Tenjin shape follows MART's *assumed* envelope. Tenjin's REST wire
 *     format could not be verified in this environment (see INTEGRATIONS.md), so
 *     treat the Tenjin routes as a test double for MART's own parser, not as a
 *     description of Tenjin. Every Tenjin response carries
 *     `x-mart-fixture: unverified-tenjin-envelope` to keep that visible.
 *
 * Usage:
 *   MART_ENABLE_FIXTURES=true node scripts/fixture-provider-server.mjs
 */

import { createServer } from 'node:http';

if (process.env.MART_ENABLE_FIXTURES !== 'true') {
  console.error(
    'Refusing to start: set MART_ENABLE_FIXTURES=true to run the local fixture provider server.',
  );
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to start: fixture providers must never run in production.');
  process.exit(1);
}

const PORT = Number(process.env.MART_FIXTURE_PORT ?? 4900);

// --------------------------------------------------------------- fixtures ---

const AD_ACCOUNT = 'act_FIXTURE0001';
const APPSFLYER_APP = 'id_FIXTURE_APP';
const TENJIN_APP = 'FIXTURE_TENJIN_APP';

/**
 * Three campaigns, chosen so the reconciliation screen has something real to
 * show rather than a uniformly happy path:
 *   - FIXTURE_C_1001 / 1002 appear in both Meta and the MMP with the same id
 *     (stable-id match).
 *   - FIXTURE_C_1003 appears only in Meta (unmatched marketing entity).
 *   - The MMP additionally reports a campaign with no id at all, which can only
 *     ever become a name-fallback candidate — never an authoritative match.
 */
const CAMPAIGNS = [
  { id: 'FIXTURE_C_1001', name: 'FIXTURE UA iOS Tier1', objective: 'APP_INSTALLS', budget: 250000 },
  { id: 'FIXTURE_C_1002', name: 'FIXTURE UA Android Broad', objective: 'APP_INSTALLS', budget: 180000 },
  { id: 'FIXTURE_C_1003', name: 'FIXTURE Retargeting EU', objective: 'APP_INSTALLS', budget: 60000 },
];
const MMP_ONLY_CAMPAIGN_NAME = 'FIXTURE UA iOS Tier1';
const COUNTRIES = ['US', 'GB', 'DE'];

/** Deterministic pseudo-randomness: same request, same numbers, every run. */
function seeded(...parts) {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function daysIn(from, to) {
  const out = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out.slice(0, 400);
}

function delivery(date, campaign, country) {
  const r = seeded(date, campaign.id, country ?? '-');
  const impressions = Math.round(20000 + r * 60000);
  const clicks = Math.round(impressions * (0.012 + r * 0.02));
  const spend = Math.round(impressions * (0.004 + r * 0.006) * 100) / 100;
  const installs = Math.max(1, Math.round(clicks * (0.08 + r * 0.12)));
  return { impressions, clicks, spend, installs };
}

// ------------------------------------------------------------------ replies --

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-mart-fixture': 'synthetic-data',
    ...headers,
  });
  res.end(payload);
}

function csv(res, rows) {
  const text = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  res.writeHead(200, {
    'content-type': 'text/csv',
    'content-length': Buffer.byteLength(text),
    'x-mart-fixture': 'synthetic-data',
  });
  res.end(text);
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Meta's own error envelope, so MART's error classification is exercised. */
function metaAuthError(res) {
  json(res, 401, {
    error: {
      message: 'Invalid OAuth access token.',
      type: 'OAuthException',
      code: 190,
      fbtrace_id: 'FIXTURE',
    },
  });
}

function bearer(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

// ------------------------------------------------------------------ routes ---

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const q = url.searchParams;

  if (req.method !== 'GET') {
    // MART's connectors are read-only. Anything else is a bug worth surfacing.
    json(res, 405, { error: { message: 'Fixture providers are read-only', type: 'FixtureError' } });
    return;
  }

  const token = bearer(req);

  // ---------------------------------------------------------- Meta Graph ---
  const meta = /^\/v\d+\.\d+\/(.+)$/.exec(path);
  if (meta) {
    if (!token) return metaAuthError(res);
    const resource = meta[1];

    if (resource === 'me/adaccounts') {
      return json(res, 200, {
        data: [
          {
            id: AD_ACCOUNT,
            account_id: AD_ACCOUNT.replace('act_', ''),
            name: 'FIXTURE Ad Account (synthetic)',
            currency: 'USD',
            timezone_name: 'UTC',
            account_status: 1,
          },
        ],
        paging: { cursors: { after: 'FIXTUREEND' } },
      });
    }

    const [account, edge] = resource.split('/');
    if (account !== AD_ACCOUNT) {
      return json(res, 400, {
        error: {
          message: `Unsupported get request. Object with ID '${account}' does not exist`,
          type: 'GraphMethodException',
          code: 100,
        },
      });
    }

    if (edge === 'campaigns') {
      return json(res, 200, {
        data: CAMPAIGNS.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          objective: campaign.objective,
          daily_budget: String(campaign.budget),
          created_time: '2026-01-05T00:00:00+0000',
          account_id: AD_ACCOUNT.replace('act_', ''),
        })),
        paging: {},
      });
    }

    if (edge === 'adsets') {
      return json(res, 200, {
        data: CAMPAIGNS.flatMap((campaign) =>
          [1, 2].map((n) => ({
            id: `${campaign.id}_AS${n}`,
            name: `${campaign.name} / adset ${n}`,
            campaign_id: campaign.id,
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            daily_budget: String(Math.round(campaign.budget / 2)),
            bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          })),
        ),
        paging: {},
      });
    }

    if (edge === 'ads') {
      return json(res, 200, {
        data: CAMPAIGNS.flatMap((campaign) =>
          [1, 2].map((n) => ({
            id: `${campaign.id}_AD${n}`,
            name: `${campaign.name} / ad ${n}`,
            adset_id: `${campaign.id}_AS${n}`,
            campaign_id: campaign.id,
            status: 'ACTIVE',
            effective_status: 'ACTIVE',
            creative: {
              id: `${campaign.id}_CR${n}`,
              name: `FIXTURE creative ${n}`,
              object_type: 'VIDEO',
            },
          })),
        ),
        paging: {},
      });
    }

    if (edge === 'insights') {
      let range;
      try {
        range = JSON.parse(q.get('time_range') ?? '{}');
      } catch {
        range = {};
      }
      if (!range.since || !range.until) {
        return json(res, 400, {
          error: { message: 'time_range is required', type: 'OAuthException', code: 100 },
        });
      }
      const withCountry = (q.get('breakdowns') ?? '').includes('country');
      const rows = [];
      for (const date of daysIn(range.since, range.until)) {
        for (const campaign of CAMPAIGNS) {
          for (const country of withCountry ? COUNTRIES : [null]) {
            const d = delivery(date, campaign, country);
            rows.push({
              date_start: date,
              date_stop: date,
              account_id: AD_ACCOUNT.replace('act_', ''),
              account_name: 'FIXTURE Ad Account (synthetic)',
              account_currency: 'USD',
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              spend: d.spend.toFixed(2),
              impressions: String(d.impressions),
              clicks: String(d.clicks),
              inline_link_clicks: String(Math.round(d.clicks * 0.8)),
              reach: String(Math.round(d.impressions * 0.7)),
              frequency: '1.4',
              ...(country ? { country } : {}),
            });
          }
        }
      }
      return json(res, 200, { data: rows, paging: {} });
    }

    return json(res, 400, {
      error: { message: `Fixture server has no route for edge '${edge}'`, type: 'GraphMethodException', code: 100 },
    });
  }

  // ------------------------------------------------------------ AppsFlyer ---
  const af = /^\/api\/(raw-data|agg-data)\/export\/app\/([^/]+)\/([^/]+)\/v5$/.exec(path);
  if (af) {
    if (!token || token.length < 20) {
      res.writeHead(401, { 'content-type': 'text/plain', 'x-mart-fixture': 'synthetic-data' });
      res.end('Unauthorized. The supplied API token is not valid.');
      return;
    }
    const [, kind, appId, report] = af;
    if (appId !== APPSFLYER_APP) {
      res.writeHead(404, { 'content-type': 'text/plain', 'x-mart-fixture': 'synthetic-data' });
      res.end(`App ${appId} is not associated with this account.`);
      return;
    }
    const from = q.get('from');
    const to = q.get('to');
    if (!from || !to) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('from and to are required');
      return;
    }

    if (kind === 'raw-data' && report === 'installs_report') {
      const rows = [
        [
          'Install Time',
          'Media Source',
          'Campaign',
          'Campaign ID',
          'Adset',
          'Adset ID',
          'Country Code',
          'Platform',
          'AppsFlyer ID',
        ],
      ];
      for (const date of daysIn(from, to)) {
        for (const campaign of CAMPAIGNS.slice(0, 2)) {
          const d = delivery(date, campaign, null);
          // The MMP sees fewer installs than the network claims: that gap is
          // exactly what the reconciliation screen exists to show.
          const count = Math.max(1, Math.round(d.installs * 0.85));
          for (let i = 0; i < count; i += 1) {
            rows.push([
              `${date} ${String(i % 24).padStart(2, '0')}:12:00`,
              'facebook ads',
              campaign.name,
              campaign.id,
              `${campaign.name} / adset 1`,
              `${campaign.id}_AS1`,
              COUNTRIES[i % COUNTRIES.length],
              i % 2 === 0 ? 'ios' : 'android',
              `FIXTURE-${date}-${campaign.id}-${i}`,
            ]);
          }
        }
        // A campaign the MMP knows only by name: never an authoritative match.
        const nameOnly = delivery(date, CAMPAIGNS[0], 'nameonly');
        for (let i = 0; i < Math.max(1, Math.round(nameOnly.installs * 0.1)); i += 1) {
          rows.push([
            `${date} 09:00:00`,
            'facebook ads',
            MMP_ONLY_CAMPAIGN_NAME,
            '',
            '',
            '',
            'US',
            'ios',
            `FIXTURE-${date}-NONAME-${i}`,
          ]);
        }
      }
      return csv(res, rows);
    }

    if (kind === 'raw-data' && report === 'in_app_events_report') {
      const rows = [
        [
          'Event Time',
          'Event Name',
          'Event Revenue USD',
          'Event Revenue Currency',
          'Media Source',
          'Campaign',
          'Campaign ID',
          'Country Code',
          'Platform',
        ],
      ];
      for (const date of daysIn(from, to)) {
        for (const campaign of CAMPAIGNS.slice(0, 2)) {
          const d = delivery(date, campaign, null);
          const purchases = Math.max(1, Math.round(d.installs * 0.06));
          for (let i = 0; i < purchases; i += 1) {
            rows.push([
              `${date} ${String((i * 3) % 24).padStart(2, '0')}:41:00`,
              'af_purchase',
              (2.99 + seeded(date, campaign.id, String(i)) * 40).toFixed(2),
              'USD',
              'facebook ads',
              campaign.name,
              campaign.id,
              COUNTRIES[i % COUNTRIES.length],
              i % 2 === 0 ? 'ios' : 'android',
            ]);
          }
        }
      }
      return csv(res, rows);
    }

    if (kind === 'agg-data' && report === 'partners_by_date_report') {
      const rows = [['Date', 'Media Source', 'Campaign', 'Installs', 'Impressions', 'Clicks']];
      for (const date of daysIn(from, to)) {
        for (const campaign of CAMPAIGNS.slice(0, 2)) {
          const d = delivery(date, campaign, null);
          rows.push([
            date,
            'facebook ads',
            campaign.name,
            String(Math.round(d.installs * 0.85)),
            String(d.impressions),
            String(d.clicks),
          ]);
        }
      }
      return csv(res, rows);
    }

    res.writeHead(200, { 'content-type': 'text/plain', 'x-mart-fixture': 'synthetic-data' });
    // AppsFlyer's real behaviour for an unavailable report: HTTP 200, prose.
    res.end('This report is only supported for accounts on the relevant plan.');
    return;
  }

  // --------------------------------------------------------------- Tenjin ---
  if (path.startsWith('/api/v2/')) {
    const headers = { 'x-mart-fixture': 'unverified-tenjin-envelope' };
    if (!token) return json(res, 401, { error: 'invalid api key' }, headers);

    if (path === '/api/v2/apps') {
      return json(
        res,
        200,
        {
          data: [
            { id: TENJIN_APP, name: 'FIXTURE Tenjin App (synthetic)', platform: 'ios', store_id: 'id000000000' },
          ],
        },
        headers,
      );
    }

    if (path === '/api/v2/user_acquisition') {
      const from = q.get('start_date') ?? q.get('from');
      const to = q.get('end_date') ?? q.get('to');
      if (!from || !to) return json(res, 400, { error: 'date range required' }, headers);
      const rows = [];
      for (const date of daysIn(from, to)) {
        for (const campaign of CAMPAIGNS.slice(0, 2)) {
          const d = delivery(date, campaign, null);
          rows.push({
            date,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            ad_network: 'Facebook',
            country: 'US',
            platform: 'ios',
            tracked_installs: Math.round(d.installs * 0.82),
            tracked_clicks: d.clicks,
            tracked_impressions: d.impressions,
            revenues: Math.round(d.installs * 0.9 * 100) / 100,
          });
        }
      }
      return json(res, 200, { data: rows }, headers);
    }

    return json(res, 404, { error: `no fixture route for ${path}` }, headers);
  }

  json(res, 404, { error: { message: `Fixture server has no route for ${path}`, type: 'FixtureError' } });
});

server.listen(PORT, () => {
  console.log(`MART fixture provider server listening on http://localhost:${PORT}`);
  console.log('  SYNTHETIC DATA ONLY — this is not a real provider and proves nothing about one.');
  console.log('  Point your .env at it:');
  console.log(`    META_GRAPH_BASE_URL=http://localhost:${PORT}`);
  console.log(`    APPSFLYER_BASE_URL=http://localhost:${PORT}`);
  console.log(`    TENJIN_BASE_URL=http://localhost:${PORT}`);
  console.log('  Then connect with any token of 20+ characters, and use:');
  console.log(`    Meta ad account   ${AD_ACCOUNT}`);
  console.log(`    AppsFlyer app id  ${APPSFLYER_APP}`);
  console.log(`    Tenjin app id     ${TENJIN_APP}`);
});
