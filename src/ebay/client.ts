import type { EbayAppTokenProvider } from './auth.js';

export class EbayApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'EbayApiError';
  }
}

export interface EbayClientOptions {
  tokenProvider: EbayAppTokenProvider;
  marketplaceId: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.ebay.com';

export class EbayClient {
  readonly #tokenProvider: EbayAppTokenProvider;
  readonly #marketplaceId: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: EbayClientOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#marketplaceId = options.marketplaceId;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.#baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const token = await this.#tokenProvider.getAccessToken();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': this.#marketplaceId,
        },
      });
    } catch (err) {
      throw new EbayApiError(0, `network error: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new EbayApiError(res.status, `eBay ${res.status} on ${path}`, body.slice(0, 500));
    }

    return (await res.json()) as T;
  }
}
