import { describe, it, expect, vi } from 'vitest';
import { jsonResponse, tokenResponse } from './helpers.js';
import { EbayAppTokenProvider, EbayAuthError } from '../src/ebay/auth.js';

describe('EbayAppTokenProvider', () => {
  it('mints a token, returns it, and caches within ttl', async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValue(
      tokenResponse('tok-1', 7200),
    );
    const provider = new EbayAppTokenProvider({
      appId: 'app',
      certId: 'cert',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await provider.getAccessToken()).toBe('tok-1');
    now = 1_000_000;
    expect(await provider.getAccessToken()).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes when token is past safety margin', async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse('tok-1', 60),
      )
      .mockResolvedValueOnce(
        tokenResponse('tok-2', 60),
      );

    const provider = new EbayAppTokenProvider({
      appId: 'app',
      certId: 'cert',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      safetyMarginMs: 5_000,
    });

    expect(await provider.getAccessToken()).toBe('tok-1');
    now = 60_000;
    expect(await provider.getAccessToken()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent token requests', async () => {
    let resolveBody!: (v: unknown) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveBody = (v) => resolve(jsonResponse(v));
        }),
    );
    const provider = new EbayAppTokenProvider({
      appId: 'app',
      certId: 'cert',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const p1 = provider.getAccessToken();
    const p2 = provider.getAccessToken();
    resolveBody({ access_token: 'tok-x', expires_in: 7200, token_type: 'Application' });
    expect(await p1).toBe('tok-x');
    expect(await p2).toBe('tok-x');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws on http error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    const provider = new EbayAppTokenProvider({
      appId: 'app',
      certId: 'cert',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.getAccessToken()).rejects.toThrow(EbayAuthError);
  });

  it('throws on missing required fields', () => {
    expect(() => new EbayAppTokenProvider({ appId: '', certId: 'x' })).toThrow(EbayAuthError);
  });
});
