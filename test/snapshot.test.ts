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
    sellerId: 'ryan_5050',
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

  it('excludes no-bid items from dollar totals (starting price does not count)', () => {
    // Two USD listings: one has bids, one is just sitting at its starting
    // price. Only the first should roll into bidUsd / split.
    const snapshot = composeSnapshot(
      [
        listing({ itemId: 'v1|1', priceUsd: 100, bidCount: 3 }),
        listing({ itemId: 'v1|2', priceUsd: 200, bidCount: 0 }),
      ],
      QUOTE,
    );
    expect(snapshot.totals.listingsCount).toBe(2);
    expect(snapshot.totals.pricedCount).toBe(1);
    expect(snapshot.totals.bidUsd).toBe(100);
    expect(snapshot.totals.split).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  });

  it('excludes ended no-bid auctions from ended totals', () => {
    const snapshot = composeSnapshot(
      [],
      QUOTE,
      [
        {
          itemId: 'v1|9',
          sellerId: 'boilerpaulie',
          title: 'Sold for $500',
          imageUrl: null,
          itemWebUrl: null,
          isAuction: true,
          endsAt: null,
          endedAt: '2026-05-06T01:00:00.000Z',
          finalPriceUsd: 500,
          finalBidCount: 4,
          currency: 'USD',
        },
        {
          itemId: 'v1|10',
          sellerId: 'boilerpaulie',
          title: 'Ended with no bids',
          imageUrl: null,
          itemWebUrl: null,
          isAuction: true,
          endsAt: null,
          endedAt: '2026-05-06T02:00:00.000Z',
          finalPriceUsd: 9999, // starting price, but should NOT count
          finalBidCount: 0,
          currency: 'USD',
        },
      ],
    );
    expect(snapshot.endedTotals.listingsCount).toBe(2);
    expect(snapshot.endedTotals.bidUsd).toBe(500);
    expect(snapshot.endedTotals.split.cashUsd).toBe(250);
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

  it('includes ended listings with their own totals', () => {
    const snapshot = composeSnapshot(
      [listing({ itemId: 'v1|1', priceUsd: 100 })],
      QUOTE,
      [
        {
          itemId: 'v1|9',
          sellerId: 'ryan_5050',
          title: 'Ended item',
          imageUrl: null,
          itemWebUrl: 'https://example.com',
          isAuction: true,
          endsAt: '2026-05-06T00:00:00.000Z',
          endedAt: '2026-05-06T01:00:00.000Z',
          finalPriceUsd: 500,
          finalBidCount: 7,
          currency: 'USD',
        },
      ],
    );
    expect(snapshot.endedItems).toHaveLength(1);
    expect(snapshot.endedItems[0]?.itemId).toBe('v1|9');
    expect(snapshot.endedItems[0]?.split?.cashUsd).toBe(250);
    expect(snapshot.endedTotals.listingsCount).toBe(1);
    expect(snapshot.endedTotals.bidsCount).toBe(7);
    expect(snapshot.endedTotals.bidUsd).toBe(500);
    // No endTimeClose map provided → endTimeSplit is null and the at-end
    // aggregate is zero/empty.
    expect(snapshot.endedItems[0]?.endTimePriceUsd).toBeNull();
    expect(snapshot.endedItems[0]?.endTimeSplit).toBeNull();
    expect(snapshot.endedTotals.pricedAtEndCount).toBe(0);
    expect(snapshot.endedTotals.splitAtEnd).toEqual({ cashUsd: 0, stockUsd: 0, shares: 0 });
    // Active totals should remain unaffected by ended items.
    expect(snapshot.totals.listingsCount).toBe(1);
    expect(snapshot.totals.bidUsd).toBe(100);
  });

  it('uses endTimeClosesByItemId to compute per-item endTimeSplit + splitAtEnd', () => {
    // Live EBAY price is 50; the auction's end-time close was 25, so the
    // shares portion of the split should double.
    const snapshot = composeSnapshot(
      [],
      QUOTE,
      [
        {
          itemId: 'v1|9',
          sellerId: 'boilerpaulie',
          title: 'Ended item',
          imageUrl: null,
          itemWebUrl: 'https://example.com',
          isAuction: true,
          endsAt: '2026-05-06T00:00:00.000Z',
          endedAt: '2026-05-06T01:00:00.000Z',
          finalPriceUsd: 500,
          finalBidCount: 4,
          currency: 'USD',
        },
      ],
      new Map([['v1|9', 25]]),
    );
    const item = snapshot.endedItems[0]!;
    expect(item.endTimePriceUsd).toBe(25);
    expect(item.endTimeSplit).toEqual({ cashUsd: 250, stockUsd: 250, shares: 10 });
    // Live split still uses live quote (price 50).
    expect(item.split).toEqual({ cashUsd: 250, stockUsd: 250, shares: 5 });
    expect(snapshot.endedTotals.splitAtEnd).toEqual({ cashUsd: 250, stockUsd: 250, shares: 10 });
    expect(snapshot.endedTotals.pricedAtEndCount).toBe(1);
  });

  it('drops items from splitAtEnd when their end-time close is missing', () => {
    const snapshot = composeSnapshot(
      [],
      QUOTE,
      [
        {
          itemId: 'v1|9',
          sellerId: 'boilerpaulie',
          title: 'Has close',
          imageUrl: null,
          itemWebUrl: null,
          isAuction: true,
          endsAt: null,
          endedAt: '2026-05-06T01:00:00.000Z',
          finalPriceUsd: 100,
          finalBidCount: 2,
          currency: 'USD',
        },
        {
          itemId: 'v1|10',
          sellerId: 'boilerpaulie',
          title: 'Missing close',
          imageUrl: null,
          itemWebUrl: null,
          isAuction: true,
          endsAt: null,
          endedAt: '2026-04-01T01:00:00.000Z',
          finalPriceUsd: 200,
          finalBidCount: 1,
          currency: 'USD',
        },
      ],
      new Map([['v1|9', 50]]),
    );
    expect(snapshot.endedItems[1]?.endTimeSplit).toBeNull();
    expect(snapshot.endedTotals.pricedAtEndCount).toBe(1);
    // Only the v1|9 item contributes to splitAtEnd (100 / 2 / 50 = 1 share).
    expect(snapshot.endedTotals.splitAtEnd).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  });
});
