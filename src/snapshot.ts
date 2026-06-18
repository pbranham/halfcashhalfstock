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
  // The ticker this item's split is denominated in. Equals the snapshot's
  // single ticker in normal mode; in "By seller" mode it's the item's
  // seller-paired ticker ($EBAY for ryan_5050, $GME for boilerpaulie). The
  // dashboard groups shares by this field for the two-row totals.
  valuationTicker: string;
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
  // See ListingView.valuationTicker. For ended items both `split` (live) and
  // `endTimeSplit` are denominated in this ticker.
  valuationTicker: string;
}

export interface LastBidSummary {
  itemId: string;
  title: string;
  bidTime: string;
  bidAmount: number;
}

// In "By seller" (mixed) mode the snapshot values each item in its seller's
// ticker. The caller supplies the resolver + the quotes; composeSnapshot stays
// synchronous and otherwise unchanged. Absent → normal single-ticker mode.
export interface ValuationContext {
  tickerForSeller: (sellerId: string) => string;
  quoteForTicker: (ticker: string) => PriceQuote;
  // The distinct quotes spanned, in display order — surfaced as Snapshot.stocks
  // so the header can show every live price.
  quotes: readonly PriceQuote[];
}

export interface Snapshot {
  generatedAt: string;
  // Primary quote. In "By seller" mode this is the default-stock quote, kept
  // for back-compat; `stocks` carries every live price the header renders.
  stock: PriceQuote;
  // Every distinct quote this snapshot values items in. One entry in normal
  // mode (=== [stock]); two in "By seller" mode ([$EBAY, $GME]).
  stocks: PriceQuote[];
  valuationMode: 'single' | 'mixed';
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
  // Present only in "By seller" mode. When given, each item is valued in its
  // seller's ticker rather than the single `stock`.
  valuation?: ValuationContext,
): Snapshot {
  // Per-item valuation: in normal mode every item uses the single `stock`; in
  // "By seller" mode it uses the seller-paired ticker's quote.
  const tickerFor = (sellerId: string): string =>
    valuation ? valuation.tickerForSeller(sellerId) : stock.symbol;
  const priceFor = (sellerId: string): number =>
    valuation ? valuation.quoteForTicker(valuation.tickerForSeller(sellerId)).price : stock.price;

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
    split: isSplittablePrice(l.priceUsd) ? splitHalfCashHalfStock(l.priceUsd, priceFor(l.sellerId)) : null,
    valuationTicker: tickerFor(l.sellerId),
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
    // A zero/negative/non-finite "close" is corrupt OHLC data, not a price.
    // Normalize it to null here so endTimePriceUsd and endTimeSplit can
    // never disagree (previously the split guarded > 0 but the raw price
    // field still surfaced the bad value to the frontend).
    const rawClose = endTimeClosesByItemId.get(e.itemId) ?? null;
    const endTimeClose =
      rawClose !== null && Number.isFinite(rawClose) && rawClose > 0 ? rawClose : null;
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
      split: isUsd && isSplittablePrice(e.finalPriceUsd) ? splitHalfCashHalfStock(e.finalPriceUsd, priceFor(e.sellerId)) : null,
      endTimePriceUsd: endTimeClose,
      endTimeSplit:
        isUsd && isSplittablePrice(e.finalPriceUsd) && endTimeClose !== null
          ? splitHalfCashHalfStock(e.finalPriceUsd, endTimeClose)
          : null,
      valuationTicker: tickerFor(e.sellerId),
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
    stocks: valuation ? [...valuation.quotes] : [stock],
    valuationMode: valuation ? 'mixed' : 'single',
    items,
    endedItems,
    // NOTE: in "By seller" mode the rolled-up `split.shares` here sums shares
    // across different tickers ($EBAY + $GME) and is therefore not meaningful
    // on its own — the dashboard regroups per-item `split` by valuationTicker
    // for display and never renders these aggregate share counts directly.
    // The cash/bidUsd dollar figures stay correct (USD is additive).
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
