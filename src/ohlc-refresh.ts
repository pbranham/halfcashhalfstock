import type { Pool } from 'pg';
import { errorMessage, type Logger } from './log.js';
import { logPassIfNotable, startBackgroundLoop } from './background-loop.js';
import { YahooProvider } from './prices/yahoo.js';
import { bulkInsertOhlcData } from './db/persist.js';

export interface OhlcRefreshResult {
  ticker: string;
  candles: number;
  inserted: number;
  error: string | null;
}

// Pull daily (1d) OHLC candles from Yahoo for each ticker and store them. The
// 1d interval is exempt from purgeOldOhlcData, so this accumulates the daily
// history the performance chart + end-time valuations rely on. Excludes
// today's still-forming candle so each day is stored once with its final
// values (bulkInsertOhlcData is ON CONFLICT DO NOTHING — it would otherwise
// pin a partial intraday value for the current day). Never throws.
export async function refreshDailyOhlcOnce(opts: {
  pool: Pool;
  yahoo: YahooProvider;
  tickers: readonly string[];
  range?: string;
  log: Logger;
}): Promise<OhlcRefreshResult[]> {
  const range = opts.range ?? '90d';
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const results: OhlcRefreshResult[] = [];
  for (const ticker of opts.tickers) {
    try {
      const candles = await opts.yahoo.getHistoricalCandles(ticker, '1d', range);
      const completed = candles.filter((c) => c.periodStart.getTime() < todayUtcMs);
      const inserted =
        completed.length === 0 ? 0 : await bulkInsertOhlcData(opts.pool, ticker, completed, 'yahoo', '1d');
      results.push({ ticker, candles: completed.length, inserted, error: null });
    } catch (err) {
      results.push({
        ticker,
        candles: 0,
        inserted: 0,
        error: errorMessage(err),
      });
    }
  }
  return results;
}

// Daily background refresh of the 1d OHLC history, on the shared background-
// loop scaffold (immediate first tick, so a deploy fills any gap right away).
// NOT prod-gated like the listing poll: it's idempotent and runs at most
// once/day per ticker (2 Yahoo calls), so a dev + prod pair both running it
// costs nothing meaningful — and running on dev means the preview self-heals
// its history on deploy.
export function startDailyOhlcRefresh(opts: {
  pool: Pool;
  tickers: readonly string[];
  log: Logger;
  yahoo?: YahooProvider;
  intervalMs?: number;
}): () => void {
  const yahoo = opts.yahoo ?? new YahooProvider();
  const log = opts.log.child({ component: 'ohlc-refresh' });
  return startBackgroundLoop({
    name: 'daily ohlc refresh',
    log,
    intervalMs: opts.intervalMs ?? 24 * 60 * 60 * 1000,
    startFields: { tickers: opts.tickers },
    tick: async () => {
      const results = await refreshDailyOhlcOnce({ pool: opts.pool, yahoo, tickers: opts.tickers, log });
      logPassIfNotable(log, 'daily ohlc refresh', results);
    },
  });
}
