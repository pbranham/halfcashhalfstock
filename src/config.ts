import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
export const DEFAULT_EBAY_USER_TOKEN_FILE = '.cache/ebay-auth-token.json';

const SELLER_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_SELLER_IDS = ['boilerpaulie', 'ryan_5050'] as const;

const Schema = z.object({
  EBAY_APP_ID: z.string().trim().min(1).optional(),
  EBAY_CERT_ID: z.string().trim().min(1).optional(),
  EBAY_DEV_ID: z.string().trim().min(1).optional(),
  EBAY_USER_TOKEN: z.string().trim().min(1).optional(),
  EBAY_USER_TOKEN_FILE: z.string().trim().min(1).optional(),
  // Comma-separated list of seller usernames to poll. Falls back to the
  // legacy single-value `EBAY_SELLER_ID` env var when unset, then to
  // DEFAULT_SELLER_IDS. Materialised as `sellerIds: string[]` on the
  // resolved Config.
  EBAY_SELLER_IDS: z.string().trim().min(1).optional(),
  EBAY_MARKETPLACE_ID: z.string().trim().min(1).default('EBAY_US'),
  FINNHUB_API_KEY: z.string().trim().min(1).optional(),
  STOCK_SYMBOL: z.string().trim().min(1).default('EBAY'),
  DATABASE_URL: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENABLE_DEBUG_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  APP_ENVIRONMENT: z.string().trim().min(1).optional(),
  ADMIN_TOKEN: z.string().trim().min(8).optional(),
  // logo.dev publishable API key used to render the ticker logo as the
  // shares "unit" on the dashboard. Falls back to spelled-out "shares"
  // when unset. Publishable (client-visible) per logo.dev's docs, so
  // serving it on /api/snapshot is fine.
  LOGO_DEV_TOKEN: z.string().trim().min(1).optional(),
});

export type Config = z.infer<typeof Schema> & { sellerIds: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const sellerIds = parseSellerIds(parsed.data.EBAY_SELLER_IDS, env.EBAY_SELLER_ID);
  return { ...parsed.data, sellerIds };
}

function parseSellerIds(plural: string | undefined, singular: string | undefined): string[] {
  const raw = plural ?? singular ?? DEFAULT_SELLER_IDS.join(',');
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('EBAY_SELLER_IDS resolved to an empty list');
  }
  for (const p of parts) {
    if (!SELLER_ID_RE.test(p)) {
      throw new Error(`Invalid seller id in EBAY_SELLER_IDS: ${p}`);
    }
  }
  // De-duplicate while preserving the user-given order.
  return Array.from(new Set(parts));
}

export function hasEbayCredentials(config: Config): boolean {
  return Boolean(config.EBAY_APP_ID && config.EBAY_CERT_ID);
}

export function hasEbayTradingCredentials(config: Config): boolean {
  return Boolean(config.EBAY_DEV_ID && resolveEbayTradingUserToken(config));
}

export function resolveEbayTradingUserToken(config: Config): string | null {
  const fileToken = readEbayTradingUserTokenFile(config.EBAY_USER_TOKEN_FILE);
  if (fileToken) return fileToken;
  return config.EBAY_USER_TOKEN ?? null;
}

function readEbayTradingUserTokenFile(tokenFile: string | undefined): string | null {
  const tokenFilePath = resolveEbayTradingUserTokenFilePath(tokenFile);
  try {
    const raw = readFileSync(tokenFilePath, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { token?: string; eBayAuthToken?: string; userToken?: string };
      return parsed.token?.trim() || parsed.eBayAuthToken?.trim() || parsed.userToken?.trim() || null;
    }
    return raw;
  } catch {
    return null;
  }
}

function resolveEbayTradingUserTokenFilePath(tokenFile: string | undefined): string {
  return path.resolve(process.cwd(), tokenFile ?? DEFAULT_EBAY_USER_TOKEN_FILE);
}
