import { describe, expect, it } from 'vitest';
import { classifyUserAgent, RequestStatsCollector } from '../src/request-stats.js';

describe('classifyUserAgent', () => {
  it('classifies common bot user agents', () => {
    expect(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot');
    expect(classifyUserAgent('curl/7.64.1')).toBe('bot');
    expect(classifyUserAgent('python-requests/2.28.1')).toBe('bot');
    expect(classifyUserAgent('UptimeRobot/2.0')).toBe('bot');
  });

  it('classifies mobile user agents', () => {
    expect(
      classifyUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('mobile');
    expect(
      classifyUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'),
    ).toBe('mobile');
  });

  it('classifies desktop user agents', () => {
    expect(
      classifyUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('desktop');
    expect(
      classifyUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
      ),
    ).toBe('desktop');
  });

  it('returns other for missing or unrecognized agents', () => {
    expect(classifyUserAgent(undefined)).toBe('other');
    expect(classifyUserAgent('')).toBe('other');
    expect(classifyUserAgent('CustomToolXYZ')).toBe('other');
  });
});

describe('RequestStatsCollector', () => {
  it('tracks concurrent requests via recordStart/recordEnd', () => {
    const collector = new RequestStatsCollector(null, 'test');
    const t1 = collector.recordStart();
    const t2 = collector.recordStart();
    const live = collector.getLiveSnapshot();
    expect(live.currentConcurrent).toBe(2);
    collector.recordEnd(t1, '/api/snapshot', 200, '1.2.3.4', 'Mozilla/5.0 Chrome');
    collector.recordEnd(t2, '/api/snapshot', 200, '1.2.3.4', 'curl/7');
    const after = collector.getLiveSnapshot();
    expect(after.currentConcurrent).toBe(0);
    expect(after.requestsLast5Min).toBe(2);
    expect(after.uaBreakdownLast5Min.desktop).toBe(1);
    expect(after.uaBreakdownLast5Min.bot).toBe(1);
    expect(after.uniqueIpsLast5Min).toBe(1);
  });

  it('reports endpoint counts in live snapshot', () => {
    const collector = new RequestStatsCollector(null, 'test');
    const t = collector.recordStart();
    collector.recordEnd(t, '/api/snapshot', 200, '1.1.1.1', 'Mozilla');
    const t2 = collector.recordStart();
    collector.recordEnd(t2, '/api/snapshot', 200, '2.2.2.2', 'Mozilla');
    const t3 = collector.recordStart();
    collector.recordEnd(t3, '/api/ohlc', 200, '1.1.1.1', 'Mozilla');
    const live = collector.getLiveSnapshot();
    expect(live.endpointsLast5Min[0]?.endpoint).toBe('/api/snapshot');
    expect(live.endpointsLast5Min[0]?.count).toBe(2);
    expect(live.uniqueIpsLast5Min).toBe(2);
  });
});
