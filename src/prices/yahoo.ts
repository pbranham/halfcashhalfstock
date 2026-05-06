import { PriceProviderError, type PriceProvider, type PriceQuote } from './types.js';

interface YahooQuoteEntry {
  symbol?: string;
  regularMarketPrice?: number;
  currency?: string;
  regularMarketTime?: number;
}

interface YahooQuoteResponse {
  quoteResponse?: { result?: YahooQuoteEntry[]; error?: unknown };
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; halfcashhalfstock/0.1; +https://github.com/pbranham/halfcashhalfstock)';

export interface YahooProviderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

export class YahooProvider implements PriceProvider {
  readonly name = 'yahoo';
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #userAgent: string;

  constructor(options: YahooProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://query1.finance.yahoo.com/v7/finance/quote';
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async getQuote(symbol: string): Promise<PriceQuote> {
    const url = new URL(this.#baseUrl);
    url.searchParams.set('symbols', symbol);

    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': this.#userAgent },
      });
    } catch (err) {
      throw new PriceProviderError(this.name, `network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      throw new PriceProviderError(this.name, `http ${res.status}`);
    }

    const body = (await res.json()) as YahooQuoteResponse;
    const entry = body.quoteResponse?.result?.[0];
    if (!entry || typeof entry.regularMarketPrice !== 'number' || entry.regularMarketPrice <= 0) {
      throw new PriceProviderError(this.name, `invalid quote payload for ${symbol}`);
    }

    const asOf =
      typeof entry.regularMarketTime === 'number'
        ? new Date(entry.regularMarketTime * 1000).toISOString()
        : new Date().toISOString();

    return {
      symbol: entry.symbol ?? symbol,
      price: entry.regularMarketPrice,
      currency: entry.currency ?? 'USD',
      asOf,
      source: this.name,
    };
  }
}
