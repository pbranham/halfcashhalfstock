import { afterEach, describe, expect, it, vi } from 'vitest';
import { getItemBidHistory, getItemSellingStatus } from '../src/ebay/trading.js';

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

const GET_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>12345</ItemID>
    <SellingStatus>
      <CurrentPrice currencyID="USD">355.00</CurrentPrice>
      <BidCount>17</BidCount>
      <ListingStatus>Completed</ListingStatus>
    </SellingStatus>
  </Item>
</GetItemResponse>`;

const GET_ITEM_FAILURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ShortMessage>Invalid item ID.</ShortMessage>
    <LongMessage>The item ID 99 is invalid or no longer available.</LongMessage>
  </Errors>
</GetItemResponse>`;

describe('getItemSellingStatus', () => {
  it('parses final price, bid count, currency and status from GetItem', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(GET_ITEM_XML, { status: 200 }));

    const ss = await getItemSellingStatus('v1|12345|0', 'user-token');

    const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(String(requestInit?.body)).toContain('<ItemID>12345</ItemID>');
    expect((requestInit?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME']).toBe('GetItem');
    expect(ss).toMatchObject({
      itemId: '12345',
      listingStatus: 'Completed',
      currentPrice: 355,
      currencyId: 'USD',
      bidCount: 17,
      ack: 'Success',
      errorMessage: null,
    });
  });

  it('surfaces Ack=Failure with the error message and zeroed numbers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(GET_ITEM_FAILURE_XML, { status: 200 }),
    );
    const ss = await getItemSellingStatus('99', 'user-token');
    expect(ss.ack).toBe('Failure');
    expect(ss.errorMessage).toContain('invalid or no longer available');
    expect(ss.currentPrice).toBe(0);
    expect(ss.bidCount).toBe(0);
  });
});
