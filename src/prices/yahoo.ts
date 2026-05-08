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

interface YahooChartResult {
  meta?: { symbol?: string; currency?: string };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: (number | null)[];
      high?: (number | null)[];
      low?: (number | null)[];
      close?: (number | null)[];
    }>;
  };
}

interface YahooChartResponse {
  chart?: { result?: YahooChartResult[]; error?: unknown };
}

export interface OhlcCandle {
  periodStart: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
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
  readonly #chartUrl: string;
  readonly #userAgent: string;

  constructor(options: YahooProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://query1.finance.yahoo.com/v7/finance/quote';
    this.#chartUrl = 'https://query1.finance.yahoo.com/v8/finance/chart';
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

  async getHistoricalCandles(
    symbol: string,
    interval: string = '15m',
    range: string = '14d',
  ): Promise<OhlcCandle[]> {
    const encodedSymbol = encodeURIComponent(symbol);
    const url = new URL(`${this.#chartUrl}/${encodedSymbol}`);
    url.searchParams.set('interval', interval);
    url.searchParams.set('range', range);

    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': this.#userAgent },
      });
    } catch (err) {
      throw new PriceProviderError(this.name, `network error: ${(err as Error).message}`, err);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new PriceProviderError(
        this.name,
        `http ${res.status} for ${symbol} (${interval}/${range}): ${bodyText.slice(0, 200)}`,
      );
    }

    const body = (await res.json()) as YahooChartResponse;
    const result = body.chart?.result?.[0];
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
      throw new PriceProviderError(this.name, `invalid chart payload for ${symbol}`);
    }

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    const candles: OhlcCandle[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      if (!timestamp || typeof timestamp !== 'number') continue;

      const open = quote.open?.[i] ?? null;
      const high = quote.high?.[i] ?? null;
      const low = quote.low?.[i] ?? null;
      const close = quote.close?.[i] ?? null;

      if (close === null) continue;

      candles.push({
        periodStart: new Date(timestamp * 1000),
        open,
        high,
        low,
        close,
      });
    }

    return candles;
  }
}
