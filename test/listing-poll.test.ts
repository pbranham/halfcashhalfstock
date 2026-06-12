import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundListingPoll } from '../src/listing-poll.js';
import { createLogger } from '../src/log.js';
import type { Listing } from '../src/ebay/seller.js';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Flush the microtask queue so the void-scheduled tick() inside the loop
// actually runs, without advancing any setInterval timers.
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('startBackgroundListingPoll', () => {
  it('fires immediately and then on the supplied interval', async () => {
    const fetchListings = vi.fn(async (): Promise<Listing[]> => []);
    const process = vi.fn(async () => undefined);
    const stop = startBackgroundListingPoll({
      fetchListings,
      process,
      log: silentLogger(),
      intervalMs: 1_000,
    });

    // Just the immediate tick — no interval has elapsed yet.
    await flushMicrotasks();
    expect(fetchListings).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);

    // Advance two intervals → two more ticks.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchListings).toHaveBeenCalledTimes(3);
    expect(process).toHaveBeenCalledTimes(3);

    stop();
  });

  it('skips a tick when the previous tick is still in flight', async () => {
    // process() never resolves until we release it, so subsequent ticks
    // should all bail out without calling fetchListings again.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchListings = vi.fn(async (): Promise<Listing[]> => []);
    const process = vi.fn(async () => {
      await gate;
    });

    const stop = startBackgroundListingPoll({
      fetchListings,
      process,
      log: silentLogger(),
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(500); // ~5 ticks worth, all should skip
    expect(fetchListings).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);

    release();
    stop();
  });

  it('keeps ticking after a tick throws', async () => {
    let calls = 0;
    const fetchListings = vi.fn(async (): Promise<Listing[]> => {
      calls += 1;
      if (calls === 1) throw new Error('upstream blip');
      return [];
    });
    const process = vi.fn(async () => undefined);
    const stop = startBackgroundListingPoll({
      fetchListings,
      process,
      log: silentLogger(),
      intervalMs: 100,
    });

    // First tick (immediate) throws inside fetchListings — process not called.
    await flushMicrotasks();
    expect(process).toHaveBeenCalledTimes(0);
    // Loop survives and fires again on the next interval.
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchListings).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenCalledTimes(1);

    stop();
  });

  it('stop() halts further ticks', async () => {
    const fetchListings = vi.fn(async (): Promise<Listing[]> => []);
    const process = vi.fn(async () => undefined);
    const stop = startBackgroundListingPoll({
      fetchListings,
      process,
      log: silentLogger(),
      intervalMs: 100,
    });

    await flushMicrotasks();
    expect(fetchListings).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchListings).toHaveBeenCalledTimes(1); // unchanged after stop
  });
});
