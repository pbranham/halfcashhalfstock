// Masks an eBay bidder username for public display, matching the way eBay's
// own public bid-history page presents buyer IDs to non-sellers (first char
// + asterisks + last char, e.g. "boilerpaulie" → "b***e").
//
// As the seller, the Trading API returns full usernames; we strip them at
// the API boundary so the public item-audit page never reveals private
// bidder identities. Already-masked usernames (e.g. "3***2" from viewbids
// parsing) pass through unchanged.

const ALREADY_MASKED = /^[0-9A-Za-z]\*{2,4}[0-9A-Za-z]$/;

export function maskBidder(bidder: string | null | undefined): string {
  if (!bidder) return 'unknown';
  if (bidder === 'unknown') return 'unknown';
  if (ALREADY_MASKED.test(bidder)) return bidder;
  if (bidder.length <= 2) return bidder;
  return `${bidder[0]}***${bidder[bidder.length - 1]}`;
}
