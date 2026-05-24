import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  getClosingPriceAt,
  insertBids,
  persistSnapshot,
  readBidsForItem,
  reconcileItemBids,
  upsertListing,
} from '../src/db/persist.js';
import type { Listing } from '../src/ebay/seller.js';
import type { BidRecord } from '../src/ebay/trading.js';

type MockPool = {
  query: ReturnType<typeof vi.fn>;
};

function makePool(): MockPool {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

const LISTING: Listing = {
  itemId: 'v1|111|0',
  sellerId: 'ryan_5050',
  title: 'Cohen Plush',
  imageUrl: 'https://i.ebayimg.com/x.jpg',
  itemWebUrl: 'https://www.ebay.com/itm/111',
  priceUsd: 12.34,
  currency: 'USD',
  bidCount: 3,
  endsAt: '2026-05-15T00:00:00Z',
  buyingOptions: ['AUCTION'],
  isAuction: true,
};

describe('upsertListing', () => {
  it('issues a single INSERT ... ON CONFLICT statement with all listing fields', async () => {
    const pool = makePool();
    await upsertListing(pool as unknown as Pool, LISTING);
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO listings/);
    expect(sql).toMatch(/seller_id/);
    expect(sql).toMatch(/ON CONFLICT \(item_id\) DO UPDATE/);
    expect(params).toEqual([
      'v1|111|0',
      'ryan_5050',
      'Cohen Plush',
      'https://i.ebayimg.com/x.jpg',
      'https://www.ebay.com/itm/111',
      true,
      '2026-05-15T00:00:00Z',
      12.34,
      3,
      'USD',
    ]);
  });
});

describe('insertBids', () => {
  it('returns 0 and skips the query when bids is empty', async () => {
    const pool = makePool();
    const inserted = await insertBids(pool as unknown as Pool, 'v1|1|0', []);
    expect(inserted).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('filters out bids with empty bid_time or non-finite amount', async () => {
    const pool = makePool();
    const bids: BidRecord[] = [
      { bidder: 'a', bidTime: '', bidAmount: 10 },
      { bidder: 'b', bidTime: '2026-05-07T12:00:00Z', bidAmount: Number.NaN },
      { bidder: 'c', bidTime: '2026-05-07T12:01:00Z', bidAmount: -5 },
      { bidder: 'd', bidTime: '2026-05-07T12:02:00Z', bidAmount: 25 },
    ];
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await insertBids(pool as unknown as Pool, 'v1|1|0', bids);

    expect(pool.query).toHaveBeenCalledOnce();
    const [, params] = pool.query.mock.calls[0];
    // Only the last bid (d) should pass the filter; 4 params per bid.
    expect(params).toEqual(['v1|1|0', 'd', '2026-05-07T12:02:00Z', 25]);
  });

  it('replaces empty bidder with the unknown sentinel', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const bids: BidRecord[] = [{ bidder: '', bidTime: '2026-05-07T12:00:00Z', bidAmount: 50 }];

    await insertBids(pool as unknown as Pool, 'v1|1|0', bids);

    const [, params] = pool.query.mock.calls[0];
    expect(params[1]).toBe('unknown');
  });

  it('issues bulk INSERT with ON CONFLICT DO NOTHING for multiple bids', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const bids: BidRecord[] = [
      { bidder: 'a', bidTime: '2026-05-07T12:00:00Z', bidAmount: 10 },
      { bidder: 'b', bidTime: '2026-05-07T12:01:00Z', bidAmount: 12 },
    ];

    const inserted = await insertBids(pool as unknown as Pool, 'v1|1|0', bids);

    expect(inserted).toBe(2);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO bids/);
    expect(sql).toMatch(/ON CONFLICT \(item_id, bid_time, bidder\) DO NOTHING/);
    // 2 bids x 4 params each = 8 params
    expect(params).toHaveLength(8);
  });
});

describe('reconcileItemBids', () => {
  function makeTxPool() {
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (/^DELETE/.test(sql)) return Promise.resolve({ rows: [], rowCount: 8 });
        if (/^INSERT/.test(sql)) return Promise.resolve({ rows: [], rowCount: 12 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    return { pool, client };
  }

  const BIDS: BidRecord[] = [
    { bidder: '5***t', bidTime: '2026-05-08T16:00:00.000Z', bidAmount: 4800 },
    { bidder: 'a***b', bidTime: '2026-05-09T21:20:00.000Z', bidAmount: 5100 },
    { bidder: '5***t', bidTime: '2026-05-09T21:23:01.000Z', bidAmount: 5200 },
  ];

  it('replaces bids inside a transaction and updates the listing', async () => {
    const { pool, client } = makeTxPool();
    await reconcileItemBids(pool as unknown as Pool, 'v1|336|0', BIDS);

    const sqls = client.query.mock.calls.map(([sql]) => sql as string);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => /^DELETE FROM bids/.test(s))).toBe(true);
    expect(sqls.some((s) => /^INSERT INTO bids/.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE listings/.test(s) && /last_backfilled_at = NOW\(\)/.test(s))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns the max bid as finalPriceUsd and the row counts', async () => {
    const { pool } = makeTxPool();
    const result = await reconcileItemBids(pool as unknown as Pool, 'v1|336|0', BIDS);
    expect(result).toEqual({ deleted: 8, inserted: 12, finalPriceUsd: 5200, bidCount: 3 });
  });

  it('refuses to delete when given zero valid bids', async () => {
    const { pool } = makeTxPool();
    await expect(
      reconcileItemBids(pool as unknown as Pool, 'v1|336|0', []),
    ).rejects.toThrow(/zero valid rows/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back when a query fails mid-transaction', async () => {
    const { pool, client } = makeTxPool();
    client.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [], rowCount: 0 });
      if (/^DELETE/.test(sql)) return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await expect(
      reconcileItemBids(pool as unknown as Pool, 'v1|336|0', BIDS),
    ).rejects.toThrow('db down');
    const sqls = client.query.mock.calls.map(([sql]) => sql as string);
    expect(sqls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('persistSnapshot', () => {
  it('upserts every listing, snapshots changes, and reconciles bids', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await persistSnapshot(pool as unknown as Pool, [
      { listing: LISTING, bids: [{ bidder: 'a', bidTime: '2026-05-07T12:00:00Z', bidAmount: 10 }] },
      { listing: { ...LISTING, itemId: 'v1|222|0' }, bids: null },
    ]);

    expect(result.listings).toBe(2);
    expect(result.bids).toBe(1);
    expect(result.removedBids).toBe(0);
    const sqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /INSERT INTO listings/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO listing_snapshots/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO bids/.test(s))).toBe(true);
  });

  it('does NOT mark bids as removed (reconciliation disabled)', async () => {
    // GetAllBidders only returns each bidder's highest bid, not every bid,
    // so reconciliation produced false-positive removals. Until we have
    // reliable retraction detection, persistSnapshot only appends.
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await persistSnapshot(pool as unknown as Pool, [
      {
        listing: LISTING,
        bids: [{ bidder: 'a', bidTime: '2026-05-07T12:00:00Z', bidAmount: 10 }],
      },
    ]);

    expect(result.removedBids).toBe(0);
    const sqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /UPDATE bids SET removed_at/.test(s))).toBe(false);
  });
});

describe('readBidsForItem', () => {
  it('returns bids ordered by bid_time with removed_at and first_seen_at', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          bidder: 'a',
          bid_time: new Date('2026-05-07T12:00:00.000Z'),
          bid_amount_usd: '10.50',
          first_seen_at: new Date('2026-05-07T12:01:00.000Z'),
          removed_at: null,
        },
        {
          bidder: 'b',
          bid_time: new Date('2026-05-07T12:05:00.000Z'),
          bid_amount_usd: '12.00',
          first_seen_at: new Date('2026-05-07T12:06:00.000Z'),
          removed_at: new Date('2026-05-08T09:00:00.000Z'),
        },
      ],
      rowCount: 2,
    });

    const bids = await readBidsForItem(pool as unknown as Pool, 'v1|111|0');

    expect(bids).toEqual([
      {
        bidder: 'a',
        bidTime: '2026-05-07T12:00:00.000Z',
        bidAmountUsd: 10.5,
        firstSeenAt: '2026-05-07T12:01:00.000Z',
        removedAt: null,
      },
      {
        bidder: 'b',
        bidTime: '2026-05-07T12:05:00.000Z',
        bidAmountUsd: 12,
        firstSeenAt: '2026-05-07T12:06:00.000Z',
        removedAt: '2026-05-08T09:00:00.000Z',
      },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SELECT bidder, bid_time, bid_amount_usd, first_seen_at, removed_at/);
    expect(sql).toMatch(/ORDER BY bid_time ASC/);
    expect(params).toEqual(['v1|111|0']);
  });
});

describe('getClosingPriceAt', () => {
  it('returns the close from the most-recent-at-or-before period for the ticker', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ close: '57.42' }], rowCount: 1 });
    const when = new Date('2026-05-13T15:30:00Z');
    const price = await getClosingPriceAt(pool as unknown as Pool, 'EBAY', when);
    expect(price).toBe(57.42);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM ohlc_data/);
    expect(sql).toMatch(/period_start <= \$2/);
    expect(sql).toMatch(/ORDER BY period_start DESC/);
    // Tie-breaker: 1m beats 15m beats 1d.
    expect(sql).toMatch(/CASE interval WHEN '1m' THEN 1 WHEN '15m' THEN 2 WHEN '1d' THEN 3/);
    expect(params).toEqual(['EBAY', when]);
  });

  it('returns null when no row exists at or before `when`', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const price = await getClosingPriceAt(pool as unknown as Pool, 'EBAY', new Date());
    expect(price).toBeNull();
  });

  it('returns null when the stored close is non-finite (defensive)', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [{ close: 'not-a-number' }], rowCount: 1 });
    const price = await getClosingPriceAt(pool as unknown as Pool, 'EBAY', new Date());
    expect(price).toBeNull();
  });
});
