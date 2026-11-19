# halfcashhalfstock

Live monitor for [Ryan Cohen's eBay auctions](https://www.ebay.com/usr/ryan_5050),
expressed as the **half cash + half stock** equivalent at the live market
price — a nod to GameStop's proposed cash-and-stock bid for eBay.

For each active listing, the dashboard shows:

- The current bid `B`
- **Cash half**: `B / 2`
- **Stock half**: `(B / 2) / spotPrice` shares of the selected ticker

Plus portfolio-wide totals. Users can flip between EBAY and GME with a button,
or type any ticker (including class shares like `BRK.A` and Finnhub crypto pairs
like `BINANCE:BTCUSDT`).

## Stack

- Node.js 20+ / TypeScript / Express
- eBay [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html)
  (OAuth client_credentials) for active listings; eBay Trading API
  (optional) for per-bid timestamps, parsed with `fast-xml-parser`
- Stock quotes from Finnhub (sole live-quote provider); Yahoo Finance is used only for historical daily candles
- Postgres (optional) for cross-instance request dedup, bid history, and
  OHLC candle storage
- Background `TickerQueue` service that polls all known tickers continuously
  and validates new ones on demand
- Vanilla static frontend, no bundler, polls every 30 s
- PWA install support (`manifest.webmanifest`, SVG icon, `hchs` short name)

## Quickstart (local)

```bash
git clone https://github.com/pbranham/halfcashhalfstock.git
cd halfcashhalfstock
npm install
cp .env.example .env
# fill in EBAY_APP_ID, EBAY_CERT_ID, FINNHUB_API_KEY (recommended)
npm run dev
# open http://localhost:3000
```

The server runs without Postgres — bid history and OHLC features just stay
disabled. To enable them, set `DATABASE_URL` to a Postgres connection string
and migrations run automatically on startup.

## Required keys

### eBay Browse API (free)

1. Sign up at <https://developer.ebay.com/> (free).
2. Once approved, open the Application Keys page and create a **Production**
   keyset. Copy the App ID and Cert ID into `.env`:
   - `EBAY_APP_ID` → App ID (Client ID)
   - `EBAY_CERT_ID` → Cert ID (Client Secret)
3. Default scope `https://api.ebay.com/oauth/api_scope` is included with every
   keyset; no extra approval needed for Browse search.

The default rate limit on the Browse API is generous (thousands of calls per
day); the in-process cache pulls every 30 s regardless of how many browsers
are open.

### eBay Trading API (optional, enables per-bid timestamps)

Set `EBAY_DEV_ID` (from the same Production keyset page) and an Auth'n'Auth
user token (`EBAY_USER_TOKEN`, or `EBAY_USER_TOKEN_FILE` pointing at a JSON
file). When present, the snapshot includes the timestamp of the most recent
bid on each auction and a `lastBid` summary across all auctions, ended
auctions get their final price/bid count reconciled automatically via
GetItem, and buyer feedback is captured hourly via GetFeedback.

Two eBay-imposed time limits worth knowing:

- **User tokens expire after ~18 months**, silently — the API keeps
  answering, just with `Ack=Failure` on every call. `/api/health` flags a
  suspect token after 5 consecutive failures (`tradingAuth: suspect`);
  mint a fresh token from the developer portal when it does.
- **Ended items leave eBay's ~90-day window**: GetItem and the public
  bid-history page both stop working for older items. Everything this app
  captures (finals, bid timelines, feedback) is persisted in Postgres
  before that window closes and survives it.

### Finnhub (recommended, free)

1. Sign up at <https://finnhub.io/register>.
2. Copy the API key into `.env` as `FINNHUB_API_KEY`.

Finnhub is the only live-quote provider (free tier: 60 calls/min, US stocks
plus crypto/forex via prefixed symbols). If `FINNHUB_API_KEY` is unset the
server still boots, but every quote fails and the dashboard shows the stale
banner; Yahoo's unofficial quote endpoint was removed (it now requires a
crumb token). Yahoo is still used for historical daily candles.

### Postgres (optional but recommended)

When `DATABASE_URL` is set, the server enables:

- **Cross-instance dedup** via `cache_entries` — multiple Render replicas
  share the same upstream API responses
- **Bid history persistence** in `listings` and `bids` — the dashboard's
  "most recent bid" is sourced from here
- **OHLC candle storage** in `ohlc_data` — 14d of 15-minute candles plus
  forward 1-minute candles for any ticker the dashboard touches

Migrations run at startup (see [Data persistence](#data-persistence)).
On Render, attach a free Postgres add-on and `DATABASE_URL` is provided
automatically.

## Configuration

| Variable                  | Required | Default       | Notes                                                              |
| ------------------------- | -------- | ------------- | ------------------------------------------------------------------ |
| `EBAY_APP_ID`             | yes\*    | —             | eBay OAuth `client_id`                                             |
| `EBAY_CERT_ID`            | yes\*    | —             | eBay OAuth `client_secret`                                         |
| `EBAY_DEV_ID`             | no       | —             | Required for Trading API (per-bid timestamps)                      |
| `EBAY_USER_TOKEN`         | no       | —             | Auth'n'Auth user token; alternative to file                        |
| `EBAY_USER_TOKEN_FILE`    | no       | `.cache/...`  | Path to JSON file containing the user token                        |
| `EBAY_SELLER_IDS`         | no       | `boilerpaulie,ryan_5050` | Comma-separated seller usernames to track. Legacy `EBAY_SELLER_ID` (single value) is accepted as a fallback. |
| `EBAY_SELLER_TICKERS`     | no       | `boilerpaulie:GME,ryan_5050:EBAY` | `seller:TICKER,...` pairing for "By seller" valuation; sellers absent from the map use `STOCK_SYMBOL` |
| `EBAY_MARKETPLACE_ID`     | no       | `EBAY_US`     | eBay marketplace                                                   |
| `FINNHUB_API_KEY`         | no       | —             | Live stock quotes (sole provider); without it quotes fail          |
| `STOCK_SYMBOL`            | no       | `EBAY`        | Default ticker for the stock half of the math                      |
| `DATABASE_URL`            | no       | —             | Postgres connection string; enables persistence + OHLC + queue     |
| `PORT`                    | no       | `3000`        |                                                                    |
| `LOG_LEVEL`               | no       | `info`        | `debug` \| `info` \| `warn` \| `error`                             |
| `NODE_ENV`                | no       | `development` | `development` \| `test` \| `production`                            |
| `ENABLE_DEBUG_ENDPOINTS`  | no       | `false`       | When `true`, exposes `/api/debug/ohlc-stats` (dev/staging only)    |
| `ADMIN_TOKEN`             | no       | —             | Gates `/admin` and `/api/admin/*` (>= 8 chars)                     |
| `APP_ENVIRONMENT`         | no       | —             | Tags `request_stats` rows (`prod` / `dev`). Only `prod` runs the background listing poll and feedback sweep (dev and prod share one DB). |
| `LOGO_DEV_TOKEN`          | no       | —             | logo.dev publishable API key. When set, the dashboard renders the ticker logo as the shares "unit"; otherwise falls back to spelled-out "shares". |

\* Without eBay credentials the server still boots and serves the static UI;
`/api/snapshot` returns a 503 with a clear log line until both keys are set.

## API endpoints

| Method | Path                       | Description                                                                  |
| ------ | -------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/`                        | Static frontend (`public/index.html`)                                        |
| GET    | `/healthz`                 | Liveness probe; always 200 once the server is listening                      |
| GET    | `/api/snapshot`            | JSON snapshot. Query: `symbol` (1–20 chars, regex `^[A-Z][A-Z0-9.\-:]{0,19}$`); falls back to `STOCK_SYMBOL` if absent or invalid. Unknown symbols are validated through the TickerQueue (synchronous, up to ~4s). |
| GET    | `/api/health`              | Health JSON (`ok`/`degraded`/`error`; 503 on DB failure); see `docs/operations.md` |
| GET    | `/api/item`                | Per-item audit data (bids, feedback, gallery). Query: `itemId`. |
| GET    | `/api/ohlc-history`        | Retained daily OHLC for the performance chart. Query: `tickers`, `days`. |
| GET    | `/api/ticker-logo`         | Server-side logo.dev proxy (keeps `LOGO_DEV_TOKEN` off the client); cached 24h in memory and in the browser. Query: `symbol`. |
| GET/POST | `/api/admin/*`           | Admin stats + maintenance (`ADMIN_TOKEN`); all actions are `POST /api/admin/cleanup`. |
| GET    | `/api/history`             | Bid history for one item. Query: `itemId`. Requires Postgres.                 |
| GET    | `/api/ohlc`                | OHLC candles for a ticker. Query: `ticker`, `days` (1–30, default 7). Requires Postgres. |
| GET    | `/api/debug/ohlc-stats`    | Per-ticker per-interval candle counts + queue status. Requires `ENABLE_DEBUG_ENDPOINTS=true`. |

Admin actions not described elsewhere (`docs/ebay-data.md`, `docs/dashboard.md`), all sent as
`POST /api/admin/cleanup {action, ...}`: `count_removed_bids`, `restore_all_bids` (clear
`bids.removed_at`), `restore_listings` (clear `listings.ended_at`), `list_stuck_listings`,
`force_mark_ended` (`itemId`), `delete_environment` / `rename_environment` (`request_stats`
environment labels), `delete_before` (deletes `request_stats` / `session_stats` / `seen_ips`
rows older than a date).

`/api/snapshot`, `/api/history`, `/api/ohlc`, and `/api/debug/ohlc-stats` are
rate-limited at 60 requests/min/IP.

### Snapshot payload shape

```jsonc
{
  "stock": { "symbol": "EBAY", "price": 86.42, "currency": "USD", "asOf": "...", "source": "finnhub" },
  "items": [ /* per-listing objects with bid, half-cash, half-stock fields */ ],
  "totals": { "listingsCount": 12, "pricedCount": 12, "bidsCount": 47, "bidUsd": 1234.56, "split": { "cashUsd": 617.28, "stockUsd": 617.28, "shares": 7.1432 } },
  "lastBid": { "itemId": "...", "bidTime": "...", "bidAmountUsd": 100 }, // present when Trading API is configured
  "generatedAt": "2026-05-09T..."
}
```

## Live data flow (`TickerQueue`)

When Postgres is configured, `src/ticker-queue.ts` runs two coordinated loops
on top of the Finnhub price provider. Together they decouple
data ingestion from user activity and bound API quota use regardless of how
many users submit custom tickers.

```
                    ┌──────────────────────────────┐
                    │      TickerQueue (in-proc)   │
                    │                              │
   user submits     │  ┌────────────────────────┐  │
   custom ticker ─▶ │  │  active queue (Set)    │  │
                    │  │  drains every ~2.5s    │  │
                    │  │  → batched validate    │  │
                    │  └──────────┬─────────────┘  │
                    │             │                │
                    │             ▼                │
                    │  ┌────────────────────────┐  │
                    │  │  known tickers (Set)   │──┼──▶ live 1m writes
                    │  │  EBAY + GME always +   │  │    (deduped by quote.asOf)
                    │  │  recent customs (30m)  │  │
                    │  │  passive every ~30s    │  │
                    │  └────────────────────────┘  │
                    │                              │
                    │  ┌────────────────────────┐  │
                    │  │  negative cache (Map)  │  │
                    │  │  invalid tickers       │  │
                    │  │  1hr TTL               │  │
                    │  └────────────────────────┘  │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                             price provider
                                (Finnhub)
```

**Behaviors that matter:**

- `/api/snapshot?symbol=X` for unknown `X` blocks up to 4s waiting for the
  next active drain. Valid → 200 + snapshot. Invalid → 400. The 4s wait is
  what makes the UX feel "the system is checking" instead of laggy.
- Live writes are deduped on `quote.asOf` — when the upstream timestamp
  hasn't advanced (markets closed, weekend, holiday) no new 1m candle is
  written. Crypto pairs keep ticking 24/7.
- Always-active tickers (EBAY, GME) get a one-time 14d/15m backfill at
  startup, with a skip-if-fresh check to avoid re-fetching on every restart.
- Custom tickers do **not** get historical backfill — they accumulate 1m
  candles forward from first sighting. Keeps the DB bounded.
- Quota math: passive ~5 calls / 30s + active 1 call / drain when queue
  non-empty ≈ 24 calls/min worst case, well under Finnhub's 60/min limit.

## PWA install

The frontend ships a web app manifest, an SVG icon, and the iOS-specific
meta tags needed to install to a phone home screen.

- **Android Chrome**: ⋮ menu → Install app (or "Add to Home screen").
  Home-screen label: **hchs**.
- **iOS Safari**: Share → Add to Home Screen. Label: **hchs**.

iOS pre-16.4 doesn't render SVG favicons cleanly and may show a screenshot
icon on the home screen. Replace `public/icon.svg` with a 180×180 PNG (and
update the `apple-touch-icon` link in `index.html`) if pixel-perfect iOS
icons matter.

## Scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Hot-reload dev server via `tsx`              |
| `npm run build`     | Compile TypeScript to `dist/`                |
| `npm start`         | Run the compiled server                      |
| `npm test`          | Vitest unit and integration tests            |
| `npm run lint`      | ESLint (flat config)                         |
| `npm run typecheck` | `tsc --noEmit` over `src/`                   |
| `npm run format`    | Prettier write                               |

## Deploy

### Docker

```bash
docker build -t halfcashhalfstock .
docker run --rm -p 3000:3000 --env-file .env halfcashhalfstock
```

### Render

```bash
# Push the repo to GitHub, then on Render:
# New + → Blueprint → point at render.yaml → set the sync:false vars
```

`render.yaml` declares a free-tier web service. Set `EBAY_APP_ID`,
`EBAY_CERT_ID`, and `FINNHUB_API_KEY` in the Render dashboard. To enable
persistence, attach a Postgres add-on and Render will set `DATABASE_URL`
automatically. Set `ENABLE_DEBUG_ENDPOINTS=true` on staging only if you want
to verify backfill via `/api/debug/ohlc-stats`.

### Anywhere else

The Dockerfile is portable: Fly.io, Railway, AWS App Runner, Cloud Run, your
own VPS — all the same `docker run` invocation.

## Architecture

```
                            Browser UI (vanilla JS, PWA)
                            polls /api/snapshot every 30s
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │  Express + Helmet    │
                            │  /api/snapshot       │
                            │  /api/history        │
                            │  /api/ohlc           │
                            │  /api/debug/...      │
                            └──┬─────────┬─────────┘
                               │         │
                  ┌────────────┘         └────────────┐
                  │                                   │
                  ▼                                   ▼
         eBay Browse + Trading APIs           TickerQueue + price providers
         (OAuth, TTL/DB cached)                (Finnhub)
                  │                                   │
                  └─────────────┬─────────────────────┘
                                ▼
                       ┌──────────────────┐
                       │    Postgres      │
                       │ ──────────────── │
                       │  listings        │
                       │  bids            │
                       │  cache_entries   │
                       │  ohlc_data       │
                       │  feedback, ...   │
                       └──────────────────┘
```

- All upstream calls are TTL-cached with single-flight coalescing in
  `src/cache.ts`. When Postgres is configured, `DbBackedCache` checks the DB
  for a fresh entry before any in-process miss reaches upstream — multiple
  replicas share the same payloads.
- Listings are normalized in `src/ebay/seller.ts`; non-USD bids are kept in
  the per-item view but excluded from totals so currencies never silently mix.
- The half/half math (`src/math.ts`) is a pure function with input validation;
  it's the single place to swap to a Decimal type if precision ever matters.
- `src/snapshot.ts` composes the final JSON response from listings + price.

## Data persistence

Schema migrations live under `migrations/` and run at startup in lexical order.

| Table             | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `listings`        | Current state per item, upserted on every snapshot poll               |
| `bids`            | Append-only individual bids (Trading API), `(item, time, bidder)` PK  |
| `cache_entries`   | JSONB payloads keyed by cache_key with `expires_at` for cross-replica dedup |
| `ohlc_data`       | OHLC candles, PK includes `interval` ('15m', '1m', '1d'); 1d rows are never purged |
| `listing_snapshots` | Deduped per-listing price/bid history |
| `feedback`        | Buyer feedback captured hourly (unique on item/commenter/time) |
| `request_stats`, `session_stats`, `seen_ips` | Privacy-respecting request metrics |

**Retention policy** (enforced by `purgeOldOhlcData` on TickerQueue startup):

- 15m candles older than 14 days → deleted
- 1m candles older than 5 days → deleted
- Custom-ticker rows age out naturally — once 1m data goes stale (5d), the
  ticker drops out of the passive poll's known-ticker set

## Security posture

- Secrets only live in env vars and never leave the server.
- Helmet sets a strict CSP (`default-src 'self'`; `manifest-src 'self'` for
  PWA install; `img-src` allows `*.ebayimg.com` for thumbnails; no inline
  scripts/styles).
- All API routes are rate-limited (60 req/min/IP).
- Ticker symbols and seller IDs are regex-validated before being interpolated
  into upstream filter syntax or URL paths.
- `/api/debug/ohlc-stats` is gated behind `ENABLE_DEBUG_ENDPOINTS=true` so
  production deploys don't accidentally expose internals.
- Errors return generic 503 messages; details only appear in structured logs.
- Docker image runs as the unprivileged `node` user with no shell.

## Disclaimer

Not affiliated with Ryan Cohen, GameStop, eBay, Finnhub, or Yahoo. Auction
data is provided by the public eBay Browse API; stock data is provided by
Finnhub or Yahoo Finance. Numbers are for entertainment, not investment
advice.

## License

[MIT](LICENSE)
