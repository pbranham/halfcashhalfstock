import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchViewbidsHtml,
  parseEbayDate,
  parseViewbids,
  ViewbidsParseError,
} from '../src/ebay/viewbids.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEbayDate', () => {
  it('parses the 24-hour "May-09-26 14:23:01 PDT" format', () => {
    expect(parseEbayDate('May-09-26 14:23:01 PDT')).toBe('2026-05-09T21:23:01.000Z');
  });

  it('parses the 12-hour "May 09, 2026 at 2:23:01 PM PDT" format', () => {
    expect(parseEbayDate('May 09, 2026 at 2:23:01 PM PDT')).toBe('2026-05-09T21:23:01.000Z');
  });

  it('applies the PST offset (-08:00) distinctly from PDT', () => {
    expect(parseEbayDate('Jan-05-26 10:00:00 PST')).toBe('2026-01-05T18:00:00.000Z');
  });

  it('expands 2-digit years to 20xx', () => {
    expect(parseEbayDate('Dec-31-26 23:59:59 PST')).toBe('2027-01-01T07:59:59.000Z');
  });

  it('converts 12-hour PM correctly and keeps 12 PM as noon', () => {
    expect(parseEbayDate('Jun 01, 2026 at 12:30:00 PM PST')).toBe('2026-06-01T20:30:00.000Z');
  });

  it('converts 12 AM to midnight', () => {
    expect(parseEbayDate('Jun 01, 2026 at 12:30:00 AM PST')).toBe('2026-06-01T08:30:00.000Z');
  });

  it('throws on an unrecognized timezone', () => {
    expect(() => parseEbayDate('May-09-26 14:23:01 XYZ')).toThrow(/timezone/i);
  });

  it('throws on an unrecognized format', () => {
    expect(() => parseEbayDate('sometime last week')).toThrow(/unrecognized/i);
  });
});

describe('parseViewbids', () => {
  const FIXTURE = `
    <html><body>
    <table class="x-bid-table">
      <tr><td>5***t</td><td>US $5,200.00</td><td>May-09-26 14:23:01 PDT</td></tr>
      <tr><td>a***b</td><td>US $5,100.00</td><td>May-09-26 14:20:00 PDT</td></tr>
      <tr><td>5***t</td><td>US $4,800.00</td><td>May-08-26 09:00:00 PDT</td></tr>
    </table>
    </body></html>`;

  it('extracts every bid with thousands separators stripped', () => {
    const result = parseViewbids(FIXTURE);
    expect(result.bidCount).toBe(3);
    expect(result.bids.map((b) => b.bidAmount)).toEqual([4800, 5100, 5200]);
  });

  it('reports the final price as the maximum bid', () => {
    expect(parseViewbids(FIXTURE).finalPriceUsd).toBe(5200);
  });

  it('returns bids sorted ascending by bid time', () => {
    const times = parseViewbids(FIXTURE).bids.map((b) => b.bidTime);
    expect(times).toEqual([...times].sort());
  });

  it('parses the 12-hour timestamp variant', () => {
    const html = '<tr><td>z***9</td><td>US $99.99</td>' +
      '<td>May 09, 2026 at 2:23:01 PM PDT</td></tr>';
    const result = parseViewbids(html);
    expect(result.bids[0]).toEqual({
      bidder: 'z***9',
      bidTime: '2026-05-09T21:23:01.000Z',
      bidAmount: 99.99,
    });
  });

  it('throws ViewbidsParseError with diagnostics on empty/garbage HTML', () => {
    expect(() => parseViewbids('<html><body>nothing here</body></html>')).toThrow(
      ViewbidsParseError,
    );
  });
});

describe('fetchViewbidsHtml', () => {
  it('returns ok with the page HTML on a 200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>bid history</html>', { status: 200 }),
    );
    const outcome = await fetchViewbidsHtml('336571278724');
    expect(outcome.status).toBe('ok');
  });

  it('classifies a 403 as blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    const outcome = await fetchViewbidsHtml('336571278724');
    expect(outcome).toEqual({ status: 'blocked', httpStatus: 403 });
  });

  it('classifies a 200 challenge page as blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Pardon Our Interruption</html>', { status: 200 }),
    );
    const outcome = await fetchViewbidsHtml('336571278724');
    expect(outcome.status).toBe('blocked');
  });

  it('classifies a network failure as error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const outcome = await fetchViewbidsHtml('336571278724');
    expect(outcome).toEqual({ status: 'error', message: 'ECONNRESET' });
  });

  it('requests the bfl/viewbids URL with browser headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));
    await fetchViewbidsHtml('336571278724');
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain('/bfl/viewbids/336571278724');
    expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/Chrome/);
  });
});
