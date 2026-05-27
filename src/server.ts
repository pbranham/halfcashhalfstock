import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import compression from 'compression';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Pool } from 'pg';
import {
  hasEbayCredentials,
  loadConfig,
  resolveEbayTradingUserToken,
  type Config,
} from './config.js';
import { createLogger, type Logger } from './log.js';
import { TtlCache, DbBackedCache } from './cache.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import {
  bulkInsertOhlcData,
  forceMarkEnded,
  getClosingPriceAt,
  persistSnapshot,
  readBidsForItem,
  readEndedListings,
  readListingDetail,
  readListingSnapshots,
  readOhlcStats,
  readStuckListings,
  reconcileItemBids,
  type SnapshotPersistInput,
} from './db/persist.js';
import { EbayAppTokenProvider } from './ebay/auth.js';
import { EbayClient } from './ebay/client.js';
import { listSellerActiveItems, type Listing } from './ebay/seller.js';
import { fetchBidHistory } from './ebay/bid-history.js';
import { normalizeTradingItemId } from './ebay/trading.js';
import { parseViewbids, ViewbidsParseError } from './ebay/viewbids.js';
import { FinnhubProvider } from './prices/finnhub.js';
import { YahooProvider } from './prices/yahoo.js';
import { ChainedPriceProvider } from './prices/provider.js';
import type { PriceProvider, PriceQuote } from './prices/types.js';
import { composeSnapshot, type Snapshot } from './snapshot.js';
import { maskBidder } from './anon.js';
import { TickerQueue } from './ticker-queue.js';
import { RequestStatsCollector } from './request-stats.js';
import { backfillEndedListings } from './ebay/backfill.js';

const LISTINGS_TTL_MS = 30_000;
const PRICE_TTL_MS = 30_000;
const SNAPSHOT_TTL_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function shouldSkipMetrics(reqPath: string): boolean {
  return (
    reqPath === '/healthz' ||
    reqPath === '/admin' ||
    reqPath.startsWith('/admin.') ||
    reqPath.startsWith('/api/admin/')
  );
}

interface Deps {
  config: Config;
  log: Logger;
  fetchListings: () => Promise<Listing[]>;
  fetchQuote: (symbol: string) => Promise<PriceQuote>;
  db?: Pool | null;
  tickerQueue?: TickerQueue | null;
  requestStats?: RequestStatsCollector | null;
}

async function enrichWithBidHistory(deps: Deps, listings: Listing[]): Promise<Listing[]> {
  const userToken = resolveEbayTradingUserToken(deps.config);
  const devId = deps.config.EBAY_DEV_ID;
  const tradingEnabled = Boolean(devId && userToken);

  const enriched: { listing: Listing; bids: SnapshotPersistInput['bids'] }[] = await Promise.all(
    listings.map(async (listing) => {
      if (!tradingEnabled || !listing.isAuction || !listing.bidCount) {
        return { listing, bids: null };
      }
      const history = await fetchBidHistory(listing.itemId, listing.bidCount, devId!, userToken!, deps.db);
      return {
        listing: { ...listing, lastBidTime: history?.lastBidTime ?? null },
        bids: history?.bids ?? null,
      };
    }),
  );

  if (deps.db) {
    persistSnapshot(deps.db, enriched).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error('db persistence failed', { error: message });
    });
  }

  return enriched.map(({ listing }) => listing);
}

function buildPriceProvider(config: Config, log: Logger): PriceProvider {
  const providers: PriceProvider[] = [];
  if (config.FINNHUB_API_KEY) {
    providers.push(new FinnhubProvider({ apiKey: config.FINNHUB_API_KEY }));
  }
  providers.push(new YahooProvider());
  return new ChainedPriceProvider(providers, { logger: log.child({ component: 'price' }) });
}

function buildDeps(
  config: Config,
  log: Logger,
  db: Pool | null,
  tickerQueue: TickerQueue | null = null,
  requestStats: RequestStatsCollector | null = null,
): Deps {
  const priceCache = db ? new DbBackedCache<PriceQuote>(db) : new TtlCache<PriceQuote>();
  const listingCache = db ? new DbBackedCache<Listing[]>(db) : new TtlCache<Listing[]>();
  const priceProvider = buildPriceProvider(config, log);

  const fetchQuote = (symbol: string): Promise<PriceQuote> =>
    priceCache.get(symbol, PRICE_TTL_MS, () => priceProvider.getQuote(symbol));

  let fetchListings: () => Promise<Listing[]>;
  if (hasEbayCredentials(config)) {
    const tokenProvider = new EbayAppTokenProvider({
      appId: config.EBAY_APP_ID!,
      certId: config.EBAY_CERT_ID!,
    });
    const client = new EbayClient({
      tokenProvider,
      marketplaceId: config.EBAY_MARKETPLACE_ID,
    });
    fetchListings = async () => {
      // Per-seller cache keys so each seller's poll caches independently.
      const perSeller = await Promise.all(
        config.sellerIds.map((sellerId) =>
          listingCache.get(sellerId, LISTINGS_TTL_MS, () =>
            listSellerActiveItems(client, sellerId),
          ),
        ),
      );
      return perSeller.flat();
    };
  } else {
    fetchListings = () => {
      throw new Error('eBay credentials are not configured (set EBAY_APP_ID and EBAY_CERT_ID)');
    };
  }

  return { config, log, fetchListings, fetchQuote, db, tickerQueue, requestStats };
}

export function createApp(deps: Deps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'https://i.ebayimg.com', 'https://*.ebayimg.com', 'data:'],
          'connect-src': ["'self'"],
          'manifest-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
    }),
  );
  app.use(compression());

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (deps.requestStats && !shouldSkipMetrics(req.path)) {
      const startTime = deps.requestStats.recordStart();
      const userAgent = req.headers['user-agent'];
      const originalSend = res.send;
      res.send = function (data: unknown) {
        deps.requestStats?.recordEnd(startTime, req.path, res.statusCode, req.ip ?? '', userAgent);
        return originalSend.call(this, data);
      };
    }
    next();
  });

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send('ok');
  });

  const snapshotCache = new TtlCache<Snapshot>();

  app.get('/api/snapshot', apiLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim().toUpperCase() : '';
      const symbol = rawSymbol && /^[A-Z][A-Z0-9.\-:]{0,19}$/.test(rawSymbol) ? rawSymbol : deps.config.STOCK_SYMBOL;

      // Window of ended listings to include. Defaults to 14 days (the
      // "Recently ended" view); the dashboard's "All time" toggle passes a
      // much larger value. Cap to ~100 years to keep the range sane.
      const rawEndedDays = typeof req.query.endedDays === 'string'
        ? Number.parseInt(req.query.endedDays, 10)
        : 14;
      const endedDays = Number.isFinite(rawEndedDays) && rawEndedDays > 0 && rawEndedDays <= 36500
        ? rawEndedDays
        : 14;

      if (deps.tickerQueue && !deps.tickerQueue.isKnown(symbol)) {
        if (deps.tickerQueue.isBlacklisted(symbol)) {
          res.status(400).json({ error: 'invalid_ticker', symbol });
          return;
        }
        const result = await deps.tickerQueue.submitForValidation(symbol);
        if (!result.valid) {
          const status = result.error === 'invalid_ticker' ? 400 : 503;
          res.status(status).json({ error: result.error, symbol });
          return;
        }
      }

      const snapshot = await snapshotCache.get(`snapshot:${symbol}:ed${endedDays}`, SNAPSHOT_TTL_MS, async () => {
        const [listings, quote] = await Promise.all([deps.fetchListings(), deps.fetchQuote(symbol)]);
        const enriched = await enrichWithBidHistory(deps, listings);
        const ended = deps.db ? await readEndedListings(deps.db, endedDays) : [];
        // For end-time pricing, look up each USD-denominated ended item's
        // EBAY (or selected ticker) close at the moment it ended. Issue
        // the queries in parallel via Promise.all so a wide "All time"
        // window doesn't serialize ~50+ round-trips and hold the pg pool
        // long enough to stall concurrent snapshot requests. Each query
        // is itself a primary-key range scan, so they all return quickly
        // — the bottleneck was the sequential await chain.
        const endTimeClosesByItemId = new Map<string, number | null>();
        if (deps.db) {
          const db = deps.db;
          const usdEnded = ended.filter((e) => e.currency === 'USD');
          const closes = await Promise.all(
            usdEnded.map((e) => getClosingPriceAt(db, quote.symbol, new Date(e.endedAt))),
          );
          usdEnded.forEach((e, i) => {
            endTimeClosesByItemId.set(e.itemId, closes[i] ?? null);
          });
        }
        return composeSnapshot(enriched, quote, ended, endTimeClosesByItemId);
      });
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=15')
        .json(snapshot);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/item', apiLimiter, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.db) {
      res.status(503).json({ error: 'item_unavailable', detail: 'database not configured' });
      return;
    }
    const itemId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
      res.status(400).json({ error: 'bad_request', detail: 'missing or invalid id' });
      return;
    }
    try {
      const [listing, bids, snapshots] = await Promise.all([
        readListingDetail(deps.db, itemId),
        readBidsForItem(deps.db, itemId),
        readListingSnapshots(deps.db, itemId),
      ]);
      if (!listing) {
        res.status(404).json({ error: 'not_found', detail: 'item not seen by this server' });
        return;
      }
      // Mask bidder usernames at the API boundary. When we're the seller,
      // Trading API returns full IDs; eBay's own public bid-history page
      // shows them masked, so the public dashboard does the same.
      const maskedBids = bids.map((b) => ({ ...b, bidder: maskBidder(b.bidder) }));
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=15')
        .json({ listing, bids: maskedBids, snapshots, asOf: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/history', apiLimiter, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.db) {
      res.status(503).json({ error: 'history_unavailable', detail: 'database not configured' });
      return;
    }
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId.trim() : '';
    if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
      res.status(400).json({ error: 'bad_request', detail: 'missing or invalid itemId' });
      return;
    }
    try {
      const bids = await readBidsForItem(deps.db, itemId);
      const maskedBids = bids.map((b) => ({ ...b, bidder: maskBidder(b.bidder) }));
      res.status(200).set('Cache-Control', 'public, max-age=15').json({ itemId, bids: maskedBids });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/ohlc', apiLimiter, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.db) {
      res.status(503).json({ error: 'ohlc_unavailable', detail: 'database not configured' });
      return;
    }
    const ticker = typeof req.query.ticker === 'string' ? req.query.ticker.trim().toUpperCase() : '';
    const daysStr = typeof req.query.days === 'string' ? req.query.days.trim() : '7';
    if (!ticker || !/^[A-Z][A-Z0-9.\-:]{0,19}$/.test(ticker)) {
      res.status(400).json({ error: 'bad_request', detail: 'missing or invalid ticker' });
      return;
    }
    const days = Math.max(1, Math.min(30, Number.parseInt(daysStr, 10) || 7));
    try {
      const now = new Date();
      const startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const { readOhlcData } = await import('./db/persist.js');
      const candles = await readOhlcData(deps.db, ticker, startTime, now);
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=60')
        .json({ ticker, days, candles, asOf: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  if (deps.config.ENABLE_DEBUG_ENDPOINTS) {
    app.get('/api/debug/ohlc-stats', apiLimiter, async (_req: Request, res: Response, next: NextFunction) => {
      if (!deps.db) {
        res.status(503).json({ error: 'debug_unavailable', detail: 'database not configured' });
        return;
      }
      try {
        const stats = await readOhlcStats(deps.db);
        const queueStatus = deps.tickerQueue?.getStatus() ?? null;
        res.status(200).set('Cache-Control', 'no-store').json({
          stats,
          queue: queueStatus,
          asOf: new Date().toISOString(),
        });
      } catch (err) {
        next(err);
      }
    });

  }

  const requireAdminToken = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.config.ADMIN_TOKEN) {
      res.status(503).json({ error: 'admin_unavailable', detail: 'ADMIN_TOKEN not configured' });
      return;
    }
    const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const provided = headerToken || queryToken;
    if (!provided || provided !== deps.config.ADMIN_TOKEN) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.get('/api/admin/stats', apiLimiter, requireAdminToken, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.db) {
      res.status(503).json({ error: 'stats_unavailable', detail: 'database not configured' });
      return;
    }
    try {
      const hoursStr = typeof req.query.hours === 'string' ? req.query.hours.trim() : '24';
      const hours = Math.max(1, Math.min(2160, Number.parseInt(hoursStr, 10) || 24));
      const envFilter = typeof req.query.environment === 'string' ? req.query.environment.trim() : '';
      const requestedInterval = typeof req.query.interval === 'string' ? req.query.interval.trim() : '';
      let interval: '5min' | 'hour' | 'day';
      if (requestedInterval === '5min' || requestedInterval === 'hour' || requestedInterval === 'day') {
        interval = requestedInterval;
      } else if (hours <= 48) {
        interval = '5min';
      } else if (hours <= 720) {
        interval = 'hour';
      } else {
        interval = 'day';
      }
      const sessionInterval = interval === '5min' ? 'hour' : interval;

      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const params: unknown[] = [since, interval];
      const sessionParams: unknown[] = [since, sessionInterval];
      let envClause = '';
      if (envFilter && /^[a-zA-Z0-9_-]{1,32}$/.test(envFilter)) {
        envClause = ' AND environment = $3';
        params.push(envFilter);
        sessionParams.push(envFilter);
      }

      const hourly = await deps.db.query(
        `
        SELECT hour, endpoint, status_code, environment, request_count, unique_ips,
               max_concurrent, avg_concurrent, min_concurrent,
               bot_count, mobile_count, desktop_count, other_count
        FROM request_stats
        WHERE hour >= $1 AND interval = $2${envClause}
        ORDER BY hour DESC, environment, endpoint, status_code
        `,
        params,
      );
      const ipEnvClause = envFilter && /^[a-zA-Z0-9_-]{1,32}$/.test(envFilter)
        ? ' AND environment = $2'
        : '';
      const ipParams: unknown[] = [since];
      if (ipEnvClause) ipParams.push(envFilter);

      const summaryRequests = await deps.db.query(
        `
        SELECT environment,
               SUM(request_count)::INTEGER AS total_requests,
               MAX(max_concurrent)::INTEGER AS peak_concurrent,
               AVG(avg_concurrent)::NUMERIC(10,2) AS avg_concurrent,
               SUM(bot_count)::INTEGER AS bot_count,
               SUM(mobile_count)::INTEGER AS mobile_count,
               SUM(desktop_count)::INTEGER AS desktop_count,
               SUM(other_count)::INTEGER AS other_count
        FROM request_stats
        WHERE hour >= $1 AND interval = $2${envClause}
        GROUP BY environment
        ORDER BY environment
        `,
        params,
      );
      const summaryIps = await deps.db.query(
        `
        SELECT environment, COUNT(DISTINCT ip_hash)::INTEGER AS unique_ips
        FROM seen_ips
        WHERE hour >= $1${ipEnvClause}
        GROUP BY environment
        ORDER BY environment
        `,
        ipParams,
      );
      const ipsByEnv = new Map(summaryIps.rows.map((r: { environment: string; unique_ips: number }) => [r.environment, r.unique_ips]));
      const summary = {
        rows: summaryRequests.rows.map((row: { environment: string }) => ({
          ...row,
          unique_ips: ipsByEnv.get(row.environment) ?? 0,
        })),
      };
      const sessions = await deps.db.query(
        `
        SELECT environment,
               SUM(session_count)::INTEGER AS total_sessions,
               SUM(bounce_count)::INTEGER AS bounce_count,
               CASE WHEN SUM(session_count) > 0
                    THEN (SUM(total_duration_seconds) / SUM(session_count))::NUMERIC(10,2)
                    ELSE 0 END AS avg_duration_seconds,
               CASE WHEN SUM(session_count) > 0
                    THEN (SUM(total_requests)::NUMERIC / SUM(session_count))::NUMERIC(10,2)
                    ELSE 0 END AS avg_requests_per_session
        FROM session_stats
        WHERE hour >= $1 AND interval = $2${envClause}
        GROUP BY environment
        ORDER BY environment
        `,
        sessionParams,
      );
      const environments = await deps.db.query(
        `SELECT DISTINCT environment FROM request_stats ORDER BY environment`,
      );
      res.status(200).set('Cache-Control', 'no-store').json({
        summary: summary.rows,
        sessions: sessions.rows,
        hourly: hourly.rows,
        environments: environments.rows.map((r: { environment: string }) => r.environment),
        currentEnvironment: deps.config.APP_ENVIRONMENT ?? deps.config.NODE_ENV,
        windowHours: hours,
        interval,
        asOf: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/live', apiLimiter, requireAdminToken, (_req: Request, res: Response) => {
    if (!deps.requestStats) {
      res.status(503).json({ error: 'live_unavailable', detail: 'request stats not configured' });
      return;
    }
    res.status(200).set('Cache-Control', 'no-store').json({
      ...deps.requestStats.getLiveSnapshot(),
      asOf: new Date().toISOString(),
    });
  });

  // Global JSON parser stays tight at 10kb, but skips the cleanup route: its
  // import_viewbids_html action accepts a pasted eBay page (100KB+).
  const globalJson = express.json({ limit: '10kb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/admin/cleanup') return next();
    return globalJson(req, res, next);
  });

  app.post('/api/admin/cleanup', express.json({ limit: '4mb' }), apiLimiter, requireAdminToken, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.db) {
      res.status(503).json({ error: 'cleanup_unavailable', detail: 'database not configured' });
      return;
    }
    try {
      const body = req.body as {
        action?: string;
        environment?: string;
        from?: string;
        to?: string;
        itemId?: string;
        html?: string;
        tickers?: unknown;
        range?: string;
      } | undefined;
      const action = body?.action;

      if (action === 'delete_environment') {
        const env = body?.environment?.trim() ?? '';
        if (!env || !/^[a-zA-Z0-9_-]{1,32}$/.test(env)) {
          res.status(400).json({ error: 'bad_request', detail: 'invalid environment' });
          return;
        }
        const reqDel = await deps.db.query('DELETE FROM request_stats WHERE environment = $1', [env]);
        const sessDel = await deps.db.query('DELETE FROM session_stats WHERE environment = $1', [env]);
        const ipDel = await deps.db.query('DELETE FROM seen_ips WHERE environment = $1', [env]);
        res.status(200).json({
          action: 'delete_environment',
          environment: env,
          deleted: {
            request_stats: reqDel.rowCount ?? 0,
            session_stats: sessDel.rowCount ?? 0,
            seen_ips: ipDel.rowCount ?? 0,
          },
        });
        return;
      }

      if (action === 'rename_environment') {
        const from = body?.from?.trim() ?? '';
        const to = body?.to?.trim() ?? '';
        if (!from || !/^[a-zA-Z0-9_-]{1,32}$/.test(from) || !to || !/^[a-zA-Z0-9_-]{1,32}$/.test(to)) {
          res.status(400).json({ error: 'bad_request', detail: 'invalid from/to environment' });
          return;
        }
        const reqUpd = await deps.db.query(
          `UPDATE request_stats SET environment = $2 WHERE environment = $1
           AND NOT EXISTS (
             SELECT 1 FROM request_stats r2
             WHERE r2.hour = request_stats.hour
               AND r2.endpoint = request_stats.endpoint
               AND r2.status_code = request_stats.status_code
               AND r2.environment = $2
               AND r2.interval = request_stats.interval
           )`,
          [from, to],
        );
        await deps.db.query('DELETE FROM request_stats WHERE environment = $1', [from]);
        const sessUpd = await deps.db.query(
          `UPDATE session_stats SET environment = $2 WHERE environment = $1
           AND NOT EXISTS (
             SELECT 1 FROM session_stats s2
             WHERE s2.hour = session_stats.hour
               AND s2.environment = $2
               AND s2.interval = session_stats.interval
           )`,
          [from, to],
        );
        await deps.db.query('DELETE FROM session_stats WHERE environment = $1', [from]);
        const ipUpd = await deps.db.query(
          `UPDATE seen_ips SET environment = $2 WHERE environment = $1
           AND NOT EXISTS (
             SELECT 1 FROM seen_ips i2
             WHERE i2.ip_hash = seen_ips.ip_hash
               AND i2.hour = seen_ips.hour
               AND i2.environment = $2
           )`,
          [from, to],
        );
        await deps.db.query('DELETE FROM seen_ips WHERE environment = $1', [from]);
        res.status(200).json({
          action: 'rename_environment',
          from,
          to,
          updated: {
            request_stats: reqUpd.rowCount ?? 0,
            session_stats: sessUpd.rowCount ?? 0,
            seen_ips: ipUpd.rowCount ?? 0,
          },
        });
        return;
      }

      if (action === 'restore_all_bids') {
        const result = await deps.db.query(
          'UPDATE bids SET removed_at = NULL WHERE removed_at IS NOT NULL',
        );
        res.status(200).json({
          action: 'restore_all_bids',
          restored: result.rowCount ?? 0,
        });
        return;
      }

      if (action === 'restore_listings') {
        const result = await deps.db.query(
          'UPDATE listings SET ended_at = NULL WHERE ended_at IS NOT NULL',
        );
        res.status(200).json({
          action: 'restore_listings',
          restored: result.rowCount ?? 0,
        });
        return;
      }

      if (action === 'count_removed_bids') {
        const result = await deps.db.query<{ count: string }>(
          'SELECT COUNT(*)::TEXT AS count FROM bids WHERE removed_at IS NOT NULL',
        );
        res.status(200).json({
          action: 'count_removed_bids',
          count: Number(result.rows[0]?.count ?? '0'),
        });
        return;
      }

      if (action === 'backfill_ended_now') {
        const userToken = resolveEbayTradingUserToken(deps.config);
        if (!deps.config.EBAY_DEV_ID || !userToken) {
          res.status(503).json({
            error: 'backfill_unavailable',
            detail: 'EBAY_DEV_ID and EBAY_USER_TOKEN must be set',
          });
          return;
        }
        const result = await backfillEndedListings(
          deps.db,
          deps.config.EBAY_DEV_ID,
          userToken,
          deps.log,
        );
        res.status(200).json({ action: 'backfill_ended_now', ...result });
        return;
      }

      if (action === 'list_stuck_listings') {
        const stuck = await readStuckListings(deps.db);
        res.status(200).json({ action: 'list_stuck_listings', count: stuck.length, items: stuck });
        return;
      }

      if (action === 'force_mark_ended') {
        const itemId = (body?.itemId ?? '').trim();
        if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
          res.status(400).json({ error: 'bad_request', detail: 'missing or invalid itemId' });
          return;
        }
        const marked = await forceMarkEnded(deps.db, itemId);
        res.status(200).json({ action: 'force_mark_ended', itemId, marked });
        return;
      }

      if (action === 'rebackfill_one') {
        const itemId = (body?.itemId ?? '').trim();
        if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
          res.status(400).json({ error: 'bad_request', detail: 'missing or invalid itemId' });
          return;
        }
        const userToken = resolveEbayTradingUserToken(deps.config);
        if (!deps.config.EBAY_DEV_ID || !userToken) {
          res.status(503).json({ error: 'rebackfill_unavailable', detail: 'Trading API not configured' });
          return;
        }
        await deps.db.query(
          `UPDATE listings SET last_backfilled_at = NULL, backfill_attempts = 0 WHERE item_id = $1`,
          [itemId],
        );
        const result = await backfillEndedListings(deps.db, deps.config.EBAY_DEV_ID, userToken, deps.log);
        res.status(200).json({ action: 'rebackfill_one', itemId, ...result });
        return;
      }

      if (action === 'inspect_bid_history') {
        const itemId = (body?.itemId ?? '').trim();
        if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
          res.status(400).json({ error: 'bad_request', detail: 'missing or invalid itemId' });
          return;
        }
        const userToken = resolveEbayTradingUserToken(deps.config);
        if (!deps.config.EBAY_DEV_ID || !userToken) {
          res.status(503).json({
            error: 'inspect_unavailable',
            detail: 'EBAY_DEV_ID and EBAY_USER_TOKEN must be set',
          });
          return;
        }
        try {
          const { getItemBidHistory } = await import('./ebay/trading.js');
          const history = await getItemBidHistory(itemId, deps.config.EBAY_DEV_ID, userToken);
          const dbState = await deps.db.query<{
            current_price_usd: string;
            current_bid_count: number;
            ended_at: Date | null;
            last_backfilled_at: Date | null;
            backfill_attempts: number;
          }>(
            `SELECT current_price_usd, current_bid_count, ended_at,
                    last_backfilled_at, backfill_attempts
             FROM listings WHERE item_id = $1`,
            [itemId],
          );
          const dbBids = await deps.db.query<{ count: string }>(
            `SELECT COUNT(*)::TEXT AS count FROM bids WHERE item_id = $1`,
            [itemId],
          );
          const dbRow = dbState.rows[0];
          res.status(200).json({
            action: 'inspect_bid_history',
            itemId,
            api: {
              bidCount: history.bidCount,
              currentPrice: history.currentPrice,
              currentPriceType: typeof history.currentPrice,
              bidsReturned: history.bids.length,
              bidsSample: history.bids.slice(0, 5),
              maxBidAmount: history.bids.length > 0 ? Math.max(...history.bids.map((b) => b.bidAmount)) : 0,
            },
            db: {
              currentPriceUsd: dbRow ? Number(dbRow.current_price_usd) : null,
              currentBidCount: dbRow?.current_bid_count ?? null,
              endedAt: dbRow?.ended_at ? dbRow.ended_at.toISOString() : null,
              lastBackfilledAt: dbRow?.last_backfilled_at ? dbRow.last_backfilled_at.toISOString() : null,
              backfillAttempts: dbRow?.backfill_attempts ?? null,
              totalBidRows: Number(dbBids.rows[0]?.count ?? '0'),
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(200).json({
            action: 'inspect_bid_history',
            itemId,
            error: message,
          });
        }
        return;
      }

      if (action === 'reset_backfill_attempts') {
        const result = await deps.db.query(
          `UPDATE listings
           SET backfill_attempts = 0, last_backfilled_at = NULL
           WHERE ended_at IS NOT NULL`,
        );
        res.status(200).json({
          action: 'reset_backfill_attempts',
          reset: result.rowCount ?? 0,
        });
        return;
      }

      if (action === 'delete_before') {
        const beforeStr = body?.environment ?? '';
        const before = new Date(beforeStr);
        if (Number.isNaN(before.getTime())) {
          res.status(400).json({ error: 'bad_request', detail: 'invalid date' });
          return;
        }
        const reqDel = await deps.db.query('DELETE FROM request_stats WHERE hour < $1', [before]);
        const sessDel = await deps.db.query('DELETE FROM session_stats WHERE hour < $1', [before]);
        const ipDel = await deps.db.query('DELETE FROM seen_ips WHERE hour < $1', [before]);
        res.status(200).json({
          action: 'delete_before',
          before: before.toISOString(),
          deleted: {
            request_stats: reqDel.rowCount ?? 0,
            session_stats: sessDel.rowCount ?? 0,
            seen_ips: ipDel.rowCount ?? 0,
          },
        });
        return;
      }

      if (action === 'list_ended_for_reconcile') {
        // Just list the ended items with current state. Auto-fetching viewbids
        // pages from this server's IP has never succeeded (eBay's datacenter-IP
        // challenge is universal), so the UI goes straight to paste mode for
        // every item — no 2-minute wait for guaranteed failures.
        const ended = await readEndedListings(deps.db, 3650);
        const items = ended.map((listing) => ({
          itemId: listing.itemId,
          numericId: normalizeTradingItemId(listing.itemId),
          title: listing.title,
          currentPriceUsd: listing.finalPriceUsd,
          currentBidCount: listing.finalBidCount,
        }));
        res.status(200).json({ action: 'list_ended_for_reconcile', count: items.length, items });
        return;
      }

      if (action === 'backfill_ohlc_history') {
        // Pulls daily OHLC candles from Yahoo and stores them under
        // interval='1d', which is exempt from purgeOldOhlcData and therefore
        // accumulates the long-running history we need to value ended
        // auctions at the EBAY close on the day they ended.
        const tickersIn = Array.isArray(body?.tickers) ? body.tickers : ['EBAY', 'GME'];
        const tickers = tickersIn
          .filter((t): t is string => typeof t === 'string' && /^[A-Z][A-Z0-9.\-:]{0,19}$/.test(t))
          .slice(0, 10);
        if (tickers.length === 0) {
          res.status(400).json({ error: 'bad_request', detail: 'no valid tickers' });
          return;
        }
        const range = typeof body?.range === 'string' && /^\d{1,3}(d|mo|y)$/.test(body.range)
          ? body.range
          : '90d';
        const yahoo = new YahooProvider();
        const perTicker: Array<{ ticker: string; candles: number; inserted: number; error?: string }> = [];
        for (const ticker of tickers) {
          try {
            const candles = await yahoo.getHistoricalCandles(ticker, '1d', range);
            const inserted = candles.length === 0
              ? 0
              : await bulkInsertOhlcData(deps.db, ticker, candles, 'yahoo', '1d');
            perTicker.push({ ticker, candles: candles.length, inserted });
          } catch (err) {
            perTicker.push({
              ticker,
              candles: 0,
              inserted: 0,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        res.status(200).json({ action: 'backfill_ohlc_history', range, results: perTicker });
        return;
      }

      if (action === 'import_viewbids_html') {
        const itemId = (body?.itemId ?? '').trim();
        if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
          res.status(400).json({ error: 'bad_request', detail: 'missing or invalid itemId' });
          return;
        }
        const html = body?.html ?? '';
        if (typeof html !== 'string' || html.trim().length === 0 || html.length > 3_000_000) {
          res.status(400).json({ error: 'bad_request', detail: 'missing or oversized html' });
          return;
        }
        try {
          const parsed = parseViewbids(html);
          // When the page tells us the auction has zero active bids, pass
          // the starting-bid (carried as finalPriceUsd) so the listing's
          // current_price drops back to the starting floor.
          const r = await reconcileItemBids(
            deps.db,
            itemId,
            parsed.bids,
            parsed.retractedBids,
            parsed.knownZeroBids
              ? { knownZeroBids: true, zeroBidsPriceUsd: parsed.finalPriceUsd }
              : {},
          );
          res.status(200).json({
            action: 'import_viewbids_html',
            itemId,
            status: 'imported',
            deleted: r.deleted,
            inserted: r.inserted,
            retractedInserted: r.retractedInserted,
            finalPriceUsd: r.finalPriceUsd,
            bidCount: r.bidCount,
            retractedCount: parsed.retractedBids.length,
            knownZeroBids: parsed.knownZeroBids ?? false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(200).json({
            action: 'import_viewbids_html',
            itemId,
            status: 'parse-failed',
            error: message,
            diagnostics: err instanceof ViewbidsParseError ? err.diagnostics : undefined,
          });
        }
        return;
      }

      res.status(400).json({ error: 'bad_request', detail: 'unknown action' });
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'unknown error';
    const stack = err instanceof Error ? err.stack : undefined;
    deps.log.error('request failed', { error: message, stack });
    if (res.headersSent) return;
    const body: { error: string; detail?: string } = { error: 'service_unavailable' };
    if (deps.config.NODE_ENV !== 'production') body.detail = message;
    res.status(503).json(body);
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'halfcashhalfstock' },
  });

  if (!hasEbayCredentials(config)) {
    log.warn('eBay credentials missing; /api/snapshot will return 503 until set');
  }

  let db: Pool | null = null;
  if (config.DATABASE_URL) {
    db = createPool(config.DATABASE_URL);
    try {
      await runMigrations(db, log);
      log.info('database ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('database initialization failed; continuing without persistence', {
        error: message,
      });
      await db.end().catch(() => {});
      db = null;
    }
  } else {
    log.warn('DATABASE_URL not set; bid history will not be persisted');
  }

  let tickerQueue: TickerQueue | null = null;
  if (db) {
    tickerQueue = new TickerQueue({
      db,
      yahoo: new YahooProvider(),
      priceProvider: buildPriceProvider(config, log),
      log,
    });
    await tickerQueue.start();
  }

  let requestStats: RequestStatsCollector | null = null;
  if (db) {
    const environment = config.APP_ENVIRONMENT ?? config.NODE_ENV;
    requestStats = new RequestStatsCollector(db, environment);
    requestStats.start();
    requestStats.purgeOldStats().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('request stats purge failed', { error: message });
    });
  }

  let backfillInterval: NodeJS.Timeout | null = null;
  const backfillUserToken = resolveEbayTradingUserToken(config);
  if (db && config.EBAY_DEV_ID && backfillUserToken) {
    const devIdLocal = config.EBAY_DEV_ID;
    const tokenLocal = backfillUserToken;
    const dbLocal = db;
    const runBackfill = (): void => {
      backfillEndedListings(dbLocal, devIdLocal, tokenLocal, log).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('backfill loop error', { error: message });
      });
    };
    backfillInterval = setInterval(runBackfill, 60_000);
    backfillInterval.unref();
    runBackfill();
  }

  const deps = buildDeps(config, log, db, tickerQueue, requestStats);
  const app = createApp(deps);
  const server = app.listen(config.PORT, () => {
    log.info('listening', { port: config.PORT, sellerIds: config.sellerIds });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    if (tickerQueue) tickerQueue.stop();
    if (requestStats) requestStats.stop();
    if (backfillInterval) clearInterval(backfillInterval);
    server.close(() => {
      if (db) {
        db.end().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
