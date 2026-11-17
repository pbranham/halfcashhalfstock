# Architecture reference

Module map, API budget, and cross-cutting patterns. Rules live in `/CLAUDE.md`;
setup, env vars, endpoints, schema live in `/README.md`.

## Layout

```
src/
  server.ts                  HTTP, routes, request-stats wiring, graceful shutdown
  config.ts                  zod env schema; resolveEbayTradingUserToken / has*Credentials helpers
  cache.ts                   TtlCache + DbBackedCache (single-flight, stale-fallback, U+0000 strip)
  log.ts                     Logger
  snapshot.ts                composeSnapshot — listings + price + math + totals + galleries
  ticker-queue.ts            stock OHLC scheduler with request-windowed scoping
  request-stats.ts           privacy-respecting metrics + UA classifier + sessions
  math.ts                    pure half/half split
  anon.ts                    maskBidder: public bidder-name masking at the API boundary
  seller-poll.ts             createAdaptiveSellerFetch: sleep sellers with 0 listings
  item-details-enricher.ts   fire-and-forget gallery + description backfill
  reconcile-finals.ts        reconcileFinalsForItems: GetItem → updateEndedListingFinals
  listing-poll.ts            startBackgroundListingPoll: always-on 30s loop (prod only)
  feedback-sweep.ts          hourly GetFeedback sweep → feedback table (prod only)
  ohlc-refresh.ts            startDailyOhlcRefresh: daily 1d-OHLC pull from Yahoo (any env w/ DB)
  db/
    pool.ts                  pg.Pool factory
    migrate.ts               filesystem-driven migration runner (atomic per file)
    persist.ts               every DB read/write the app does
  ebay/
    auth.ts                  Browse API OAuth client_credentials, cached
    client.ts                generic Browse API HTTP wrapper
    seller.ts                listSellerActiveItems → normalized Listing[]; upgradeEbayImageUrl
    item-details.ts          fetchItemDetails → gallery + description per item
    trading.ts               GetAllBidders + GetItem + GetFeedback XML clients
    bid-history.ts           fetchBidHistory: DB-first, Trading API fallback, DB final fallback
    viewbids.ts              public bid-history page scraper + parser (current path)
  prices/
    finnhub.ts, provider.ts, types.ts   Finnhub-only quote chain
    yahoo.ts                 getHistoricalCandles ONLY (quote endpoint dead; see `docs/dead-ends.md`)
public/
  index.html  app.js         dashboard (active + recently ended)
  item.html   item.js        per-item audit page (gallery + description iframe)
  admin.html  admin.js       admin dashboard + maintenance actions
  carousel.js                attachCyclingCarousel: shared clone-pad cycling track
  lightbox.js                openImageLightbox: shared fullscreen modal
  *.css       theme-init.js
test/
  roughly one *.test.ts per src/ module (not client.ts, bid-history.ts, db/migrate.ts,
  db/pool.ts); vitest, no jsdom
migrations/  NNN_*.sql, applied in order, recorded in `_migrations` table
```

## API budget

eBay Browse free tier is **~5,000 calls/day**. Several things keep us
comfortably under it:

- **Background listing poll** (`startBackgroundListingPoll`): runs on a
  30s interval, independent of HTTP requests, so bids and auction-end
  transitions land in the DB even at 3am with nobody on the dashboard.
  Gated on `APP_ENVIRONMENT === 'prod'` because dev and prod share the
  same database — a second instance polling would double upstream calls
  without adding coverage. Single-flighted (skips when prior tick is
  still in-flight). Baseline cost at 30s: `1 active seller × 1 call / 30s
  = 2,880 calls/day`. Bumping the cadence to 20s = 4,320/day (still
  safe); 15s = 5,760/day (over budget).
- **Adaptive seller polling** (`createAdaptiveSellerFetch`): a seller that
  comes back with zero active listings is skipped for 30 min before we
  check again. With Ryan currently dormant, the background loop costs ~1
  call per tick instead of N-sellers calls per tick.
- **Ticker queue scoping** (`TickerQueue`): the passive price-poll refreshes
  only EBAY + GME forever, plus any custom ticker viewed within the last
  30 min. Custom tickers age out so we don't hammer Finnhub for every
  symbol ever typed into the dropdown. "By seller" mode (`?symbol=MIXED`)
  fetches both EBAY + GME per snapshot, but both are already always-warm,
  so it adds no Finnhub cost beyond what single-ticker viewing already
  incurs (and `fetchQuote` is itself cached per symbol).
- **Per-item details enrichment** (`createItemDetailsEnricher`): the per-
  item Browse `/item/{id}` call (gallery + description) runs only for rows
  missing details OR older than 7 days, concurrency capped at 4. After the
  initial backfill it amortises to near-zero/day.
- **`/api/ohlc-history`** (The Other Half performance chart) hits no eBay
  or Finnhub upstream at all — it reads only the retained 1d OHLC rows from
  Postgres, is cached ~1h, and is fetched once per page load. Zero external
  API cost. The 1d rows themselves are kept current by `startDailyOhlcRefresh`
  — a **daily** Yahoo `getHistoricalCandles('1d')` pull for the seller
  tickers (≈2 calls/day/env), entirely separate from the eBay Browse quota.

Remaining headroom (~2,000 calls/day under the 5,000 cap at the current
30s cadence) is intentional — reserved for a future last-60s endgame
burst path on actively-closing auctions, plus normal user-driven Browse
hits when the snapshot cache misses.

## Useful patterns already in code

- Adaptive seller polling and ticker-queue scoping: see "API budget" above
  (tests: `test/seller-poll.test.ts`, `test/ticker-queue.test.ts`).
- **Stale-fallback in `DbBackedCache`**: when a live fetch fails and the DB
  has a past-TTL row, we serve the stale row and set `degraded=true`. The
  snapshot endpoint surfaces that as `snapshot.degraded` so the frontend
  shows an amber banner instead of zeroes.
- **Null-byte sanitization in cache writes** (`storeDb`): strips `\u0000`
  escapes before JSONB insert — Postgres JSONB rejects the whole document
  if any string contains one, even though RFC 8259 permits them. Tripped
  on an eBay title; regression-tested.
- **Defensive math at the snapshot boundary** (`isSplittablePrice`):
  every `splitHalfCashHalfStock` call goes through a `Number.isFinite +
  non-negative` predicate so a malformed cached payload or unexpected
  Browse API shape doesn't 503 the snapshot. Bad-priced rows just show
  "—".
- **Hi-res images everywhere** (`upgradeEbayImageUrl`): every eBay CDN
  URL goes through a `s-l<N>` token bump to `s-l1600` server-side (in
  `normalizeListing` + `fetchItemDetails`) and also at render time in
  `app.js` / `item.js` (covers ended rows persisted with a small URL
  before the upgrade landed).
- **Stuck-listing recovery**: `markEndedListings` stamps any listing not
  seen in the active poll for >1 hour as ended. The "Find stuck" admin
  button surfaces listings where this auto-recovery missed.
- **`inspect_bid_history` admin action** shows raw Trading API output side
  by side with DB state — useful diagnostic even though the API itself is
  broken for us.
- **Snapshot dedup**: `insertListingSnapshotIfChanged` skips identical
  consecutive rows so the history table stays compact.
- **DB-first reads**: `bid-history.ts` and `DbBackedCache` always check
  Postgres before any upstream call — minimizes API quota and works across
  multiple Render instances.
