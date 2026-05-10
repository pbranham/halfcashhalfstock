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
  persistSnapshot,
  readBidsForItem,
  readOhlcStats,
  type SnapshotPersistInput,
} from './db/persist.js';
import { EbayAppTokenProvider } from './ebay/auth.js';
import { EbayClient } from './ebay/client.js';
import { listSellerActiveItems, type Listing } from './ebay/seller.js';
import { fetchBidHistory } from './ebay/bid-history.js';
import { FinnhubProvider } from './prices/finnhub.js';
import { YahooProvider } from './prices/yahoo.js';
import { ChainedPriceProvider } from './prices/provider.js';
import type { PriceProvider, PriceQuote } from './prices/types.js';
import { composeSnapshot, type Snapshot } from './snapshot.js';
import { TickerQueue } from './ticker-queue.js';
import { RequestStatsCollector } from './request-stats.js';

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
    fetchListings = () =>
      listingCache.get(config.EBAY_SELLER_ID, LISTINGS_TTL_MS, () =>
        listSellerActiveItems(client, config.EBAY_SELLER_ID),
      );
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

      const snapshot = await snapshotCache.get(`snapshot:${symbol}`, SNAPSHOT_TTL_MS, async () => {
        const [listings, quote] = await Promise.all([deps.fetchListings(), deps.fetchQuote(symbol)]);
        const enriched = await enrichWithBidHistory(deps, listings);
        return composeSnapshot(enriched, quote);
      });
      res
        .status(200)
        .set('Cache-Control', 'public, max-age=15')
        .json(snapshot);
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
      res.status(200).set('Cache-Control', 'public, max-age=15').json({ itemId, bids });
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

  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

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

  const deps = buildDeps(config, log, db, tickerQueue, requestStats);
  const app = createApp(deps);
  const server = app.listen(config.PORT, () => {
    log.info('listening', { port: config.PORT, sellerId: config.EBAY_SELLER_ID });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    if (tickerQueue) tickerQueue.stop();
    if (requestStats) requestStats.stop();
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
