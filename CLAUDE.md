# CLAUDE.md

Context for Claude sessions on this repo. README.md covers setup, deploy, and
config — this file covers what a returning session needs to be productive
without re-discovering everything.

## What this project is

A Node 20 / TypeScript / Express + Postgres app that monitors **Ryan Cohen's
eBay seller account (`ryan_5050`)** and converts each live auction bid into a
"half cash + half EBAY stock" equivalent at the live market price. As of
May 2026 all 36 monitored auctions have ended; the dashboard now displays
final ended-state plus an "ended bids reconciliation" admin tool.

Production: https://halfcashhalfstock.onrender.com — Dev:
https://halfcashhalfstock-dev.onrender.com (deploys from
`claude/ebay-auction-monitor-vdOMZ`).

## Stack at a glance

- Node 20, TypeScript strict, ESM (`"type":"module"`, `.js` import specifiers).
- Express + Helmet (strict CSP, no inline scripts) + express-rate-limit.
- Postgres via `pg` Pool. Migrations in `migrations/NNN_*.sql` run sequentially
  on startup by `src/db/migrate.ts`; latest is `012_listing_backfill_tracking`.
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

## Ended-auction bid reconciliation (current feature, PR #18)

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
  - **Retraction table** is truncated off the text before tokenizing by
    cutting at the string "Bid retraction and cancellation history".
  - **Row pairing is bidder-delimited and order-agnostic**: each bidder
    starts a fresh row, then collects the next amount + date. Amounts
    appearing before the first bidder (e.g. "Winning bid: $X" header) are
    dropped naturally because there's no row to attach to.
  - On zero-bid parse, throws `ViewbidsParseError` with rich diagnostics:
    token counts, autoBidsSkipped, dateParseFailures, raw-HTML "$"/challenge
    sniff, and a 400-char text window around the first amount token.
- `persist.reconcileItemBids(pool, itemId, bids)` — transactional
  delete-and-replace inside `pool.connect()` BEGIN/COMMIT. Refuses to run
  on empty bids (a failed parse can never wipe good data).
- Two admin actions: `list_ended_for_reconcile` (fast, no fetching — just
  returns the ended items with current state) and `import_viewbids_html`
  (`{itemId, html}` paste action). The earlier bulk-fetch action was
  removed: server-side fetching of `bfl/viewbids/*` from the Render IP
  always returns eBay's "Pardon Our Interruption" challenge page, so the
  loop was a 2-minute wait for guaranteed failure on every item. Don't
  re-add it without first verifying the IP/headers situation has changed.
- Admin UI: "Reconcile all" button shows the full ended-items table
  immediately, with a paste textarea + "Copy view-source URL" button per
  row. Chrome blocks `<a href="view-source:...">` navigation, so the UI
  uses a clipboard-copy button instead of a link.

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
- **Vitest is fast** (~2s for 99 tests); run early when iterating.
- **Don't paste large content into chat** — save to a file (e.g. `.tmp/x.html`,
  gitignored) and tell me the path. I'll Read just the lines I need.
- **PR activity**: PR #18's body should be updated when shipping notable
  commits. `gh` CLI is not available; use the `mcp__github__*` MCP tools.
- **`/clear` between phases**. The plan→implement→calibrate→ship cycle
  doesn't need the earlier phases' context once you've moved on.

## Environment

- `EBAY_APP_ID`, `EBAY_CERT_ID` — Browse API (required for live data).
- `EBAY_DEV_ID`, `EBAY_USER_TOKEN` — Trading API (optional, mostly dead).
- `FINNHUB_API_KEY` — stock prices (Yahoo fallback works without).
- `DATABASE_URL` — Postgres (optional; everything degrades gracefully).
- `ADMIN_TOKEN` — required to access `/admin` (>= 8 chars).
- `APP_ENVIRONMENT` — tags request_stats rows ("prod" / "dev").
