import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.js';
import { createLogger } from '../src/log.js';
import { loadConfig } from '../src/config.js';
import type { Listing } from '../src/ebay/seller.js';
import type { PriceQuote } from '../src/prices/types.js';

const QUOTE: PriceQuote = {
  symbol: 'EBAY',
  price: 50,
  currency: 'USD',
  asOf: '2026-05-06T18:00:00.000Z',
  source: 'finnhub',
};

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

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

let server: http.Server;
let baseUrl: string;

async function startApp(deps: Parameters<typeof createApp>[0]) {
  const app = createApp(deps);
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
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('serves /api/snapshot with computed totals', async () => {
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [LISTING],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { bidUsd: number; split: { shares: number } } };
    expect(body.totals.bidUsd).toBe(100);
    expect(body.totals.split.shares).toBe(1);
  });

  it('serves /api/snapshot?symbol=MIXED valuing each seller in its own stock', async () => {
    const ryan = { ...LISTING, itemId: 'v1|1', sellerId: 'ryan_5050', priceUsd: 100, bidCount: 2 };
    const mine = { ...LISTING, itemId: 'v1|2', sellerId: 'boilerpaulie', priceUsd: 100, bidCount: 2 };
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [ryan, mine],
      // $EBAY @ 50, $GME @ 25 — distinct so the per-seller math is visible.
      fetchQuote: async (symbol: string): Promise<PriceQuote> =>
        symbol === 'GME'
          ? { symbol: 'GME', price: 25, currency: 'USD', asOf: QUOTE.asOf, source: 'finnhub' }
          : { symbol: 'EBAY', price: 50, currency: 'USD', asOf: QUOTE.asOf, source: 'finnhub' },
    });
    const res = await fetch(`${baseUrl}/api/snapshot?symbol=MIXED`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      valuationMode: string;
      stocks: { symbol: string }[];
      items: { itemId: string; valuationTicker: string; split: { shares: number } }[];
    };
    expect(body.valuationMode).toBe('mixed');
    expect(body.stocks.map((q) => q.symbol)).toEqual(['EBAY', 'GME']);
    const byId = Object.fromEntries(body.items.map((i) => [i.itemId, i]));
    // Ryan → $EBAY @ 50: shares = (100/2)/50 = 1.
    expect(byId['v1|1']?.valuationTicker).toBe('EBAY');
    expect(byId['v1|1']?.split.shares).toBe(1);
    // Mine → $GME @ 25: shares = (100/2)/25 = 2.
    expect(byId['v1|2']?.valuationTicker).toBe('GME');
    expect(byId['v1|2']?.split.shares).toBe(2);
  });

  it('returns 503 in production without leaking detail', async () => {
    await startApp({
      config: loadConfig({ NODE_ENV: 'production' }),
      log: silentLogger(),
      fetchListings: vi.fn(async () => {
        throw new Error('upstream-secret-detail');
      }),
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('service_unavailable');
    expect(JSON.stringify(body)).not.toContain('upstream-secret-detail');
  });

  it('returns 503 with error detail outside production for diagnosis', async () => {
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: vi.fn(async () => {
        throw new Error('upstream-detail-here');
      }),
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('service_unavailable');
    expect(body.detail).toBe('upstream-detail-here');
  });

  it('returns 404 from /api/ticker-logo when LOGO_DEV_TOKEN is unset', async () => {
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/ticker-logo?symbol=GME`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('logo_unavailable');
  });

  it('returns 400 from /api/ticker-logo for a malformed symbol', async () => {
    await startApp({
      config: loadConfig({ LOGO_DEV_TOKEN: 'pk_test' }),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/ticker-logo?symbol=not+a+ticker`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('serves /api/ohlc-history daily OHLC bars per ticker from the DB', async () => {
    const dbRows = [
      { ticker: 'EBAY', period_start: new Date('2026-05-13T20:00:00Z'), open: '108', high: '110', low: '107', close: '108.61' },
      { ticker: 'GME', period_start: new Date('2026-05-13T20:00:00Z'), open: '21', high: '22', low: '20.8', close: '21.77' },
    ];
    const db = { query: async () => ({ rows: dbRows, rowCount: dbRows.length }) };
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
      db: db as never,
    });
    const res = await fetch(`${baseUrl}/api/ohlc-history?tickers=EBAY,GME&days=120`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ohlc: Record<string, Array<{ t: number; c: number }>> };
    expect(body.ohlc.EBAY).toEqual([{ t: Date.parse('2026-05-13T20:00:00Z'), o: 108, h: 110, l: 107, c: 108.61 }]);
    expect(body.ohlc.GME).toEqual([{ t: Date.parse('2026-05-13T20:00:00Z'), o: 21, h: 22, l: 20.8, c: 21.77 }]);
  });

  it('returns empty ohlc from /api/ohlc-history when no DB is configured', async () => {
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/ohlc-history?tickers=EBAY`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ohlc: Record<string, unknown> };
    expect(body.ohlc).toEqual({});
  });

  it('snapshot tickerLogoUrl points at the local proxy when the token is set', async () => {
    await startApp({
      config: loadConfig({ LOGO_DEV_TOKEN: 'pk_test' }),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/api/snapshot?symbol=GME`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tickerLogoUrl: string | null };
    expect(body.tickerLogoUrl).toBe('/api/ticker-logo?symbol=GME');
    // The publishable token should never appear in any client-visible URL.
    expect(JSON.stringify(body)).not.toContain('pk_test');
  });

  it('emits a strict CSP header', async () => {
    await startApp({
      config: loadConfig({}),
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => QUOTE,
    });
    const res = await fetch(`${baseUrl}/healthz`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('frame-ancestors');
  });
});

describe('/api/health', () => {
  it('reports ok with not-configured/not-running components on a bare app', async () => {
    await startApp({
      config: { sellerIds: ['boilerpaulie'] } as never,
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => { throw new Error('no provider'); },
    });
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('not-configured');
    expect(body.checks.listingPoll).toBe('not-running');
    expect(body.checks.tradingAuth).toBe('ok');
  });

  it('degrades when the caches are serving stale data', async () => {
    await startApp({
      config: { sellerIds: ['boilerpaulie'] } as never,
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => { throw new Error('no provider'); },
      dataDegraded: () => true,
    });
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(String(body.checks.liveData)).toContain('degraded');
  });

  it('errors (503) when the DB ping fails', async () => {
    const badPool = { query: async () => { throw new Error('conn refused'); } };
    await startApp({
      config: { sellerIds: ['boilerpaulie'] } as never,
      log: silentLogger(),
      fetchListings: async () => [],
      fetchQuote: async () => { throw new Error('no provider'); },
      db: badPool as never,
    });
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.checks.db).toBe('error');
  });
});
