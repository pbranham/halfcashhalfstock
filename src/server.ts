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

const LISTINGS_TTL_MS = 30_000;
const PRICE_TTL_MS = 30_000;
const SNAPSHOT_TTL_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

interface Deps {
  config: Config;
  log: Logger;
  fetchListings: () => Promise<Listing[]>;
  fetchQuote: (symbol: string) => Promise<PriceQuote>;
  db?: Pool | null;
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

function buildDeps(config: Config, log: Logger, db: Pool | null): Deps {
  const priceCache = db ? new DbBackedCache<PriceQuote>(db) : new TtlCache<PriceQuote>();
  const listingCache = db ? new DbBackedCache<Listing[]>(db) : new TtlCache<Listing[]>();
  const priceProvider = buildPriceProvider(config, log);

  const fetchQuote = (symbol: string): Promise<PriceQuote> =>
    priceCache.get(symbol, PRICE_TTL_MS, () =>
      priceProvider.getQuote(symbol),
    );

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

  return { config, log, fetchListings, fetchQuote, db };
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
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
    }),
  );
  app.use(compression());

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
      const symbol = rawSymbol && /^[A-Z]{1,10}$/.test(rawSymbol) ? rawSymbol : deps.config.STOCK_SYMBOL;

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

  const deps = buildDeps(config, log, db);
  const app = createApp(deps);
  const server = app.listen(config.PORT, () => {
    log.info('listening', { port: config.PORT, sellerId: config.EBAY_SELLER_ID });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
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
