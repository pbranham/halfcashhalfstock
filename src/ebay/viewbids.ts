import type { BidRecord } from './trading.js';

// One-time reconciliation of ENDED auction bid history from eBay's public
// bid-history page (https://www.ebay.com/bfl/viewbids/<id>). eBay's APIs do not
// expose full bid history to non-sellers, but this page lists every bid
// (amount, anonymized bidder, exact timestamp) and stays public ~90 days after
// an auction ends. Because the monitored auctions have all ended, the data is
// permanently static — this is a repair, not an ongoing data source.

export interface ViewbidsParseResult {
  bids: BidRecord[];
  finalPriceUsd: number;
  bidCount: number;
}

export type ViewbidsFetchOutcome =
  | { status: 'ok'; html: string }
  | { status: 'blocked'; httpStatus: number }
  | { status: 'error'; message: string };

export class ViewbidsParseError extends Error {
  readonly diagnostics: string;
  constructor(message: string, diagnostics: string) {
    super(message);
    this.name = 'ViewbidsParseError';
    this.diagnostics = diagnostics;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Named US timezone abbreviations → fixed UTC offsets. eBay US auction pages
// render PDT/PST; the rest are defensive.
const ZONE_OFFSETS: Record<string, string> = {
  PDT: '-07:00',
  PST: '-08:00',
  MDT: '-06:00',
  MST: '-07:00',
  CDT: '-05:00',
  CST: '-06:00',
  EDT: '-04:00',
  EST: '-05:00',
  UTC: '+00:00',
  GMT: '+00:00',
};

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// Handles both "May-09-26 14:23:01 PDT" and
// "May 09, 2026 at 2:23:01 PM PDT". Returns a UTC ISO string.
export function parseEbayDate(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();

  // Format A: Mon-DD-YY HH:MM:SS ZZZ (24-hour)
  const a = text.match(
    /([A-Za-z]{3})-(\d{1,2})-(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Za-z]{2,4})/,
  );
  // Format B: Mon DD, YYYY at H:MM:SS AM/PM ZZZ (12-hour)
  const b = text.match(
    /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\s+(?:at\s+)?(\d{1,2}):(\d{2}):(\d{2})\s*([AaPp][Mm])\s+([A-Za-z]{2,4})/,
  );

  let month: string | undefined;
  let day: string;
  let year: string;
  let hour: number;
  let minute: string;
  let second: string;
  let zone: string;

  if (a) {
    month = MONTHS[a[1]!.toLowerCase().slice(0, 3)];
    day = a[2]!;
    year = a[3]!;
    hour = Number(a[4]);
    minute = a[5]!;
    second = a[6]!;
    zone = a[7]!.toUpperCase();
  } else if (b) {
    month = MONTHS[b[1]!.toLowerCase().slice(0, 3)];
    day = b[2]!;
    year = b[3]!;
    hour = Number(b[4]);
    minute = b[5]!;
    second = b[6]!;
    const meridiem = b[7]!.toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    zone = b[8]!.toUpperCase();
  } else {
    throw new Error(`unrecognized eBay date format: "${raw}"`);
  }

  if (!month) throw new Error(`unrecognized month in eBay date: "${raw}"`);
  const offset = ZONE_OFFSETS[zone];
  if (!offset) throw new Error(`unrecognized timezone "${zone}" in eBay date: "${raw}"`);
  if (year.length === 2) year = `20${year}`;

  const iso = `${year}-${month}-${day.padStart(2, '0')}T` +
    `${String(hour).padStart(2, '0')}:${minute}:${second}${offset}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`could not parse eBay date: "${raw}" (built "${iso}")`);
  }
  return parsed.toISOString();
}

interface Token {
  index: number;
  kind: 'bidder' | 'amount' | 'date';
  value: string;
}

// The viewbids DOM uses obfuscated, churn-prone class names, so parsing anchors
// on stable semantic tokens instead of CSS selectors: the "US $" currency
// prefix, eBay's "5***t" bidder masking, and the date formats above. The HTML
// is flattened to text, every token located, then tokens are walked in
// document order — each amount pairs with the most recent bidder and the next
// date — which matches eBay's per-row render order (bidder, amount, date).
export function parseViewbids(html: string): ViewbidsParseResult {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');

  const tokens: Token[] = [];

  const amountRe = /US\s*\$\s*([\d,]+\.\d{2})/g;
  for (let m = amountRe.exec(text); m; m = amountRe.exec(text)) {
    tokens.push({ index: m.index, kind: 'amount', value: m[1]!.replace(/,/g, '') });
  }

  // Anonymized bidder, e.g. "5***t" / "a***b" / "1***2".
  const bidderRe = /([0-9A-Za-z])\*{2,4}([0-9A-Za-z])/g;
  for (let m = bidderRe.exec(text); m; m = bidderRe.exec(text)) {
    tokens.push({ index: m.index, kind: 'bidder', value: m[0] });
  }

  const dateRe = new RegExp(
    '(?:[A-Za-z]{3}-\\d{1,2}-\\d{2,4}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+[A-Za-z]{2,4})' +
    '|(?:[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{2,4}\\s+(?:at\\s+)?\\d{1,2}:\\d{2}:\\d{2}\\s*[AaPp][Mm]\\s+[A-Za-z]{2,4})',
    'g',
  );
  for (let m = dateRe.exec(text); m; m = dateRe.exec(text)) {
    tokens.push({ index: m.index, kind: 'date', value: m[0] });
  }

  tokens.sort((x, y) => x.index - y.index);

  const bids: BidRecord[] = [];
  const seen = new Set<string>();
  let pendingBidder: string | null = null;
  let pendingAmount: number | null = null;

  for (const token of tokens) {
    if (token.kind === 'bidder') {
      pendingBidder = token.value;
      pendingAmount = null;
    } else if (token.kind === 'amount') {
      pendingAmount = Number(token.value);
    } else if (token.kind === 'date' && pendingBidder && pendingAmount !== null) {
      let bidTime: string;
      try {
        bidTime = parseEbayDate(token.value);
      } catch {
        continue;
      }
      const key = `${pendingBidder}|${bidTime}|${pendingAmount}`;
      if (!seen.has(key)) {
        seen.add(key);
        bids.push({ bidder: pendingBidder, bidTime, bidAmount: pendingAmount });
      }
      pendingAmount = null;
    }
  }

  if (bids.length === 0) {
    const counts = {
      bidder: tokens.filter((t) => t.kind === 'bidder').length,
      amount: tokens.filter((t) => t.kind === 'amount').length,
      date: tokens.filter((t) => t.kind === 'date').length,
    };
    const sample = text.replace(/\n+/g, ' ').trim().slice(0, 600);
    throw new ViewbidsParseError(
      'no bids found on viewbids page',
      `tokens=${JSON.stringify(counts)} textSample="${sample}"`,
    );
  }

  bids.sort((x, y) => (x.bidTime < y.bidTime ? -1 : x.bidTime > y.bidTime ? 1 : 0));
  const finalPriceUsd = bids.reduce((max, b) => (b.bidAmount > max ? b.bidAmount : max), 0);
  return { bids, finalPriceUsd, bidCount: bids.length };
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

function looksBlocked(html: string): boolean {
  return /Pardon Our Interruption|splashui\/challenge|captcha|unusual traffic/i.test(html);
}

// numericId must be the bare numeric eBay item id (use normalizeTradingItemId).
export async function fetchViewbidsHtml(numericId: string): Promise<ViewbidsFetchOutcome> {
  const url =
    `https://www.ebay.com/bfl/viewbids/${encodeURIComponent(numericId)}` +
    `?item=${encodeURIComponent(numericId)}&rt=nc`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (res.status === 403 || res.status === 429) {
      return { status: 'blocked', httpStatus: res.status };
    }
    if (!res.ok) {
      return { status: 'error', message: `HTTP ${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    if (looksBlocked(html)) {
      return { status: 'blocked', httpStatus: res.status };
    }
    return { status: 'ok', html };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', message };
  } finally {
    clearTimeout(timeout);
  }
}
