import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { reconcileFinalsForItems } from '../src/reconcile-finals.js';
import { createLogger } from '../src/log.js';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function makePool(matched = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: matched });
  return { pool: { query } as unknown as Pool, query };
}

function xml(body: string) {
  return new Response(body, { status: 200 });
}

const SUCCESS = (price: number, bidCount: number, status = 'Completed') => `<?xml version="1.0"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <SellingStatus>
      <CurrentPrice currencyID="USD">${price}</CurrentPrice>
      <BidCount>${bidCount}</BidCount>
      <ListingStatus>${status}</ListingStatus>
    </SellingStatus>
  </Item>
</GetItemResponse>`;

const FAILURE = `<?xml version="1.0"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors><ShortMessage>boom</ShortMessage></Errors>
</GetItemResponse>`;

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('reconcileFinalsForItems', () => {
  it('writes finals via updateEndedListingFinals for eligible items', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(xml(SUCCESS(1234.5, 17)));
    const { pool, query } = makePool();
    const out = await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['v1|111|0'],
      log: silentLogger(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The UPDATE statement was fired with the GetItem-reported price/count.
    const update = query.mock.calls.find(([sql]) =>
      /UPDATE listings/.test(sql as string),
    );
    expect(update).toBeDefined();
    const params = update![1] as unknown[];
    expect(params).toEqual(['v1|111|0', 1234.5, 17]);
    expect(out[0]?.outcome).toBe('updated');
  });

  it('skips with reason when status is not Completed/Ended', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(xml(SUCCESS(10, 1, 'Active')));
    const { pool, query } = makePool();
    const out = await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['v1|222|0'],
      log: silentLogger(),
    });
    expect(out[0]?.outcome).toBe('skip');
    expect(out[0]?.reason).toContain('listingStatus=Active');
    // No UPDATE fired — only the GetItem call hit the network.
    expect(
      query.mock.calls.find(([sql]) => /UPDATE listings/.test(sql as string)),
    ).toBeUndefined();
  });

  it('skips on Ack=Failure with the error message in reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(xml(FAILURE));
    const { pool } = makePool();
    const out = await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['v1|999|0'],
      log: silentLogger(),
    });
    expect(out[0]?.outcome).toBe('skip');
    expect(out[0]?.reason).toContain('ack=Failure');
    expect(out[0]?.reason).toContain('boom');
  });

  it('records error outcome without throwing when the API call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const { pool } = makePool();
    const out = await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['v1|500|0'],
      log: silentLogger(),
    });
    expect(out[0]?.outcome).toBe('error');
    expect(out[0]?.reason).toBeDefined();
  });

  it('caps the number of items processed by maxItems', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(xml(SUCCESS(1, 1)));
    const { pool } = makePool();
    await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['a', 'b', 'c', 'd', 'e'],
      log: silentLogger(),
      maxItems: 2,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('trading auth failure streak', () => {
  it('grows on consecutive Ack=Failure and resets on a healthy response', async () => {
    const { getTradingAuthFailureStreak, _resetTradingAuthStreakForTests } = await import('../src/reconcile-finals.js');
    _resetTradingAuthStreakForTests();
    const { pool } = makePool();

    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(xml(FAILURE)));
    await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['a', 'b', 'c'],
      log: silentLogger(),
    });
    expect(getTradingAuthFailureStreak()).toBe(3);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(xml(SUCCESS(10, 2))));
    await reconcileFinalsForItems({
      pool,
      userToken: 'tok',
      itemIds: ['d'],
      log: silentLogger(),
    });
    expect(getTradingAuthFailureStreak()).toBe(0);
    _resetTradingAuthStreakForTests();
  });
});
