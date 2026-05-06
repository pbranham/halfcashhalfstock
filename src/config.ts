import { z } from 'zod';

const Schema = z.object({
  EBAY_APP_ID: z.string().trim().min(1).optional(),
  EBAY_CERT_ID: z.string().trim().min(1).optional(),
  EBAY_SELLER_ID: z.string().trim().min(1).default('ryan_5050'),
  EBAY_MARKETPLACE_ID: z.string().trim().min(1).default('EBAY_US'),
  FINNHUB_API_KEY: z.string().trim().min(1).optional(),
  STOCK_SYMBOL: z.string().trim().min(1).default('EBAY'),
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
