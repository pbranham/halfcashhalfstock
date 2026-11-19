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

// One provider HTTP GET: network failures and non-2xx answers become a
// PriceProviderError (`detail` is appended to the status; with
// `includeBody` the first 200 chars of the error body follow); otherwise
// returns the parsed JSON.
export async function fetchProviderJson(
  providerName: string,
  fetchImpl: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  opts: { detail?: string; includeBody?: boolean } = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    throw new PriceProviderError(providerName, `network error: ${(err as Error).message}`, err);
  }
  if (!res.ok) {
    const bodyText = opts.includeBody ? await res.text().catch(() => '') : null;
    throw new PriceProviderError(
      providerName,
      `http ${res.status}${opts.detail ?? ''}${bodyText === null ? '' : `: ${bodyText.slice(0, 200)}`}`,
    );
  }
  return res.json();
}

// A quote's epoch-seconds timestamp as ISO text; now when it's missing.
export function epochSecondsIso(t: unknown): string {
  return typeof t === 'number' ? new Date(t * 1000).toISOString() : new Date().toISOString();
}
