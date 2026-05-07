import { getItemBidHistory, type BidRecord, type ItemBidHistory } from './trading.js';
import { TtlCache } from '../cache.js';

const BID_HISTORY_TTL_MS = 30_000;
const tradeCache = new TtlCache<ItemBidHistory>();

export interface CachedBidHistory {
  bidCount: number;
  currentPrice: number;
  bids: BidRecord[];
  lastBidTime: string | null;
  lastBidAmount: number | null;
}

// Permanent cache keyed by (itemId, bidCount). A given bid count for a given
// item is immutable — once we've fetched the bid history at bid count N,
// it never changes. New bids increase the count, which becomes a new key.
const bidHistoryCache = new Map<string, CachedBidHistory>();

export async function fetchBidHistory(
  itemId: string,
  currentBidCount: number,
  devId: string,
  userToken: string,
): Promise<CachedBidHistory | null> {
  const cacheKey = `${itemId}|${currentBidCount}`;
  const cached = bidHistoryCache.get(cacheKey);
  if (cached) return cached;

  try {
    const history = await tradeCache.get(
      `bid-history-${itemId}`,
      BID_HISTORY_TTL_MS,
      () => getItemBidHistory(itemId, devId, userToken),
    );

    const lastBid = history.bids.length > 0 ? history.bids[history.bids.length - 1] : null;
    const result: CachedBidHistory = {
      bidCount: history.bidCount,
      currentPrice: history.currentPrice,
      bids: history.bids,
      lastBidTime: lastBid?.bidTime ?? null,
      lastBidAmount: lastBid?.bidAmount ?? null,
    };

    bidHistoryCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
