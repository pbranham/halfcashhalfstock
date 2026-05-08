import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
export const DEFAULT_EBAY_USER_TOKEN_FILE = '.cache/ebay-auth-token.json';

const Schema = z.object({
  EBAY_APP_ID: z.string().trim().min(1).optional(),
  EBAY_CERT_ID: z.string().trim().min(1).optional(),
  EBAY_DEV_ID: z.string().trim().min(1).optional(),
  EBAY_USER_TOKEN: z.string().trim().min(1).optional(),
  EBAY_USER_TOKEN_FILE: z.string().trim().min(1).optional(),
  EBAY_SELLER_ID: z.string().trim().min(1).default('ryan_5050'),
  EBAY_MARKETPLACE_ID: z.string().trim().min(1).default('EBAY_US'),
  FINNHUB_API_KEY: z.string().trim().min(1).optional(),
  STOCK_SYMBOL: z.string().trim().min(1).default('EBAY'),
  DATABASE_URL: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
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
