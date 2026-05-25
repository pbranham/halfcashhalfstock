import { describe, it, expect, vi } from 'vitest';
import { EbayAppTokenProvider } from '../src/ebay/auth.js';
import { EbayClient } from '../src/ebay/client.js';
import { listSellerActiveItems } from '../src/ebay/seller.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildClient(fetchImpl: ReturnType<typeof vi.fn>): EbayClient {
  const tokenProvider = new EbayAppTokenProvider({
    appId: 'a',
    certId: 'b',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return new EbayClient({
    tokenProvider,
    marketplaceId: 'EBAY_US',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('listSellerActiveItems', () => {
  it('rejects malformed seller ids', async () => {
    const fetchImpl = vi.fn();
    const client = buildClient(fetchImpl);
    await expect(listSellerActiveItems(client, 'evil; drop')).rejects.toThrow(RangeError);
  });

  it('issues a search request with category_ids=0 and AUCTION+FIXED_PRICE buyingOptions', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(jsonResponse({ itemSummaries: [] }));

    const client = buildClient(fetchImpl);
    await listSellerActiveItems(client, 'ryan_5050');

    const searchCall = fetchImpl.mock.calls[1]?.[0] as URL;
    expect(searchCall.pathname).toBe('/buy/browse/v1/item_summary/search');
    expect(searchCall.searchParams.get('category_ids')).toBe('0');
    expect(searchCall.searchParams.get('filter')).toBe(
      'sellers:{ryan_5050},buyingOptions:{AUCTION|FIXED_PRICE}',
    );
  });

  it('normalizes auction and buy-it-now items', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        itemSummaries: [
          {
            itemId: 'v1|111',
            title: 'Signed Cohen Letter',
            image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
            itemWebUrl: 'https://www.ebay.com/itm/111',
            currentBidPrice: { value: '42.50', currency: 'USD' },
            price: { value: '5', currency: 'USD' },
            bidCount: 7,
            itemEndDate: '2026-05-08T00:00:00Z',
            buyingOptions: ['AUCTION'],
          },
          {
            itemId: 'v1|222',
            title: 'Plush Cat',
            itemWebUrl: 'https://www.ebay.com/itm/222',
            price: { value: '199.99', currency: 'USD' },
            buyingOptions: ['FIXED_PRICE'],
          },
          {
            itemId: 'v1|333',
            title: 'Gold Bar',
            itemWebUrl: 'https://www.ebay.com/itm/333',
            price: { value: '1000', currency: 'EUR' },
            buyingOptions: ['FIXED_PRICE'],
          },
          { title: 'no-id' },
        ],
      }),
    );

    const client = buildClient(fetchImpl);
    const items = await listSellerActiveItems(client, 'ryan_5050');

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      itemId: 'v1|111',
      sellerId: 'ryan_5050',
      isAuction: true,
      priceUsd: 42.5,
      bidCount: 7,
      endsAt: '2026-05-08T00:00:00Z',
    });
    expect(items[1]).toMatchObject({ itemId: 'v1|222', sellerId: 'ryan_5050', isAuction: false, priceUsd: 199.99 });
    expect(items[2]?.priceUsd).toBeNull();
    expect(items[2]?.currency).toBe('EUR');
  });

  it('paginates when a full page is returned', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    const fullPage = {
      itemSummaries: Array.from({ length: 200 }, (_, i) => ({
        itemId: `v1|${i}`,
        title: `Item ${i}`,
        itemWebUrl: `https://www.ebay.com/itm/${i}`,
        price: { value: '1.00', currency: 'USD' },
        buyingOptions: ['FIXED_PRICE'],
      })),
    };
    fetchImpl.mockResolvedValueOnce(jsonResponse(fullPage));
    fetchImpl.mockResolvedValueOnce(jsonResponse({ itemSummaries: [] }));

    const client = buildClient(fetchImpl);
    const items = await listSellerActiveItems(client, 'ryan_5050');
    expect(items).toHaveLength(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
