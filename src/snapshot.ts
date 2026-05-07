import { splitHalfCashHalfStock, sumSplits, type HalfSplit } from './math.js';
import type { Listing } from './ebay/seller.js';
import type { PriceQuote } from './prices/types.js';

export interface ListingView {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string;
  currency: string | null;
  priceUsd: number | null;
  bidCount: number | null;
  endsAt: string | null;
  isAuction: boolean;
  split: HalfSplit | null;
  lastBidTime: string | null;
}

export interface LastBidSummary {
  itemId: string;
  title: string;
  bidTime: string;
  bidAmount: number;
}

export interface Snapshot {
  generatedAt: string;
  stock: PriceQuote;
  items: ListingView[];
  totals: {
    listingsCount: number;
    pricedCount: number;
    bidsCount: number;
    bidUsd: number;
    split: HalfSplit;
  };
  lastBid: LastBidSummary | null;
}

export function composeSnapshot(listings: readonly Listing[], stock: PriceQuote): Snapshot {
  const items: ListingView[] = listings.map((l) => ({
    itemId: l.itemId,
    title: l.title,
    imageUrl: l.imageUrl,
    itemWebUrl: l.itemWebUrl,
    currency: l.currency,
    priceUsd: l.priceUsd,
    bidCount: l.bidCount,
    endsAt: l.endsAt,
    isAuction: l.isAuction,
    split: l.priceUsd !== null ? splitHalfCashHalfStock(l.priceUsd, stock.price) : null,
    lastBidTime: l.lastBidTime ?? null,
  }));

  const priced = items.filter((i): i is ListingView & { split: HalfSplit; priceUsd: number } =>
    i.split !== null && i.priceUsd !== null,
  );

  let lastBid: LastBidSummary | null = null;
  for (const item of items) {
    if (!item.lastBidTime || item.priceUsd === null) continue;
    const itemTime = Date.parse(item.lastBidTime);
    if (Number.isNaN(itemTime)) continue;
    if (lastBid === null || itemTime > Date.parse(lastBid.bidTime)) {
      lastBid = {
        itemId: item.itemId,
        title: item.title,
        bidTime: item.lastBidTime,
        bidAmount: item.priceUsd,
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    stock,
    items,
    totals: {
      listingsCount: items.length,
      pricedCount: priced.length,
      bidsCount: items.reduce((sum, i) => sum + (i.bidCount ?? 0), 0),
      bidUsd: priced.reduce((sum, i) => sum + i.priceUsd, 0),
      split: sumSplits(priced.map((i) => i.split)),
    },
    lastBid,
  };
}
