import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { TickerQueue } from '../src/ticker-queue.js';
import { createLogger } from '../src/log.js';
import type { YahooProvider } from '../src/prices/yahoo.js';
import type { PriceProvider } from '../src/prices/types.js';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function makeQueue(opts: { requestWindowMs?: number } = {}) {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
  const priceProvider = { getQuote: vi.fn() } as unknown as PriceProvider;
  const yahoo = {} as unknown as YahooProvider;
  const queue = new TickerQueue({
    db: pool,
    yahoo,
    priceProvider,
    log: silentLogger(),
    alwaysActiveTickers: ['EBAY', 'GME'],
    requestWindowMs: opts.requestWindowMs ?? 30 * 60 * 1000,
  });
  return queue;
}

describe('TickerQueue poll scoping', () => {
  it('polls only the always-active set until a custom ticker is requested', () => {
    const queue = makeQueue();
    expect(queue.getStatus().activelyPolling).toEqual(['EBAY', 'GME']);

    queue.markRequested('AAPL');
    expect(queue.getStatus().activelyPolling).toEqual(['AAPL', 'EBAY', 'GME']);
  });

  it('never tracks always-active tickers as custom requests', () => {
    const queue = makeQueue();
    queue.markRequested('EBAY');
    // Still just the always-active set; EBAY isn't double-counted or special.
    expect(queue.getStatus().activelyPolling).toEqual(['EBAY', 'GME']);
  });

  it('drops a custom ticker from the poll set once the request window lapses', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const queue = makeQueue({ requestWindowMs: 10_000 });
      queue.markRequested('TSLA');
      expect(queue.getStatus().activelyPolling).toContain('TSLA');

      // Advance past the window — TSLA should be pruned, EBAY/GME remain.
      now.mockReturnValue(1_000_000 + 10_001);
      expect(queue.getStatus().activelyPolling).toEqual(['EBAY', 'GME']);
    } finally {
      now.mockRestore();
    }
  });
});
