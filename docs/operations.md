# Operations reference

## Deployments

Production `https://halfcashhalfstock.onrender.com`, dev
`https://halfcashhalfstock-dev.onrender.com` (URLs recorded by the owner; not
verifiable from the repo — check the Render dashboard for which branch each
service deploys). CI (`.github/workflows`) runs lint, typecheck, test, build
on pushes to `main` and on PRs. Setup, env vars, and Docker/Render steps:
`README.md`.

## Operational health

- **`GET /api/health`** (unauthenticated, no data exposure): `{status:
  ok|degraded|error, checks, asOf}`. Checks: `db` (live `SELECT 1`;
  failure → status `error` + HTTP 503), `liveData` (the DbBackedCache
  stale-fallback flag), `listingPoll` / `feedbackSweep` heartbeats
  (`not-running` is NORMAL outside prod; `stalled` = ran before then
  went silent past its cadence — 150s for the 30s poll, ~2h for the
  hourly sweep), and `tradingAuth` (below). Point uptime monitors here
  rather than `/healthz` (bare liveness).
- **Trading token expiry detection**: eBay user tokens die silently
  (~18 months) — the API answers `Ack=Failure` on every call.
  `reconcile-finals.ts` keeps a module-level consecutive-failure streak
  (any healthy response resets it); at 5 it warn-logs once and
  `/api/health` reports `tradingAuth: suspect`. Heartbeat getters live
  in their modules (`getListingPollHeartbeat`, `getFeedbackSweepHeartbeat`,
  `getTradingAuthFailureStreak`).
