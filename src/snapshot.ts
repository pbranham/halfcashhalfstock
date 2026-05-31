import { splitHalfCashHalfStock, sumSplits, type HalfSplit } from './math.js';
import type { Listing } from './ebay/seller.js';
import type { PriceQuote } from './prices/types.js';
import type { EndedListingRow } from './db/persist.js';

export interface ListingView {
  itemId: string;
  sellerId: string;
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
  // Extra gallery images from the per-item Browse details. Excludes
  // imageUrl, so callers render [imageUrl, ...additionalImages]. Empty
  // until the background enrichment pass populates the row.
  additionalImages: string[];
}

export interface EndedListingView {
  itemId: string;
  sellerId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  isAuction: boolean;
  endsAt: string | null;
  endedAt: string;
  finalPriceUsd: number;
  finalBidCount: number;
  currency: string;
  // Same shape as ListingView.additionalImages — gallery URLs from the
  // per-item Browse details, excluding imageUrl.
  additionalImages: string[];
  // Split using the LIVE stock price for the snapshot's ticker.
  split: HalfSplit | null;
  // The stock close (in USD) at the moment this auction ended, looked up
  // from the OHLC table. null if we have no history for that timestamp.
  endTimePriceUsd: number | null;
  // Split using endTimePriceUsd instead of live. null when endTimePriceUsd
  // is null or the auction currency isn't USD.
  endTimeSplit: HalfSplit | null;
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
  endedItems: EndedListingView[];
  totals: {
    listingsCount: number;
    pricedCount: number;
    bidsCount: number;
    bidUsd: number;
    split: HalfSplit;
  };
  endedTotals: {
    listingsCount: number;
    bidsCount: number;
    bidUsd: number;
    // Aggregate split using LIVE stock price (sums each item's `split`).
    split: HalfSplit;
    // Aggregate split using each item's end-time close (sums each item's
    // `endTimeSplit`). Items where endTimeSplit is null are skipped.
    splitAtEnd: HalfSplit;
    // How many items contributed to splitAtEnd. May be less than
    // listingsCount when OHLC history doesn't cover an item's end time.
    pricedAtEndCount: number;
  };
  lastBid: LastBidSummary | null;
}

// A price is splittable when it's a finite non-negative number. The math
// fn itself rejects anything else, so all call sites guard with this — a
// non-finite price slipping in (e.g. a cached payload from an older code
// version where the field was missing, or an unexpected Browse API shape
// on a 0-bid auction) becomes a quiet null split rather than a 503.
function isSplittablePrice(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function composeSnapshot(
  listings: readonly Listing[],
  stock: PriceQuote,
  ended: readonly EndedListingRow[] = [],
  // Stock closes (in USD) keyed by ended item's itemId. Caller is responsible
  // for looking these up from the OHLC table for the current stock symbol —
  // composeSnapshot stays synchronous.
  endTimeClosesByItemId: ReadonlyMap<string, number | null> = new Map(),
  // Gallery URLs (excluding the primary imageUrl) keyed by itemId. Same
  // shape as endTimeClosesByItemId: caller looks them up, composer just
  // surfaces them. Items without an entry get an empty array.
  additionalImagesByItemId: ReadonlyMap<string, string[]> = new Map(),
): Snapshot {
  const items: ListingView[] = listings.map((l) => ({
    itemId: l.itemId,
    sellerId: l.sellerId,
    title: l.title,
    imageUrl: l.imageUrl,
    itemWebUrl: l.itemWebUrl,
    currency: l.currency,
    priceUsd: isSplittablePrice(l.priceUsd) ? l.priceUsd : null,
    bidCount: l.bidCount,
    endsAt: l.endsAt,
    isAuction: l.isAuction,
    split: isSplittablePrice(l.priceUsd) ? splitHalfCashHalfStock(l.priceUsd, stock.price) : null,
    lastBidTime: l.lastBidTime ?? null,
    additionalImages: additionalImagesByItemId.get(l.itemId) ?? [],
  }));

  // Items with at least one real bid AND a USD price contribute to the
  // dollar totals. No-bid items have priceUsd set to eBay's starting price
  // which shouldn't roll up into the half/half math until someone actually
  // bids.
  const priced = items.filter(
    (i): i is ListingView & { split: HalfSplit; priceUsd: number } =>
      i.split !== null && i.priceUsd !== null && (i.bidCount ?? 0) > 0,
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

  const endedItems: EndedListingView[] = ended.map((e) => {
    const isUsd = e.currency === 'USD';
    const endTimeClose = endTimeClosesByItemId.get(e.itemId) ?? null;
    return {
      itemId: e.itemId,
      sellerId: e.sellerId,
      title: e.title,
      imageUrl: e.imageUrl,
      itemWebUrl: e.itemWebUrl,
      isAuction: e.isAuction,
      endsAt: e.endsAt,
      endedAt: e.endedAt,
      finalPriceUsd: e.finalPriceUsd,
      finalBidCount: e.finalBidCount,
      currency: e.currency,
      additionalImages: additionalImagesByItemId.get(e.itemId) ?? [],
      split: isUsd && isSplittablePrice(e.finalPriceUsd) ? splitHalfCashHalfStock(e.finalPriceUsd, stock.price) : null,
      endTimePriceUsd: endTimeClose,
      endTimeSplit:
        isUsd && isSplittablePrice(e.finalPriceUsd) && endTimeClose !== null && endTimeClose > 0
          ? splitHalfCashHalfStock(e.finalPriceUsd, endTimeClose)
          : null,
    };
  });
  // Same no-bid exclusion for ended items: an auction that ended at the
  // starting price with zero bids didn't actually clear, so its starting
  // price shouldn't roll into the ended totals.
  const endedPriced = endedItems.filter(
    (i): i is EndedListingView & { split: HalfSplit } =>
      i.split !== null && (i.finalBidCount ?? 0) > 0,
  );
  const endedPricedAtEnd = endedItems.filter(
    (i): i is EndedListingView & { endTimeSplit: HalfSplit } =>
      i.endTimeSplit !== null && (i.finalBidCount ?? 0) > 0,
  );

  return {
    generatedAt: new Date().toISOString(),
    stock,
    items,
    endedItems,
    totals: {
      listingsCount: items.length,
      pricedCount: priced.length,
      bidsCount: items.reduce((sum, i) => sum + (i.bidCount ?? 0), 0),
      bidUsd: priced.reduce((sum, i) => sum + i.priceUsd, 0),
      split: sumSplits(priced.map((i) => i.split)),
    },
    endedTotals: {
      listingsCount: endedItems.length,
      bidsCount: endedItems.reduce((sum, i) => sum + i.finalBidCount, 0),
      bidUsd: endedPriced.reduce((sum, i) => sum + i.finalPriceUsd, 0),
      split: sumSplits(endedPriced.map((i) => i.split)),
      splitAtEnd: sumSplits(endedPricedAtEnd.map((i) => i.endTimeSplit)),
      pricedAtEndCount: endedPricedAtEnd.length,
    },
    lastBid,
  };
}
