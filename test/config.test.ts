import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  hasEbayCredentials,
  hasEbayTradingCredentials,
  loadConfig,
  resolveEbayTradingUserToken,
} from '../src/config.js';

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

  it('hasEbayTradingCredentials reports both Trading-API keys present', () => {
    const cfg = loadConfig({ EBAY_DEV_ID: 'd', EBAY_USER_TOKEN: 't' });
    expect(hasEbayTradingCredentials(cfg)).toBe(true);
  });

  it('hasEbayTradingCredentials reports token-file based Trading credentials as present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hchs-config-'));
    try {
      const tokenFile = path.join(dir, 'token.json');
      writeFileSync(tokenFile, JSON.stringify({ token: 'from-file-token' }), 'utf8');
      const cfg = loadConfig({ EBAY_DEV_ID: 'd', EBAY_USER_TOKEN_FILE: tokenFile });
      expect(hasEbayTradingCredentials(cfg)).toBe(true);
      expect(resolveEbayTradingUserToken(cfg)).toBe('from-file-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveEbayTradingUserToken prefers token file over env token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hchs-config-'));
    try {
      const tokenFile = path.join(dir, 'token.json');
      writeFileSync(tokenFile, JSON.stringify({ eBayAuthToken: 'file-wins' }), 'utf8');
      const cfg = loadConfig({
        EBAY_DEV_ID: 'd',
        EBAY_USER_TOKEN: 'env-fallback',
        EBAY_USER_TOKEN_FILE: tokenFile,
      });
      expect(resolveEbayTradingUserToken(cfg)).toBe('file-wins');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveEbayTradingUserToken falls back to EBAY_USER_TOKEN when token file is missing', () => {
    const cfg = loadConfig({
      EBAY_DEV_ID: 'd',
      EBAY_USER_TOKEN: 'env-fallback',
      EBAY_USER_TOKEN_FILE: '/tmp/definitely-missing-hchs-token-file.json',
    });
    expect(resolveEbayTradingUserToken(cfg)).toBe('env-fallback');
  });

  it('hasEbayTradingCredentials returns false when either Trading-API key is missing', () => {
    expect(
      hasEbayTradingCredentials(
        loadConfig({
          EBAY_DEV_ID: 'd',
          EBAY_USER_TOKEN_FILE: '/tmp/definitely-missing-hchs-token-file.json',
        }),
      ),
    ).toBe(false);
    expect(hasEbayTradingCredentials(loadConfig({ EBAY_USER_TOKEN: 't' }))).toBe(false);
    expect(hasEbayTradingCredentials(loadConfig({}))).toBe(false);
  });
});
