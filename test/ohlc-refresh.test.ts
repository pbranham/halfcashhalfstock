import { describe, it, expect, vi } from 'vitest';
import { silentLogger } from './helpers.js';
import type { Pool } from 'pg';
import { refreshDailyOhlcOnce } from '../src/ohlc-refresh.js';
import type { YahooProvider } from '../src/prices/yahoo.js';

function candle(periodStart: Date, close: number) {
  return { periodStart, open: close, high: close, low: close, close };
}

// A pool whose every query reports `rowCount` rows.
function poolWithRowCount(rowCount: number) {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount }) };
}

// A Yahoo provider whose getHistoricalCandles is `getHistoricalCandles`.
function yahooWith(getHistoricalCandles: ReturnType<typeof vi.fn>): YahooProvider {
  return { getHistoricalCandles } as unknown as YahooProvider;
}

// One refresh pass over EBAY + GME.
function refreshBoth(pool: ReturnType<typeof poolWithRowCount>, yahoo: YahooProvider) {
  return refreshDailyOhlcOnce({ pool: pool as unknown as Pool, yahoo, tickers: ['EBAY', 'GME'], log: silentLogger() });
}

describe('refreshDailyOhlcOnce', () => {
  it("inserts completed days but excludes today's still-forming candle", async () => {
    const pool = poolWithRowCount(2);
    const past = [
      candle(new Date('2026-05-28T20:00:00Z'), 100),
      candle(new Date('2026-05-29T20:00:00Z'), 101),
    ];
    const today = candle(new Date(), 102); // current day — must be filtered out
    const yahoo = yahooWith(vi.fn().mockResolvedValue([...past, today]));

    const results = await refreshBoth(pool, yahoo);

    expect(results).toHaveLength(2);
    // Only the two completed days are passed to the insert (today filtered).
    expect(results[0]).toMatchObject({ ticker: 'EBAY', candles: 2, error: null });
    expect(results[1]).toMatchObject({ ticker: 'GME', candles: 2, error: null });
    // bulkInsertOhlcData built params from 2 candles (8 params each) → 16.
    const [, params] = pool.query.mock.calls[0];
    expect(params).toHaveLength(16);
  });

  it('reports a per-ticker error without throwing the whole pass', async () => {
    const pool = poolWithRowCount(0);
    const yahoo = yahooWith(vi
        .fn()
        .mockRejectedValueOnce(new Error('yahoo 429'))
        .mockResolvedValueOnce([candle(new Date('2026-05-20T20:00:00Z'), 99)]));

    const results = await refreshBoth(pool, yahoo);

    expect(results[0]).toMatchObject({ ticker: 'EBAY', candles: 0, inserted: 0 });
    expect(results[0]?.error).toMatch(/yahoo 429/);
    expect(results[1]).toMatchObject({ ticker: 'GME', candles: 1, error: null });
  });
});
