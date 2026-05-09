import type { Pool } from 'pg';
import type { Logger } from './log.js';
import type { YahooProvider } from './prices/yahoo.js';
import { storeOhlcData, bulkInsertOhlcData, purgeOldOhlcData } from './db/persist.js';

export type ValidationResult =
  | { valid: true; symbol: string; price: number }
  | { valid: false; symbol: string; error: 'invalid_ticker' | 'fetch_failed' | 'timeout' };

export interface TickerQueueOptions {
  db: Pool;
  yahoo: YahooProvider;
  log: Logger;
  alwaysActiveTickers?: string[];
  passiveIntervalMs?: number;
  activeIntervalMs?: number;
  maxWaitMs?: number;
  negativeCacheTtlMs?: number;
}

interface PendingResolver {
  resolve: (r: ValidationResult) => void;
  timeoutHandle: NodeJS.Timeout;
}

export class TickerQueue {
  readonly #db: Pool;
  readonly #yahoo: YahooProvider;
  readonly #log: Logger;
  readonly #alwaysActive: Set<string>;
  readonly #passiveIntervalMs: number;
  readonly #activeIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #negativeCacheTtlMs: number;

  readonly #activeQueue = new Set<string>();
  readonly #negativeCache = new Map<string, number>();
  readonly #pendingResolvers = new Map<string, PendingResolver[]>();
  readonly #knownTickers = new Set<string>();

  #passiveTimer: NodeJS.Timeout | null = null;
  #activeTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #lastBackfillAt: Date | null = null;
  #backfillStatus: 'pending' | 'success' | 'partial' | 'failed' = 'pending';

  constructor(options: TickerQueueOptions) {
    this.#db = options.db;
    this.#yahoo = options.yahoo;
    this.#log = options.log.child({ component: 'ticker-queue' });
    this.#alwaysActive = new Set(options.alwaysActiveTickers ?? ['EBAY', 'GME']);
    this.#passiveIntervalMs = options.passiveIntervalMs ?? 30_000;
    this.#activeIntervalMs = options.activeIntervalMs ?? 2_500;
    this.#maxWaitMs = options.maxWaitMs ?? 4_000;
    this.#negativeCacheTtlMs = options.negativeCacheTtlMs ?? 60 * 60 * 1000;

    for (const t of this.#alwaysActive) this.#knownTickers.add(t);
  }

  async start(): Promise<void> {
    await this.refreshKnownTickers();

    void this.initialBackfill();

    void this.runPassivePoll();
    this.#passiveTimer = setInterval(() => {
      void this.runPassivePoll();
    }, this.#passiveIntervalMs);
    this.#activeTimer = setInterval(() => {
      void this.runActiveDrain();
    }, this.#activeIntervalMs);
    this.#log.info('ticker queue started', {
      alwaysActive: Array.from(this.#alwaysActive),
      passiveMs: this.#passiveIntervalMs,
      activeMs: this.#activeIntervalMs,
    });
  }

  getStatus(): { lastBackfillAt: string | null; backfillStatus: string; knownTickers: string[] } {
    return {
      lastBackfillAt: this.#lastBackfillAt ? this.#lastBackfillAt.toISOString() : null,
      backfillStatus: this.#backfillStatus,
      knownTickers: Array.from(this.#knownTickers).sort(),
    };
  }

  private async initialBackfill(): Promise<void> {
    let failures = 0;
    let successes = 0;
    let skipped = 0;
    for (const ticker of this.#alwaysActive) {
      const result = await this.triggerBackfill(ticker);
      if (result === 'fresh') skipped += 1;
      else if (result === 'ok') successes += 1;
      else failures += 1;
    }
    try {
      const purged = await purgeOldOhlcData(this.#db);
      if (purged > 0) this.#log.info('purged old ohlc data', { count: purged });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('purge failed', { error: message });
    }

    this.#lastBackfillAt = new Date();
    if (failures === 0) {
      this.#backfillStatus = 'success';
    } else if (successes === 0 && skipped === 0) {
      this.#backfillStatus = 'failed';
    } else {
      this.#backfillStatus = 'partial';
    }
    this.#log.info('initial backfill complete', {
      successes,
      failures,
      skipped,
      status: this.#backfillStatus,
    });
  }

  stop(): void {
    this.#stopping = true;
    if (this.#passiveTimer) clearInterval(this.#passiveTimer);
    if (this.#activeTimer) clearInterval(this.#activeTimer);
    this.#passiveTimer = null;
    this.#activeTimer = null;
    for (const [, resolvers] of this.#pendingResolvers) {
      for (const r of resolvers) {
        clearTimeout(r.timeoutHandle);
      }
    }
    this.#pendingResolvers.clear();
  }

  isKnown(symbol: string): boolean {
    return this.#knownTickers.has(symbol);
  }

  isBlacklisted(symbol: string): boolean {
    const expiry = this.#negativeCache.get(symbol);
    if (!expiry) return false;
    if (expiry < Date.now()) {
      this.#negativeCache.delete(symbol);
      return false;
    }
    return true;
  }

  async submitForValidation(symbol: string): Promise<ValidationResult> {
    if (this.isBlacklisted(symbol)) {
      return { valid: false, symbol, error: 'invalid_ticker' };
    }
    if (this.isKnown(symbol)) {
      return { valid: true, symbol, price: 0 };
    }

    this.#activeQueue.add(symbol);

    return new Promise<ValidationResult>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        const list = this.#pendingResolvers.get(symbol);
        if (list) {
          const idx = list.findIndex((r) => r.resolve === resolve);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.#pendingResolvers.delete(symbol);
        }
        resolve({ valid: false, symbol, error: 'timeout' });
      }, this.#maxWaitMs);

      const resolvers = this.#pendingResolvers.get(symbol) ?? [];
      resolvers.push({ resolve, timeoutHandle });
      this.#pendingResolvers.set(symbol, resolvers);
    });
  }

  private resolveAll(symbol: string, result: ValidationResult): void {
    const resolvers = this.#pendingResolvers.get(symbol);
    if (!resolvers) return;
    for (const r of resolvers) {
      clearTimeout(r.timeoutHandle);
      r.resolve(result);
    }
    this.#pendingResolvers.delete(symbol);
  }

  private async refreshKnownTickers(): Promise<void> {
    try {
      const res = await this.#db.query<{ ticker: string }>(
        `SELECT DISTINCT ticker FROM ohlc_data
         WHERE interval = '1m' AND period_start > NOW() - INTERVAL '5 days'`,
      );
      this.#knownTickers.clear();
      for (const t of this.#alwaysActive) this.#knownTickers.add(t);
      for (const row of res.rows) this.#knownTickers.add(row.ticker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.error('failed to refresh known tickers', { error: message });
    }
  }

  private async runActiveDrain(): Promise<void> {
    if (this.#stopping || this.#activeQueue.size === 0) return;

    const tickers = Array.from(this.#activeQueue);
    this.#activeQueue.clear();

    let quotes: Map<string, { symbol: string; price: number; source: string }>;
    try {
      quotes = await this.#yahoo.getQuotes(tickers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('active drain fetch failed', { error: message, tickers });
      for (const ticker of tickers) {
        this.resolveAll(ticker, { valid: false, symbol: ticker, error: 'fetch_failed' });
      }
      return;
    }

    for (const ticker of tickers) {
      const quote = quotes.get(ticker);
      if (quote && quote.price > 0) {
        await this.persistLiveQuote(ticker, quote);
        this.#knownTickers.add(ticker);
        this.resolveAll(ticker, { valid: true, symbol: ticker, price: quote.price });
        void this.triggerBackfill(ticker);
      } else {
        this.#negativeCache.set(ticker, Date.now() + this.#negativeCacheTtlMs);
        this.resolveAll(ticker, { valid: false, symbol: ticker, error: 'invalid_ticker' });
      }
    }
  }

  private async runPassivePoll(): Promise<void> {
    if (this.#stopping) return;
    await this.refreshKnownTickers();
    const tickers = Array.from(this.#knownTickers);
    if (tickers.length === 0) return;

    let quotes: Map<string, { symbol: string; price: number; source: string }>;
    try {
      quotes = await this.#yahoo.getQuotes(tickers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('passive poll fetch failed', { error: message, count: tickers.length });
      return;
    }

    let stored = 0;
    for (const [ticker, quote] of quotes) {
      try {
        await this.persistLiveQuote(ticker, quote);
        stored += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#log.debug('passive store failed', { ticker, error: message });
      }
    }
    if (stored > 0) {
      this.#log.debug('passive poll stored', { count: stored });
    }
  }

  private async persistLiveQuote(
    ticker: string,
    quote: { price: number; source: string },
  ): Promise<void> {
    const periodStart = new Date();
    periodStart.setSeconds(0, 0);
    await storeOhlcData(
      this.#db,
      ticker,
      periodStart,
      { close: quote.price },
      quote.source,
      '1m',
    );
  }

  private async triggerBackfill(ticker: string): Promise<'fresh' | 'ok' | 'fail'> {
    try {
      const has15m = await this.#db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ohlc_data
         WHERE ticker = $1 AND interval = '15m' AND period_start > NOW() - INTERVAL '14 days'`,
        [ticker],
      );
      if (Number(has15m.rows[0]?.count ?? 0) > 100) return 'fresh';

      const candles = await this.#yahoo.getHistoricalCandles(ticker, '15m', '14d');
      if (candles.length === 0) return 'fail';

      const inserted = await bulkInsertOhlcData(this.#db, ticker, candles, 'yahoo', '15m');
      this.#log.info('backfilled ticker', { ticker, candles: candles.length, inserted });
      return 'ok';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log.warn('ticker backfill failed', { ticker, error: message });
      return 'fail';
    }
  }
}
