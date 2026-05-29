import type { Pool } from 'pg';

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

export class DbBackedCache<T> {
  readonly #memory: TtlCache<T>;
  readonly #pool: Pool;
  // True when the most recent load fell back to a past-TTL row because the
  // live fetch failed. Lets callers surface a "live updates are delayed"
  // signal without ever hiding the (stale) data. Self-heals: the next
  // fresh DB hit or successful live fetch clears it.
  #degraded = false;

  constructor(pool: Pool, options: TtlCacheOptions = {}) {
    this.#pool = pool;
    this.#memory = new TtlCache(options);
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  async get(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const fresh = this.#memory.peek(key);
    if (fresh !== undefined) return fresh;

    const dbCached = await this.checkDb(key);
    if (dbCached !== undefined) {
      this.#degraded = false;
      return dbCached;
    }

    try {
      const value = await this.#memory.get(key, ttlMs, loader);
      this.#degraded = false;
      await this.storeDb(key, value, ttlMs).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // If the storage failure is *still* "invalid input syntax for type
        // json" after the null-byte strip in storeDb, log a 500-char sample
        // so we can see exactly what character PG is rejecting. Otherwise
        // just log the message — the storage failure is non-fatal.
        if (message.includes('invalid input syntax for type json')) {
          const sample = JSON.stringify(value).slice(0, 500);
          console.error(`Failed to cache ${key} to DB: ${message} | sample: ${sample}`);
        } else {
          console.error(`Failed to cache ${key} to DB:`, message);
        }
      });
      return value;
    } catch (err) {
      // The live fetch failed (e.g. a transient eBay/price-provider blip, or
      // a cold-started process racing its first upstream call). Rather than
      // error the whole snapshot, fall back to the most recent cached value
      // even if it's past its TTL — slightly-stale data beats an error page,
      // and this masks cold-start races where the fresh row just expired.
      // Only propagate the error when there's no cached value at all.
      const stale = await this.checkDbStale(key);
      if (stale !== undefined) {
        this.#degraded = true;
        return stale;
      }
      throw err;
    }
  }

  private async checkDb(key: string): Promise<T | undefined> {
    try {
      const result = await this.#pool.query(
        'SELECT payload FROM cache_entries WHERE cache_key = $1 AND expires_at > NOW()',
        [key],
      );
      if (result.rows.length === 0) return undefined;
      return result.rows[0].payload as T;
    } catch {
      return undefined;
    }
  }

  // Most recent cached value regardless of expiry — used only as a
  // last-resort fallback when the live fetch fails.
  private async checkDbStale(key: string): Promise<T | undefined> {
    try {
      const result = await this.#pool.query(
        'SELECT payload FROM cache_entries WHERE cache_key = $1',
        [key],
      );
      if (result.rows.length === 0) return undefined;
      return result.rows[0].payload as T;
    } catch {
      return undefined;
    }
  }

  private async storeDb(key: string, value: T, ttlMs: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    // Serialize ourselves (rather than letting pg-node auto-stringify) so we
    // can strip the one character Postgres's JSONB column won't accept: the
    // null byte (U+0000). RFC 8259 allows it in JSON strings, but JSONB
    // rejects the whole document if any string contains one. They're never
    // meaningful in display text (always corruption — copy-paste artifacts
    // in eBay titles, etc.), so dropping them is safe and preserves the rest
    // of the payload. JSON.stringify emits the literal six-character escape
    // sequence backslash-u-0-0-0-0, hence the doubled backslash in the regex.
    const json = JSON.stringify(value).replace(/\\u0000/g, '');
    await this.#pool.query(
      `INSERT INTO cache_entries (cache_key, payload, expires_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = $2::jsonb, expires_at = $3`,
      [key, json, expiresAt],
    );
  }

  invalidate(key: string): void {
    this.#memory.invalidate(key);
  }

  clear(): void {
    this.#memory.clear();
  }
}
