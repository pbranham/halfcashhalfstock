import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  insertBids,
  persistSnapshot,
  readBidsForItem,
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
    expect(sql).toMatch(/ON CONFLICT \(item_id\) DO UPDATE/);
    expect(params).toEqual([
      'v1|111|0',
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

describe('persistSnapshot', () => {
  it('upserts every listing and inserts bids only when present', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await persistSnapshot(pool as unknown as Pool, [
      { listing: LISTING, bids: [{ bidder: 'a', bidTime: '2026-05-07T12:00:00Z', bidAmount: 10 }] },
      { listing: { ...LISTING, itemId: 'v1|222|0' }, bids: null },
    ]);

    expect(result.listings).toBe(2);
    expect(result.bids).toBe(1);
    // 2 upserts + 1 bid insert = 3 queries
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});

describe('readBidsForItem', () => {
  it('returns bids ordered by bid_time with ISO strings and number amounts', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          bidder: 'a',
          bid_time: new Date('2026-05-07T12:00:00.000Z'),
          bid_amount_usd: '10.50',
        },
        {
          bidder: 'b',
          bid_time: new Date('2026-05-07T12:05:00.000Z'),
          bid_amount_usd: '12.00',
        },
      ],
      rowCount: 2,
    });

    const bids = await readBidsForItem(pool as unknown as Pool, 'v1|111|0');

    expect(bids).toEqual([
      { bidder: 'a', bidTime: '2026-05-07T12:00:00.000Z', bidAmountUsd: 10.5 },
      { bidder: 'b', bidTime: '2026-05-07T12:05:00.000Z', bidAmountUsd: 12 },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SELECT bidder, bid_time, bid_amount_usd/);
    expect(sql).toMatch(/ORDER BY bid_time ASC/);
    expect(params).toEqual(['v1|111|0']);
  });
});
