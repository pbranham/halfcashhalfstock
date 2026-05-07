import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import compression from 'compression';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {
  hasEbayCredentials,
  hasEbayTradingCredentials,
  loadConfig,
  type Config,
} from './config.js';
import { createLogger, type Logger } from './log.js';
import { TtlCache } from './cache.js';
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
}

async function enrichWithBidHistory(deps: Deps, listings: Listing[]): Promise<Listing[]> {
  if (!hasEbayTradingCredentials(deps.config)) return listings;
  const devId = deps.config.EBAY_DEV_ID!;
  const userToken = deps.config.EBAY_USER_TOKEN!;
  return Promise.all(
    listings.map(async (listing) => {
      if (!listing.isAuction || !listing.bidCount) return listing;
      const history = await fetchBidHistory(listing.itemId, listing.bidCount, devId, userToken);
      return { ...listing, lastBidTime: history?.lastBidTime ?? null };
    }),
  );
}

function buildPriceProvider(config: Config, log: Logger): PriceProvider {
  const providers: PriceProvider[] = [];
  if (config.FINNHUB_API_KEY) {
    providers.push(new FinnhubProvider({ apiKey: config.FINNHUB_API_KEY }));
  }
  providers.push(new YahooProvider());
  return new ChainedPriceProvider(providers, { logger: log.child({ component: 'price' }) });
}

function buildDeps(config: Config, log: Logger): Deps {
  const priceCache = new TtlCache<PriceQuote>();
  const listingCache = new TtlCache<Listing[]>();
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

  return { config, log, fetchListings, fetchQuote };
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

  const deps = buildDeps(config, log);
  const app = createApp(deps);
  const server = app.listen(config.PORT, () => {
    log.info('listening', { port: config.PORT, sellerId: config.EBAY_SELLER_ID });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    server.close(() => process.exit(0));
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
