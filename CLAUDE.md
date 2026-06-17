# CLAUDE.md

Context for Claude sessions on this repo. README.md covers setup, deploy, and
config — this file covers what a returning session needs to be productive
without re-discovering everything.

## What this project is

A Node 20 / TypeScript / Express + Postgres app that monitors **multiple eBay
seller accounts** (`boilerpaulie` + `ryan_5050` by default; configurable via
`EBAY_SELLER_IDS`) and converts each live auction bid into a "half cash + half
EBAY stock" equivalent at the live market price. The dashboard has a seller
filter (`[All] [Mine] [Ryan]`), a per-card seller badge, a stock control
(`[By seller] [$EBAY] [$GME]` + custom) where **By seller** values each
seller's auctions in their own paired stock (Ryan→$EBAY, mine→$GME) and shows
both live prices, and a `[Live] [At auction end]` toggle on the ended-auctions
section that revalues each closed auction using the stock close at the moment
it ended. Per-card image
carousels + a click-to-zoom lightbox surface every gallery photo each listing
carries; the item-audit page also renders the seller's HTML description in a
sandboxed iframe.

Ryan's original 36 auctions all ended in early May 2026 and are still shown
in the ended-section; my own (boilerpaulie) auctions started rolling in late
May. As of late May 2026, Ryan has zero active listings — the adaptive seller
poll (see "Useful patterns") puts him to sleep for 30 min between checks, so
the active API budget is effectively one seller most of the time.

Production: https://halfcashhalfstock.onrender.com — Dev:
https://halfcashhalfstock-dev.onrender.com (deploys from
`claude/ebay-auction-monitor-vdOMZ`).

## Stack at a glance

- Node 20, TypeScript strict, ESM (`"type":"module"`, `.js` import specifiers).
- Express + Helmet (strict CSP, no inline scripts; explicit `frame-src 'self'`
  for the description iframe) + express-rate-limit.
- Postgres via `pg` Pool. Migrations in `migrations/NNN_*.sql` run sequentially
  on startup by `src/db/migrate.ts`; latest is `017_feedback`.
- Vanilla static frontend in `public/` — no bundler, no CDNs. Browser-native
  ESM modules (`<script type="module">`) for `app.js`/`item.js`; those import
  `carousel.js` + `lightbox.js`.
- Vitest for tests (currently **191**). ESLint + Prettier for lint/format.
- `fast-xml-parser` (Trading API XML); no HTML parser dep (regex in
  `viewbids.ts`).
- Render hosts both web service and Postgres. Local dev works without DB
  (graceful degradation).

## Documentation upkeep — read this first

**CLAUDE.md is part of every feature commit's contract.** A commit that
does any of the following MUST update this file in the same commit, not
"later":

- Adds, removes, or renames a source module / public asset / migration
- Adds an env var, DB column, admin action, API endpoint, or
  `localStorage` key
- Changes a documented behaviour, convention, or invariant
- Materially changes architecture (new background pass, new caching
  layer, new external dependency, replaced library)

Common edit targets when shipping a feature: the **Layout** block, the
relevant **prose section** (or a new one), the **Environment** list, the
**UI persistence** list, the **API budget** numbers, and the **test
count** in "Stack at a glance".

Smaller commits — bug fixes inside an existing module, UI tweaks that
don't change conventions — generally don't need doc updates.

When in doubt, ask: "would a returning Claude session reading just this
file get confused or make wrong assumptions about what I shipped?" If
yes, update the doc.

This rule exists because the doc has drifted before and the cost of
re-discovering current state from git history is high. Don't let it
drift again.

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
    yahoo.ts                 getHistoricalCandles ONLY (quote endpoint dead; see "Dead code")
public/
  index.html  app.js         dashboard (active + recently ended)
  item.html   item.js        per-item audit page (gallery + description iframe)
  admin.html  admin.js       admin dashboard + maintenance actions
  carousel.js                attachCyclingCarousel: shared clone-pad cycling track
  lightbox.js                openImageLightbox: shared fullscreen modal
  *.css       theme-init.js
test/
  one *.test.ts per src/ module; vitest, no jsdom
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

## Conventions that bit us

- **eBay item IDs come in `v1|<numeric>|0` format** from Browse API. The
  numeric portion is what `/itm/<id>` and `/bfl/viewbids/<id>` URLs need. Use
  `normalizeTradingItemId` (exported from `src/ebay/trading.ts`).
- **All admin actions go through one endpoint**: `POST /api/admin/cleanup`
  with `{action: 'xxx', ...}` body, gated by `ADMIN_TOKEN` env var. New
  features add a new action branch, NOT a new route.
- **Global JSON limit is 10kb**, but the cleanup route has a route-scoped
  4mb parser so pasted eBay pages fit. The global parser explicitly skips
  `/api/admin/cleanup` to avoid clashing.
- **Item ID validation regex**: `/^[A-Za-z0-9|.-]{1,64}$/` — reuse this for
  any new admin action that takes an itemId.
- **Public JS is vanilla ESM + CSP-strict**: no inline scripts, no eval, no
  CDNs. New behavior goes in an existing `public/*.js` file or a new module
  imported via `<script type="module">`. `frame-src 'self'` is the one CSP
  exception we needed — for the description iframe.
- **Tests mock fetch with `vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(...))`**.
  See `test/ebay.trading.test.ts` for the pattern.
- **Tests mock pg with a `MockPool`** — `{ query: vi.fn().mockResolvedValue({rows:[], rowCount:0}) }`.
  For transactional code use a client mock too:
  `pool.connect()` → `{ query, release: vi.fn() }`. See `test/db.persist.test.ts`.
- **Commits**: scoped style (`feat(admin):`, `fix(viewbids):`, etc), 1-2 sentence
  "why" body, HEREDOC, footer `https://claude.ai/code/session_...`. See
  recent log for examples.
- **Branch**: develop on `claude/ebay-auction-monitor-vdOMZ`. PRs are opened
  per coherent change (the long-running-draft pattern was abandoned around
  PR #22); keep PRs scoped and merge them when CI is green.

## Live-environment limitations

- The Claude sandbox **blocks all outbound HTTP** (even no-auth /healthz).
  All eBay/Finnhub/Yahoo verification must happen on the deployed dev site.
- The Render dev IP is a datacenter; eBay typically returns a 200 "Pardon
  Our Interruption" challenge page for `/bfl/viewbids/*` from this IP, so
  the reconcile loop falls back to paste mode for nearly every item.

## Multi-seller dashboard (PR #19)

The dashboard polls `config.sellerIds` (parsed from `EBAY_SELLER_IDS`, with
the legacy `EBAY_SELLER_ID` accepted as a fallback). Each fetched listing
carries a `sellerId` that's persisted on `listings.seller_id` and exposed in
both the active and ended snapshot views.

Frontend behaviour:

- `[All] [Mine] [Ryan]` pills above the controls bar — filter persisted in
  `localStorage.hchs.sellerFilter`. The active filter drives the active list,
  the ended list, both totals cards, and the "most recent bid" widget — all
  re-aggregated client-side from the filtered subset.
- **0-bid ended auctions are hidden from the ended list** — they didn't
  clear, so they're non-events that just clutter the display. The dollar
  totals already exclude them server-side (`composeSnapshot`'s
  `endedPriced` filter); the visible-list filter is in `renderFilteredView`
  (`(i.finalBidCount ?? 0) > 0`). They're still in the snapshot payload
  for any future "include unsold" toggle.
- Per-card `@sellerId` chip next to the Auction/Ended tag with seller-specific
  colors (`.seller-badge-mine` / `.seller-badge-ryan`).
- Sort selection is shared by active and ended lists. For ended, `price-low`
  / `price-high` use `finalPriceUsd`, `most-bids` uses `finalBidCount`, and
  `ending-soonest` / `recent-bid-activity` fall back to most-recently-ended.

If you add a third seller later, update both `EBAY_SELLER_IDS` and the
hard-coded `SELLER_PILL_TO_ID` map at the top of `public/app.js` — and add a
new `.seller-badge-<id>` color in `style.css`.

## End-time stock-price toggle (PR #19)

Ended-section header has a `[Live] [At auction end]` segmented control.
Persisted in `localStorage.hchs.endedPriceMode`. When "At auction end" is on:

- Each ended item's split is recomputed using the stock close nearest the
  item's `endedAt`.
- The ended totals row sums the per-item end-time splits and surfaces a
  "Missing end-time price" stat whenever `pricedAtEndCount < listingsCount`.

Data path:

- `getClosingPriceAt(pool, ticker, when)` in `db/persist.ts` picks the row
  with the largest `period_start <= when`, tie-breaking on interval
  preference `1m > 15m > 1d`. Returns null when no row covers `when`.
- The snapshot endpoint calls it for every USD-denominated ended item against
  the currently-selected ticker, builds a `Map<itemId, close|null>`, and
  passes it to `composeSnapshot` (5th arg now; the 6th is the
  `additionalImagesByItemId` map used by the gallery feature).
- The OHLC table's `interval='1d'` rows are exempt from `purgeOldOhlcData`,
  so daily history accumulates indefinitely. Populate it via the
  `backfill_ohlc_history` admin action (defaults: tickers `EBAY,GME`, range
  `90d`). The action calls `YahooProvider.getHistoricalCandles(ticker, '1d',
  range)` and bulk-upserts the candles. Re-runnable; idempotent.

For an auction that ended during market hours, finer-grain candles (if still
within retention) give a more accurate price; for older auctions only the
daily close at market open exists, which is good enough for the visualization.

## The Other Half (brokerage; Phase 4 + "The Other Half" v2)

Dashboard section between Totals and the most-recent-bid widget — the
site's core hypothetical, resolved: if every winning buyer had really
paid half in stock at the close-of-auction price, here's how that **other
half** is doing today. (Was "The Imaginary Brokerage"; renamed per owner.
Full roadmap for the v2 evolution — performance chart, item-level P&L,
item-page conversion chart — in `~/.claude/plans/the-other-half.md`.)

**Model:** ONE position per stock, made of **lots** grouped by the day
auctions ended (tax-lot style); each lot is funded by the auction items
whose thumbnails sit beneath it. Items are lots/auctions, NOT "positions".
Decisions locked: track **stock value only** (cash half deferred);
**ended-only** (active auctions are a future "pending" callout); eBay
fees + payout lag are out of scope.

**Enable toggle:** the section header carries a Hide/Show button
(`#brokerage-toggle`, mirrors the ended section). `otherHalfEnabled` is
persisted in `localStorage.hchs.otherHalf` (`on`/`off`, default on) and
collapses/expands `#brokerage-body` via `applyOtherHalfEnabled()`. (Phase
3 will also gate per-item P&L on ended cards off this flag.) The slim
header stays visible when collapsed so it's re-enableable.

- Pure frontend transform of data already on the snapshot:
  `aggregateBrokerage(endedItems, priceForTicker, tickerOrder)` in `app.js`
  marks each sold item's `endTimeSplit` (shares + stock-half dollars at its
  end-time close) to the live price of its `valuationTicker`. No new data.
  Returns `{ positions, byTicker, total, excludedCount }`: `byTicker` is a
  per-stock rollup (each stock's own cost/worth/P&L + `sellers` + `lots`,
  ordered by `tickerOrder`), `total` the USD composite. `withPnl(base,
  cost, worth)` attaches `pnl`/`pnlPct`; `buildLots(positions)` groups a
  stock's items into day-lots (most recent first). Positions preserve INPUT
  order, so `renderBrokerage` sorts `endedItems` by the page Sort pill (via
  `sortEndedItems`) before calling.
- Respects the seller filter + selected stock like everything else in
  `renderFilteredView`. Hidden entirely when no sold item has an
  end-time close or the price feed is down (no dashes-on-display).
- **One unified table** (`renderHoldings()` → `.brokerage-holdings`, a CSS
  grid; rows are `display:contents` so cells align). NOT a separate stats
  block + "Position detail" anymore — the lots roll into the holdings table:
  - Columns: **Stock/Date · Shares · Avg cost · Cost basis · Worth today ·
    Unrealized P&L** (`pnlNode` = ▲/▼ dollar amount with the % stacked
    directly beneath it, `.pnl` flex-column; colours in `.pnl-up`/`.pnl-down`).
  - Per stock: a **position row** (`.bh-pos`, bold) whose Stock cell is a
    disclosure button (`.pos-toggle`, caret + $TICKER + logo + @seller).
    Clicking collapses/expands that stock's lots; `collapsedPositions` (a
    module Set, default expanded) survives the 30s re-render and a toggle
    rebuilds just the table. A header **Expand all / Collapse all** button
    (`#brokerage-expand`, `syncExpandAllButton()`) toggles them en masse;
    shown only when enabled + 2+ stocks.
  - Under each (when expanded): its **day-lots** as `.bh-lot` sub-rows (date
    indented in the Stock column, same money columns), each followed by a
    `.lot-treemap-row` — a **squarified treemap** (`squarify()`,
    `lotTreemapRow()`) of the funding auctions where each tile's AREA ∝ that
    item's buying power (its half-stock $). Photos sit inside via
    `object-fit: contain` (whole photo, never cropped/stretched — owner's
    hard requirement); big-enough tiles caption the shares; tiny slices
    (< 2.5%) collapse into one `+N` tile. Tiles are positioned in % against
    the container's `aspect-ratio`, so it scales with width with no
    re-layout. A one-item lot shows a single `.tm-single` thumbnail instead.
    Each tile → item page. Lots are date-ordered, newest first. (Replaced the
    equal-size thumbnail strip — see `~/.claude/plans/the-other-half.md`;
    NEXT: per-position treemap when a position is collapsed.)
  - A composite **Total** row only when 2+ stocks (shares `—`). Full-width
    `.bh-sep` rules separate stock groups; `.bh-sep-strong` above Total.
  - Below 560px the grid reflows to stacked cards (data-label prefixes).
- Items lacking an end-time close are counted in a footnote. Head-to-head
  seller comparison was considered and CUT at the owner's request — don't
  add it back.
- **Performance chart (Phase 2)** above the table (`#brokerage-chart`): the
  stock-only portfolio value over time, with a **chart-type toggle** (top
  right: **area / % / candlestick**, persisted) and an **interactive
  legend** (Total + each stock, click to hide, persisted; hidden in
  candlestick mode). Pure client transform —
  `buildPerformanceSeries(positions, ohlcHistory, priceForTicker, now)` marks
  each lot's shares to the **daily bar** on every day since the earliest lot,
  producing per-stock component values, the total, running cost basis (Σ
  stock-halves), and a composite portfolio **OHLC candle** (shares-weighted
  combine of the stocks' bars — high/low are approximations), plus a final
  **live** point (no candle) so the last value matches "worth today".
  `renderPerformanceChart` draws an SVG (measured to container width, so a
  resize / section-expand / toggle re-renders via `lastPerfRender`):
  - **area** stacks the visible stock components, **proportional within a
    zoomed band** (NOT pinned to 0 — that compressed the variation when one
    stock dwarfs another) + an optional total outline;
  - **%** (a line of returns; total accent/red + per-stock component lines +
    lot markers + now dot) plots **return vs cost basis** (`ret = value/cost
    − 1`) against a flat 0% baseline + a `%` axis — so differently-sized
    stocks are comparable on one scale (`ret`/`compVal`/`scopePlotV` give the
    return; the 0-clamp is skipped so negatives show). (The absolute-$ "line"
    chart was REMOVED — it read poorly alone; % replaced it and a persisted
    `line` migrates to `pct`.)
  - **candlestick** draws composite portfolio candles (green/red), completed
    days only.
  Everything is **legend-scoped**: the y-domain, the dashed cost line, the
  scrub readout, and the now/value all reflect only the visible series (so
  isolating one small stock is readable, and the total-cost line can't drag
  the axis negative — `lo` is also clamped ≥ 0). `useTotal` = candlestick OR
  the Total chip on OR nothing selected. Each ticker legend chip shows its
  **close**, updating on hover. Hidden when <2 points
  of history (graceful when OHLC isn't backfilled). Bars come from **`GET
  /api/ohlc-history?tickers=EBAY,GME&days=N`** (server reads the retained 1d
  OHLC via `readDailyOhlc` → `{ ticker: [{t,o,h,l,c}] }`, cached ~1h); the
  dashboard fetches it once (`refreshOhlcHistory`) and reconstructs
  client-side, so the seller filter / mode toggle re-derive with no refetch.
  **Data:** 1d candles are kept current
  automatically by `startDailyOhlcRefresh` (`ohlc-refresh.ts`) — a daily
  Yahoo pull that excludes today's partial candle and runs on any env with a
  DB, with an immediate first tick so a deploy self-heals gaps. The
  `backfill_ohlc_history` admin action remains for an immediate fill or a
  longer seed range. (1d candles used to grow ONLY when someone clicked that
  button, which is why history could stall — fixed by the daily refresh.)
- **Pending callout** (`#brokerage-pending`): open (still-running) auctions
  aren't realized lots, so they sit OUTSIDE the position as a quiet line —
  total bids + the shares they'd buy at today's price if they closed now.
  Decision locked: ended-only for the position; this is the "pending" view.
- Decisions locked (see `~/.claude/plans/the-other-half.md`): **stock value
  only** (cash half deferred), **ended-only** lots, eBay fees + payout lag
  out of scope.

## "By seller" mixed valuation

Default stock mode for the **All** seller view: instead of valuing every
auction in one ticker, value each in its seller's paired stock — Ryan's
(`ryan_5050`) in **$EBAY**, mine (`boilerpaulie`) in **$GME** (the same
thematic pairing the seller-filter pill swap already used). A
`[By seller] [$EBAY] [$GME]` pill sits at the head of the stock control;
choosing a specific ticker overrides to single-stock for everyone (the
old behavior). The label is "By seller"; the wire/`localStorage` value is
`MIXED`.

- **Server**: `?symbol=MIXED` is handled in `/api/snapshot`. It bypasses
  ticker validation (MIXED isn't a real symbol), fetches a quote for every
  ticker in `mixedValuationTickers(config)` (= `[EBAY, GME]`, default stock
  first), and hands `composeSnapshot` a `ValuationContext`
  (`tickerForSeller` / `quoteForTicker` / `quotes`). Each item's `split`
  and `endTimeSplit` are then denominated in its seller ticker, and
  end-time OHLC closes are looked up per seller ticker (cache key is
  `${itemId}:${ticker}`). The seller→ticker map lives in `config.ts`
  (`resolveSellerTicker`, default `boilerpaulie:GME,ryan_5050:EBAY`,
  overridable via `EBAY_SELLER_TICKERS`).
- **Snapshot shape** (additive — existing single-ticker callers unaffected):
  every `ListingView`/`EndedListingView` carries `valuationTicker`; the
  snapshot root carries `stocks: PriceQuote[]` (one entry in single mode,
  two in mixed) and `valuationMode: 'single' | 'mixed'`. The rolled-up
  `totals.split.shares` mixes tickers in mixed mode and is NOT rendered —
  the dashboard regroups per-item by `valuationTicker`.
- **Dashboard**: the header shows one live price per stock
  (`.ticker-quotes`, inline on wide screens / stacked under 720px — owner's
  choice). The **Totals** "Half Stock" stat becomes one shares row per
  stock via `sharesCard`; cash/dollar figures stay single (USD is
  additive). The **brokerage** goes further — a full per-stock holdings
  table + composite Total + per-stock-grouped Statement (see The Imaginary
  Brokerage section). Each tile shows its seller stock's shares + logo
  (`splitBox(cash, shares, ticker)`; per-ticker logos built on the fly via
  `logoUrlFor(ticker)` since the proxy keys off `?symbol=`). The Totals
  aggregates (`aggregateActiveTotals`/`aggregateEndedTotals`) sum per-item
  splits grouped by ticker via `sumSplitsByTicker`.
- The **item page is unaffected** — it never read the dashboard's stored
  ticker, and each item belongs to exactly one seller (one stock) anyway.
- If you add a third seller, the pairing comes from `EBAY_SELLER_TICKERS`
  (or the default map); the header/totals/brokerage already render N stock
  rows, but the brokerage tagline hard-codes "$EBAY / $GME" copy — update
  it there.

## Per-item gallery + description (PR #26)

Each listing can carry up to 24 gallery images + an HTML description that
`item_summary/search` doesn't return. We backfill lazily.

- **`fetchItemDetails(client, itemId, primaryImageUrl)`** wraps Browse's
  per-item endpoint, upgrades all URLs to `s-l1600` (eBay's largest standard
  render size), and dedupes against the primary so render code can do
  `[primary, ...additional]` without doubling up. Returns null on 404;
  non-404 errors re-throw.
- **`createItemDetailsEnricher`** is fire-and-forget. Given the items in a
  snapshot (active + ended, as a thin `{itemId, imageUrl}[]` shape), it picks
  rows missing details OR older than 7 days, fetches with concurrency 4,
  persists via `upsertItemDetails`, and never throws. Single-flighted at
  module scope so re-entrant calls collapse to one in-flight pass. The
  snapshot endpoint kicks it after `readEndedListings` returns.
- Storage: three columns on `listings` (`additional_images jsonb`,
  `description_html text`, `details_fetched_at timestamptz`). A 404 from
  eBay persists an empty row so we don't re-attempt the missing item every
  snapshot (the 7-day staleness window still applies).

Frontend carousel:

- **`public/carousel.js`** — `attachCyclingCarousel(track, opts)` is the
  shared cycling-carousel helper, used by the inline tile galleries
  (`app.js`), the item-page header gallery (`item.js`), and the modal
  (`lightbox.js`). The clone-pad pattern (prepend last-image clone, append
  first-image clone) + a `scrollend`-driven warp handles infinite wrap-
  around for both swipe and button clicks. Both tracks use
  `scroll-behavior: smooth` in CSS, so the warp specifically toggles to
  `auto` to avoid the smooth scroll animating *through* every in-between
  slide (PR #26's last fix). Image count is a fixed-width `i / N` counter
  (eBay caps at 24 — dots overflow narrow tiles past ~8).
- **`public/lightbox.js`** — `openImageLightbox(urls, startIndex, alt,
  {onClose})` mounts a single persistent `.lightbox` div to `<body>` on
  first open. ESC / backdrop / × close; arrow keys flip slides; opens at
  the inline carousel's snapped index and reports the closing index back
  via `onClose` so the inline carousel re-syncs.
- **Description iframe**: `<iframe sandbox="" srcdoc="…">`. Empty sandbox =
  no scripts + opaque origin, so seller HTML can't reach the parent and the
  parent CSP doesn't restrict the iframe's own images/styles. CSP has
  explicit `frame-src 'self'` to permit mounting the about:srcdoc frame.

## Final price/bid-count reconcile via GetItem (Trading API)

**Distinct from the bid-history timeline below.** The dashboard's half/half
math only needs the *final price* and *bid count*, not the per-bid timeline.
Those two numbers are available authoritatively from the Trading API
`GetItem` call (`SellingStatus.CurrentPrice` + `BidCount`) for ANY item in
eBay's ~90-day window — own listings and others' — via `api.ebay.com`, which
is **not** subject to the "Pardon Our Interruption" datacenter-IP challenge
that blocks scraping the public viewbids page. So this path works
server-side, no paste required.

- `getItemSellingStatus(itemId, userToken)` in `src/ebay/trading.ts` —
  GetItem XML call; returns `{ listingStatus, currentPrice, currencyId,
  bidCount, ack, errorMessage }`. Does NOT return the bid timeline.
- `reconcileFinalsForItems({ pool, userToken, itemIds, log, maxItems? })`
  in `src/reconcile-finals.ts` — shared helper that calls GetItem for each
  item, applies the eligibility guards (Completed/Ended, USD, finite price
  > 0, Ack ≠ Failure), writes finals via `updateEndedListingFinals`, and
  never throws. Returns a per-item outcome (`updated` / `no-op` / `skip` /
  `error`). Used by both the post-close auto-pass (below) and the admin
  audit action.
- `updateEndedListingFinals(pool, itemId, priceUsd, bidCount)` in
  `db/persist.ts` — writes the finals, but only onto rows already marked
  ended (`ended_at IS NOT NULL`), so it can never clobber a live auction.
- Admin action `reconcile_selling_status` (`{ itemId?, apply? }`) —
  **DRY RUN by default**: reports DB-vs-eBay per ended item and writes
  nothing. Re-run with `apply:true` to persist. Only acts when the item is
  Completed/Ended, USD, price finite/>0, Ack≠Failure, and the value differs.
  Capped at 60 items/run. Admin UI has "Dry run" + "Apply" buttons.
- **Verified live** (PR #30): the dry-run reported every DB price already
  matched eBay (`$X → $X` across 45 items), confirming GetItem works for
  both own and others' listings. Bid counts diverged on heavy-bid items
  (DB count from viewbids parse was ~15 short of eBay's badge count);
  bid count is cosmetic vs the price math, so it's acceptable either
  way — applying GetItem's count brings DB closer to eBay's display
  without changing any dollar number.

### Auto post-close reconcile

Built on top of the same helper, fires inside the snapshot loader:

- `persistSnapshot` now returns `{ ..., justEnded: string[] }` — the
  itemIds it just stamped `ended_at` on this cycle. Two paths feed into
  it: `markEndedListings` (item not in active poll AND past its end or
  unseen for >1h) and `markPastEndDateAsEnded` (item still in Browse
  search but its `ends_at` is in the past — covers eBay keeping ended
  items active for several minutes post-close).
- `enrichWithBidHistory` chains a `.then` after `persistSnapshot` that
  calls `reconcileFinalsForItems` on `justEnded`. Fire-and-forget,
  capped at 20 items/cycle, logged as `post-close reconcile`. So the
  authoritative final price + bid count land on the row within **one
  snapshot cycle** of the auction transitioning to ended — typically
  30s of wall-clock time after the auction's actual end (since
  `markPastEndDateAsEnded` fires the moment `ends_at < NOW()`, no
  waiting for Browse to drop the item).

This does NOT replace the viewbids paste flow for the *bid timeline* (the
per-bidder chart on the item page) — only the final price/count the
dashboard totals use.

## Buyer feedback capture (Phase 2.5)

eBay's profile pages only link feedback to items for a limited window
(~90 days). The hourly sweep preserves the record permanently:

- `getFeedbackPage(userToken, {userId?, page?})` in `src/ebay/trading.ts`
  wraps Trading `GetFeedback` (`FeedbackReceivedAsSeller`, 200/page).
  Detail entries carry numeric ItemID + CommentText + CommentType + Role.
  Without `userId` it returns the TOKEN OWNER's feedback; with `userId`
  it returns another account's public feedback. **Verified live (first
  dry run, Jun 2026): full detail rows — comment text + item linkage —
  DO come through for other users via UserID** (ryan_5050: 30 fetched,
  30 mapped). The sweep still treats an empty result as an outcome, not
  an error, in case eBay tightens this later.
- `sweepFeedbackOnce` (`src/feedback-sweep.ts`): per configured seller
  (first = token owner, no UserID; rest by UserID), paginate (cap 5
  pages), keep entries with Role=Seller + a comment time, map numeric
  ItemID → canonical `v1|<n>|0` via `readNumericToCanonicalIdMap`, and
  idempotently insert (`upsertFeedback`, unique on
  item/commenter/time). Feedback for untracked items is dropped.
- `startFeedbackSweep`: hourly loop, same shape as the listing poll
  (prod-gated — shared DB, immediate first tick, single-flight, stop fn).
  ~48 Trading calls/day for two sellers, against the separate Trading
  quota (~5,000/day), so negligible.
- Admin action `sweep_feedback` (dry-run default + `apply:true`) with
  Dry run / Apply buttons — the dry run shows per-seller fetch/map counts
  plus a sample, which is how the Ryan-via-UserID question gets answered
  empirically on first use.
- `/api/item` includes `feedback[]` (commenters masked at the boundary,
  same policy as bidders). Item page renders a "Buyer feedback" section
  (hidden when empty) with +/○/− icons and a positive/neutral/negative
  summary count in the header. It sits ABOVE the stats section. The
  stats section itself is ended-aware: heading "Final result" (vs
  "Current state"), label "Final price", and the two highest-bid cards
  collapse away for ended items unless highest-tracked genuinely exceeds
  the final price (then one neutral "Highest bid tracked" card).
- Storage: `feedback` table (migration `017`), canonical item_id.

## Bid-history reconciliation (PR #18 + #19)

The eBay Trading API's `GetAllBidders` returns empty for non-sellers on
ended auctions. The Shopping and Finding APIs are decommissioned (Feb 2025).
Marketplace Insights is closed to new applicants. **The only complete public
source of the per-bid timeline is `https://www.ebay.com/bfl/viewbids/<id>?item=<id>&rt=nc`** (see the GetItem section above for the simpler
final-price-only path).

Implementation:

- `src/ebay/viewbids.ts` — `fetchViewbidsHtml(numericId)` and
  `parseViewbids(html)`. The parser anchors on stable tokens, NOT on CSS
  selectors (eBay's class names are obfuscated and churn):
  - **Amount**: `\$\s*([\d,]+\.\d{2})` — bare `$`, no "US " prefix.
  - **Bidder**: `[0-9A-Za-z]\*{2,4}[0-9A-Za-z]` — anonymized `3***2`.
  - **Date**: three formats supported; the live eBay format is day-first
    "13 May 2026 at 11:38:33am PDT" (no comma, lowercase am/pm, no space
    before am/pm).
  - **Auto/proxy bids** are filtered by checking the 24 chars before each
    bidder token for the unique trailing phrase `the bidder.` (the end of
    eBay's "...placed by eBay on behalf of the bidder." italic marker).
    A wider window leaks across rows.
  - **Retraction table** is split off at "Bid retraction and cancellation
    history" and parsed separately by `parseRetractedSection`. That parser
    expects TWO dates per row (bid time + retraction time) and auto-swaps
    when eBay renders the columns in reverse order. Rows without exactly
    two parseable dates are silently skipped — best-effort until we see
    real retraction-page HTML to calibrate against.
  - **Row pairing is bidder-delimited and order-agnostic**: each bidder
    starts a fresh row, then collects the next amount + date. Amounts
    appearing before the first bidder (e.g. "Winning bid: $X" header) are
    dropped naturally because there's no row to attach to.
  - On zero-bid parse, throws `ViewbidsParseError` with rich diagnostics:
    token counts, autoBidsSkipped, dateParseFailures, raw-HTML "$"/challenge
    sniff, and a 400-char text window around the first amount token.
- `persist.reconcileItemBids(pool, itemId, bids, retracted?)` —
  transactional delete-and-replace inside `pool.connect()` BEGIN/COMMIT.
  Refuses to run on empty bids (a failed parse can never wipe good data).
  When the optional `retracted` array is non-empty, each retraction is
  inserted with `removed_at = bid.removedAt` so the item-page bid timeline
  shows it with strikethrough/retraction-detected styling. Final price and
  bid count come from active bids only — matching eBay's "Bids" count.
- Two admin actions: `list_ended_for_reconcile` (fast, no fetching — just
  returns the ended items with current state) and `import_viewbids_html`
  (`{itemId, html}` paste action). **Works for live auctions too** — no
  ended/active guard. The earlier bulk-fetch action was removed: server-side
  fetching of `bfl/viewbids/*` from the Render IP always returns eBay's
  "Pardon Our Interruption" challenge page, so the loop was a 2-minute wait
  for guaranteed failure on every item. Don't re-add it without first
  verifying the IP/headers situation has changed.
- Admin UI: "Reconcile all" button shows the full ended-items table
  immediately, with two real links per row ("Open page ↗" and "View
  source ↗") + a paste textarea + Import button. `view-source:` URLs
  ARE clickable from `<a href>` — don't replace them with copy-button
  workarounds.
- **Item-page paste box** (`public/item.html` / `item.js`): the same
  paste-and-import flow lives inside each item's admin-section. Gated by
  `hasAdminToken()`. Useful for fixing a live auction's bid history without
  waiting for it to end. After a successful import the page data reloads so
  the bid table refreshes inline.
- **Source tracking** (migration `016`): `reconcileItemBids` stamps
  `listings.bids_imported_at = NOW()` — the only durable signal that a
  complete viewbids timeline exists for an item (paste-import rows and
  Trading-API max-bid rows are indistinguishable in the `bids` table).
  Surfaced as `bidsImportedAt` on `/api/item`; the item chart's
  data-source line keys off it (three layperson tiers: "Complete bid
  history from eBay · imported <date>" / "Built from each bidder's
  highest bid — the steps between bids are estimated" / "Price checked
  every 30 seconds — bids may have landed between checks"). Sampled
  charts draw a STEP path with hollow markers + a dashed bridge-to-now
  segment; bid-based charts keep direct segments and solid dots. The
  item page shows ONE bids card (eBay's count primary, "<N> tracked
  here" as a `<details>` disclosure when ours differs).
- **Stamp backfill** (admin action `backfill_import_stamps`, dry-run by
  default + `apply:true`): items paste-imported BEFORE migration 016 have
  a null stamp and would mislabel as "built from each bidder's highest
  bid". `backfillBidsImportedStamps` stamps them retroactively on three
  signals, any one conclusive: masked bidder rows (`%*%` — public
  viewbids masks names, Trading stores real ones), retraction rows
  (`removed_at` — only the paste import writes those), or seller ≠ the
  Trading-token account (`config.sellerIds[0]` — GetAllBidders returns
  nothing for other sellers, so their bid rows can only be pastes). The
  one shape not caught: a seller-view paste (unmasked names, own item,
  no retractions) — re-import those individually.
- **Chart shape (post-Phase 3)**: ONE y axis (price, always linear) +
  three encodings max — price line/dots, muted volume buckets, proxy-
  defense dots (+ rare retraction markers). The cumulative bid-count
  line, its right axis, and y-log were CUT (count was redundant with the
  volume bars and its second axis invited meaningless comparisons; log-y
  does nothing at auction price ranges). Time lens is a visible
  three-state segmented control, persisted as `hchs.chart.zoom`:
  `[Full auction]` (linear) / `[Opening rush]` (log time-since-start —
  expands the opening hours; hype-driven runs like Ryan's did their
  price discovery in an opening frenzy, NOT at the end — owner-confirmed
  use case, keep it) / `[Snipe zoom]` (log
  time-until-end — expands the final minutes for traditional bidding
  wars). Below 500px the dollar labels move inside the plot and both
  margins collapse (~93% of viewport is plot). Touch scrubbing is
  scroll-intent-gated: horizontal drag scrubs, vertical drag scrolls the
  page (the old handlers preventDefault'd everything and trapped
  scrolling). The scrub readout has a reserved min-height so scrubbing
  never reflows content under the finger.

If a paste parse-fails, get the diagnostics from the admin UI result — do
NOT have the user paste the full HTML into Claude chat. The diagnostics
string is a few hundred chars and identifies the exact regex to adjust.

## Link redirect fix

eBay redirects ended `/itm/<id>` URLs to "similar items" only when the
listing is linked to an eBay catalog/product page (mass-market goods like
video games). Unique items never redirect. The fix is the documented
no-redirect parameter **`nordt=true`** — `orig_cvip=true` does NOT work.
Applied in `endedEbayUrl()` in both `public/app.js` and `public/item.js`.

## Two-timestamp UI (PR #27)

Top bar carries two distinct timestamps, both derived from data already on
the snapshot:

- **Price-feed time** (right column, under the ticker): `snapshot.stock.asOf`
  formatted differently depending on market state — `4:00 PM` when open
  (live, day prefix would read as falsely anchored), `FRI 4:00 PM` when
  closed (so a Friday close shown on Saturday is unambiguous).
- **Auction-data time** (center column): `snapshot.generatedAt`, labelled
  `Auctions updated at 4:30 PM`. The three words are individual spans so
  the mobile-portrait CSS can stack them vertically while desktop renders
  them inline.

Stale ⚠ is on `.ticker-meta::before` so it surfaces in both market-open
(only as-of shown) and market-closed (status + as-of shown) cases.

## Dead code / dead ends

Don't propose these — we already tried them and confirmed they don't work
for ended-auction bid recovery as a non-seller:

- **GetAllBidders for ended-auction bid recovery**: returns empty offers
  for non-sellers on ended items (confirmed via eBay KB articles). The
  backfill machinery built on it (`src/ebay/backfill.ts`, a 60s loop in
  `main()`, the `backfill_ended_now` / `rebackfill_one` /
  `reset_backfill_attempts` admin actions, the listings
  `last_backfilled_at` / `backfill_attempts` columns) was REMOVED in the
  Phase-1 cleanup — it burned one useless Trading call per minute forever.
  The DB columns remain (harmless); `inspect_bid_history` remains for
  diagnostics; `getItemBidHistory` in trading.ts remains because the live
  enrichment path still uses it for the seller's own active auctions.
- Shopping API (`GetItemDetails`): decommissioned 2025-02-05.
- Finding API (`findCompletedItems`): decommissioned 2025-02-05.
- Marketplace Insights API: closed to new applicants.
- Browse API for ended listings: stops returning them after a few hours.
- **Yahoo Finance unofficial QUOTE endpoint** (`prices/yahoo.ts`): started
  401-ing in mid-2026 — Yahoo now requires a "crumb" CSRF token via a
  cookie/header pair. Removed from the live-quote chain in the Phase-1
  cleanup (it only ever added a guaranteed-failure hop after every Finnhub
  429). `YahooProvider.getHistoricalCandles` is NOT removed — the
  `backfill_ohlc_history` admin action still uses it; verify it still
  returns candles before relying on it. If Finnhub becomes chronically
  flaky, add a real server-to-server provider (Alpha Vantage / IEX Cloud)
  rather than fight Yahoo's crumb.
- **Feedback photos**: NOT in the Trading `GetFeedback` response — verified
  live (Jun 2026) against real feedback; the complete field set is
  CommentText/Time/Type, CommentingUser(+Score), FeedbackID,
  FeedbackRatingStar, ItemID, ItemPrice, ItemTitle, OrderLineItemID, Role,
  TransactionID. No REST feedback API exists. The photos live only on the
  JS-rendered profile page (datacenter-IP blocked, and view-source paste
  wouldn't contain them since they load via XHR). Text-only archival is
  the ceiling.
- **Push notifications for bid events**: eBay's Platform Notifications API
  doesn't emit bid-by-bid events for *anyone's* listings (own or other
  sellers'). The supported events are mostly listing-lifecycle +
  `AuctionCheckoutComplete` (post-sale). Polling is the only path.

The viewbids public-page scraper is the only path that works for bid
history, and it only works for ~90 days after an auction ends.

## Useful patterns already in code

- **Adaptive seller polling** (`createAdaptiveSellerFetch` in
  `src/seller-poll.ts`): sellers with zero active listings sleep for 30
  min before we check again; sellers with anything live are polled at the
  normal cadence. See `test/seller-poll.test.ts`.
- **Ticker queue scoping** (`TickerQueue.markRequested` /
  `activePollSet`): passive poll refreshes only EBAY + GME forever plus
  custom tickers viewed in the last 30 min. Custom tickers age out so we
  don't burn the Finnhub free 60/min budget on every ticker ever typed.
- **Stale-fallback in `DbBackedCache`**: when a live fetch fails and the DB
  has a past-TTL row, we serve the stale row and set `degraded=true`. The
  snapshot endpoint surfaces that as `snapshot.degraded` so the frontend
  shows an amber banner instead of zeroes.
- **Null-byte sanitization in cache writes** (`storeDb`): strips ` `
  escapes before JSONB insert — Postgres JSONB rejects the whole document
  if any string contains one, even though RFC 8259 permits them. Tripped
  on an eBay title in PR #24; regression-tested.
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

## UI persistence

Dashboard state lives in `localStorage`:

- `hchs.sellerFilter` — `all` / `mine` / `ryan`
- `hchs.endedPriceMode` — `live` / `at-end`
- `hchs.endedWindow` — `14` / `all`
- `hchs.viewMode` — `list` / `grid-sm` / `grid-md` / `grid-lg`
- `hchs.sort` — one of the five sort modes
- `hchs.aboutOpen` — `1` / `0` for the collapsible intro
- `hchs.otherHalf` — `on` / `off` (default on): The Other Half brokerage
  enabled (body shown) vs collapsed
- `hchs.otherHalf.chartType` — `area` (default) / `pct` / `candle` (legacy
  `line` migrates to `pct`):
  performance-chart type
- `hchs.otherHalf.hidden` — CSV of legend series hidden on the performance
  chart (`total`, `EBAY`, `GME`)
- `hchs.chart.zoom` — item-page chart time lens: `full` / `start` /
  `snipe` (the old `hchs.chart.yScale` / `hchs.chart.xScale` keys are
  dead — y-log was cut in Phase 3; orphaned values are ignored)
- `ticker` — the selected stock: `EBAY` / `GME` / a custom ticker, or
  `MIXED` for "By seller" mode (values each seller's auctions in their own
  stock)
- `theme` — `dark` / `light` override (icon-toggle)

## Efficient workflows

- **Before committing**: `npm run build && npm test && npm run lint`
  (typecheck is part of build via `tsc`). All three should finish in ~5s
  combined.
- **Vitest is fast** (~2s for 177 tests); run early when iterating.
- **Don't paste large content into chat** — save to a file (e.g. `.tmp/x.html`,
  gitignored) and tell me the path. I'll Read just the lines I need.
- **PRs are opened per coherent change**, not against one long-running
  draft. `gh` CLI is not available; use the `mcp__github__*` MCP tools.
- **`/clear` between phases**. The plan→implement→calibrate→ship cycle
  doesn't need the earlier phases' context once you've moved on.

## Environment

- `EBAY_APP_ID`, `EBAY_CERT_ID` — Browse API (required for live data).
- `EBAY_DEV_ID`, `EBAY_USER_TOKEN` — Trading API (optional, mostly dead).
- `EBAY_SELLER_IDS` — comma-separated list of sellers to poll. Defaults to
  `boilerpaulie,ryan_5050`. Legacy `EBAY_SELLER_ID` (single value) is
  accepted as a fallback when `EBAY_SELLER_IDS` is unset.
- `EBAY_SELLER_TICKERS` — seller→stock pairing for "By seller" valuation
  mode, `seller:TICKER,seller:TICKER`. Defaults to
  `boilerpaulie:GME,ryan_5050:EBAY`. Sellers absent from the map fall back
  to `STOCK_SYMBOL`.
- `FINNHUB_API_KEY` — stock prices; the SOLE live-quote provider (Yahoo
  was cut from the chain — see "Dead code"). Without the key, startup
  still works: a stub provider fails every quote and the DbBackedCache /
  degraded banner take over. Stale-fallback covers sporadic Finnhub 429s.
- `LOGO_DEV_TOKEN` — logo.dev publishable token for ticker logos. Server
  proxies `/api/ticker-logo?symbol=…` with a 24h in-memory cache so the
  token never appears in client-visible URLs.
- `DATABASE_URL` — Postgres (optional; everything degrades gracefully).
- `ADMIN_TOKEN` — required to access `/admin` (>= 8 chars).
- `APP_ENVIRONMENT` — tags request_stats rows ("prod" / "dev"). ALSO gates
  the background listing poll (only runs when set to `prod`); dev and prod
  share the same database, so a second poller would double upstream calls.
