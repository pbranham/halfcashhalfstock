// Fixtures every test file shares — one home each instead of a copy per file.
import { vi } from 'vitest';
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
