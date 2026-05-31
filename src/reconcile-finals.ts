import type { Pool } from 'pg';
import type { Logger } from './log.js';
import { getItemSellingStatus } from './ebay/trading.js';
import { updateEndedListingFinals } from './db/persist.js';

export interface ReconcileFinalsOptions {
  pool: Pool;
  userToken: string;
  itemIds: readonly string[];
  log: Logger;
  // Cap to bound a single pass — prevents a backlog of newly-ended items
  // (e.g. after a restart) from firing dozens of Trading API calls in one go.
  // Default 20.
  maxItems?: number;
}

export interface ReconcileFinalsResult {
  itemId: string;
  // What the Trading API said. null when the call threw before returning.
  apiPrice: number | null;
  apiBidCount: number | null;
  listingStatus: string | null;
  // Action taken: 'updated' = wrote new finals; 'no-op' = eligible but
  // numbers matched; 'skip' = ineligible (status, currency, Ack); 'error'
  // = the API call or DB write threw.
  outcome: 'updated' | 'no-op' | 'skip' | 'error';
  reason?: string;
}

// Pull the authoritative final price + bid count from GetItem for each
// itemId and write it onto the listings row (only when the row is already
// marked ended). Best-effort, never throws — failures are logged and the
// pass continues. Mirrors the dry-run-then-apply admin action but runs
// unconditionally as "apply" because the caller is the post-close hook,
// not the human-triggered audit button.
export async function reconcileFinalsForItems(
  opts: ReconcileFinalsOptions,
): Promise<ReconcileFinalsResult[]> {
  const max = opts.maxItems ?? 20;
  const targets = opts.itemIds.slice(0, max);
  const results: ReconcileFinalsResult[] = [];

  for (const itemId of targets) {
    try {
      const ss = await getItemSellingStatus(itemId, opts.userToken);
      const closed = ss.listingStatus === 'Completed' || ss.listingStatus === 'Ended';
      const usd = ss.currencyId === null || ss.currencyId === 'USD';
      const priceOk = Number.isFinite(ss.currentPrice) && ss.currentPrice > 0;
      const eligible = ss.ack !== 'Failure' && closed && usd && priceOk;
      if (!eligible) {
        results.push({
          itemId,
          apiPrice: ss.currentPrice,
          apiBidCount: ss.bidCount,
          listingStatus: ss.listingStatus,
          outcome: 'skip',
          reason: ss.ack === 'Failure'
            ? `ack=Failure: ${ss.errorMessage ?? 'unknown'}`
            : !closed
              ? `listingStatus=${ss.listingStatus ?? 'null'}`
              : !usd
                ? `currency=${ss.currencyId ?? 'null'}`
                : `price=${ss.currentPrice}`,
        });
        continue;
      }
      const wrote = await updateEndedListingFinals(
        opts.pool,
        itemId,
        ss.currentPrice,
        ss.bidCount,
      );
      results.push({
        itemId,
        apiPrice: ss.currentPrice,
        apiBidCount: ss.bidCount,
        listingStatus: ss.listingStatus,
        outcome: wrote ? 'updated' : 'no-op',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.log.warn('reconcile finals failed', { itemId, error: reason });
      results.push({
        itemId,
        apiPrice: null,
        apiBidCount: null,
        listingStatus: null,
        outcome: 'error',
        reason,
      });
    }
  }
  return results;
}
