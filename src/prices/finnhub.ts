import { PriceProviderError, type PriceProvider, type PriceQuote } from './types.js';

interface FinnhubQuoteResponse {
  c?: number;
  t?: number;
}

export interface FinnhubProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class FinnhubProvider implements PriceProvider {
  readonly name = 'finnhub';
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: FinnhubProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://finnhub.io/api/v1';
  }

  async getQuote(symbol: string): Promise<PriceQuote> {
    const url = new URL(`${this.#baseUrl}/quote`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('token', this.#apiKey);

    let res: Response;
    try {
      res = await this.#fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new PriceProviderError(this.name, `network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      throw new PriceProviderError(this.name, `http ${res.status}`);
    }

    const body = (await res.json()) as FinnhubQuoteResponse;
    if (typeof body.c !== 'number' || body.c <= 0) {
      throw new PriceProviderError(this.name, `invalid quote payload for ${symbol}`);
    }

    const asOf = typeof body.t === 'number' ? new Date(body.t * 1000).toISOString() : new Date().toISOString();
    return { symbol, price: body.c, currency: 'USD', asOf, source: this.name };
  }
}
