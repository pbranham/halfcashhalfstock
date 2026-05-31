import type { Pool } from 'pg';
import type { Logger } from './log.js';
import { fetchItemDetails } from './ebay/item-details.js';
import type { EbayClient } from './ebay/client.js';
import { readListingsMissingDetails, upsertItemDetails } from './db/persist.js';

// The enricher only needs itemId + primary image URL (the latter for the
// per-item details fetch's dedupe). Both active Listings and EndedListingRows
// satisfy this shape, so the caller can pass either or both.
export interface EnrichmentTarget {
  itemId: string;
  imageUrl: string | null;
}

export interface ItemDetailsEnricherOptions {
  pool: Pool;
  client: EbayClient;
  log: Logger;
  // Treat a row as "needs re-fetch" once its details_fetched_at is older than
  // this. Item galleries and descriptions almost never change once a listing
  // is up, so the default leans long. Default 7 days.
  staleAfterMs?: number;
  // Cap the concurrent Browse /item calls. Per-item details aren't urgent
  // (they don't block any user-visible response), so we keep the burst small
  // to stay friendly with eBay's per-call rate. Default 4.
  concurrency?: number;
}

// Single-flight gate so a re-entrant call during the same tick (snapshot
// served, fire-and-forget enrich, snapshot served again) doesn't kick off
// duplicate work. One enrich pass at a time per process.
let inflight: Promise<void> | null = null;

export function createItemDetailsEnricher(opts: ItemDetailsEnricherOptions) {
  const staleAfterMs = opts.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  // Best-effort, fire-and-forget. Given some target listings (active or
  // ended), fetch details for the ones missing them (or stale) and persist.
  // Never throws — the caller (snapshot endpoint) doesn't await the result,
  // so an error here would otherwise be an unhandledRejection.
  return function enrich(targets: readonly EnrichmentTarget[]): void {
    if (inflight) return;
    inflight = (async () => {
      try {
        const candidates = targets.map((t) => t.itemId);
        const missingIds = await readListingsMissingDetails(opts.pool, candidates, staleAfterMs);
        if (missingIds.length === 0) return;

        // Index the source targets so we can pass the primary image URL
        // through to the fetch (used for dedupe).
        const byId = new Map(targets.map((t) => [t.itemId, t]));

        let idx = 0;
        const worker = async (): Promise<void> => {
          while (idx < missingIds.length) {
            const itemId = missingIds[idx++]!;
            const primary = byId.get(itemId)?.imageUrl ?? null;
            try {
              const details = await fetchItemDetails(opts.client, itemId, primary);
              if (details === null) {
                // 404 from eBay (or 410 / similar terminal status) — persist
                // an empty details row so we don't re-attempt every snapshot.
                // The staleness window still applies, so we'll re-check
                // eventually. Common for older ended auctions where eBay
                // has dropped the per-item endpoint.
                await upsertItemDetails(opts.pool, {
                  itemId,
                  additionalImages: [],
                  descriptionHtml: null,
                });
                continue;
              }
              await upsertItemDetails(opts.pool, {
                itemId,
                additionalImages: details.additionalImages,
                descriptionHtml: details.descriptionHtml,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              opts.log.warn('item details fetch failed', { itemId, error: message });
              // Skip persisting — the next pass will retry. (We don't stamp
              // a "tried" timestamp here, on purpose; failures shouldn't
              // count against the staleness window.)
            }
          }
        };

        const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker);
        await Promise.all(workers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.log.warn('item details enrichment pass failed', { error: message });
      } finally {
        inflight = null;
      }
    })();
  };
}

// Test-only: reset the module-scope in-flight gate so each test runs from a
// clean slate. Production code never calls this.
export function _resetInflightForTests(): void {
  inflight = null;
}
