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

interface BidNode {
  Bidder?: { UserID?: string };
  BidTime?: string;
  MaxBid?: string;
  BidAmount?: string;
}

interface ParsedResponse {
  GetItemResponse?: {
    Item?: {
      BidCount?: string;
      CurrentPrice?: string;
      Bids?: {
        Bid?: BidNode | BidNode[];
      };
    };
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
});

export async function getItemBidHistory(
  itemId: string,
  devId: string,
  userToken: string,
): Promise<ItemBidHistory> {
  const requestBody = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${escapeXml(userToken)}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;

  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-DEV-NAME': devId,
      'X-EBAY-API-APP-NAME': devId,
      'X-EBAY-API-CERT-NAME': devId,
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'Content-Type': 'application/xml',
    },
    body: requestBody,
  });

  if (!res.ok) {
    throw new Error(`eBay Trading API error: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml) as ParsedResponse;

  const item = parsed?.GetItemResponse?.Item;
  if (!item) {
    throw new Error(`No item found in Trading API response for ${itemId}`);
  }

  const bidCount = item.BidCount ? Number(item.BidCount) : 0;
  const currentPrice = item.CurrentPrice ? Number(item.CurrentPrice) : 0;

  const bidList = item.Bids?.Bid ?? [];
  const bidsArray = Array.isArray(bidList) ? bidList : bidList ? [bidList] : [];

  const bids: BidRecord[] = bidsArray.map((bid) => ({
    bidder: bid.Bidder?.UserID ?? 'unknown',
    bidTime: bid.BidTime ?? '',
    bidAmount: Number(bid.MaxBid ?? bid.BidAmount ?? 0),
  }));

  return {
    itemId,
    bidCount,
    currentPrice,
    bids,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
