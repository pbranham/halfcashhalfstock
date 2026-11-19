# Dead ends — do not propose again

## Dead ends

Don't propose these — we already tried them and confirmed they don't work
for ended-auction bid recovery as a non-seller:

- **GetAllBidders for ended-auction bid recovery**: returns empty offers
  for non-sellers on ended items (confirmed via eBay KB articles). The
  backfill machinery built on it (`src/ebay/backfill.ts`, a 60s loop in
  `main()`, the `backfill_ended_now` / `rebackfill_one` /
  `reset_backfill_attempts` admin actions, the listings
  `last_backfilled_at` / `backfill_attempts` columns) was REMOVED in the
  earlier cleanup — it burned one useless Trading call per minute forever.
  The DB columns remain (harmless); `inspect_bid_history` remains for
  diagnostics; `getItemBidHistory` in trading.ts remains because the live
  enrichment path still uses it for the seller's own active auctions.
- Shopping API (`GetItemDetails`): decommissioned 2025-02-05.
- Finding API (`findCompletedItems`): decommissioned 2025-02-05.
- Marketplace Insights API: closed to new applicants.
- Browse API for ended listings: stops returning them after a few hours.
- **Yahoo Finance unofficial QUOTE endpoint** (`prices/yahoo.ts`): started
  401-ing in mid-2026 — Yahoo now requires a "crumb" CSRF token via a
  cookie/header pair. Removed from the live-quote chain in an earlier
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
