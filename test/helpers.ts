// Fixtures every test file shares — one home each instead of a copy per file.
import { expect, vi } from 'vitest';
import { EbayAppTokenProvider } from '../src/ebay/auth.js';
import { EbayClient } from '../src/ebay/client.js';
import { createLogger, type Logger } from '../src/log.js';

// A logger that drops everything (errors included).
export function silentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} });
}

// A JSON Response with `body`.
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// An eBay OAuth client_credentials token answer.
export function tokenResponse(accessToken = 't', expiresIn = 7200): Response {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn, token_type: 'Application' });
}

// A fetch mock whose first answer is an app token; queue the Browse answers
// after it with mockResolvedValueOnce.
export function fetchWithToken(): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn();
  fetchImpl.mockResolvedValueOnce(tokenResponse());
  return fetchImpl;
}

// A Browse API client whose token + API calls both go through `fetchImpl`.
export function buildClient(fetchImpl: ReturnType<typeof vi.fn>): EbayClient {
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

// The "By seller" fixture both the composeSnapshot and /api/snapshot tests
// use: v1|1 is Ryan's (valued in $EBAY @ 50), v1|2 mine ($GME @ 25), each a
// $100 bid. Asserts mixed mode, both stock quotes, and each item's ticker +
// half/half split: (100/2)/50 = 1 share and (100/2)/25 = 2 shares.
export function expectSellerValuation(snapshot: {
  valuationMode: string;
  stocks: { symbol: string }[];
  items: { itemId: string; valuationTicker: string; split: unknown }[];
}): void {
  expect(snapshot.valuationMode).toBe('mixed');
  expect(snapshot.stocks.map((q) => q.symbol)).toEqual(['EBAY', 'GME']);
  const byId = Object.fromEntries(snapshot.items.map((i) => [i.itemId, i]));
  expect(byId['v1|1']?.valuationTicker).toBe('EBAY');
  expect(byId['v1|1']?.split).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  expect(byId['v1|2']?.valuationTicker).toBe('GME');
  expect(byId['v1|2']?.split).toEqual({ cashUsd: 50, stockUsd: 50, shares: 2 });
}

// Make every global fetch answer 200 with `body` (an XML/text payload);
// returns the spy.
export function respondWith(body: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
}

// What the first fetch through `spy` sent: its body text and Trading call name.
export function sentRequest(spy: ReturnType<typeof respondWith>): { body: string; callName: string | undefined } {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return {
    body: String(init?.body),
    callName: (init?.headers as Record<string, string> | undefined)?.['X-EBAY-API-CALL-NAME'],
  };
}

// The SQL text of every call a mocked pool/client `query` received.
export function sqlOf(query: { mock: { calls: unknown[][] } }): string[] {
  return query.mock.calls.map(([sql]) => sql as string);
}
