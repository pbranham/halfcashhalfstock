import { XMLParser } from 'fast-xml-parser';

export interface BidRecord {
  bidder: string;
  bidTime: string;
  bidAmount: number;
}

// Oldest bid first (ISO times compare as strings).
export function byBidTime(a: { bidTime: string }, b: { bidTime: string }): number {
  return a.bidTime < b.bidTime ? -1 : a.bidTime > b.bidTime ? 1 : 0;
}

// The highest bid amount among `bids` (0 when there are none) — an
// auction's current / final price.
export function highestBidAmount(bids: ReadonlyArray<{ bidAmount: number }>): number {
  return bids.reduce((max, b) => (b.bidAmount > max ? b.bidAmount : max), 0);
}

export interface ItemBidHistory {
  itemId: string;
  bidCount: number;
  currentPrice: number;
  bids: BidRecord[];
}

// GetAllBidders returns one Offer per unique bidder (their highest bid).
// MaxBid and HighestBid are eBay AmountType: may be a plain number or
// { '@_currencyID': string, '#text': number } when a currency attribute is present.
interface OfferNode {
  TimeBid?: string;
  MaxBid?: unknown;
  HighestBid?: unknown;
  User?: { UserID?: string };
}

interface ParsedResponse {
  GetAllBiddersResponse?: {
    BidArray?: {
      Offer?: OfferNode | OfferNode[];
    };
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
});

// One Trading API call: wraps `bodyXml` in the <CallNameRequest> envelope
// with the user token, POSTs it, and returns the parsed XML. Throws on a
// non-2xx answer.
async function tradingCall(callName: string, userToken: string, bodyXml: string): Promise<unknown> {
  const requestBody = `<?xml version="1.0" encoding="UTF-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(userToken)}</eBayAuthToken>
  </RequesterCredentials>
  ${bodyXml}
</${callName}Request>`;

  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml',
    },
    body: requestBody,
  });

  if (!res.ok) {
    throw new Error(`eBay Trading API error: ${res.status} ${res.statusText}`);
  }
  return parser.parse(await res.text());
}

// The XML parser yields one node for a single child, an array for several;
// callers always want the array.
function asArray<T>(node: T | T[] | null | undefined): T[] {
  if (Array.isArray(node)) return node;
  return node ? [node] : [];
}

export async function getItemBidHistory(
  itemId: string,
  _devId: string,
  userToken: string,
): Promise<ItemBidHistory> {
  const tradingItemId = normalizeTradingItemId(itemId);
  const parsed = (await tradingCall(
    'GetAllBidders',
    userToken,
    `<ItemID>${escapeXml(tradingItemId)}</ItemID>
  <CallMode>ViewAll</CallMode>`,
  )) as ParsedResponse;

  const offersArray = asArray<OfferNode>(parsed?.GetAllBiddersResponse?.BidArray?.Offer);

  const bids: BidRecord[] = offersArray
    .filter((o): o is OfferNode & { TimeBid: string } => Boolean(o.TimeBid))
    .map((offer) => ({
      bidder: offer.User?.UserID ?? 'unknown',
      bidTime: offer.TimeBid,
      bidAmount: parseMoney(offer.MaxBid ?? offer.HighestBid),
    }));

  // Sort ascending so bids[last] is the most recent bid action.
  bids.sort(byBidTime);

  // GetAllBidders does NOT have a top-level HighestBid field — that field
  // lives per-Offer (each bidder's MaxBid IS their highest contribution).
  // The actual current/final auction price is the max across all returned
  // Offers' MaxBid values.
  const currentPrice = highestBidAmount(bids);

  return {
    itemId: tradingItemId,
    bidCount: bids.length,
    currentPrice,
    bids,
  };
}

export function normalizeTradingItemId(itemId: string): string {
  const parts = itemId.split('|');
  if (parts.length >= 2 && parts[1]) return parts[1];
  return itemId;
}

// --- GetItem: authoritative final selling status for an ended auction ---
//
// Unlike GetAllBidders (which the non-seller can't use post-close), GetItem
// returns SellingStatus for any item still in eBay's ~90-day visibility
// window — the final CurrentPrice and the final BidCount, the two numbers
// the dashboard's half/half math actually needs. It goes to api.ebay.com,
// so it's NOT subject to the "Pardon Our Interruption" datacenter-IP
// challenge that blocks server-side scraping of the public viewbids page.
// It does NOT return the per-bid timeline (that still needs the HTML paste);
// it answers "what did this auction close at, and how many bids".

export interface ItemSellingStatus {
  itemId: string;
  // "Active" | "Completed" | "Ended" | "CustomCode" — Completed/Ended means
  // the auction has closed and CurrentPrice is final.
  listingStatus: string | null;
  currentPrice: number;
  currencyId: string | null;
  bidCount: number;
  ack: string | null;
  // First error short message when Ack is Failure (e.g. invalid item, token
  // expired, item outside the visibility window).
  errorMessage: string | null;
}

interface AmountNode {
  '@_currencyID'?: string;
  '#text'?: number | string;
}

interface ParsedItemResponse {
  GetItemResponse?: {
    Ack?: string;
    Errors?: { LongMessage?: string; ShortMessage?: string } | Array<{ LongMessage?: string; ShortMessage?: string }>;
    Item?: {
      SellingStatus?: {
        CurrentPrice?: unknown;
        BidCount?: unknown;
        ListingStatus?: string;
      };
    };
  };
}

export async function getItemSellingStatus(
  itemId: string,
  userToken: string,
): Promise<ItemSellingStatus> {
  const tradingItemId = normalizeTradingItemId(itemId);
  const parsed = (await tradingCall(
    'GetItem',
    userToken,
    `<ItemID>${escapeXml(tradingItemId)}</ItemID>`,
  )) as ParsedItemResponse;
  const resp = parsed?.GetItemResponse;
  const ss = resp?.Item?.SellingStatus;

  return {
    itemId: tradingItemId,
    listingStatus: ss?.ListingStatus ?? null,
    currentPrice: parseMoney(ss?.CurrentPrice),
    currencyId: extractCurrencyId(ss?.CurrentPrice),
    bidCount: parseIntLoose(ss?.BidCount),
    ack: resp?.Ack ?? null,
    errorMessage: extractFirstError(resp?.Errors),
  };
}

function extractCurrencyId(val: unknown): string | null {
  if (typeof val === 'object' && val !== null) {
    const id = (val as AmountNode)['@_currencyID'];
    if (typeof id === 'string') return id;
  }
  return null;
}

function parseIntLoose(val: unknown): number {
  if (typeof val === 'number') return Math.trunc(val);
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

type ErrorNode = { LongMessage?: string; ShortMessage?: string };

function extractFirstError(errors: ErrorNode | ErrorNode[] | undefined): string | null {
  if (!errors) return null;
  const first = Array.isArray(errors) ? errors[0] : errors;
  if (!first) return null;
  return first.LongMessage ?? first.ShortMessage ?? null;
}

// eBay AmountType fields carry an optional currencyID attribute, so fast-xml-parser
// may produce either a plain number or { '@_currencyID': '...', '#text': number }.
function parseMoney(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return Number(val);
  if (typeof val === 'object' && val !== null) {
    const text = (val as Record<string, unknown>)['#text'];
    if (text !== undefined) return Number(text);
  }
  return 0;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --- GetFeedback: buyer feedback entries with per-item linkage ---
//
// Returns the feedback a user has RECEIVED, one detail entry per feedback
// event, each carrying the numeric ItemID it was left on — the same mapping
// the public profile page shows, but structured and via api.ebay.com (no
// datacenter-IP challenge). With no userId, returns the token owner's
// feedback (complete detail guaranteed). With a userId, requests another
// account's public feedback — whether eBay returns full detail rows for
// arbitrary users is unverified; callers should treat empty results for
// non-owner users as "API said no", not an error.

export interface FeedbackEntry {
  // Numeric item id (Trading form). Callers map to the canonical
  // v1|<n>|0 listings key themselves.
  itemId: string;
  commentingUser: string;
  commentType: string; // Positive | Neutral | Negative | Withdrawn
  commentText: string | null;
  commentTime: string | null; // ISO
  // Role of the feedback RECIPIENT in the transaction. 'Seller' = this is
  // feedback a buyer left for the seller — the kind we preserve.
  role: string | null;
}

export interface FeedbackPage {
  entries: FeedbackEntry[];
  totalPages: number;
  ack: string | null;
  errorMessage: string | null;
}

interface FeedbackDetailNode {
  CommentingUser?: string;
  CommentText?: string;
  CommentTime?: string;
  CommentType?: string;
  ItemID?: string | number;
  Role?: string;
}

interface ParsedFeedbackResponse {
  GetFeedbackResponse?: {
    Ack?: string;
    Errors?: ErrorNode | ErrorNode[];
    FeedbackDetailArray?: {
      FeedbackDetail?: FeedbackDetailNode | FeedbackDetailNode[];
    };
    PaginationResult?: {
      TotalNumberOfPages?: number | string;
    };
  };
}

export async function getFeedbackPage(
  userToken: string,
  options: { userId?: string; page?: number } = {},
): Promise<FeedbackPage> {
  const page = options.page ?? 1;
  const userIdXml = options.userId ? `<UserID>${escapeXml(options.userId)}</UserID>
  ` : '';
  const parsed = (await tradingCall(
    'GetFeedback',
    userToken,
    `${userIdXml}<DetailLevel>ReturnAll</DetailLevel>
  <FeedbackType>FeedbackReceivedAsSeller</FeedbackType>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>`,
  )) as ParsedFeedbackResponse;
  const resp = parsed?.GetFeedbackResponse;

  const details = asArray<FeedbackDetailNode>(resp?.FeedbackDetailArray?.FeedbackDetail);

  const entries: FeedbackEntry[] = details
    .filter((d): d is FeedbackDetailNode & { ItemID: string | number; CommentingUser: string } =>
      Boolean(d.ItemID !== undefined && d.CommentingUser),
    )
    .map((d) => ({
      itemId: String(d.ItemID),
      commentingUser: String(d.CommentingUser),
      commentType: d.CommentType ?? 'Unknown',
      commentText: typeof d.CommentText === 'string' && d.CommentText.length > 0 ? String(d.CommentText) : null,
      commentTime: toIsoOrNull(d.CommentTime),
      role: d.Role ?? null,
    }));

  const totalPagesRaw = resp?.PaginationResult?.TotalNumberOfPages;
  const totalPages = typeof totalPagesRaw === 'number'
    ? totalPagesRaw
    : typeof totalPagesRaw === 'string' && Number.isFinite(Number(totalPagesRaw))
      ? Number(totalPagesRaw)
      : 1;

  return {
    entries,
    totalPages,
    ack: resp?.Ack ?? null,
    errorMessage: extractFirstError(resp?.Errors),
  };
}

// Invalid date strings must not throw mid-parse — a malformed CommentTime
// just yields null and the sweep skips that entry.
function toIsoOrNull(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
