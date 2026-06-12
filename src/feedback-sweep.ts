import type { Pool } from 'pg';
import type { Logger } from './log.js';
import { getFeedbackPage, type FeedbackEntry } from './ebay/trading.js';
import { readNumericToCanonicalIdMap, upsertFeedback, type FeedbackRow } from './db/persist.js';

// Pages per seller per sweep. 200 entries/page; both sellers have well under
// 400 feedback events in any 90-day window, so 5 pages is a generous ceiling
// that still bounds a runaway pagination loop.
const MAX_PAGES = 5;

export interface FeedbackSweepResult {
  seller: string;
  fetched: number;
  mapped: number;
  inserted: number;
  ack: string | null;
  error: string | null;
}

// One sweep pass: pull feedback for each seller, keep entries that map to a
// listing we track, persist idempotently. Never throws — per-seller failures
// are reported in the result row and the pass continues. The FIRST seller in
// `sellerIds` is the Trading-token owner and is queried without a UserID
// (own feedback, full detail guaranteed); the rest are queried by UserID,
// which returns whatever eBay deems public — possibly nothing. That outcome
// is recorded, not raised.
export async function sweepFeedbackOnce(opts: {
  pool: Pool;
  userToken: string;
  sellerIds: readonly string[];
  log: Logger;
  // When false, fetch + map but skip the DB write (admin dry-run).
  persist?: boolean;
}): Promise<{ results: FeedbackSweepResult[]; sample: FeedbackRow[] }> {
  const persist = opts.persist ?? true;
  const idMap = await readNumericToCanonicalIdMap(opts.pool);
  const results: FeedbackSweepResult[] = [];
  const sample: FeedbackRow[] = [];

  for (let i = 0; i < opts.sellerIds.length; i++) {
    const seller = opts.sellerIds[i]!;
    const isTokenOwner = i === 0;
    let fetched = 0;
    let ack: string | null = null;
    let error: string | null = null;
    const mappedRows: FeedbackRow[] = [];

    try {
      let page = 1;
      let totalPages = 1;
      while (page <= Math.min(totalPages, MAX_PAGES)) {
        const res = await getFeedbackPage(
          opts.userToken,
          isTokenOwner ? { page } : { userId: seller, page },
        );
        ack = res.ack;
        error = res.errorMessage;
        totalPages = res.totalPages;
        fetched += res.entries.length;
        for (const e of res.entries) {
          const row = toRow(e, idMap);
          if (row) mappedRows.push(row);
        }
        if (res.ack === 'Failure') break;
        page += 1;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      opts.log.warn('feedback sweep fetch failed', { seller, error });
    }

    let inserted = 0;
    if (persist && mappedRows.length > 0) {
      try {
        inserted = await upsertFeedback(opts.pool, mappedRows);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        opts.log.warn('feedback sweep persist failed', { seller, error });
      }
    }

    sample.push(...mappedRows.slice(0, 20));
    results.push({ seller, fetched, mapped: mappedRows.length, inserted, ack, error });
  }

  return { results, sample };
}

function toRow(e: FeedbackEntry, idMap: Map<string, string>): FeedbackRow | null {
  // Only feedback the seller RECEIVED (buyer commenting on the sale). When
  // eBay omits Role we keep the entry — FeedbackReceivedAsSeller was already
  // requested, so unknown-role rows are far more likely ours than not.
  if (e.role && e.role !== 'Seller') return null;
  if (!e.commentTime) return null; // can't dedupe without a timestamp
  const canonical = idMap.get(e.itemId);
  if (!canonical) return null; // feedback for an item we don't track
  return {
    itemId: canonical,
    commentingUser: e.commentingUser,
    commentType: e.commentType,
    commentText: e.commentText,
    commentTime: e.commentTime,
  };
}

// Hourly background sweep, prod-gated by the caller (dev and prod share the
// database — a second sweeper would double Trading calls without adding
// coverage). Mirrors startBackgroundListingPoll: immediate first tick,
// single-flight, survives tick errors, returns a stop function.
// Heartbeat for /api/health — last completed sweep tick (ms epoch), null
// if the sweep has never run in this process.
let lastSweepAt: number | null = null;
export function getFeedbackSweepHeartbeat(): number | null {
  return lastSweepAt;
}

export function startFeedbackSweep(opts: {
  pool: Pool;
  userToken: string;
  sellerIds: readonly string[];
  log: Logger;
  intervalMs?: number;
}): () => void {
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const log = opts.log.child({ component: 'feedback-sweep' });
  let stopping = false;
  let inflight = false;

  const tick = async (): Promise<void> => {
    if (stopping || inflight) return;
    inflight = true;
    try {
      const { results } = await sweepFeedbackOnce({
        pool: opts.pool,
        userToken: opts.userToken,
        sellerIds: opts.sellerIds,
        log,
      });
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      if (inserted > 0 || results.some((r) => r.error)) {
        log.info('feedback sweep', { results });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('feedback sweep cycle failed', { error: message });
    } finally {
      lastSweepAt = Date.now();
      inflight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  log.info('feedback sweep started', { intervalMs, sellers: opts.sellerIds });

  return () => {
    stopping = true;
    clearInterval(timer);
    log.info('feedback sweep stopped');
  };
}
