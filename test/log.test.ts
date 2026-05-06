import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/log.js';

function captureSink() {
  const lines: string[] = [];
  return { sink: (line: string) => lines.push(line), lines };
}

describe('createLogger', () => {
  it('respects the level threshold', () => {
    const { sink, lines } = captureSink();
    const log = createLogger({ level: 'warn', sink });
    log.debug('hidden');
    log.info('hidden');
    log.warn('shown');
    log.error('shown', { code: 1 });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).level).toBe('warn');
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'error', msg: 'shown', code: 1 });
  });

  it('child logger merges base fields', () => {
    const { sink, lines } = captureSink();
    const root = createLogger({ level: 'debug', sink, base: { app: 'hchs' } });
    const child = root.child({ component: 'ebay' });
    child.info('ping', { itemId: 'v1|1' });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ app: 'hchs', component: 'ebay', itemId: 'v1|1', msg: 'ping' });
  });

  it('emits ISO timestamp', () => {
    const { sink, lines } = captureSink();
    createLogger({ level: 'info', sink }).info('hello');
    expect(JSON.parse(lines[0]!).time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
