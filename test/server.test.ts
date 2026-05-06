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
