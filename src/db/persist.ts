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
     ON CONFLICT (ticker, period_start) DO NOTHING`,
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
