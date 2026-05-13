import type { Pool } from 'pg';
import type { Logger } from '../log.js';
import { getItemBidHistory } from './trading.js';
import { insertBids } from '../db/persist.js';

const BACKFILL_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5;

export interface BackfillResult {
  attempted: number;
  backfilled: number;
  failed: number;
  bidsInserted: number;
  pricesUpdated: number;
}

export async function backfillEndedListings(
  pool: Pool,
  devId: string,
  userToken: string,
  log: Logger,
): Promise<BackfillResult> {
  const cutoff = new Date(Date.now() - BACKFILL_DELAY_MS);
  const result = await pool.query<{
    item_id: string;
    current_price_usd: string;
    current_bid_count: number;
  }>(
    `SELECT item_id, current_price_usd, current_bid_count
     FROM listings
     WHERE ended_at IS NOT NULL
       AND ended_at < $1
       AND last_backfilled_at IS NULL
       AND backfill_attempts < $2
     ORDER BY ended_at DESC
     LIMIT $3`,
    [cutoff, MAX_ATTEMPTS, BATCH_SIZE],
  );

  let backfilled = 0;
  let failed = 0;
  let bidsInserted = 0;
  let pricesUpdated = 0;

  for (const row of result.rows) {
    try {
      const history = await getItemBidHistory(row.item_id, devId, userToken);
      const inserted = history.bids.length > 0
        ? await insertBids(pool, row.item_id, history.bids)
        : 0;
      bidsInserted += inserted;

      const apiPrice = history.currentPrice;
      const dbPrice = Number(row.current_price_usd);
      if (apiPrice > dbPrice) {
        await pool.query(
          `UPDATE listings
           SET current_price_usd = $1
           WHERE item_id = $2`,
          [apiPrice, row.item_id],
        );
        pricesUpdated += 1;
      }

      await pool.query(
        'UPDATE listings SET last_backfilled_at = NOW() WHERE item_id = $1',
        [row.item_id],
      );

      log.info('backfilled ended listing', {
        itemId: row.item_id,
        bidsInserted: inserted,
        finalPrice: apiPrice,
        priceUpdated: apiPrice > dbPrice,
      });
      backfilled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('backfill failed', { itemId: row.item_id, error: message });
      await pool.query(
        'UPDATE listings SET backfill_attempts = backfill_attempts + 1 WHERE item_id = $1',
        [row.item_id],
      );
      failed += 1;
    }
  }

  return {
    attempted: result.rows.length,
    backfilled,
    failed,
    bidsInserted,
    pricesUpdated,
  };
}
