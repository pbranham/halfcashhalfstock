import { describe, it, expect, vi } from 'vitest';
import { EbayAppTokenProvider } from '../src/ebay/auth.js';
import { EbayClient, EbayApiError } from '../src/ebay/client.js';
import { fetchItemDetails } from '../src/ebay/item-details.js';

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

describe('fetchItemDetails', () => {
  it('returns hi-res gallery (s-l1600) deduped against the primary image', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        image: { imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l500.jpg' },
        additionalImages: [
          // duplicate of primary at different size — dedupe should drop it
          { imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l225.jpg' },
          { imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l400.jpg' },
          { imageUrl: 'https://i.ebayimg.com/images/g/def/s-l225.jpg' },
        ],
        description: '<p>hello</p>',
      }),
    );
    const client = buildClient(fetchImpl);
    const out = await fetchItemDetails(client, 'v1|111|0', 'https://i.ebayimg.com/images/g/abc/s-l140.jpg');
    // Both g/abc/ URLs upgrade to the same s-l1600 as the primary, so
    // dedupe correctly drops both. Only the distinct g/def/ image survives.
    expect(out?.additionalImages).toEqual(['https://i.ebayimg.com/images/g/def/s-l1600.jpg']);
    expect(out?.descriptionHtml).toBe('<p>hello</p>');
  });

  it('falls back to the per-item primary image when there is no gallery', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        image: { imageUrl: 'https://i.ebayimg.com/images/g/xyz/s-l500.jpg' },
        // no additionalImages
        description: '',
      }),
    );
    const client = buildClient(fetchImpl);
    // No primary passed in (search hadn't given us one); function should
    // still surface the per-item primary so the carousel has something.
    const out = await fetchItemDetails(client, 'v1|222|0', null);
    expect(out?.additionalImages).toEqual(['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg']);
    expect(out?.descriptionHtml).toBeNull();
  });

  it('returns null on 404 instead of throwing', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const client = buildClient(fetchImpl);
    const out = await fetchItemDetails(client, 'v1|999|0');
    expect(out).toBeNull();
  });

  it('re-throws non-404 errors', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', expires_in: 7200, token_type: 'Application' }),
    );
    fetchImpl.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = buildClient(fetchImpl);
    await expect(fetchItemDetails(client, 'v1|abc|0')).rejects.toBeInstanceOf(EbayApiError);
  });
});
