import { XMLParser } from 'fast-xml-parser';

export interface BidRecord {
  bidder: string;
  bidTime: string;
  bidAmount: number;
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
    HighestBid?: unknown;
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
});

export async function getItemBidHistory(
  itemId: string,
  _devId: string,
  userToken: string,
): Promise<ItemBidHistory> {
  const tradingItemId = normalizeTradingItemId(itemId);
  const requestBody = `<?xml version="1.0" encoding="UTF-8"?>
<GetAllBiddersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(userToken)}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${escapeXml(tradingItemId)}</ItemID>
  <CallMode>ViewAll</CallMode>
</GetAllBiddersRequest>`;

  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'GetAllBidders',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml',
    },
    body: requestBody,
  });

  if (!res.ok) {
    throw new Error(`eBay Trading API error: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml) as ParsedResponse;

  const offerList = parsed?.GetAllBiddersResponse?.BidArray?.Offer ?? [];
  const offersArray: OfferNode[] = Array.isArray(offerList)
    ? offerList
    : offerList
      ? [offerList as OfferNode]
      : [];

  const bids: BidRecord[] = offersArray
    .filter((o): o is OfferNode & { TimeBid: string } => Boolean(o.TimeBid))
    .map((offer) => ({
      bidder: offer.User?.UserID ?? 'unknown',
      bidTime: offer.TimeBid,
      bidAmount: parseMoney(offer.MaxBid ?? offer.HighestBid),
    }));

  // Sort ascending so bids[last] is the most recent bid action.
  bids.sort((a, b) => (a.bidTime < b.bidTime ? -1 : a.bidTime > b.bidTime ? 1 : 0));

  return {
    itemId: tradingItemId,
    bidCount: bids.length,
    currentPrice: parseMoney(parsed?.GetAllBiddersResponse?.HighestBid),
    bids,
  };
}

function normalizeTradingItemId(itemId: string): string {
  const parts = itemId.split('|');
  if (parts.length >= 2 && parts[1]) return parts[1];
  return itemId;
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
