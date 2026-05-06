import type { Logger } from '../log.js';
import { PriceProviderError, type PriceProvider, type PriceQuote } from './types.js';

export interface ChainedProviderOptions {
  logger?: Logger;
}

export class ChainedPriceProvider implements PriceProvider {
  readonly name: string;
  readonly #providers: readonly PriceProvider[];
  readonly #logger: Logger | undefined;

  constructor(providers: readonly PriceProvider[], options: ChainedProviderOptions = {}) {
    if (providers.length === 0) {
      throw new RangeError('ChainedPriceProvider requires at least one provider');
    }
    this.#providers = providers;
    this.#logger = options.logger;
    this.name = `chained(${providers.map((p) => p.name).join(',')})`;
  }

  async getQuote(symbol: string): Promise<PriceQuote> {
    const failures: string[] = [];
    for (const provider of this.#providers) {
      try {
        return await provider.getQuote(symbol);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${reason}`);
        this.#logger?.warn('price provider failed, trying next', {
          provider: provider.name,
          symbol,
          reason,
        });
      }
    }
    throw new PriceProviderError(this.name, `all providers failed: ${failures.join('; ')}`);
  }
}
