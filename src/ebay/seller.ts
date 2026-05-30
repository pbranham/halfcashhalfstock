import type { EbayClient } from './client.js';

export interface Listing {
  itemId: string;
  sellerId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string;
  priceUsd: number | null;
  currency: string | null;
  bidCount: number | null;
  endsAt: string | null;
  buyingOptions: readonly string[];
  isAuction: boolean;
  lastBidTime?: string | null;
}

interface BrowsePrice {
  value?: string;
  currency?: string;
}

interface BrowseImage {
  imageUrl?: string;
}

interface BrowseItemSummary {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  image?: BrowseImage;
  thumbnailImages?: BrowseImage[];
  itemWebUrl?: string;
  price?: BrowsePrice;
  currentBidPrice?: BrowsePrice;
  bidCount?: number;
  itemEndDate?: string;
  buyingOptions?: string[];
}

interface BrowseSearchResponse {
  itemSummaries?: BrowseItemSummary[];
  next?: string;
}

const SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

// eBay's image CDN encodes the rendered size in the filename as `s-l<N>`
// (e.g. s-l140, s-l500). Browse search returns small thumbnails; bumping the
// number requests a larger render of the SAME upload at no extra API cost.
// 1600 is eBay's largest standard size. Only rewrites i.ebayimg.com URLs and
// only when the s-l token is present, so non-eBay or unexpected URLs pass
// through untouched.
export function upgradeEbayImageUrl(url: string | null, size = 1600): string | null {
  if (!url) return url;
  if (!/(^|\.)ebayimg\.com\//.test(url)) return url;
  return url.replace(/\/s-l\d+(\.\w+)/i, `/s-l${size}$1`);
}

export interface SellerListingsOptions {
  marketplaceCurrency?: string;
}

export async function listSellerActiveItems(
  client: EbayClient,
  sellerId: string,
  options: SellerListingsOptions = {},
): Promise<Listing[]> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(sellerId)) {
    throw new RangeError(`invalid sellerId: ${sellerId}`);
  }

  const expectedCurrency = options.marketplaceCurrency ?? 'USD';
  const listings: Listing[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.get<BrowseSearchResponse>(SEARCH_PATH, {
      // Browse search requires one of q/category_ids/epid/gtin; category_ids=0
      // is the documented "all categories" workaround for seller-only queries.
      category_ids: '0',
      // Auctions are excluded from results unless explicitly opted-in alongside FIXED_PRICE.
      filter: `sellers:{${sellerId}},buyingOptions:{AUCTION|FIXED_PRICE}`,
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    });
    const summaries = res.itemSummaries ?? [];
    for (const s of summaries) {
      const normalized = normalizeListing(s, sellerId, expectedCurrency);
      if (normalized) listings.push(normalized);
    }
    if (summaries.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return listings;
}

function normalizeListing(
  s: BrowseItemSummary,
  sellerId: string,
  expectedCurrency: string,
): Listing | null {
  const itemId = s.itemId ?? s.legacyItemId;
  const title = s.title;
  const itemWebUrl = s.itemWebUrl;
  if (!itemId || !title || !itemWebUrl) {
    // Surface the actual Browse API shape so we can see why a listing was
    // dropped (e.g. quirky 0-bid auction returning unexpected fields). One
    // warn per skipped summary; small diagnostic, big payoff next time the
    // schema surprises us.
    console.warn(
      `[seller:${sellerId}] skipping listing with missing required fields:`,
      JSON.stringify({
        itemId: s.itemId,
        legacyItemId: s.legacyItemId,
        title: s.title,
        itemWebUrl: s.itemWebUrl,
        buyingOptions: s.buyingOptions,
        hasPrice: s.price !== undefined,
        hasCurrentBidPrice: s.currentBidPrice !== undefined,
      }),
    );
    return null;
  }

  const buyingOptions = s.buyingOptions ?? [];
  const isAuction = buyingOptions.includes('AUCTION');
  const rawPrice = isAuction ? (s.currentBidPrice ?? s.price) : s.price;
  const priceValue = rawPrice?.value !== undefined ? Number(rawPrice.value) : Number.NaN;
  const currency = rawPrice?.currency ?? null;

  const priceUsd =
    Number.isFinite(priceValue) && priceValue >= 0 && currency === expectedCurrency
      ? priceValue
      : null;

  const imageUrl = upgradeEbayImageUrl(
    s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
  );

  return {
    itemId,
    sellerId,
    title,
    imageUrl,
    itemWebUrl,
    priceUsd,
    currency,
    bidCount: typeof s.bidCount === 'number' ? s.bidCount : null,
    endsAt: s.itemEndDate ?? null,
    buyingOptions,
    isAuction,
  };
}
