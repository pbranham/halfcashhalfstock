interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface EbayAuthOptions {
  appId: string;
  certId: string;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  scope?: string;
  now?: () => number;
  safetyMarginMs?: number;
}

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const DEFAULT_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const DEFAULT_SAFETY_MS = 60_000;

export class EbayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbayAuthError';
  }
}

export class EbayAppTokenProvider {
  readonly #appId: string;
  readonly #certId: string;
  readonly #fetch: typeof fetch;
  readonly #tokenUrl: string;
  readonly #scope: string;
  readonly #now: () => number;
  readonly #safetyMs: number;
  #cachedToken: { value: string; expiresAt: number } | null = null;
  #inflight: Promise<string> | null = null;

  constructor(options: EbayAuthOptions) {
    if (!options.appId || !options.certId) {
      throw new EbayAuthError('eBay appId and certId are required');
    }
    this.#appId = options.appId;
    this.#certId = options.certId;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.#scope = options.scope ?? DEFAULT_SCOPE;
    this.#now = options.now ?? (() => Date.now());
    this.#safetyMs = options.safetyMarginMs ?? DEFAULT_SAFETY_MS;
  }

  async getAccessToken(): Promise<string> {
    if (this.#cachedToken && this.#cachedToken.expiresAt > this.#now()) {
      return this.#cachedToken.value;
    }
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.#mintToken().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #mintToken(): Promise<string> {
    const basic = Buffer.from(`${this.#appId}:${this.#certId}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: this.#scope });

    let res: Response;
    try {
      res = await this.#fetch(this.#tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new EbayAuthError(`token network error: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EbayAuthError(`token http ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as TokenResponse;
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new EbayAuthError('token response missing access_token or expires_in');
    }

    const expiresAt = this.#now() + json.expires_in * 1000 - this.#safetyMs;
    this.#cachedToken = { value: json.access_token, expiresAt };
    return json.access_token;
  }
}
