import type { Logger } from './log.js';
import { createHeartbeat, startBackgroundLoop } from './background-loop.js';
import type { Listing } from './ebay/seller.js';

export interface BackgroundListingPollOptions {
  // Returns the current listings array (already shaped by adaptive-seller +
  // listings cache). The single-flight on those layers means simultaneous
  // background-poll and on-demand snapshot fetches collapse to one upstream
  // call within a TTL window.
  fetchListings: () => Promise<Listing[]>;
  // Whatever the snapshot endpoint runs to enrich + persist + auto-reconcile
  // newly-ended items. The poll just hands off to this; nothing duplicated.
  process: (listings: Listing[]) => Promise<unknown>;
  log: Logger;
  intervalMs?: number;
}

// Continuously refresh eBay listings in the background, independent of any
// HTTP request, so bid changes and auction-end transitions land in the DB
// even when nobody is on the dashboard. ONLY runs on the always-on prod
// instance (gated by the caller) — dev and prod share the same database,
// so a second instance polling would just double upstream calls without
// adding coverage.
//
// Cadence: 30s by default = ~2,880 eBay Browse calls/day for one active
// seller, well under the 5,000/day free-tier cap. Single-flight protection
// on the underlying listings cache (DbBackedCache + adaptive-seller fetch)
// means an in-flight snapshot request can't double-poll alongside this.
const heartbeat = createHeartbeat();
// Heartbeat for /api/health: null when the poll has never run in this
// process (e.g. dev, where the poll is disabled because prod owns the DB).
export const getListingPollHeartbeat = heartbeat.get;

export function startBackgroundListingPoll(
  opts: BackgroundListingPollOptions,
): () => void {
  return startBackgroundLoop({
    name: 'background listing poll',
    log: opts.log.child({ component: 'listing-poll' }),
    intervalMs: opts.intervalMs ?? 30_000,
    heartbeat,
    tick: async () => {
      const listings = await opts.fetchListings();
      await opts.process(listings);
    },
  });
}
