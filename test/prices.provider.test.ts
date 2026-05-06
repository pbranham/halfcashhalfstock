import { describe, it, expect, vi } from 'vitest';
import { ChainedPriceProvider } from '../src/prices/provider.js';
import { PriceProviderError, type PriceProvider, type PriceQuote } from '../src/prices/types.js';

function stubProvider(name: string, impl: () => Promise<PriceQuote>): PriceProvider {
  return { name, getQuote: vi.fn(impl) };
}

const QUOTE: PriceQuote = {
  symbol: 'EBAY',
  price: 57.92,
  currency: 'USD',
  asOf: '2026-05-06T18:00:00.000Z',
  source: 'finnhub',
};

describe('ChainedPriceProvider', () => {
  it('returns the first successful quote', async () => {
    const a = stubProvider('a', async () => QUOTE);
    const b = stubProvider('b', async () => {
      throw new Error('should not be called');
    });
    const chained = new ChainedPriceProvider([a, b]);
    expect(await chained.getQuote('EBAY')).toEqual(QUOTE);
    expect(a.getQuote).toHaveBeenCalledTimes(1);
    expect(b.getQuote).not.toHaveBeenCalled();
  });

  it('falls through to the next provider when the first fails', async () => {
    const a = stubProvider('a', async () => {
      throw new PriceProviderError('a', 'boom');
    });
    const b = stubProvider('b', async () => QUOTE);
    const chained = new ChainedPriceProvider([a, b]);
    expect(await chained.getQuote('EBAY')).toEqual(QUOTE);
    expect(a.getQuote).toHaveBeenCalledTimes(1);
    expect(b.getQuote).toHaveBeenCalledTimes(1);
  });

  it('throws aggregated error when all providers fail', async () => {
    const a = stubProvider('a', async () => {
      throw new Error('one');
    });
    const b = stubProvider('b', async () => {
      throw new Error('two');
    });
    const chained = new ChainedPriceProvider([a, b]);
    await expect(chained.getQuote('EBAY')).rejects.toThrow(/a: one; b: two/);
  });

  it('rejects construction with no providers', () => {
    expect(() => new ChainedPriceProvider([])).toThrow(RangeError);
  });

  it('exposes a composite name reflecting the chain', () => {
    const chained = new ChainedPriceProvider([
      stubProvider('finnhub', async () => QUOTE),
      stubProvider('yahoo', async () => QUOTE),
    ]);
    expect(chained.name).toBe('chained(finnhub,yahoo)');
  });
});
