import { afterEach, describe, expect, it, vi } from 'vitest';
import { getItemBidHistory } from '../src/ebay/trading.js';

const GET_ALL_BIDDERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetAllBiddersResponse>
  <HighestBid>12.34</HighestBid>
  <BidArray>
    <Offer>
      <TimeBid>2026-05-07T12:00:00.000Z</TimeBid>
      <MaxBid>12.34</MaxBid>
      <User><UserID>bidder1</UserID></User>
    </Offer>
  </BidArray>
</GetAllBiddersResponse>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getItemBidHistory', () => {
  it('normalizes Browse API IDs before calling Trading API', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(GET_ALL_BIDDERS_XML, { status: 200 }));

    const result = await getItemBidHistory('v1|12345|0', 'dev-id', 'user-token');

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(String(requestInit?.body)).toContain('<ItemID>12345</ItemID>');
    expect(result.itemId).toBe('12345');
  });

  it('passes through numeric IDs unchanged', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(GET_ALL_BIDDERS_XML, { status: 200 }));

    const result = await getItemBidHistory('67890', 'dev-id', 'user-token');

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(String(requestInit?.body)).toContain('<ItemID>67890</ItemID>');
    expect(result.itemId).toBe('67890');
  });
});
