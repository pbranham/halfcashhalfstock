# halfcashhalfstock

Live monitor for [Ryan Cohen's eBay auctions](https://www.ebay.com/usr/ryan_5050),
expressed as the **half cash + half EBAY stock** equivalent at the live market
price — a nod to GameStop's proposed cash-and-stock bid for eBay.

For each active listing, the dashboard shows:

- The current bid `B`
- **Cash half**: `B / 2`
- **Stock half**: `(B / 2) / spotEBAY` shares of EBAY

Plus portfolio-wide totals across all listings.

## Stack

- Node.js 20+ / TypeScript / Express
- eBay [Browse API](https://developer.ebay.com/api-docs/buy/browse/overview.html)
  with OAuth client_credentials
- Pluggable stock price provider — Finnhub primary, Yahoo Finance fallback
- Vanilla static frontend, no bundler, polls every 30 s
- In-process TTL cache with single-flight loaders

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

### Finnhub (recommended, free)

1. Sign up at <https://finnhub.io/register>.
2. Copy the API key into `.env` as `FINNHUB_API_KEY`.

If `FINNHUB_API_KEY` is unset, the server transparently falls back to Yahoo
Finance's unofficial endpoint. Finnhub is more reliable and has a real free
tier (60 calls/min, US stocks).

## Configuration

| Variable               | Required | Default      | Notes                                            |
| ---------------------- | -------- | ------------ | ------------------------------------------------ |
| `EBAY_APP_ID`          | yes\*    | —            | eBay OAuth client_id                             |
| `EBAY_CERT_ID`         | yes\*    | —            | eBay OAuth client_secret                         |
| `EBAY_SELLER_ID`       | no       | `ryan_5050`  | Seller username to track                         |
| `EBAY_MARKETPLACE_ID`  | no       | `EBAY_US`    | eBay marketplace                                 |
| `FINNHUB_API_KEY`      | no       | —            | Enables Finnhub primary; Yahoo used otherwise    |
| `STOCK_SYMBOL`         | no       | `EBAY`       | Ticker for the stock half of the math            |
| `PORT`                 | no       | `3000`       |                                                  |
| `LOG_LEVEL`            | no       | `info`       | `debug` \| `info` \| `warn` \| `error`           |

\* Without eBay credentials the server still boots and serves the static UI;
`/api/snapshot` returns a 503 with a clear log line until both keys are set.

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
# New + → Blueprint → point at render.yaml → set the three sync:false vars
```

`render.yaml` declares a free-tier web service. Set `EBAY_APP_ID`,
`EBAY_CERT_ID`, and `FINNHUB_API_KEY` in the Render dashboard.

### Anywhere else

The Dockerfile is portable: Fly.io, Railway, AWS App Runner, Cloud Run, your
own VPS — all the same `docker run` invocation.

## Architecture

```
┌────────────────┐     poll 30s      ┌────────────────────┐
│   Browser UI   │ ────────────────▶ │ /api/snapshot      │
│ (vanilla JS)   │ ◀──────────────── │ Express + Helmet   │
└────────────────┘    JSON snapshot  └─────┬──────────────┘
                                           │
                       ┌───────────────────┼─────────────────────┐
                       ▼                   ▼                     ▼
              eBay OAuth (cached)  eBay Browse API       Stock provider chain
              client_credentials   /item_summary/search  Finnhub → Yahoo
                                   (per-seller filter)   (TTL-cached)
```

- All upstream calls are TTL-cached with single-flight coalescing in
  `src/cache.ts`.
- Listings are normalized in `src/ebay/seller.ts`; non-USD bids are kept in the
  per-item view but excluded from totals so currencies never silently mix.
- The half/half math (`src/math.ts`) is a pure function with input validation;
  it's the single place to swap to a Decimal type if precision ever matters.

## Security posture

- Secrets only live in env vars and never leave the server.
- Helmet sets a strict CSP (`default-src 'self'`, no inline scripts/styles,
  images allowed only from same-origin and `*.ebayimg.com`).
- `/api/snapshot` is rate-limited (60 req/min/IP).
- Seller IDs are regex-validated before being interpolated into the eBay
  filter syntax.
- Errors return generic 503 messages; details only appear in structured logs.
- Docker image runs as the unprivileged `node` user with no shell.

## Disclaimer

Not affiliated with Ryan Cohen, GameStop, eBay, Finnhub, or Yahoo. Auction
data is provided by the public eBay Browse API; stock data is provided by
Finnhub or Yahoo Finance. Numbers are for entertainment, not investment
advice.

## License

[MIT](LICENSE)
