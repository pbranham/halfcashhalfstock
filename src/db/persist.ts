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

export async function insertListingSnapshotIfChanged(
  pool: Pool,
  listing: Listing,
): Promise<boolean> {
  const last = await pool.query<{
    current_price_usd: string;
    current_bid_count: number;
    ends_at: Date | null;
  }>(
    `SELECT current_price_usd, current_bid_count, ends_at
     FROM listing_snapshots
     WHERE item_id = $1
     ORDER BY observed_at DESC
     LIMIT 1`,
    [listing.itemId],
  );

  const lastRow = last.rows[0];
  if (lastRow) {
    const samePrice = Number(lastRow.current_price_usd) === listing.priceUsd;
    const sameBidCount = lastRow.current_bid_count === (listing.bidCount ?? 0);
    const lastEndsIso = lastRow.ends_at ? new Date(lastRow.ends_at).toISOString() : null;
    const sameEndsAt = lastEndsIso === listing.endsAt;
    if (samePrice && sameBidCount && sameEndsAt) {
      return false;
    }
  }

  await pool.query(
    `INSERT INTO listing_snapshots (
       item_id, current_price_usd, current_bid_count, currency, is_auction, ends_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      listing.itemId,
      listing.priceUsd,
      listing.bidCount ?? 0,
      listing.currency,
      listing.isAuction,
      listing.endsAt,
    ],
  );
  return true;
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

export async function reconcileBids(
  pool: Pool,
  itemId: string,
  freshBids: readonly BidRecord[],
): Promise<{ inserted: number; removed: number }> {
  const existing = await pool.query<{
    bidder: string;
    bid_time: Date;
    bid_amount_usd: string;
  }>(
    `SELECT bidder, bid_time, bid_amount_usd
     FROM bids
     WHERE item_id = $1 AND removed_at IS NULL`,
    [itemId],
  );

  const freshKeys = new Set(
    freshBids
      .filter((b) => b.bidTime && Number.isFinite(b.bidAmount))
      .map((b) => `${b.bidder || 'unknown'}|${new Date(b.bidTime).toISOString()}`),
  );

  const toMarkRemoved = existing.rows.filter((row) => {
    const key = `${row.bidder}|${row.bid_time.toISOString()}`;
    return !freshKeys.has(key);
  });

  let removed = 0;
  if (toMarkRemoved.length > 0) {
    const values: unknown[] = [itemId];
    const clauses = toMarkRemoved.map((row) => {
      const base = values.length + 1;
      values.push(row.bidder, row.bid_time);
      return `(bidder = $${base} AND bid_time = $${base + 1})`;
    });
    const res = await pool.query(
      `UPDATE bids SET removed_at = NOW()
       WHERE item_id = $1 AND removed_at IS NULL AND (${clauses.join(' OR ')})`,
      values,
    );
    removed = res.rowCount ?? 0;
  }

  const inserted = freshBids.length > 0 ? await insertBids(pool, itemId, freshBids) : 0;
  return { inserted, removed };
}

// One-time authoritative repair of an ended auction's bid history from eBay's
// public viewbids page. The page is the COMPLETE, final, static record, so this
// fully replaces the item's bids (delete + insert) rather than merging — the
// (item_id,bid_time,bidder) unique key can't catch a wrong AMOUNT on an
// otherwise-matching row, so a merge would leave stale bad data behind.
export async function reconcileItemBids(
  pool: Pool,
  itemId: string,
  bids: readonly BidRecord[],
): Promise<{ deleted: number; inserted: number; finalPriceUsd: number; bidCount: number }> {
  const valid = bids.filter(
    (b) => b.bidTime && Number.isFinite(b.bidAmount) && b.bidAmount >= 0,
  );
  // Guard: never let an empty/failed parse wipe good data.
  if (valid.length === 0) {
    throw new Error('reconcileItemBids: refusing to replace bids with zero valid rows');
  }
  const finalPriceUsd = valid.reduce((max, b) => (b.bidAmount > max ? b.bidAmount : max), 0);
  const bidCount = valid.length;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM bids WHERE item_id = $1', [itemId]);

    const values: unknown[] = [];
    const placeholders = valid
      .map((bid, i) => {
        const base = i * 4;
        values.push(itemId, bid.bidder || 'unknown', bid.bidTime, bid.bidAmount);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(', ');
    const ins = await client.query(
      `INSERT INTO bids (item_id, bidder, bid_time, bid_amount_usd)
       VALUES ${placeholders}
       ON CONFLICT (item_id, bid_time, bidder) DO NOTHING`,
      values,
    );

    await client.query(
      `UPDATE listings
       SET current_price_usd = $2, current_bid_count = $3, last_backfilled_at = NOW()
       WHERE item_id = $1`,
      [itemId, finalPriceUsd, bidCount],
    );
    await client.query('COMMIT');
    return { deleted: del.rowCount ?? 0, inserted: ins.rowCount ?? 0, finalPriceUsd, bidCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function persistSnapshot(
  pool: Pool,
  inputs: readonly SnapshotPersistInput[],
): Promise<{ listings: number; bids: number; removedBids: number; endedListings: number }> {
  let listingsTouched = 0;
  let bidsInserted = 0;
  for (const { listing, bids } of inputs) {
    await upsertListing(pool, listing);
    await insertListingSnapshotIfChanged(pool, listing);
    listingsTouched += 1;
    if (bids && bids.length > 0) {
      // NOTE: we deliberately do NOT call reconcileBids here. eBay's
      // GetAllBidders API returns one entry per unique bidder (their
      // highest bid), not every individual bid. So when a bidder re-bids,
      // their old DB entry won't match the new API response — but that
      // doesn't mean the old bid was retracted. Reconciling against this
      // incomplete data caused massive false-positive removals during
      // active auctions. Until we have a reliable retraction-detection
      // mechanism, just append (ON CONFLICT DO NOTHING) and never remove.
      bidsInserted += await insertBids(pool, listing.itemId, bids);
    }
  }
  const endedListings = await markEndedListings(pool, inputs.map((i) => i.listing.itemId));
  return { listings: listingsTouched, bids: bidsInserted, removedBids: 0, endedListings };
}

export async function markEndedListings(pool: Pool, currentItemIds: readonly string[]): Promise<number> {
  if (currentItemIds.length === 0) return 0;
  // An item is considered ended if it's no longer in the active poll AND
  // either (a) its advertised end time has passed, or (b) we haven't seen
  // it in any poll for over an hour (safety net for items where ends_at
  // was never captured, or eBay's Browse API kept returning it briefly
  // past its end). The 1-hour buffer protects against brief upstream
  // outages flipping every item to ended.
  const result = await pool.query(
    `UPDATE listings
     SET ended_at = COALESCE(ends_at, last_seen_at, NOW())
     WHERE ended_at IS NULL
       AND NOT (item_id = ANY($1::text[]))
       AND (
         (ends_at IS NOT NULL AND ends_at < NOW())
         OR (last_seen_at < NOW() - INTERVAL '1 hour')
       )`,
    [Array.from(currentItemIds)],
  );
  return result.rowCount ?? 0;
}

export interface StuckListingRow {
  itemId: string;
  title: string;
  endsAt: string | null;
  lastSeenAt: string;
  currentPriceUsd: number;
  currentBidCount: number;
}

export async function readStuckListings(pool: Pool): Promise<StuckListingRow[]> {
  const res = await pool.query<{
    item_id: string;
    title: string;
    ends_at: Date | null;
    last_seen_at: Date;
    current_price_usd: string;
    current_bid_count: number;
  }>(
    `SELECT item_id, title, ends_at, last_seen_at, current_price_usd, current_bid_count
     FROM listings
     WHERE ended_at IS NULL
       AND last_seen_at < NOW() - INTERVAL '30 minutes'
     ORDER BY last_seen_at DESC`,
  );
  return res.rows.map((row) => ({
    itemId: row.item_id,
    title: row.title,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    lastSeenAt: row.last_seen_at.toISOString(),
    currentPriceUsd: Number(row.current_price_usd),
    currentBidCount: row.current_bid_count,
  }));
}

export async function forceMarkEnded(pool: Pool, itemId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE listings
     SET ended_at = COALESCE(ends_at, last_seen_at, NOW())
     WHERE item_id = $1
       AND ended_at IS NULL`,
    [itemId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface EndedListingRow {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  isAuction: boolean;
  endsAt: string | null;
  endedAt: string;
  finalPriceUsd: number;
  finalBidCount: number;
  currency: string;
}

export async function readEndedListings(
  pool: Pool,
  sinceDays: number = 14,
): Promise<EndedListingRow[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const res = await pool.query<{
    item_id: string;
    title: string;
    image_url: string | null;
    item_web_url: string | null;
    is_auction: boolean;
    ends_at: Date | null;
    ended_at: Date;
    current_price_usd: string;
    current_bid_count: number;
    currency: string;
  }>(
    `SELECT item_id, title, image_url, item_web_url, is_auction,
            ends_at, ended_at, current_price_usd, current_bid_count, currency
     FROM listings
     WHERE ended_at IS NOT NULL AND ended_at >= $1
     ORDER BY ended_at DESC`,
    [since],
  );
  return res.rows.map((row) => ({
    itemId: row.item_id,
    title: row.title,
    imageUrl: row.image_url,
    itemWebUrl: row.item_web_url,
    isAuction: row.is_auction,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    endedAt: row.ended_at.toISOString(),
    finalPriceUsd: Number(row.current_price_usd),
    finalBidCount: row.current_bid_count,
    currency: row.currency,
  }));
}

export interface BidRow {
  bidder: string;
  bidTime: string;
  bidAmountUsd: number;
  firstSeenAt: string | null;
  removedAt: string | null;
}

export async function readBidsForItem(pool: Pool, itemId: string): Promise<BidRow[]> {
  const res = await pool.query<{
    bidder: string;
    bid_time: Date;
    bid_amount_usd: string;
    first_seen_at: Date | null;
    removed_at: Date | null;
  }>(
    `SELECT bidder, bid_time, bid_amount_usd, first_seen_at, removed_at
     FROM bids
     WHERE item_id = $1
     ORDER BY bid_time ASC`,
    [itemId],
  );
  return res.rows.map((row) => ({
    bidder: row.bidder,
    bidTime: row.bid_time.toISOString(),
    bidAmountUsd: Number(row.bid_amount_usd),
    firstSeenAt: row.first_seen_at ? row.first_seen_at.toISOString() : null,
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
  }));
}

export interface ListingDetail {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  isAuction: boolean;
  endsAt: string | null;
  endedAt: string | null;
  currentPriceUsd: number;
  currentBidCount: number;
  currency: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function readListingDetail(
  pool: Pool,
  itemId: string,
): Promise<ListingDetail | null> {
  const res = await pool.query<{
    item_id: string;
    title: string;
    image_url: string | null;
    item_web_url: string | null;
    is_auction: boolean;
    ends_at: Date | null;
    ended_at: Date | null;
    current_price_usd: string;
    current_bid_count: number;
    currency: string;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT item_id, title, image_url, item_web_url, is_auction, ends_at, ended_at,
            current_price_usd, current_bid_count, currency, first_seen_at, last_seen_at
     FROM listings
     WHERE item_id = $1`,
    [itemId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    itemId: row.item_id,
    title: row.title,
    imageUrl: row.image_url,
    itemWebUrl: row.item_web_url,
    isAuction: row.is_auction,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    currentPriceUsd: Number(row.current_price_usd),
    currentBidCount: row.current_bid_count,
    currency: row.currency,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

export interface ListingSnapshotRow {
  observedAt: string;
  currentPriceUsd: number;
  currentBidCount: number;
  endsAt: string | null;
}

export async function readListingSnapshots(
  pool: Pool,
  itemId: string,
): Promise<ListingSnapshotRow[]> {
  const res = await pool.query<{
    observed_at: Date;
    current_price_usd: string;
    current_bid_count: number;
    ends_at: Date | null;
  }>(
    `SELECT observed_at, current_price_usd, current_bid_count, ends_at
     FROM listing_snapshots
     WHERE item_id = $1
     ORDER BY observed_at ASC`,
    [itemId],
  );
  return res.rows.map((row) => ({
    observedAt: row.observed_at.toISOString(),
    currentPriceUsd: Number(row.current_price_usd),
    currentBidCount: row.current_bid_count,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
  }));
}

export interface OhlcCandle {
  periodStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

export async function storeOhlcData(
  pool: Pool,
  ticker: string,
  periodStart: Date,
  ohlc: { open?: number; high?: number; low?: number; close?: number },
  source: string,
  interval: string = '1m',
): Promise<void> {
  const { open, high, low, close } = ohlc;
  await pool.query(
    `INSERT INTO ohlc_data (ticker, period_start, open, high, low, close, source, interval)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ticker, period_start) DO UPDATE SET
       open = COALESCE(EXCLUDED.open, ohlc_data.open),
       high = GREATEST(COALESCE(EXCLUDED.high, 0), COALESCE(ohlc_data.high, 0)),
       low = LEAST(COALESCE(EXCLUDED.low, 999999), COALESCE(ohlc_data.low, 999999)),
       close = COALESCE(EXCLUDED.close, ohlc_data.close),
       source = EXCLUDED.source,
       fetched_at = NOW()`,
    [
      ticker,
      periodStart,
      open ?? null,
      high ?? null,
      low ?? null,
      close ?? null,
      source,
      interval,
    ],
  );
}

export async function readOhlcData(
  pool: Pool,
  ticker: string,
  startTime: Date,
  endTime: Date,
): Promise<OhlcCandle[]> {
  const res = await pool.query<{
    period_start: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    source: string;
  }>(
    `SELECT period_start, open, high, low, close, source
     FROM ohlc_data
     WHERE ticker = $1 AND period_start >= $2 AND period_start <= $3
     ORDER BY period_start ASC`,
    [ticker, startTime, endTime],
  );
  return res.rows.map((row) => ({
    periodStart: row.period_start.toISOString(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    source: row.source,
  }));
}

export async function bulkInsertOhlcData(
  pool: Pool,
  ticker: string,
  candles: Array<{ periodStart: Date; open: number | null; high: number | null; low: number | null; close: number | null }>,
  source: string,
  interval: string = '15m',
): Promise<number> {
  if (candles.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders = candles
    .map((candle, i) => {
      const base = i * 8;
      values.push(
        ticker,
        candle.periodStart,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        source,
        interval,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    })
    .join(', ');

  const res = await pool.query(
    `INSERT INTO ohlc_data (ticker, period_start, open, high, low, close, source, interval)
     VALUES ${placeholders}
     ON CONFLICT (ticker, period_start, interval) DO NOTHING`,
    values,
  );
  return res.rowCount ?? 0;
}

export interface OhlcIntervalStats {
  count: number;
  oldest: string | null;
  newest: string | null;
}

export interface OhlcTickerStats {
  [interval: string]: OhlcIntervalStats;
}

export interface OhlcStats {
  [ticker: string]: OhlcTickerStats;
}

export async function readOhlcStats(pool: Pool): Promise<OhlcStats> {
  const res = await pool.query<{
    ticker: string;
    interval: string;
    count: string;
    oldest: Date | null;
    newest: Date | null;
  }>(
    `SELECT ticker, interval, COUNT(*) AS count,
            MIN(period_start) AS oldest,
            MAX(period_start) AS newest
     FROM ohlc_data
     GROUP BY ticker, interval
     ORDER BY ticker, interval`,
  );
  const stats: OhlcStats = {};
  for (const row of res.rows) {
    if (!stats[row.ticker]) stats[row.ticker] = {};
    stats[row.ticker]![row.interval] = {
      count: Number(row.count),
      oldest: row.oldest ? row.oldest.toISOString() : null,
      newest: row.newest ? row.newest.toISOString() : null,
    };
  }
  return stats;
}

export async function purgeOldOhlcData(pool: Pool): Promise<number> {
  const now = new Date();
  const purgeAfter15m = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const purgeAfter1m = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `DELETE FROM ohlc_data
     WHERE (interval = '15m' AND period_start < $1) OR (interval = '1m' AND period_start < $2)`,
    [purgeAfter15m, purgeAfter1m],
  );
  return result.rowCount ?? 0;
}
