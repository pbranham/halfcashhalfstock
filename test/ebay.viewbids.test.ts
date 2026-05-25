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

  it('parses the day-first eBay viewbids format "13 May 2026 at 11:38:33am PDT"', () => {
    expect(parseEbayDate('13 May 2026 at 11:38:33am PDT')).toBe('2026-05-13T18:38:33.000Z');
  });

  it('parses day-first format with single-digit day and pm', () => {
    expect(parseEbayDate('7 May 2026 at 4:01:28pm PDT')).toBe('2026-05-07T23:01:28.000Z');
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

  // Mirrors the real eBay viewbids page (PR #18 calibration): bare "$" prefix
  // with no "US ", day-first "13 May 2026 at 11:38:33am PDT" timestamps, an
  // italic "automatic bid (proxy bid)" marker on proxy rows that must be
  // filtered, a "Winning bid" header amount that must NOT count, and a
  // retraction table at the bottom that must NOT count.
  const EBAY_FIXTURE = `
    <html><body>
    <h1>Bid History</h1>
    <span>Winning bid:</span><span>$2,900.00</span>
    <table class="app-bid-history__table">
      <tr><td><span>Highest Bidder</span>3***2</td><td>$2,900.00</td><td>13 May 2026 at 11:38:33am PDT</td></tr>
      <tr><td>w***1</td><td>$2,850.00</td><td>13 May 2026 at 11:20:27am PDT</td></tr>
      <tr><td><span class=italic>This is an automatic bid (proxy bid) placed by eBay on behalf of the bidder.</span>w***1</td><td>$2,550.00</td><td>13 May 2026 at 11:20:27am PDT</td></tr>
      <tr><td>3***2</td><td>$2,500.00</td><td>13 May 2026 at 11:38:24am PDT</td></tr>
      <tr><td>Starting price</td><td>$0.01</td><td>6 May 2026 at 12:58:04pm PDT</td></tr>
    </table>
    <h2>Bid retraction and cancellation history</h2>
    <table><tr><td>x***n</td><td>$1,234.00</td><td>7 May 2026 at 10:17:00am PDT</td></tr></table>
    </body></html>`;

  it('parses real eBay viewbids markup ($, day-first dates) — final price', () => {
    expect(parseViewbids(EBAY_FIXTURE).finalPriceUsd).toBe(2900);
  });

  it('filters auto/proxy bids and the starting-price row', () => {
    // 3 real bidder rows (3***2, w***1, 3***2) — proxy w***1 and Starting price are excluded.
    const result = parseViewbids(EBAY_FIXTURE);
    expect(result.bidCount).toBe(3);
    expect(result.bids.map((b) => b.bidAmount).sort((a, b) => a - b)).toEqual([2500, 2850, 2900]);
  });

  it('truncates the retraction section so x***n does not appear as a bid', () => {
    const bidders = parseViewbids(EBAY_FIXTURE).bids.map((b) => b.bidder);
    expect(bidders).not.toContain('x***n');
  });

  it('does not double-count the leading "Winning bid" header amount', () => {
    // If the header amount counted, 3***2's row would see $2,900.00 attached
    // to itself AND also leak into the next row. Spot-check that w***1's
    // amount is $2,850, not $2,900.
    const wStar = parseViewbids(EBAY_FIXTURE).bids.find((b) => b.bidder === 'w***1');
    expect(wStar?.bidAmount).toBe(2850);
  });

  it('yields empty retractedBids when the retraction row only has one date', () => {
    // The legacy fixture's retraction row only contains one timestamp;
    // the new parser requires two (bid time + retraction time) so it
    // should produce zero retracted bids without affecting active parsing.
    const result = parseViewbids(EBAY_FIXTURE);
    expect(result.retractedBids).toEqual([]);
  });

  // Fixture with one active bid and one retraction row containing two dates
  // (bid placed at, retracted at) — the format we expect eBay's retraction
  // table to produce.
  const RETRACTION_FIXTURE = `
    <html><body>
    <h1>Bid History</h1>
    <table class="app-bid-history__table">
      <tr><td><span>Highest Bidder</span>3***2</td><td>$100.00</td><td>13 May 2026 at 11:38:33am PDT</td></tr>
      <tr><td>Starting price</td><td>$0.01</td><td>6 May 2026 at 12:58:04pm PDT</td></tr>
    </table>
    <h2>Bid retraction and cancellation history</h2>
    <table>
      <tr>
        <td>x***n</td>
        <td>$1,234.00</td>
        <td>7 May 2026 at 10:17:00am PDT</td>
        <td>Retracted because of typing mistake</td>
        <td>7 May 2026 at 10:25:14am PDT</td>
      </tr>
    </table>
    </body></html>`;

  it('parses a retracted-bid row into retractedBids with both timestamps', () => {
    const result = parseViewbids(RETRACTION_FIXTURE);
    expect(result.retractedBids).toHaveLength(1);
    expect(result.retractedBids[0]).toEqual({
      bidder: 'x***n',
      bidAmount: 1234,
      bidTime: '2026-05-07T17:17:00.000Z',
      removedAt: '2026-05-07T17:25:14.000Z',
    });
  });

  it('keeps retracted bidders out of the active bid list', () => {
    const bidders = parseViewbids(RETRACTION_FIXTURE).bids.map((b) => b.bidder);
    expect(bidders).not.toContain('x***n');
  });

  it('does not affect final price when only retracted bids exceed it', () => {
    // The retraction row's $1,234.00 must not leak into finalPriceUsd —
    // the active section's only valid bidder is 3***2 at $100.00.
    expect(parseViewbids(RETRACTION_FIXTURE).finalPriceUsd).toBe(100);
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
