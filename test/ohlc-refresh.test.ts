import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { refreshDailyOhlcOnce } from '../src/ohlc-refresh.js';
import { createLogger } from '../src/log.js';
import type { YahooProvider } from '../src/prices/yahoo.js';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function candle(periodStart: Date, close: number) {
  return { periodStart, open: close, high: close, low: close, close };
}

describe('refreshDailyOhlcOnce', () => {
  it("inserts completed days but excludes today's still-forming candle", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 2 }) };
    const past = [
      candle(new Date('2026-05-28T20:00:00Z'), 100),
      candle(new Date('2026-05-29T20:00:00Z'), 101),
    ];
    const today = candle(new Date(), 102); // current day — must be filtered out
    const yahoo = {
      getHistoricalCandles: vi.fn().mockResolvedValue([...past, today]),
    } as unknown as YahooProvider;

    const results = await refreshDailyOhlcOnce({
      pool: pool as unknown as Pool,
      yahoo,
      tickers: ['EBAY', 'GME'],
      log: silentLogger(),
    });

    expect(results).toHaveLength(2);
    // Only the two completed days are passed to the insert (today filtered).
    expect(results[0]).toMatchObject({ ticker: 'EBAY', candles: 2, error: null });
    expect(results[1]).toMatchObject({ ticker: 'GME', candles: 2, error: null });
    // bulkInsertOhlcData built params from 2 candles (8 params each) → 16.
    const [, params] = pool.query.mock.calls[0];
    expect(params).toHaveLength(16);
  });

  it('reports a per-ticker error without throwing the whole pass', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const yahoo = {
      getHistoricalCandles: vi
        .fn()
        .mockRejectedValueOnce(new Error('yahoo 429'))
        .mockResolvedValueOnce([candle(new Date('2026-05-20T20:00:00Z'), 99)]),
    } as unknown as YahooProvider;

    const results = await refreshDailyOhlcOnce({
      pool: pool as unknown as Pool,
      yahoo,
      tickers: ['EBAY', 'GME'],
      log: silentLogger(),
    });

    expect(results[0]).toMatchObject({ ticker: 'EBAY', candles: 0, inserted: 0 });
    expect(results[0]?.error).toMatch(/yahoo 429/);
    expect(results[1]).toMatchObject({ ticker: 'GME', candles: 1, error: null });
  });
});
