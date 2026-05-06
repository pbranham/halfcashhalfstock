import { describe, it, expect } from 'vitest';
import { composeSnapshot } from '../src/snapshot.js';
import type { Listing } from '../src/ebay/seller.js';
import type { PriceQuote } from '../src/prices/types.js';

const QUOTE: PriceQuote = {
  symbol: 'EBAY',
  price: 50,
  currency: 'USD',
  asOf: '2026-05-06T18:00:00.000Z',
  source: 'finnhub',
};

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    itemId: 'v1|1',
    title: 'Test',
    imageUrl: null,
    itemWebUrl: 'https://example.com',
    priceUsd: 100,
    currency: 'USD',
    bidCount: 1,
    endsAt: null,
    buyingOptions: ['AUCTION'],
    isAuction: true,
    ...overrides,
  };
}

describe('composeSnapshot', () => {
  it('computes per-item splits and totals', () => {
    const snapshot = composeSnapshot(
      [listing({ itemId: 'v1|1', priceUsd: 100 }), listing({ itemId: 'v1|2', priceUsd: 50 })],
      QUOTE,
    );
    expect(snapshot.totals.listingsCount).toBe(2);
    expect(snapshot.totals.pricedCount).toBe(2);
    expect(snapshot.totals.bidUsd).toBe(150);
    expect(snapshot.totals.split).toEqual({ cashUsd: 75, stockUsd: 75, shares: 1.5 });
    expect(snapshot.items[0]?.split).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  });

  it('skips items with null priceUsd from totals but keeps them in items[]', () => {
    const snapshot = composeSnapshot(
      [listing({ itemId: 'v1|1', priceUsd: 100 }), listing({ itemId: 'v1|2', priceUsd: null })],
      QUOTE,
    );
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[1]?.split).toBeNull();
    expect(snapshot.totals.pricedCount).toBe(1);
    expect(snapshot.totals.bidUsd).toBe(100);
  });

  it('produces empty totals for empty listings', () => {
    const snapshot = composeSnapshot([], QUOTE);
    expect(snapshot.totals).toEqual({
      listingsCount: 0,
      pricedCount: 0,
      bidUsd: 0,
      split: { cashUsd: 0, stockUsd: 0, shares: 0 },
    });
  });

  it('emits ISO generatedAt', () => {
    const snapshot = composeSnapshot([], QUOTE);
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
