# eBay data paths reference

How listings, finals, bid timelines, feedback, and galleries are obtained.
Dead ends are in `docs/dead-ends.md`.

## Live-environment limitations

- The dev/bash environment **does have outbound network** (verified: `npm
  ping` / `registry.npmjs.org` reachable) — so packages CAN be installed and
  a library vendored. An older note here claimed "blocks all outbound HTTP";
  that's wrong for package access. eBay/Finnhub *live* verification is still
  best on the deployed dev site (it needs credentials/tokens, and the Render
  datacenter IP is what gets the eBay challenge below) — but don't repeat the
  blanket "no network" claim.
- The Render dev IP is a datacenter; eBay typically returns a 200 "Pardon
  Our Interruption" challenge page for `/bfl/viewbids/*` from this IP, so
  the reconcile loop falls back to paste mode for nearly every item.

## Per-item gallery + description

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

Frontend (carousel, lightbox, description iframe): `docs/dashboard.md`.

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
- GetItem works for both own and others' listings. Bid counts from a
  viewbids parse can be well short of eBay's badge count on heavy-bid
  items; bid count is cosmetic vs the price math, so applying GetItem's
  count only brings the DB closer to eBay's display without changing any
  dollar number. (Live verification log: `docs/archive/`.)

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

## Buyer feedback capture

eBay's profile pages only link feedback to items for a limited window
(~90 days). The hourly sweep preserves the record permanently:

- `getFeedbackPage(userToken, {userId?, page?})` in `src/ebay/trading.ts`
  wraps Trading `GetFeedback` (`FeedbackReceivedAsSeller`, 200/page).
  Detail entries carry numeric ItemID + CommentText + CommentType + Role.
  Without `userId` it returns the TOKEN OWNER's feedback; with `userId`
  it returns another account's public feedback. **Full detail rows — comment
  text + item linkage — DO come through for other users via UserID**
  (verified live Jun 2026; see `docs/archive/`). The sweep still treats an empty result as an outcome, not
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

## Bid-history reconciliation

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
- **Chart shape (current)**: ONE y axis (price, always linear) +
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
