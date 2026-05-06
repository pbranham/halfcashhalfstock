export interface PriceQuote {
  symbol: string;
  price: number;
  currency: string;
  asOf: string;
  source: string;
}

export interface PriceProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<PriceQuote>;
}

export class PriceProviderError extends Error {
  constructor(
    readonly providerName: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PriceProviderError';
  }
}
