import type { EbayClient } from './client.js';
import { upgradeEbayImageUrl } from './seller.js';

// Subset of the eBay Browse /buy/browse/v1/item/{id} response we care about.
// See https://developer.ebay.com/api-docs/buy/browse/resources/item/methods/getItem
interface BrowseItemImage {
  imageUrl?: string;
}

interface BrowseItemResponse {
  // Browse's "primary" image, repeated here from item_summary/search.
  image?: BrowseItemImage;
  // The full seller gallery. Often includes the primary as the first entry;
  // we dedupe against primaryUrl below so callers can safely render
  // [primary, ...additional] without doubling up.
  additionalImages?: BrowseItemImage[];
  // Raw seller HTML. Can be empty or absent.
  description?: string;
}

export interface ItemDetailsResult {
  additionalImages: string[];
  descriptionHtml: string | null;
}

const ITEM_PATH = '/buy/browse/v1/item/';

// Fetch the per-item details that aren't in item_summary/search: the full
// gallery and the seller's HTML description. Returns null if eBay reports
// the item as gone (404) — callers persist a stamp regardless so we don't
// retry the missing-item forever.
//
// One Browse call per itemId. The same s-l URL bump used by seller.ts is
// applied here so the gallery URLs come back high-res.
export async function fetchItemDetails(
  client: EbayClient,
  itemId: string,
  primaryImageUrl: string | null = null,
): Promise<ItemDetailsResult | null> {
  // eBay's path-segment item IDs may contain `|` (the canonical v1|<n>|0
  // form) and dots; encodeURIComponent handles both safely.
  const path = `${ITEM_PATH}${encodeURIComponent(itemId)}`;
  let res: BrowseItemResponse;
  try {
    res = await client.get<BrowseItemResponse>(path);
  } catch (err) {
    // 404 is treated as "no details, don't retry too eagerly" — the caller
    // still persists a fetched-at stamp so the staleness window applies.
    const status =
      err !== null && typeof err === 'object' && 'status' in err
        ? Number((err as { status: unknown }).status)
        : NaN;
    if (status === 404) return null;
    throw err;
  }

  // Gallery: bump every URL to s-l1600 and dedupe against the primary so
  // callers can render [primary, ...additional] without doubling up. Order
  // from eBay is preserved otherwise.
  const seen = new Set<string>();
  const primaryUpgraded = upgradeEbayImageUrl(primaryImageUrl);
  if (primaryUpgraded) seen.add(primaryUpgraded);
  const additionalImages: string[] = [];
  for (const img of res.additionalImages ?? []) {
    const upgraded = upgradeEbayImageUrl(img.imageUrl ?? null);
    if (!upgraded || seen.has(upgraded)) continue;
    seen.add(upgraded);
    additionalImages.push(upgraded);
  }
  // Some listings only carry the primary on `.image` in the item response;
  // include it as a fallback gallery entry if the seller gave us nothing
  // else, so the carousel always has at least the primary even when the
  // listing predates the columns being populated.
  if (additionalImages.length === 0) {
    const primaryFromItem = upgradeEbayImageUrl(res.image?.imageUrl ?? null);
    if (primaryFromItem && !seen.has(primaryFromItem)) additionalImages.push(primaryFromItem);
  }

  const descriptionHtml = typeof res.description === 'string' && res.description.length > 0
    ? res.description
    : null;

  return { additionalImages, descriptionHtml };
}
