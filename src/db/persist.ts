import type { Pool } from 'pg';
import type { Listing } from '../ebay/seller.js';
import type { BidRecord } from '../ebay/trading.js';

export interface SnapshotPersistInput {
  listing: Listing;
  bids: BidRecord[] | null;
}

export async function upsertListing(pool: Pool, listing: Listing): Promise<void> {
  await pool.query(
    `INSERT INTO listings (
       item_id, title, image_url, item_web_url, is_auction, ends_at,
       current_price_usd, current_bid_count, currency, first_seen_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (item_id) DO UPDATE SET
       title = EXCLUDED.title,
       image_url = EXCLUDED.image_url,
       item_web_url = EXCLUDED.item_web_url,
       is_auction = EXCLUDED.is_auction,
       ends_at = EXCLUDED.ends_at,
       current_price_usd = EXCLUDED.current_price_usd,
       current_bid_count = EXCLUDED.current_bid_count,
       currency = EXCLUDED.currency,
       last_seen_at = NOW()`,
    [
      listing.itemId,
      listing.title,
      listing.imageUrl,
      listing.itemWebUrl,
      listing.isAuction,
      listing.endsAt,
      listing.priceUsd,
      listing.bidCount,
      listing.currency,
    ],
  );
}

export async function insertBids(
  pool: Pool,
  itemId: string,
  bids: readonly BidRecord[],
): Promise<number> {
  const valid = bids.filter(
    (b) => b.bidTime && Number.isFinite(b.bidAmount) && b.bidAmount >= 0,
  );
  if (valid.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders = valid
    .map((bid, i) => {
      const base = i * 4;
      values.push(itemId, bid.bidder || 'unknown', bid.bidTime, bid.bidAmount);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    })
    .join(', ');

  const res = await pool.query(
    `INSERT INTO bids (item_id, bidder, bid_time, bid_amount_usd)
     VALUES ${placeholders}
     ON CONFLICT (item_id, bid_time, bidder) DO NOTHING`,
    values,
  );
  return res.rowCount ?? 0;
}

export async function persistSnapshot(
  pool: Pool,
  inputs: readonly SnapshotPersistInput[],
): Promise<{ listings: number; bids: number }> {
  let listingsTouched = 0;
  let bidsInserted = 0;
  for (const { listing, bids } of inputs) {
    await upsertListing(pool, listing);
    listingsTouched += 1;
    if (bids && bids.length > 0) {
      bidsInserted += await insertBids(pool, listing.itemId, bids);
    }
  }
  return { listings: listingsTouched, bids: bidsInserted };
}

export interface BidRow {
  bidder: string;
  bidTime: string;
  bidAmountUsd: number;
}

export async function readBidsForItem(pool: Pool, itemId: string): Promise<BidRow[]> {
  const res = await pool.query<{
    bidder: string;
    bid_time: Date;
    bid_amount_usd: string;
  }>(
    `SELECT bidder, bid_time, bid_amount_usd
     FROM bids
     WHERE item_id = $1
     ORDER BY bid_time ASC`,
    [itemId],
  );
  return res.rows.map((row) => ({
    bidder: row.bidder,
    bidTime: row.bid_time.toISOString(),
    bidAmountUsd: Number(row.bid_amount_usd),
  }));
}
