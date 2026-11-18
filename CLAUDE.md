# CLAUDE.md

Rules every session obeys. This file is always loaded: it holds **rules only**
(stable, one canonical copy), is capped at **200 lines**, and never holds state,
logs, counts, or "currently…" statements. Reference material lives in `docs/`.

## What this project is

Node 20 / TypeScript / Express + Postgres app that monitors multiple eBay seller
accounts (`EBAY_SELLER_IDS`) and converts each auction bid into a "half cash +
half stock" equivalent at the live market price. Vanilla static frontend in
`public/`, no bundler. Local dev works without a DB (graceful degradation).

## Where things live (one home per topic)

| Topic | File |
| --- | --- |
| Setup, env vars, endpoints, schema, deploy, TickerQueue flow | `README.md` |
| Module map, API budget, cross-cutting patterns | `docs/architecture.md` |
| Dashboard/frontend behaviour, UI persistence keys, design + a11y | `docs/dashboard.md` |
| The Other Half (brokerage section) | `docs/other-half.md` |
| eBay data paths: finals, bid timelines, feedback, galleries | `docs/ebay-data.md` |
| Health checks, deployments | `docs/operations.md` |
| Approaches already tried and rejected | `docs/dead-ends.md` — read before proposing a new eBay data path or price provider |
| Dated point-in-time notes | `docs/archive/` — history, not truth |

## Doc hygiene

- Rules go here; reference goes in the owning `docs/` file or README; nothing is
  written in two places — link instead.
- Never record state or logs in an always-loaded file: no test counts, PR numbers,
  "verified on <date>", "as of <month>", "currently dormant". Use `git log`.
- A commit that adds/removes/renames a module, public asset, migration, env var,
  DB column, endpoint, admin action, or `localStorage` key updates the owning doc
  in the same commit (module map → `docs/architecture.md`; env var/endpoint/table
  → `README.md`; `localStorage` key → `docs/dashboard.md`). CLAUDE.md changes only
  when a rule changes.
- Check every concrete claim (path, function, env var, number) against the code
  before writing it.

## Build and verify

- Before committing: `npm run build && npm test && npm run lint` (CI also runs
  `npm run typecheck`). All must be green.
- TypeScript strict, ESM (`"type":"module"`, `.js` import specifiers).
- The repo is NOT prettier-clean: never run `prettier --write` on whole files
  (`printWidth: 100`); format only the lines you touch.
- Large pasted content (eBay pages) goes in a gitignored `.tmp/` file, not chat.
- Tests: mock fetch with `vi.spyOn(globalThis, 'fetch').mockResolvedValue(new
  Response(...))` (`test/ebay.trading.test.ts`); mock pg with a `MockPool`
  `{ query: vi.fn().mockResolvedValue({rows:[], rowCount:0}) }`, plus
  `pool.connect()` → `{ query, release: vi.fn() }` for transactions
  (`test/db.persist.test.ts`). vitest, no jsdom.

## Server conventions

- eBay item IDs from Browse are `v1|<numeric>|0`; `/itm/<id>` and
  `/bfl/viewbids/<id>` need the numeric part — use `normalizeTradingItemId`
  (`src/ebay/trading.ts`).
- ALL admin actions go through `POST /api/admin/cleanup` with `{action:'xxx', ...}`
  (gated by `ADMIN_TOKEN`). New features add an action branch, never a new route.
- Global JSON body limit is 10kb; the cleanup route has its own 4mb parser and the
  global parser skips it. Keep both.
- Item ID validation regex: `/^[A-Za-z0-9|.-]{1,64}$/` — reuse for any new itemId input.
- Every `splitHalfCashHalfStock` call goes through `isSplittablePrice`; bad prices
  render "—", never a 503.
- Strip `\u0000` before JSONB writes (`storeDb`): Postgres JSONB rejects it.
- Bid history: parser changes anchor on stable tokens, not CSS classes. On a
  parse failure use the admin UI's diagnostics string — never ask the user to
  paste full HTML into chat. Full detail: `docs/ebay-data.md`.
- Do NOT re-add server-side fetching of `bfl/viewbids/*` (eBay challenges the
  datacenter IP) unless the IP/header situation is verified changed. The paste
  import is the path.
- Ended `/itm/` links need `nordt=true` (`endedEbayUrl()` in `app.js` and
  `item.js`); `orig_cvip=true` does not work.
- Final price/bid count come from Trading `GetItem` (`reconcileFinalsForItems`),
  not the viewbids timeline. `updateEndedListingFinals` only touches rows already
  ended — it must never touch a live auction.

## Budget and polling rules

- eBay Browse is ~5,000 calls/day. The background listing poll is 30s (≈2,880/day
  for one active seller); 20s is the ceiling, 15s is over budget. Check the math in
  `docs/architecture.md` before changing any cadence or adding an upstream call.
- Background pollers (listing poll, feedback sweep) run ONLY when
  `APP_ENVIRONMENT === 'prod'` — dev and prod share one database, and a second
  poller doubles upstream calls.
- Finnhub is the sole live-quote provider. Yahoo is historical candles only; do not
  put it back in the quote chain (see `docs/dead-ends.md`).

## Frontend rules

- Public JS is vanilla ESM and CSP-strict: no inline scripts, no eval, no CDNs.
  New behaviour goes in an existing `public/*.js` or a new module imported via
  `<script type="module">`. `frame-src 'self'` (description iframe) is the only
  CSP exception; the iframe stays `sandbox=""`.
- All pages share the theme tokens in `style.css :root`. Never reintroduce
  `--card-bg` / `--text` / `--accent-bg` (they don't exist). Light mode must work
  on every page.
- Keep the global `:focus-visible` outline; don't suppress it. New pill classes
  go in the `@media (pointer: coarse)` list (>=40px hit areas).
- Sort modes live in three places (buttons, `<select>` options, `SORT_MODES`) —
  change all three together.
- Adding a third seller: update `EBAY_SELLER_IDS`, `SELLER_PILL_TO_ID` in
  `public/app.js`, a `.seller-badge-<id>` colour in `style.css`, and the
  "$EBAY / $GME" tagline copy in the brokerage (pairing via `EBAY_SELLER_TICKERS`).
- UI state persists under `hchs.*` `localStorage` keys (list in `docs/dashboard.md`).

## Owner decisions (don't re-litigate)

- The Other Half: stock value only (cash half deferred), ended-only lots, no eBay
  fees/payout lag. Head-to-head seller comparison was CUT — don't add it back.
  The image-treemap was built twice and rejected — don't re-attempt without a
  clear visual win. The absolute-$ "line" chart was removed (replaced by %).
- Item-page chart: one linear price axis; the cumulative-count line, its axis, and
  y-log were cut. The `[Opening rush]` log-time lens is intentional — keep it.
- 0-bid ended auctions are hidden from the ended list (still in the payload).

## Git and PRs

- Develop on the branch the session/task assigns; push there only.
- Commits: scoped style (`feat(admin):`, `fix(viewbids):`), a 1–2 sentence "why"
  body, HEREDOC, with the session's attribution footer.
- One PR per coherent change, opened only when asked; merge when CI is green. `gh`
  is not available — use the `mcp__github__*` tools.
- One implementation per behavior (see global CLAUDE.md): before adding code,
  find what the repo already has and reuse or generalise it; never copy-adapt.
