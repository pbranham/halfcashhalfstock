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
      [
        listing({ itemId: 'v1|1', priceUsd: 100, bidCount: 7 }),
        listing({ itemId: 'v1|2', priceUsd: 50, bidCount: 3 }),
      ],
      QUOTE,
    );
    expect(snapshot.totals.listingsCount).toBe(2);
    expect(snapshot.totals.pricedCount).toBe(2);
    expect(snapshot.totals.bidsCount).toBe(10);
    expect(snapshot.totals.bidUsd).toBe(150);
    expect(snapshot.totals.split).toEqual({ cashUsd: 75, stockUsd: 75, shares: 1.5 });
    expect(snapshot.items[0]?.split).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  });

  it('counts bids across listings even when some lack prices', () => {
    const snapshot = composeSnapshot(
      [
        listing({ itemId: 'v1|1', priceUsd: 100, bidCount: 4 }),
        listing({ itemId: 'v1|2', priceUsd: null, bidCount: 11 }),
        listing({ itemId: 'v1|3', priceUsd: 30, bidCount: null }),
      ],
      QUOTE,
    );
    expect(snapshot.totals.bidsCount).toBe(15);
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
      bidsCount: 0,
      bidUsd: 0,
      split: { cashUsd: 0, stockUsd: 0, shares: 0 },
    });
  });

  it('emits ISO generatedAt', () => {
    const snapshot = composeSnapshot([], QUOTE);
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null lastBid when no listings have a bid timestamp', () => {
    const snapshot = composeSnapshot([listing({ itemId: 'v1|1', priceUsd: 100 })], QUOTE);
    expect(snapshot.lastBid).toBeNull();
  });

  it('selects the most recent lastBid across listings', () => {
    const snapshot = composeSnapshot(
      [
        listing({
          itemId: 'v1|1',
          priceUsd: 100,
          lastBidTime: '2026-05-06T10:00:00.000Z',
        }),
        listing({
          itemId: 'v1|2',
          priceUsd: 250,
          lastBidTime: '2026-05-07T15:30:00.000Z',
        }),
        listing({
          itemId: 'v1|3',
          priceUsd: 75,
          lastBidTime: '2026-05-07T09:00:00.000Z',
        }),
      ],
      QUOTE,
    );
    expect(snapshot.lastBid).toEqual({
      itemId: 'v1|2',
      title: 'Test',
      bidTime: '2026-05-07T15:30:00.000Z',
      bidAmount: 250,
    });
  });

  it('exposes lastBidTime per item view', () => {
    const snapshot = composeSnapshot(
      [listing({ itemId: 'v1|1', priceUsd: 100, lastBidTime: '2026-05-07T12:00:00.000Z' })],
      QUOTE,
    );
    expect(snapshot.items[0]?.lastBidTime).toBe('2026-05-07T12:00:00.000Z');
  });
});
