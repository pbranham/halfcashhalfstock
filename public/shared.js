// Helpers every page (dashboard, item audit, admin) shares. One home each —
// pages import what they need instead of keeping their own copies.

// localStorage key holding the admin bearer token (set on /admin, read by
// the item page's admin tools).
export const ADMIN_TOKEN_KEY = 'hchs.admin.token';

// Build an element: `props.class` sets className; link/image/aria-* props
// go through setAttribute; anything else is assigned as a property. String
// children become text nodes; null/undefined children are skipped.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'href' || k === 'target' || k === 'rel' || k === 'src' || k === 'alt' || k === 'loading' || k === 'title' || k.startsWith('aria-')) {
      node.setAttribute(k, v);
    } else {
      node[k] = v;
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// Escape text for interpolation into innerHTML.
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A persisted choice from a fixed set: the stored value when it's one of
// `allowed`, otherwise `fallback`.
export function loadChoice(key, allowed, fallback) {
  const stored = localStorage.getItem(key);
  return allowed.includes(stored) ? stored : fallback;
}

// Persist `value` under `key` when it's one of `allowed`.
export function saveChoice(key, allowed, value) {
  if (allowed.includes(value)) localStorage.setItem(key, value);
}

// Upgrade an eBay image URL to a larger render (see upgradeEbayImageUrl on
// the server). Applied at render so even listings persisted with a small
// thumbnail URL (e.g. ended rows fetched before the server-side upgrade
// landed) display crisply. Non-eBay URLs pass through unchanged.
export function hiResImg(url, size = 1600) {
  if (!url || !/(^|\.)ebayimg\.com\//.test(url)) return url;
  return url.replace(/\/s-l\d+(\.\w+)/i, `/s-l${size}$1`);
}

// The eBay listing page for an item id (Browse `v1|<numeric>|0` or numeric).
export function ebayItemUrl(itemId) {
  if (!itemId) return 'https://www.ebay.com/';
  const parts = String(itemId).split('|');
  const legacyNumber = parts.length >= 2 && parts[1] ? parts[1] : itemId;
  return `https://www.ebay.com/itm/${encodeURIComponent(legacyNumber)}`;
}

// For ended auctions, append eBay's no-redirect parameter (nordt=true) so the
// original ended listing is shown instead of redirecting to "similar items".
// eBay only redirects ended listings that are linked to a catalog/product page
// (e.g. mass-market goods); nordt=true suppresses that. orig_cvip=true is kept
// as a harmless legacy hint.
export function endedEbayUrl(itemWebUrl, itemId) {
  const base = itemWebUrl || ebayItemUrl(itemId);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}nordt=true&orig_cvip=true`;
}

// "1 bid" / "3 bids": the count with the word, pluralised with an "s".
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// POST one admin maintenance action (`body.action`) to the single admin
// endpoint with the bearer token. Returns the fetch Response.
export function postAdminAction(token, body) {
  return fetch('/api/admin/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
