# CLAUDE.md

Context for Claude sessions on this repo. README.md covers setup, deploy, and
config — this file covers what a returning session needs to be productive
without re-discovering everything.

## What this project is

A Node 20 / TypeScript / Express + Postgres app that monitors **multiple eBay
seller accounts** (`boilerpaulie` + `ryan_5050` by default; configurable via
`EBAY_SELLER_IDS`) and converts each live auction bid into a "half cash + half
EBAY stock" equivalent at the live market price. The dashboard has a seller
filter (`[All] [Mine] [Ryan]`), a per-card seller badge, and a `[Live] [At
auction end]` toggle on the ended-auctions section that revalues each closed
auction using the EBAY close at the moment it ended.

Ryan's original 36 auctions all ended in early May 2026 and are still shown
in the ended-section; my own (boilerpaulie) auctions started rolling in late
May.

Production: https://halfcashhalfstock.onrender.com — Dev:
https://halfcashhalfstock-dev.onrender.com (deploys from
`claude/ebay-auction-monitor-vdOMZ`).

## Stack at a glance

- Node 20, TypeScript strict, ESM (`"type":"module"`, `.js` import specifiers).
- Express + Helmet (strict CSP, no inline scripts) + express-rate-limit.
- Postgres via `pg` Pool. Migrations in `migrations/NNN_*.sql` run sequentially
  on startup by `src/db/migrate.ts`; latest is `013_listings_seller_id`.
- Vanilla static frontend in `public/` — no bundler. CSP-compatible.
- Vitest for tests. ESLint + Prettier for lint/format.
- `fast-xml-parser` (Trading API XML); no HTML parser dep (regex in
  `viewbids.ts`).
- Render hosts both web service and Postgres. Local dev works without DB
  (graceful degradation).

## Layout

```
src/
  server.ts            HTTP, routes, request-stats wiring, graceful shutdown
  config.ts            zod env schema; resolveEbayTradingUserToken / has*Credentials helpers
  cache.ts             TtlCache + DbBackedCache (single-flight)
  log.ts               Logger
  snapshot.ts          composeSnapshot — listings + price + math + totals
  ticker-queue.ts      stock OHLC backfill scheduler
  request-stats.ts     privacy-respecting metrics + UA classifier + sessions
  math.ts              pure half/half split
  db/
    pool.ts            pg.Pool factory
    migrate.ts         filesystem-driven migration runner (atomic per file)
    persist.ts         every DB read/write the app does
  ebay/
    auth.ts            Browse API OAuth client_credentials, cached
    client.ts          generic Browse API HTTP wrapper
    seller.ts          listSellerActiveItems → normalized Listing[]
    trading.ts         GetAllBidders XML client (see "Dead code" below)
    bid-history.ts     fetchBidHistory: DB-first, Trading API fallback, DB final fallback
    backfill.ts        backfillEndedListings — DEAD for our use case (see below)
    viewbids.ts        public bid-history page scraper + parser (current path)
  prices/
    finnhub.ts, yahoo.ts, provider.ts, types.ts   chained provider
public/
  index.html  app.js   dashboard (active + recently ended)
  item.html   item.js  per-item audit page
  admin.html  admin.js admin dashboard + maintenance actions
  *.css       theme-init.js
test/
  one *.test.ts per src/ module; vitest, no jsdom
migrations/  NNN_*.sql, applied in order, recorded in `_migrations` table
```

## Conventions that bit us

- **eBay item IDs come in `v1|<numeric>|0` format** from Browse API. The
  numeric portion is what `/itm/<id>` and `/bfl/viewbids/<id>` URLs need. Use
  `normalizeTradingItemId` (exported from `src/ebay/trading.ts`).
- **All admin actions go through one endpoint**: `POST /api/admin/cleanup`
  with `{action: 'xxx', ...}` body, gated by `ADMIN_TOKEN` env var. New
  features add a new action branch, NOT a new route.
- **Global JSON limit is 10kb**, but the cleanup route has a route-scoped
  4mb parser so pasted eBay pages fit (server.ts ~line 466). The global
  parser explicitly skips `/api/admin/cleanup` to avoid clashing.
- **Item ID validation regex**: `/^[A-Za-z0-9|.-]{1,64}$/` — reuse this for
  any new admin action that takes an itemId.
- **Public JS is vanilla and CSP-strict**: no inline scripts, no eval, no
  CDNs. New behavior goes in an existing `public/*.js` file or a new one
  loaded via `<script src>`.
- **Tests mock fetch with `vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(...))`**.
  See `test/ebay.trading.test.ts` for the pattern.
- **Tests mock pg with a `MockPool`** — `{ query: vi.fn().mockResolvedValue({rows:[], rowCount:0}) }`.
  For transactional code use a client mock too:
  `pool.connect()` → `{ query, release: vi.fn() }`. See `test/db.persist.test.ts`.
- **Commits**: scoped style (`feat(admin):`, `fix(viewbids):`, etc), 1-2 sentence
  "why" body, HEREDOC, footer `https://claude.ai/code/session_...`. See
  recent log for examples.
- **Branch**: develop on `claude/ebay-auction-monitor-vdOMZ`. PR #18 is the
  long-running draft for this branch; update its body when shipping notable
  commits rather than opening a new PR per change.

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
  item's `endedAt`. Per-card bid-row note shows the close used.
- The ended totals row sums the per-item end-time splits and surfaces a
  "Missing end-time price" stat whenever `pricedAtEndCount < listingsCount`.

Data path:

- `getClosingPriceAt(pool, ticker, when)` in `db/persist.ts` picks the row
  with the largest `period_start <= when`, tie-breaking on interval
  preference `1m > 15m > 1d`. Returns null when no row covers `when`.
- The snapshot endpoint calls it for every USD-denominated ended item against
  the currently-selected ticker, builds a `Map<itemId, close|null>`, and
  passes it as the optional 4th arg to `composeSnapshot`.
- The OHLC table's `interval='1d'` rows are exempt from `purgeOldOhlcData`,
  so daily history accumulates indefinitely. Populate it via the new
  `backfill_ohlc_history` admin action (defaults: tickers `EBAY,GME`, range
  `90d`). The action calls `YahooProvider.getHistoricalCandles(ticker, '1d',
  range)` and bulk-upserts the candles. Re-runnable; idempotent.

For an auction that ended during market hours, finer-grain candles (if still
within retention) give a more accurate price; for older auctions only the
daily close at market open exists, which is good enough for the visualization.

## Bid-history reconciliation (PR #18 + #19)

The eBay Trading API's `GetAllBidders` returns empty for non-sellers on
ended auctions. The Shopping and Finding APIs are decommissioned (Feb 2025).
Marketplace Insights is closed to new applicants. **The only complete public
source of historical bid history is `https://www.ebay.com/bfl/viewbids/<id>?item=<id>&rt=nc`.**

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

If a paste parse-fails, get the diagnostics from the admin UI result — do
NOT have the user paste the full HTML into Claude chat. The diagnostics
string is a few hundred chars and identifies the exact regex to adjust.

## Link redirect fix

eBay redirects ended `/itm/<id>` URLs to "similar items" only when the
listing is linked to an eBay catalog/product page (mass-market goods like
video games). Unique items never redirect. The fix is the documented
no-redirect parameter **`nordt=true`** — `orig_cvip=true` does NOT work.
Applied in `endedEbayUrl()` in both `public/app.js` and `public/item.js`.

## Dead code / dead ends

Don't propose these — we already tried them and confirmed they don't work
for ended-auction bid recovery as a non-seller:

- `src/ebay/backfill.ts` and the `backfill_ended_now` / `rebackfill_one` /
  `reset_backfill_attempts` admin actions. They call `GetAllBidders` which
  returns empty offers for non-sellers on ended items (confirmed via eBay
  KB articles). Left in place for diagnostic value via `inspect_bid_history`.
- Shopping API (`GetItemDetails`): decommissioned 2025-02-05.
- Finding API (`findCompletedItems`): decommissioned 2025-02-05.
- Marketplace Insights API: closed to new applicants.
- Browse API for ended listings: stops returning them.

The viewbids public-page scraper is the only path that works, and it only
works for ~90 days after an auction ends.

## Useful patterns already in code

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

## Efficient workflows

- **Before committing**: `npm run build && npm test && npm run lint`
  (typecheck is part of build via `tsc`). All three should finish in ~5s
  combined.
- **Vitest is fast** (~2s for 115 tests); run early when iterating.
- **Don't paste large content into chat** — save to a file (e.g. `.tmp/x.html`,
  gitignored) and tell me the path. I'll Read just the lines I need.
- **PR activity**: the current long-running PR is #19. Update its body
  when shipping notable commits. `gh` CLI is not available; use the
  `mcp__github__*` MCP tools.
- **`/clear` between phases**. The plan→implement→calibrate→ship cycle
  doesn't need the earlier phases' context once you've moved on.

## Environment

- `EBAY_APP_ID`, `EBAY_CERT_ID` — Browse API (required for live data).
- `EBAY_DEV_ID`, `EBAY_USER_TOKEN` — Trading API (optional, mostly dead).
- `EBAY_SELLER_IDS` — comma-separated list of sellers to poll. Defaults to
  `boilerpaulie,ryan_5050`. Legacy `EBAY_SELLER_ID` (single value) is
  accepted as a fallback when `EBAY_SELLER_IDS` is unset.
- `FINNHUB_API_KEY` — stock prices (Yahoo fallback works without).
- `DATABASE_URL` — Postgres (optional; everything degrades gracefully).
- `ADMIN_TOKEN` — required to access `/admin` (>= 8 chars).
- `APP_ENVIRONMENT` — tags request_stats rows ("prod" / "dev").
