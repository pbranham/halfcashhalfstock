import type { Listing } from './ebay/seller.js';

export interface AdaptiveSellerFetchOptions {
  sellerIds: readonly string[];
  // Fetch one seller's active listings. Expected to be cached upstream (the
  // server wraps the per-seller Browse call in the listing cache), so this
  // helper only decides *whether* to call it, not how to cache the result.
  fetchOne: (sellerId: string) => Promise<Listing[]>;
  // How long a seller that returned zero active listings is left "asleep" —
  // skipped on every poll, contributing no listings — before we check again.
  // Default 30 min. Sellers with at least one listing are always polled at
  // the normal (fast) cadence.
  idleTtlMs?: number;
  now?: () => number;
}

// Build a fetchListings() that adapts per-seller polling frequency to whether
// the seller currently has any active listings. A seller with live auctions
// is polled every call (the caller's fast cadence); a seller that comes back
// empty (e.g. Ryan, whose auctions have all ended) is skipped for idleTtlMs
// so we don't spend an eBay Browse call every 30s confirming "still nothing".
// This keeps us well under eBay's free daily quota without delaying data for
// sellers who are actually active.
export function createAdaptiveSellerFetch(
  opts: AdaptiveSellerFetchOptions,
): () => Promise<Listing[]> {
  const idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  // sellerId -> timestamp until which the seller is treated as asleep.
  const idleUntil = new Map<string, number>();

  return async () => {
    const t = now();
    const perSeller = await Promise.all(
      opts.sellerIds.map(async (sellerId) => {
        if (t < (idleUntil.get(sellerId) ?? 0)) return [] as Listing[];
        const items = await opts.fetchOne(sellerId);
        if (items.length === 0) idleUntil.set(sellerId, t + idleTtlMs);
        else idleUntil.delete(sellerId);
        return items;
      }),
    );
    return perSeller.flat();
  };
}
