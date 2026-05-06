interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCacheOptions {
  now?: () => number;
}

export class TtlCache<T> {
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #inflight = new Map<string, Promise<T>>();

  constructor(options: TtlCacheOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async get(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const fresh = this.peek(key);
    if (fresh !== undefined) return fresh;

    const inflight = this.#inflight.get(key);
    if (inflight) return inflight;

    const promise = loader()
      .then((value) => {
        this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
        return value;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });

    this.#inflight.set(key, promise);
    return promise;
  }

  peek(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  invalidate(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
