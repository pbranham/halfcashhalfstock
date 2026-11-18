# Dashboard (frontend) reference

Behaviour of `public/app.js` / `item.js` and conventions for the vanilla-JS UI.

## Multi-seller dashboard

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

## End-time stock-price toggle

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
  passes it to `composeSnapshot` (5th arg; the 6th is the
  `additionalImagesByItemId` map used by the gallery feature, the 7th the
  `ValuationContext` for "By seller" mode).
- The OHLC table's `interval='1d'` rows are exempt from `purgeOldOhlcData`,
  so daily history accumulates indefinitely. Populate it via the
  `backfill_ohlc_history` admin action (defaults: tickers `EBAY,GME`, range
  `90d`). The action calls `YahooProvider.getHistoricalCandles(ticker, '1d',
  range)` and bulk-upserts the candles. Re-runnable; idempotent.

For an auction that ended during market hours, finer-grain candles (if still
within retention) give a more accurate price; for older auctions only the
daily close at market open exists, which is good enough for the visualization.

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
  table + composite Total + per-stock-grouped Statement (see `docs/other-half.md`). Each tile shows its seller stock's shares + logo
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

## Gallery carousel, lightbox, description iframe

(Data side — `fetchItemDetails`, the enricher, storage — is in `docs/ebay-data.md`.)

Frontend carousel:

- **`public/carousel.js`** — `attachCyclingCarousel(track, opts)` is the
  shared cycling-carousel helper, used by the inline tile galleries
  (`app.js`), the item-page header gallery (`item.js`), and the modal
  (`lightbox.js`). The clone-pad pattern (prepend last-image clone, append
  first-image clone) + a `scrollend`-driven warp handles infinite wrap-
  around for both swipe and button clicks. Both tracks use
  `scroll-behavior: smooth` in CSS, so the warp specifically toggles to
  `auto` to avoid the smooth scroll animating *through* every in-between
  slide. Image count is a fixed-width `i / N` counter
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

## Two-timestamp UI

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

## Design + a11y conventions

- All three pages share the theme tokens in `style.css :root` — item.css
  AND admin.css were both rewritten off their orphaned-variable green
  fallbacks; never reintroduce `--card-bg`/`--text`/`--accent-bg`
  (they don't exist; check `:root` for the real names). Light mode must
  work on every page.
- Global `:focus-visible` outline (accent, 2px) covers buttons, links,
  inputs, selects, summaries, and tabindexed elements — new interactive
  elements get it for free; don't suppress it.
- Coarse-pointer (touch) devices get >=40px hit areas on the pill
  controls via the `@media (pointer: coarse)` block in style.css — add
  new pill classes to that list.
- Sort control is pills on desktop, a native `<select>` under 600px —
  both drive the same state through `applySort`; keep them in sync if
  sort modes change (three places: buttons, select options, SORT_MODES).
- The admin topbar overrides the dashboard's 3-column grid with flex
  (`.admin-body .topbar`) — the shared grid template assumes children
  that only the dashboard has.
- Item-page galleries are keyboard-operable: gallery focusable,
  ArrowLeft/Right flip, Enter/Space opens the lightbox.

## UI persistence

Dashboard state lives in `localStorage`:

- `hchs.sellerFilter` — `all` / `mine` / `ryan`
- `hchs.endedPriceMode` — `live` / `at-end`
- `hchs.endedWindow` — `recent` (last 14 days) / `all`
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
  dead — y-log was cut; orphaned values are ignored)
- `ticker` — the selected stock: `EBAY` / `GME` / a custom ticker, or
  `MIXED` for "By seller" mode (values each seller's auctions in their own
  stock)
- `hchs.admin.token` — admin token the admin page and item-page paste box send
  (`hasAdminToken()`); set from the admin page, never committed
- `theme` — `dark` / `light` override (icon-toggle)
