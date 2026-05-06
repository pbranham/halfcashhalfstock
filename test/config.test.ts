import { describe, it, expect } from 'vitest';
import { hasEbayCredentials, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when only minimal env is provided', () => {
    const cfg = loadConfig({});
    expect(cfg.EBAY_SELLER_ID).toBe('ryan_5050');
    expect(cfg.EBAY_MARKETPLACE_ID).toBe('EBAY_US');
    expect(cfg.STOCK_SYMBOL).toBe('EBAY');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string to number', () => {
    const cfg = loadConfig({ PORT: '8080' });
    expect(cfg.PORT).toBe(8080);
  });

  it('rejects invalid PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('hasEbayCredentials reports both keys present', () => {
    const cfg = loadConfig({ EBAY_APP_ID: 'a', EBAY_CERT_ID: 'b' });
    expect(hasEbayCredentials(cfg)).toBe(true);
  });

  it('hasEbayCredentials returns false when either key is missing', () => {
    expect(hasEbayCredentials(loadConfig({ EBAY_APP_ID: 'a' }))).toBe(false);
    expect(hasEbayCredentials(loadConfig({}))).toBe(false);
  });
});
