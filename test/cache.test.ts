import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { TtlCache, DbBackedCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('caches a value within the TTL window', async () => {
    let now = 1_000;
    const cache = new TtlCache<number>({ now: () => now });
    const loader = vi.fn(async () => 42);

    expect(await cache.get('k', 500, loader)).toBe(42);
    now = 1_400;
    expect(await cache.get('k', 500, loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads after expiry', async () => {
    let now = 1_000;
    const cache = new TtlCache<number>({ now: () => now });
    let i = 0;
    const loader = vi.fn(async () => ++i);

    expect(await cache.get('k', 100, loader)).toBe(1);
    now = 1_101;
    expect(await cache.get('k', 100, loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent loads (single-flight)', async () => {
    const cache = new TtlCache<number>();
    let resolveLoader!: (n: number) => void;
    const loader = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoader = resolve;
        }),
    );

    const p1 = cache.get('k', 1_000, loader);
    const p2 = cache.get('k', 1_000, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
  });

  it('does not cache rejected loads and allows retry', async () => {
    const cache = new TtlCache<number>();
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const ok = vi.fn(async () => 9);

    await expect(cache.get('k', 1_000, failing)).rejects.toThrow('boom');
    expect(await cache.get('k', 1_000, ok)).toBe(9);
  });

  it('invalidate removes a key', async () => {
    const cache = new TtlCache<number>();
    const loader = vi.fn(async () => 1);
    await cache.get('k', 1_000, loader);
    cache.invalidate('k');
    await cache.get('k', 1_000, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('DbBackedCache', () => {
  // Minimal pg Pool stub whose query() is routed by SQL shape.
  function makePool(handlers: {
    fresh?: unknown; // payload for "expires_at > NOW()" SELECT, or undefined for miss
    stale?: unknown; // payload for the un-expiry-filtered SELECT, or undefined for miss
  }) {
    const query = vi.fn(async (sql: string) => {
      if (/INSERT INTO cache_entries/.test(sql)) return { rows: [], rowCount: 1 };
      const filtersByExpiry = /expires_at > NOW\(\)/.test(sql);
      const payload = filtersByExpiry ? handlers.fresh : handlers.stale;
      return payload === undefined ? { rows: [] } : { rows: [{ payload }] };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  it('returns the live value and writes it to the DB on a full miss', async () => {
    const { pool, query } = makePool({ fresh: undefined, stale: undefined });
    const cache = new DbBackedCache<number>(pool);
    const loader = vi.fn(async () => 7);
    expect(await cache.get('k', 1_000, loader)).toBe(7);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO cache_entries/.test(sql))).toBe(true);
  });

  it('serves a fresh DB row without calling the loader', async () => {
    const { pool } = makePool({ fresh: 42, stale: 42 });
    const cache = new DbBackedCache<number>(pool);
    const loader = vi.fn(async () => 99);
    expect(await cache.get('k', 1_000, loader)).toBe(42);
    expect(loader).not.toHaveBeenCalled();
  });

  it('falls back to a stale DB row when the live fetch fails', async () => {
    // No fresh row (expired), but a stale row exists; loader throws.
    const { pool } = makePool({ fresh: undefined, stale: 123 });
    const cache = new DbBackedCache<number>(pool);
    const loader = vi.fn(async () => {
      throw new Error('eBay down');
    });
    expect(await cache.get('k', 1_000, loader)).toBe(123);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('propagates the error when the live fetch fails and no stale row exists', async () => {
    const { pool } = makePool({ fresh: undefined, stale: undefined });
    const cache = new DbBackedCache<number>(pool);
    const loader = vi.fn(async () => {
      throw new Error('eBay down');
    });
    await expect(cache.get('k', 1_000, loader)).rejects.toThrow('eBay down');
  });
});
