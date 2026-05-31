import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { createItemDetailsEnricher, _resetInflightForTests } from '../src/item-details-enricher.js';
import { createLogger } from '../src/log.js';
import type { EbayClient } from '../src/ebay/client.js';
import type { Listing } from '../src/ebay/seller.js';

function listing(itemId: string): Listing {
  return {
    itemId,
    sellerId: 's',
    title: 't',
    imageUrl: `https://i.ebayimg.com/images/g/${itemId}/s-l500.jpg`,
    itemWebUrl: `https://www.ebay.com/itm/${itemId}`,
    priceUsd: 1,
    currency: 'USD',
    bidCount: 0,
    endsAt: null,
    buyingOptions: ['AUCTION'],
    isAuction: true,
  };
}

function makeMocks(missing: string[]) {
  // Pool stub: returns the supplied "missing" ids from
  // readListingsMissingDetails; records every UPDATE call so we can assert
  // what was persisted.
  const updates: Array<{ itemId: string; images: string[]; desc: string | null }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (/SELECT item_id FROM listings/.test(sql)) {
        return { rows: missing.map((id) => ({ item_id: id })) };
      }
      if (/UPDATE listings/.test(sql)) {
        const [itemId, imagesJson, desc] = params as [string, string, string | null];
        updates.push({ itemId, images: JSON.parse(imagesJson), desc });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
  const log = createLogger({ level: 'error', sink: () => {} });
  return { pool, log, updates };
}

function fakeClient(responses: Record<string, unknown>): EbayClient {
  return {
    get: vi.fn(async (path: string) => {
      // path looks like /buy/browse/v1/item/<encodedId>
      const id = decodeURIComponent(path.replace('/buy/browse/v1/item/', ''));
      const r = responses[id];
      if (r === '404') {
        const err: Error & { status?: number } = new Error('not found');
        err.status = 404;
        throw err;
      }
      return r as never;
    }),
  } as unknown as EbayClient;
}

beforeEach(() => _resetInflightForTests());

describe('createItemDetailsEnricher', () => {
  it('fetches and persists details only for listings flagged as missing', async () => {
    const { pool, log, updates } = makeMocks(['a', 'b']);
    const client = fakeClient({
      a: { additionalImages: [{ imageUrl: 'https://i.ebayimg.com/x/s-l500.jpg' }], description: '<p>A</p>' },
      b: { additionalImages: [{ imageUrl: 'https://i.ebayimg.com/y/s-l500.jpg' }], description: null },
    });
    const enrich = createItemDetailsEnricher({ pool, client, log, concurrency: 2 });

    enrich([listing('a'), listing('b'), listing('c')]);
    await vi.waitFor(() => expect(updates).toHaveLength(2));

    const sorted = updates.slice().sort((u, v) => u.itemId.localeCompare(v.itemId));
    expect(sorted[0]).toEqual({
      itemId: 'a',
      images: ['https://i.ebayimg.com/x/s-l1600.jpg'],
      desc: '<p>A</p>',
    });
    expect(sorted[1]).toEqual({
      itemId: 'b',
      images: ['https://i.ebayimg.com/y/s-l1600.jpg'],
      desc: null,
    });
    // 'c' was not flagged missing → never fetched.
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls.some(([p]) => p === '/buy/browse/v1/item/c')).toBe(false);
  });

  it('accepts EnrichmentTargets from any source shape (active or ended)', async () => {
    // Caller passes a thin {itemId, imageUrl} shape — same call should work
    // whether the source is an active Listing or an EndedListingRow. Both
    // get fetched.
    const { pool, log, updates } = makeMocks(['active-1', 'ended-1']);
    const client = fakeClient({
      'active-1': { additionalImages: [{ imageUrl: 'https://i.ebayimg.com/a/s-l500.jpg' }], description: '' },
      'ended-1': { additionalImages: [{ imageUrl: 'https://i.ebayimg.com/e/s-l500.jpg' }], description: '' },
    });
    const enrich = createItemDetailsEnricher({ pool, client, log });

    enrich([
      { itemId: 'active-1', imageUrl: 'https://i.ebayimg.com/a/s-l140.jpg' },
      { itemId: 'ended-1', imageUrl: null },
    ]);
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    const ids = updates.map((u) => u.itemId).sort();
    expect(ids).toEqual(['active-1', 'ended-1']);
  });

  it('persists an empty row on 404 so the missing item is not re-attempted', async () => {
    const { pool, log, updates } = makeMocks(['gone']);
    const client = fakeClient({ gone: '404' });
    const enrich = createItemDetailsEnricher({ pool, client, log });

    enrich([listing('gone')]);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toEqual({ itemId: 'gone', images: [], desc: null });
  });

  it('skips persisting on a non-404 fetch error (retried on the next pass)', async () => {
    const { pool, log, updates } = makeMocks(['oops']);
    const client = {
      get: vi.fn(async () => {
        throw new Error('eBay 500');
      }),
    } as unknown as EbayClient;
    const enrich = createItemDetailsEnricher({ pool, client, log });

    enrich([listing('oops')]);
    // Give the inflight promise a chance to settle. Nothing should be
    // persisted; the next pass will retry.
    await vi.waitFor(
      () => expect((client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0),
    );
    expect(updates).toHaveLength(0);
  });

  it('single-flights: a second call while a pass is running is a no-op', async () => {
    const { pool, log, updates } = makeMocks(['a']);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      get: vi.fn(async () => {
        await gate;
        return { additionalImages: [{ imageUrl: 'https://i.ebayimg.com/z/s-l500.jpg' }], description: '' };
      }),
    } as unknown as EbayClient;
    const enrich = createItemDetailsEnricher({ pool, client, log });

    enrich([listing('a')]); // starts the pass; awaits the gate
    enrich([listing('a')]); // should be a no-op (single-flight)
    enrich([listing('a')]); // also a no-op
    release();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
