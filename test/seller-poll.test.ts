import { describe, it, expect, vi } from 'vitest';
import { createAdaptiveSellerFetch } from '../src/seller-poll.js';
import type { Listing } from '../src/ebay/seller.js';

function listing(itemId: string, sellerId: string): Listing {
  return {
    itemId,
    sellerId,
    title: 't',
    imageUrl: null,
    itemWebUrl: 'https://www.ebay.com/itm/1',
    priceUsd: 1,
    currency: 'USD',
    bidCount: 0,
    endsAt: null,
    buyingOptions: ['AUCTION'],
    isAuction: true,
  };
}

describe('createAdaptiveSellerFetch', () => {
  it('polls every active seller on each call', async () => {
    const fetchOne = vi.fn(async (s: string) => [listing(`${s}-1`, s)]);
    const fetch = createAdaptiveSellerFetch({ sellerIds: ['mine', 'ryan'], fetchOne });

    await fetch();
    await fetch();

    // Both sellers had listings, so both are polled both times: 4 calls.
    expect(fetchOne).toHaveBeenCalledTimes(4);
  });

  it('skips a seller that returned zero listings until the idle window lapses', async () => {
    let t = 1_000_000;
    const fetchOne = vi.fn(async (s: string) => (s === 'ryan' ? [] : [listing('m1', 'mine')]));
    const fetch = createAdaptiveSellerFetch({
      sellerIds: ['mine', 'ryan'],
      fetchOne,
      idleTtlMs: 10_000,
      now: () => t,
    });

    // First call fetches both; ryan comes back empty → goes to sleep.
    await fetch();
    expect(fetchOne).toHaveBeenCalledWith('ryan');
    expect(fetchOne).toHaveBeenCalledTimes(2);

    // Within the idle window: ryan is skipped, only mine is polled.
    t += 5_000;
    const out = await fetch();
    expect(fetchOne).toHaveBeenCalledTimes(3); // +1 (mine only)
    expect(out).toEqual([listing('m1', 'mine')]); // ryan contributes nothing

    // Past the idle window: ryan is checked again.
    t += 6_000;
    await fetch();
    expect(fetchOne).toHaveBeenCalledTimes(5); // +2 (mine + ryan)
  });

  it('wakes a seller back up to the fast cadence once they have listings again', async () => {
    let t = 0;
    let ryanHasItems = false;
    const fetchOne = vi.fn(async (s: string) => {
      if (s === 'ryan') return ryanHasItems ? [listing('r1', 'ryan')] : [];
      return [listing('m1', 'mine')];
    });
    const fetch = createAdaptiveSellerFetch({
      sellerIds: ['mine', 'ryan'],
      fetchOne,
      idleTtlMs: 10_000,
      now: () => t,
    });

    await fetch(); // ryan empty → asleep
    t += 11_000;
    ryanHasItems = true;
    await fetch(); // window lapsed, ryan checked, now has items → awake

    fetchOne.mockClear();
    t += 1_000;
    await fetch(); // ryan should be polled again immediately (not asleep)
    expect(fetchOne).toHaveBeenCalledWith('ryan');
  });
});
