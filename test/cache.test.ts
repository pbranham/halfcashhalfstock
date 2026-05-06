import { describe, it, expect, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';

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
