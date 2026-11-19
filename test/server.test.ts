import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE, expectSellerValuation, silentLogger } from './helpers.js';
import { createApp, listenOrExit } from '../src/server.js';
import { createLogger } from '../src/log.js';
import { loadConfig } from '../src/config.js';
import type { Listing } from '../src/ebay/seller.js';
import type { PriceQuote } from '../src/prices/types.js';

const LISTING: Listing = {
  itemId: 'v1|999',
  sellerId: 'ryan_5050',
  title: 'Cohen Plush',
  imageUrl: 'https://i.ebayimg.com/x.jpg',
  itemWebUrl: 'https://www.ebay.com/itm/999',
  priceUsd: 100,
  currency: 'USD',
  bidCount: 4,
  endsAt: '2026-05-08T00:00:00Z',
  buyingOptions: ['AUCTION'],
  isAuction: true,
};

let server: http.Server;
let baseUrl: string;

// GET `path` from the running app: its status and JSON body (typed `T`).
async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

type Deps = Parameters<typeof createApp>[0];

interface HealthBody {
  status: string;
  checks: Record<string, string>;
}

// The /api/health tests' app: one seller, no quote provider.
const BARE_HEALTH_DEPS: Partial<Deps> = {
  config: { sellerIds: ['boilerpaulie'] } as never,
  fetchQuote: async () => {
    throw new Error('no provider');
  },
};

// Start the app on a free port. Unset deps default to a bare app: default
// config, silent log, no listings, the fixed QUOTE.
async function startApp(overrides: Partial<Deps> = {}) {
  const app = createApp({
    config: loadConfig({}),
    log: silentLogger(),
    fetchListings: async () => [],
    fetchQuote: async () => QUOTE,
    ...overrides,
  });
  return await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(() => {});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('createApp', () => {
  it('serves /healthz', async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('serves /api/snapshot with computed totals', async () => {
    await startApp({
      fetchListings: async () => [LISTING],
    });
    const { status, body } = await getJson<{ totals: { bidUsd: number; split: { shares: number } } }>('/api/snapshot');
    expect(status).toBe(200);
    expect(body.totals.bidUsd).toBe(100);
    expect(body.totals.split.shares).toBe(1);
  });

  it('serves /api/snapshot?symbol=MIXED valuing each seller in its own stock', async () => {
    const ryan = { ...LISTING, itemId: 'v1|1', sellerId: 'ryan_5050', priceUsd: 100, bidCount: 2 };
    const mine = { ...LISTING, itemId: 'v1|2', sellerId: 'boilerpaulie', priceUsd: 100, bidCount: 2 };
    await startApp({
      fetchListings: async () => [ryan, mine],
      // $EBAY @ 50, $GME @ 25 — distinct so the per-seller math is visible.
      fetchQuote: async (symbol: string): Promise<PriceQuote> =>
        symbol === 'GME'
          ? { symbol: 'GME', price: 25, currency: 'USD', asOf: QUOTE.asOf, source: 'finnhub' }
          : { symbol: 'EBAY', price: 50, currency: 'USD', asOf: QUOTE.asOf, source: 'finnhub' },
    });
    const { status, body } = await getJson<Parameters<typeof expectSellerValuation>[0]>(
      '/api/snapshot?symbol=MIXED',
    );
    expect(status).toBe(200);
    expectSellerValuation(body);
  });

  it('returns 503 in production without leaking detail', async () => {
    await startApp({
      config: loadConfig({ NODE_ENV: 'production' }),
      fetchListings: vi.fn(async () => {
        throw new Error('upstream-secret-detail');
      }),
    });
    const { status, body } = await getJson<{ error: string }>('/api/snapshot');
    expect(status).toBe(503);
    expect(body.error).toBe('service_unavailable');
    expect(JSON.stringify(body)).not.toContain('upstream-secret-detail');
  });

  it('returns 503 with error detail outside production for diagnosis', async () => {
    await startApp({
      fetchListings: vi.fn(async () => {
        throw new Error('upstream-detail-here');
      }),
    });
    const { status, body } = await getJson<{ error: string; detail?: string }>('/api/snapshot');
    expect(status).toBe(503);
    expect(body.error).toBe('service_unavailable');
    expect(body.detail).toBe('upstream-detail-here');
  });

  it('returns 404 from /api/ticker-logo when LOGO_DEV_TOKEN is unset', async () => {
    await startApp();
    const { status, body } = await getJson<{ error: string }>('/api/ticker-logo?symbol=GME');
    expect(status).toBe(404);
    expect(body.error).toBe('logo_unavailable');
  });

  it('returns 400 from /api/ticker-logo for a malformed symbol', async () => {
    await startApp({
      config: loadConfig({ LOGO_DEV_TOKEN: 'pk_test' }),
    });
    const { status, body } = await getJson<{ error: string }>('/api/ticker-logo?symbol=not+a+ticker');
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
  });

  it('serves /api/ohlc-history daily OHLC bars per ticker from the DB', async () => {
    const dbRows = [
      { ticker: 'EBAY', period_start: new Date('2026-05-13T20:00:00Z'), open: '108', high: '110', low: '107', close: '108.61' },
      { ticker: 'GME', period_start: new Date('2026-05-13T20:00:00Z'), open: '21', high: '22', low: '20.8', close: '21.77' },
    ];
    const db = { query: async () => ({ rows: dbRows, rowCount: dbRows.length }) };
    await startApp({
      db: db as never,
    });
    const { status, body } = await getJson<{ ohlc: Record<string, Array<{ t: number; c: number }>> }>('/api/ohlc-history?tickers=EBAY,GME&days=120');
    expect(status).toBe(200);
    expect(body.ohlc.EBAY).toEqual([{ t: Date.parse('2026-05-13T20:00:00Z'), o: 108, h: 110, l: 107, c: 108.61 }]);
    expect(body.ohlc.GME).toEqual([{ t: Date.parse('2026-05-13T20:00:00Z'), o: 21, h: 22, l: 20.8, c: 21.77 }]);
  });

  it('returns empty ohlc from /api/ohlc-history when no DB is configured', async () => {
    await startApp();
    const { status, body } = await getJson<{ ohlc: Record<string, unknown> }>('/api/ohlc-history?tickers=EBAY');
    expect(status).toBe(200);
    expect(body.ohlc).toEqual({});
  });

  it('snapshot tickerLogoUrl points at the local proxy when the token is set', async () => {
    await startApp({
      config: loadConfig({ LOGO_DEV_TOKEN: 'pk_test' }),
    });
    const { status, body } = await getJson<{ tickerLogoUrl: string | null }>('/api/snapshot?symbol=GME');
    expect(status).toBe(200);
    expect(body.tickerLogoUrl).toBe('/api/ticker-logo?symbol=GME');
    // The publishable token should never appear in any client-visible URL.
    expect(JSON.stringify(body)).not.toContain('pk_test');
  });

  it('emits a strict CSP header', async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/healthz`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('frame-ancestors');
  });
});

describe('/api/health', () => {
  it('reports ok with not-configured/not-running components on a bare app', async () => {
    await startApp(BARE_HEALTH_DEPS);
    const { status, body } = await getJson<HealthBody>('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('not-configured');
    expect(body.checks.listingPoll).toBe('not-running');
    expect(body.checks.tradingAuth).toBe('ok');
  });

  it('degrades when the caches are serving stale data', async () => {
    await startApp({
      ...BARE_HEALTH_DEPS,
      dataDegraded: () => true,
    });
    const { status, body } = await getJson<HealthBody>('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(String(body.checks.liveData)).toContain('degraded');
  });

  it('errors (503) when the DB ping fails', async () => {
    const badPool = { query: async () => { throw new Error('conn refused'); } };
    await startApp({
      ...BARE_HEALTH_DEPS,
      db: badPool as never,
    });
    const { status, body } = await getJson<HealthBody>('/api/health');
    expect(status).toBe(503);
    expect(body.status).toBe('error');
    expect(body.checks.db).toBe('error');
  });
});

describe('listenOrExit', () => {
  it('logs and exits 1 when the port is taken', async () => {
    await startApp();
    const takenPort = (server.address() as AddressInfo).port;
    const lines: string[] = [];
    const app = createApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    // Settles on whichever callback path runs: exit(1) or a 'listening' log.
    const code = await new Promise<number | 'listening'>((resolve) => {
      const second = listenOrExit(app, takenPort, createLogger({
        level: 'info',
        sink: (l) => {
          lines.push(l);
          if (JSON.parse(l).msg === 'listening') {
            second.close();
            resolve('listening');
          }
        },
      }), {}, (c) => resolve(c));
    });
    expect(code).toBe(1);
    const entry = JSON.parse(lines.find((l) => JSON.parse(l).msg === 'listen failed') ?? '{}');
    expect(entry).toMatchObject({ level: 'error', port: takenPort });
    expect(entry.error).toMatch(/EADDRINUSE/);
  });
});

// Express 5 (path-to-regexp 8, router 2, serve-static 2) route shapes.
describe('page + static routes', () => {
  it.each(['/admin', '/admin.html', '/item', '/item.html'])('%s inlines the shared head', async (p) => {
    await startApp();
    const res = await fetch(`${baseUrl}${p}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).not.toContain('<!--#head-common-->');
    expect(html).toContain('<head>');
  });

  it('serves / and /shared.js from public/', async () => {
    await startApp();
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const js = await fetch(`${baseUrl}/shared.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
  });

  it('404s an unknown path', async () => {
    await startApp();
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  });
});
