import type { Pool } from 'pg';
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

export async function fetchBidHistory(
  itemId: string,
  currentBidCount: number,
  devId: string,
  userToken: string,
  db?: Pool | null,
): Promise<CachedBidHistory | null> {
  try {
    let history: ItemBidHistory;

    const dbBids = db ? await checkDbActiveBids(db, itemId) : null;
    if (dbBids && dbBids.length === currentBidCount) {
      history = {
        itemId,
        bidCount: currentBidCount,
        currentPrice: dbBids[dbBids.length - 1]?.bidAmount ?? 0,
        bids: dbBids,
      };
    } else {
      history = await tradeCache.get(
        `bid-history-${itemId}`,
        BID_HISTORY_TTL_MS,
        () => getItemBidHistory(itemId, devId, userToken),
      );
    }

    const lastBid = history.bids.length > 0 ? history.bids[history.bids.length - 1] : null;
    return {
      bidCount: history.bidCount,
      currentPrice: history.currentPrice,
      bids: history.bids,
      lastBidTime: lastBid?.bidTime ?? null,
      lastBidAmount: lastBid?.bidAmount ?? null,
    };
  } catch {
    return null;
  }
}

async function checkDbActiveBids(pool: Pool, itemId: string): Promise<BidRecord[] | null> {
  try {
    const result = await pool.query(
      `SELECT bidder, bid_time, bid_amount_usd FROM bids
       WHERE item_id = $1 AND removed_at IS NULL
       ORDER BY bid_time ASC`,
      [itemId],
    );
    if (result.rows.length === 0) return null;
    return result.rows.map((row) => ({
      bidder: row.bidder as string,
      bidTime: new Date(row.bid_time as Date).toISOString(),
      bidAmount: parseFloat(row.bid_amount_usd as string),
    }));
  } catch {
    return null;
  }
}
