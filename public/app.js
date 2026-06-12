import { openImageLightbox } from '/lightbox.js';
import { attachCyclingCarousel } from '/carousel.js';

const POLL_MS = 30_000;
const QUICK_RETRY_MS = 4_000;
const STALE_MS = 120_000;

const SUPPORTED_SYMBOLS = ['EBAY', 'GME'];
let activeSymbol = SUPPORTED_SYMBOLS[0];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const shares = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
// Compact form for narrow split columns on tiles: round to 4 significant
// digits so values like 14.7438 → 14.74 fit on one line beside the logo
// without needing ellipsis. Totals (wide columns) keep the full 4 dp form.
const sharesCompact = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });
const integer = new Intl.NumberFormat('en-US');

// --- Sort & animation state ---
// Sort mode — must match data-sort values on .sort-btn elements in index.html.
const SORT_MODES = ['ending-soonest', 'recent-bid-activity', 'price-low', 'price-high', 'most-bids'];
function loadSort() {
  const stored = localStorage.getItem('hchs.sort');
  return SORT_MODES.includes(stored) ? stored : 'ending-soonest';
}
function saveSort(value) {
  if (SORT_MODES.includes(value)) localStorage.setItem('hchs.sort', value);
}
let currentSort = loadSort();
let lastSnapshot = null;
let prevBidCounts = new Map(); // itemId → bidCount from last successful render

// --- Seller filter state ---
// Pill id → matching sellerId (or null for "all"). The mapping is hard-coded
// because the dashboard knows about exactly two sellers today; adding a third
// means adding a pill + entry here.
const SELLER_PILL_TO_ID = {
  all: null,
  mine: 'boilerpaulie',
  ryan: 'ryan_5050',
};
// Each filter has a thematic stock pairing: Ryan wants to buy eBay, I want
// to buy GameStop. Picking a filter swaps the ticker to match. The user can
// still manually pick a different ticker afterward — the auto-swap only
// fires on filter changes.
const SELLER_FILTER_DEFAULT_TICKER = {
  all: 'EBAY',
  mine: 'GME',
  ryan: 'EBAY',
};
function loadSellerFilterFromStorage() {
  const stored = localStorage.getItem('hchs.sellerFilter');
  return stored && stored in SELLER_PILL_TO_ID ? stored : 'all';
}
function saveSellerFilterToStorage(value) {
  if (value in SELLER_PILL_TO_ID) localStorage.setItem('hchs.sellerFilter', value);
}
let currentSellerFilter = loadSellerFilterFromStorage();

function filterBySeller(items) {
  const wanted = SELLER_PILL_TO_ID[currentSellerFilter];
  if (!wanted) return items;
  return items.filter((i) => i.sellerId === wanted);
}

function sellerBadgeClass(sellerId) {
  if (sellerId === 'boilerpaulie') return 'seller-badge seller-badge-mine';
  if (sellerId === 'ryan_5050') return 'seller-badge seller-badge-ryan';
  return 'seller-badge';
}

// --- Ended-section "Live vs At end" stock-price mode ---
const ENDED_MODES = ['live', 'at-end'];
function loadEndedPriceMode() {
  const stored = localStorage.getItem('hchs.endedPriceMode');
  return ENDED_MODES.includes(stored) ? stored : 'live';
}
function saveEndedPriceMode(value) {
  if (ENDED_MODES.includes(value)) localStorage.setItem('hchs.endedPriceMode', value);
}
let currentEndedPriceMode = loadEndedPriceMode();

// --- Ended-section time window ("Recently ended" vs "All time") ---
// The "all" value caps at the server's 36500-day max (~100 years) so we
// effectively fetch everything ever ended. The DB never deletes ended
// listings — they accumulate indefinitely under the listings table — so
// this is the right way to expose the full history.
const ENDED_WINDOWS = ['recent', 'all'];
const ENDED_WINDOW_DAYS = { recent: 14, all: 36500 };
function loadEndedWindow() {
  const stored = localStorage.getItem('hchs.endedWindow');
  return ENDED_WINDOWS.includes(stored) ? stored : 'recent';
}
function saveEndedWindow(value) {
  if (ENDED_WINDOWS.includes(value)) localStorage.setItem('hchs.endedWindow', value);
}
let currentEndedWindow = loadEndedWindow();

// --- Item view mode (list / small / medium / large grid) ---
// All modes share the same renderItem DOM; only a class on the items
// containers changes, so switching is a pure CSS reflow — no re-render.
const VIEW_MODES = ['list', 'grid-sm', 'grid-md', 'grid-lg'];
function loadViewMode() {
  const stored = localStorage.getItem('hchs.viewMode');
  return VIEW_MODES.includes(stored) ? stored : 'grid-md';
}
function saveViewMode(value) {
  if (VIEW_MODES.includes(value)) localStorage.setItem('hchs.viewMode', value);
}
let currentViewMode = loadViewMode();

// Apply the current view mode class to both the active and ended item
// containers. Safe to call repeatedly (e.g. after each render).
function applyViewMode() {
  for (const id of ['items', 'ended-items']) {
    const container = document.getElementById(id);
    if (!container) continue;
    for (const mode of VIEW_MODES) container.classList.remove(`view-${mode}`);
    container.classList.add(`view-${currentViewMode}`);
  }
}

// --- Ticker state ---
function loadTickerFromStorage() {
  const stored = localStorage.getItem('ticker');
  if (stored && /^[A-Z][A-Z0-9.\-:]{0,19}$/.test(stored)) {
    return stored;
  }
  return SUPPORTED_SYMBOLS[0];
}
function saveTickerToStorage(ticker) {
  if (/^[A-Z][A-Z0-9.\-:]{0,19}$/.test(ticker)) {
    localStorage.setItem('ticker', ticker);
  }
}

activeSymbol = loadTickerFromStorage();
function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function formatRelativeBidAge(isoTime, nowMs = Date.now()) {
  const ts = parseTimestamp(isoTime);
  if (ts === null) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - ts) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ${seconds}s ago`;

  const hours = Math.floor(minutes / 60);
  const minutesRemainder = minutes % 60;
  if (hours < 24) return `${hours}h ${minutesRemainder}m ago`;

  const days = Math.floor(hours / 24);
  const hoursRemainder = hours % 24;
  return `${days}d ${hoursRemainder}h ago`;
}

function formatLocalTimestamp(isoTime) {
  const ts = parseTimestamp(isoTime);
  if (ts === null) return 'Unknown timestamp';
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  });
}

function sortItems(items, sort) {
  const sorted = [...items];
  switch (sort) {
    case 'ending-soonest':
      return sorted.sort((a, b) => {
        if (!a.endsAt && !b.endsAt) return 0;
        if (!a.endsAt) return 1;
        if (!b.endsAt) return -1;
        return new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime();
      });
    case 'price-low':
      return sorted.sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity));
    case 'price-high':
      return sorted.sort((a, b) => (b.priceUsd ?? -Infinity) - (a.priceUsd ?? -Infinity));
    case 'most-bids':
      return sorted.sort((a, b) => (b.bidCount ?? 0) - (a.bidCount ?? 0));
    case 'recent-bid-activity':
      return sorted.sort((a, b) => {
        const aTs = parseTimestamp(a.lastBidTime);
        const bTs = parseTimestamp(b.lastBidTime);
        if (aTs === null && bTs === null) return 0;
        if (aTs === null) return 1;
        if (bTs === null) return -1;
        return bTs - aTs;
      });
    default:
      return sorted;
  }
}

// Apply the same sort selection to ended items. There's no "ending soon" for
// auctions that have already ended, so ending-soonest and recent-bid-activity
// both fall back to "most recently ended first" — the closest semantic match.
function sortEndedItems(items, sort) {
  const sorted = [...items];
  switch (sort) {
    case 'price-low':
      return sorted.sort((a, b) => (a.finalPriceUsd ?? Infinity) - (b.finalPriceUsd ?? Infinity));
    case 'price-high':
      return sorted.sort((a, b) => (b.finalPriceUsd ?? -Infinity) - (a.finalPriceUsd ?? -Infinity));
    case 'most-bids':
      return sorted.sort((a, b) => (b.finalBidCount ?? 0) - (a.finalBidCount ?? 0));
    case 'ending-soonest':
    case 'recent-bid-activity':
    default:
      return sorted.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  }
}

// Recompute totals from a filtered subset so the on-page numbers reflect the
// active seller filter. Mirrors the server-side composeSnapshot math:
// no-bid items are excluded from the dollar totals (their priceUsd is just
// the starting price, which shouldn't count until someone bids).
function aggregateActiveTotals(items, stockPrice) {
  const priced = items.filter(
    (i) =>
      i.priceUsd !== null && i.priceUsd !== undefined && (i.bidCount ?? 0) > 0,
  );
  const bidUsd = priced.reduce((sum, i) => sum + i.priceUsd, 0);
  const cashUsd = bidUsd / 2;
  const stockUsd = bidUsd / 2;
  const shares = stockPrice > 0 ? stockUsd / stockPrice : 0;
  return {
    listingsCount: items.length,
    pricedCount: priced.length,
    bidsCount: items.reduce((sum, i) => sum + (i.bidCount ?? 0), 0),
    bidUsd,
    split: { cashUsd, stockUsd, shares },
  };
}

function aggregateEndedTotals(items, stockPrice) {
  // No-bid auctions (finalBidCount === 0) didn't actually clear at any real
  // price, so they shouldn't roll into the ended totals.
  const hasBid = (i) => (i.finalBidCount ?? 0) > 0;

  // Live split: every USD-priced item with at least one bid contributes at
  // the current stock price.
  const priced = items.filter((i) => i.split !== null && i.split !== undefined && hasBid(i));
  const bidUsd = priced.reduce((sum, i) => sum + i.finalPriceUsd, 0);
  const cashUsd = bidUsd / 2;
  const stockUsd = bidUsd / 2;
  const shares = stockPrice > 0 ? stockUsd / stockPrice : 0;

  // End-time split: sum each item's pre-computed endTimeSplit. Items where
  // OHLC history is missing OR that never received a bid drop out of this
  // aggregate.
  const pricedAtEnd = items.filter(
    (i) => i.endTimeSplit !== null && i.endTimeSplit !== undefined && hasBid(i),
  );
  const splitAtEnd = pricedAtEnd.reduce(
    (acc, i) => ({
      cashUsd: acc.cashUsd + i.endTimeSplit.cashUsd,
      stockUsd: acc.stockUsd + i.endTimeSplit.stockUsd,
      shares: acc.shares + i.endTimeSplit.shares,
    }),
    { cashUsd: 0, stockUsd: 0, shares: 0 },
  );

  return {
    listingsCount: items.length,
    bidsCount: items.reduce((sum, i) => sum + (i.finalBidCount ?? 0), 0),
    bidUsd,
    split: { cashUsd, stockUsd, shares },
    splitAtEnd,
    pricedAtEndCount: pricedAtEnd.length,
  };
}

// --- The Imaginary Brokerage ---
// The site's core hypothetical, resolved: if every winning buyer had really
// paid half in stock at the close-of-auction price, here's how that stock
// is doing today. Pure transform of data already on the snapshot — each
// sold item's endTimeSplit (shares + stock-half dollars at its end-time
// close) marked to the live price.
function aggregateBrokerage(endedItems, livePrice) {
  const sold = endedItems.filter((i) => (i.finalBidCount ?? 0) > 0);
  const positions = sold
    .filter((i) => i.endTimeSplit && Number.isFinite(i.endTimeSplit.shares))
    .map((i) => {
      const shares = i.endTimeSplit.shares;
      const costBasis = i.endTimeSplit.stockUsd;
      const worthNow = livePrice > 0 ? shares * livePrice : null;
      return {
        itemId: i.itemId,
        title: i.title,
        endedAt: i.endedAt,
        shares,
        closePrice: i.endTimePriceUsd,
        costBasis,
        worthNow,
        pnl: worthNow !== null ? worthNow - costBasis : null,
      };
    })
    .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  const shares = positions.reduce((sum, p) => sum + p.shares, 0);
  const costBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const worthNow = livePrice > 0 ? shares * livePrice : null;
  return {
    positions,
    excludedCount: sold.length - positions.length,
    shares,
    costBasis,
    worthNow,
    pnl: worthNow !== null ? worthNow - costBasis : null,
    pnlPct: worthNow !== null && costBasis > 0 ? ((worthNow - costBasis) / costBasis) * 100 : null,
  };
}

function pnlNode(pnl, pct) {
  const up = pnl >= 0;
  const cls = up ? 'pnl-up' : 'pnl-down';
  const arrow = up ? '\u25b2' : '\u25bc';
  const pctStr = pct !== null && Number.isFinite(pct) ? ` (${up ? '+' : ''}${pct.toFixed(1)}%)` : '';
  return el('span', { class: cls, textContent: `${arrow} ${up ? '+' : '\u2212'}${usd.format(Math.abs(pnl))}${pctStr}` });
}

function renderBrokerage(snapshot, filteredEnded, livePrice) {
  const section = document.getElementById('brokerage-section');
  if (!section) return;
  const b = aggregateBrokerage(filteredEnded, livePrice);
  // Nothing sold with an end-time price yet (or price feed down) — the
  // hypothetical has nothing to say; hide rather than show dashes.
  if (b.positions.length === 0 || b.worthNow === null) {
    section.hidden = true;
    return;
  }
  const symbol = snapshot.stock?.symbol ?? activeSymbol;

  setText(
    document.getElementById('brokerage-tagline'),
    `If every buyer had really paid half in $${symbol} stock, here\u2019s how their shares are doing:`,
  );

  const stats = document.getElementById('brokerage-stats');
  stats.replaceChildren();
  const cards = [
    { label: 'Shares held', value: sharesValue(b.shares) },
    { label: 'Cost basis', value: usd.format(b.costBasis) },
    { label: 'Worth today', value: usd.format(b.worthNow) },
    { label: 'Unrealized P&L', value: pnlNode(b.pnl, b.pnlPct) },
  ];
  for (const stat of cards) {
    const valueEl = el('div', { class: 'stat-value' });
    if (typeof stat.value === 'string') valueEl.textContent = stat.value;
    else valueEl.appendChild(stat.value);
    stats.appendChild(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-label', textContent: stat.label }),
        valueEl,
      ]),
    );
  }

  setText(
    document.getElementById('brokerage-summary'),
    `Statement (${b.positions.length} position${b.positions.length === 1 ? '' : 's'})`,
  );

  const table = document.getElementById('brokerage-table');
  table.replaceChildren();
  for (const p of b.positions) {
    const row = el('div', { class: 'brokerage-row' });
    row.appendChild(
      el('a', {
        class: 'brokerage-item',
        href: `/item.html?id=${encodeURIComponent(p.itemId)}`,
        textContent: p.title,
      }),
    );
    const detail = el('div', { class: 'brokerage-detail' });
    const closeStr = p.closePrice !== null ? ` @ ${usd.format(p.closePrice)}` : '';
    detail.appendChild(el('span', { textContent: `${sharesCompact.format(p.shares)} sh${closeStr}` }));
    detail.appendChild(el('span', { textContent: `cost ${usd.format(p.costBasis)}` }));
    detail.appendChild(el('span', { textContent: `now ${usd.format(p.worthNow)}` }));
    detail.appendChild(pnlNode(p.pnl, p.costBasis > 0 ? (p.pnl / p.costBasis) * 100 : null));
    row.appendChild(detail);
    table.appendChild(row);
  }

  const footnote = document.getElementById('brokerage-footnote');
  if (b.excludedCount > 0) {
    setText(footnote, `${b.excludedCount} sold item${b.excludedCount === 1 ? '' : 's'} excluded \u2014 no stock price on record for the moment the auction ended.`);
    footnote.hidden = false;
  } else {
    footnote.hidden = true;
  }

  section.hidden = false;
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function el(tag, props = {}, children = []) {
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

function timeRemaining(endsAt) {
  if (!endsAt) return '';
  const ms = new Date(endsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'ended';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days >= 1) return `${days}d ${hours}h left`;
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function isUsMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutesInDay = Number(get('hour')) * 60 + Number(get('minute'));
  return minutesInDay >= 9 * 60 + 30 && minutesInDay < 16 * 60;
}

// Short clock format: "4:00 PM" (no seconds). Stale snapshots refresh on a
// 30s cadence so seconds-precision was always either 0s ago or 30s ago —
// minute-precision is cleaner and reads exactly the same.
function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The price's "as of" time, formatted differently depending on whether the
// market is open. Live: just the clock (it ticks in real time, so showing
// "MON 3:42 PM" reads as falsely-anchored). Closed: prepend the short
// weekday so a stale close-of-day price is unambiguous on a weekend.
function formatPriceAsOf(asOfDate, marketOpen) {
  if (!asOfDate || Number.isNaN(asOfDate.getTime())) return '';
  const clock = formatClock(asOfDate);
  if (marketOpen) return clock;
  const weekday = asOfDate.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  return `${weekday} ${clock}`;
}

function renderTicker(snapshot) {
  const ticker = document.getElementById('ticker');
  if (!ticker) return;
  const price = snapshot?.stock?.price;
  const symbol = snapshot?.stock?.symbol ?? activeSymbol;
  setText(ticker.querySelector('.ticker-symbol'), `$${symbol}`);
  setText(ticker.querySelector('.ticker-price'), price ? usd.format(price) : '—');
  const generated = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  const isStale = generated ? Date.now() - generated.getTime() > STALE_MS : false;
  ticker.classList.toggle('is-stale', isStale);
  const marketOpen = isUsMarketOpen();
  setText(ticker.querySelector('.ticker-status'), marketOpen ? '' : 'Market closed');
  // Price-feed timestamp lives directly below the market-status line so the
  // user can tell at a glance how stale the stock value is (especially over
  // a weekend, when the close from Friday afternoon should be unambiguous).
  const asOf = snapshot?.stock?.asOf ? new Date(snapshot.stock.asOf) : null;
  setText(ticker.querySelector('.ticker-as-of'), formatPriceAsOf(asOf, marketOpen));
}

// The center "Updated" widget tracks the *auction* data timestamp —
// distinct from the price-feed time shown under the ticker. snapshot.
// generatedAt fires right after the listings cache returns, so it's a
// faithful "when did we last refresh the auctions" signal.
function renderLastUpdated(snapshot) {
  const el = document.getElementById('last-updated');
  if (!el) return;
  const generated = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  if (!generated) {
    el.replaceChildren();
    return;
  }
  // Three discrete spans so the mobile CSS can stack them onto their own
  // lines (Auctions / updated at / 3:37 AM) while desktop renders them
  // inline as a single sentence — text nodes between spans give the
  // inline spacing for free.
  const mk = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  el.replaceChildren(
    mk('updated-headline', 'Auctions'),
    document.createTextNode(' '),
    mk('updated-verb', 'updated at'),
    document.createTextNode(' '),
    mk('updated-time', formatClock(generated)),
  );
}

function renderDegradedBanner(snapshot) {
  const banner = document.getElementById('degraded-banner');
  if (!banner) return;
  // snapshot.degraded is set by the server when the listings/quote caches
  // are serving past-TTL data because live fetches are failing. We still
  // render all the (stale) data — this just flags that it's not live.
  banner.hidden = !snapshot?.degraded;
}

function renderPriceSource(snapshot) {
  const el = document.getElementById('price-source');
  if (!el) return;
  const source = snapshot?.stock?.source;
  setText(el, source === 'finnhub' ? 'Finnhub' : source === 'yahoo' ? 'Yahoo Finance' : 'Finnhub or Yahoo Finance');
}

function renderTotals(snapshot, totals) {
  const root = document.getElementById('totals');
  if (!root) return;
  root.replaceChildren();
  if (!snapshot || !totals) return;
  const { listingsCount, bidsCount, bidUsd, split } = totals;
  const symbol = snapshot.stock?.symbol ?? activeSymbol;
  const items = [
    { label: 'Active listings', value: integer.format(listingsCount) },
    { label: 'Bids', value: integer.format(bidsCount ?? 0) },
    { label: 'Sum of current bids', value: usd.format(bidUsd) },
    { label: 'Half Cash', value: usd.format(split.cashUsd) },
    { label: 'Half Stock', value: sharesValue(split.shares) },
  ];
  for (const stat of items) {
    const valueEl = el('div', { class: 'stat-value' });
    if (typeof stat.value === 'string') valueEl.textContent = stat.value;
    else valueEl.appendChild(stat.value);
    root.appendChild(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-label', textContent: stat.label }),
        valueEl,
      ]),
    );
  }
}

// Inline icon markup. Sale-mode icons replace the spelled-out tag on the
// smaller grid sizes (CSS toggles text vs icon per view mode); the history
// icon (a tiny line chart, matching the per-item price/bid chart) replaces
// the "history →" text link on the price line.
const ICON_AUCTION =
  '<svg class="tag-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
  '<rect x="1.5" y="13.4" width="11" height="1.8" rx="0.9" fill="currentColor"/>' +
  '<g transform="rotate(45 7 6)">' +
  '<rect x="3.2" y="1" width="4.4" height="3" rx="0.6" fill="currentColor"/>' +
  '<rect x="4.7" y="3.4" width="1.4" height="7.6" rx="0.5" fill="currentColor"/>' +
  '</g></svg>';
const ICON_BIN =
  '<svg class="tag-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
  '<path d="M7.3 1.4 14.2 8.3a1.1 1.1 0 0 1 0 1.5l-4.4 4.4a1.1 1.1 0 0 1-1.5 0L1.4 7.3V2.5a1.1 1.1 0 0 1 1.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<circle cx="4.6" cy="4.6" r="1.05" fill="currentColor"/></svg>';
const ICON_HISTORY =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<polyline points="1.5,10.5 5.5,6.5 8.5,8.5 14.5,2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<line x1="1.5" y1="14" x2="14.5" y2="14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

// Sale-mode tag carrying BOTH an icon and the spelled-out label; CSS shows
// whichever fits the active view mode (text on large grid + list, icon on
// small/medium grids).
function saleTag(isAuction) {
  const span = el('span', { class: isAuction ? 'tag tag-auction' : 'tag tag-bin' });
  span.innerHTML = isAuction ? ICON_AUCTION : ICON_BIN;
  span.appendChild(el('span', { class: 'tag-text', textContent: isAuction ? 'Auction' : 'Buy it now' }));
  return span;
}

// History link as a compact icon (lives on the price line). Tooltip +
// aria-label keep it discoverable/accessible without spelled-out text.
function historyLink(itemId) {
  const a = el('a', {
    class: 'item-audit-link',
    href: `/item?id=${encodeURIComponent(itemId)}`,
    title: 'View bid & price history',
    'aria-label': 'View bid and price history',
  });
  a.innerHTML = ICON_HISTORY;
  return a;
}

// Ticker-logo state, refreshed from each /api/snapshot response. When the
// server has a logo.dev token, this is the image URL for the currently
// selected stock; otherwise null and we fall back to a spelled-out "shares"
// unit.
let currentTickerLogoUrl = null;
let currentTickerSymbol = '';

// The ticker logo <img>, or null when no logo is configured. Callers decide
// the fallback: the inline "shares" unit (sharesUnit) or simply nothing (the
// split's "Half Stock" label, which already names the asset).
function tickerLogoImg() {
  if (!currentTickerLogoUrl) return null;
  return el('img', {
    class: 'ticker-logo',
    src: currentTickerLogoUrl,
    alt: currentTickerSymbol,
    title: currentTickerSymbol,
    loading: 'lazy',
  });
}

// The "unit" trailing the shares value — the ticker logo when available
// (mirrors a currency glyph), otherwise the spelled-out word "shares". The
// img onerror handler downgrades to the text unit if the logo fails to
// load (network error, unknown ticker, etc.) without leaving a broken icon.
function sharesUnit() {
  const img = tickerLogoImg();
  if (img) {
    img.addEventListener('error', () => {
      img.replaceWith(el('span', { class: 'unit', textContent: 'shares' }));
    });
    return img;
  }
  return el('span', { class: 'unit', textContent: 'shares' });
}

// Upgrade an eBay image URL to a larger render (see upgradeEbayImageUrl on
// the server). Applied at render so even listings persisted with a small
// thumbnail URL (e.g. ended rows fetched before the server-side upgrade
// landed) display crisply. Non-eBay URLs pass through unchanged.
function hiResImg(url, size = 1600) {
  if (!url || !/(^|\.)ebayimg\.com\//.test(url)) return url;
  return url.replace(/\/s-l\d+(\.\w+)/i, `/s-l${size}$1`);
}

// Build a cycling image carousel for an item's gallery. Pass
// `[primary, ...additional]` deduped. The track wrap-cycles in both
// directions (swipe past either end → other end) and clicking an image
// opens the lightbox at the same index; when the lightbox closes, the
// inline gallery jumps to whatever image the user was on in the modal so
// they stay continuous.
function imageGallery(images, alt) {
  const cleaned = images.filter(Boolean).map((u) => hiResImg(u));
  // Dedupe while preserving order so a listing whose primary equals
  // additional[0] doesn't flash the same image twice.
  const seen = new Set();
  const ordered = [];
  for (const u of cleaned) {
    if (seen.has(u)) continue;
    seen.add(u);
    ordered.push(u);
  }
  const single = ordered.length <= 1;
  const wrap = el('div', { class: `item-gallery${single ? ' single-image' : ''}` });
  if (ordered.length === 0) return wrap;

  const track = el('div', { class: 'gallery-track' });
  wrap.appendChild(track);
  // Counter goes on every gallery (consistent indicator regardless of how
  // many images the listing has — eBay caps at 24, which would overflow
  // any dot strip on a 160px tile).
  const counter = el('div', { class: 'gallery-counter', 'aria-hidden': 'true' });
  wrap.appendChild(counter);

  const prev = el('button', { class: 'gallery-nav gallery-prev', type: 'button', 'aria-label': 'Previous image', textContent: '‹' });
  const next = el('button', { class: 'gallery-nav gallery-next', type: 'button', 'aria-label': 'Next image', textContent: '›' });
  if (!single) {
    wrap.appendChild(prev);
    wrap.appendChild(next);
  }

  const carousel = attachCyclingCarousel(track, {
    images: ordered,
    alt: alt ?? '',
    counterEl: counter,
  });
  prev.addEventListener('click', (e) => { e.stopPropagation(); carousel.step(-1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); carousel.step(1); });

  // Click any image to open the lightbox at the currently-visible slide;
  // when the lightbox closes, jump this inline carousel to the index the
  // user landed on so opening + closing maintains continuity.
  track.style.cursor = 'zoom-in';
  track.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    e.stopPropagation();
    openImageLightbox(ordered, carousel.getIndex(), alt ?? '', {
      onClose: (finalIdx) => carousel.goTo(finalIdx),
    });
  });
  return wrap;
}

// The half-cash / half-stock split box shared by active and ended cards.
//
// Each half is a flex-wrap line holding a label + an atomic (nowrap) value.
// On a wide tile the value sits to the right of its label (a tidy receipt);
// on a narrow tile — where a four-digit dollar amount can't fit beside the
// label — the whole value wraps to its own line beneath the label instead of
// overflowing into the neighbouring value or off the tile edge. One value
// per atomic unit, free to reflow, is the only layout that holds at every
// tile width (the values themselves are intrinsically wide).
function splitBox(cashUsd, sharesAmount) {
  const split = el('div', { class: 'item-split' });
  split.appendChild(
    el('div', { class: 'split-half' }, [
      el('span', { class: 'label', textContent: 'Half Cash' }),
      el('span', { class: 'value', textContent: usd.format(cashUsd) }),
    ]),
  );
  split.appendChild(
    el('div', { class: 'split-half' }, [
      el('span', { class: 'label', textContent: 'Half Stock' }),
      el('span', { class: 'value' }, [sharesValue(sharesAmount, { compact: true })]),
    ]),
  );
  return split;
}

// Format a shares amount as "{N} <unit>" where the unit is the ticker logo
// or the word "shares". `compact: true` uses 4 significant digits (for
// narrow tile splits); default uses the full 4-decimal form (for totals).
function sharesValue(n, { compact = false } = {}) {
  return el('span', {}, [
    compact ? sharesCompact.format(n) : shares.format(n),
    sharesUnit(),
  ]);
}

function ebayItemUrl(itemId) {
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
function endedEbayUrl(itemWebUrl, itemId) {
  const base = itemWebUrl || ebayItemUrl(itemId);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}nordt=true&orig_cvip=true`;
}

function renderItem(item, symbol) {
  const card = el('article', { class: 'item' });
  card.appendChild(imageGallery([item.imageUrl, ...(item.additionalImages ?? [])], item.title));
  const body = el('div', { class: 'item-body' });
  body.appendChild(
    el('h2', { class: 'item-title' }, [
      el('a', { href: item.itemWebUrl, target: '_blank', rel: 'noopener noreferrer', textContent: item.title }),
    ]),
  );
  const meta = el('div', { class: 'item-meta' });
  meta.appendChild(saleTag(item.isAuction));
  if (item.sellerId) {
    meta.appendChild(el('span', { class: sellerBadgeClass(item.sellerId), textContent: `@${item.sellerId}` }));
  }
  body.appendChild(meta);

  // Price line: the large price on the left, with bid count + time remaining
  // stacked beside it (two lines of normal text matching the taller price
  // font), and the history icon pinned to the far right. Consolidating these
  // here reclaims the line the meta row used to spend on bids/time.
  const bidRow = el('div', { class: 'item-bid-row' });
  const priceLine = el('div', { class: 'item-bid-price' }, [
    el('div', { class: 'item-bid', textContent: item.priceUsd != null ? usd.format(item.priceUsd) : '—' }),
    historyLink(item.itemId),
  ]);
  bidRow.appendChild(priceLine);
  const stats = el('div', { class: 'item-bid-stats' });
  if (item.bidCount !== null && item.bidCount !== undefined) {
    stats.appendChild(el('span', { class: 'item-bid-stat', textContent: `${item.bidCount} bid${item.bidCount === 1 ? '' : 's'}` }));
  }
  const remaining = timeRemaining(item.endsAt);
  if (remaining) stats.appendChild(el('span', { class: 'item-bid-stat', textContent: remaining }));
  if (stats.children.length) bidRow.appendChild(stats);
  body.appendChild(bidRow);
  if (item.split) {
    body.appendChild(splitBox(item.split.cashUsd, item.split.shares));
  }
  card.appendChild(body);
  return card;
}

function renderEndedSection(snapshot, endedItems, totals) {
  const section = document.getElementById('ended-section');
  const root = document.getElementById('ended-items');
  const totalsRoot = document.getElementById('ended-totals');
  if (!section || !root || !totalsRoot) return;

  // Always show the section once a snapshot has loaded — the time-window
  // toggle in the header needs to be reachable even when the current
  // window happens to be empty (e.g. nothing ended in the last 14 days
  // but the user wants to see older items via "All time"). Empty-state
  // message replaces the cards while keeping the controls accessible.
  section.hidden = false;

  if (!endedItems || endedItems.length === 0) {
    totalsRoot.replaceChildren();
    const message = currentEndedWindow === 'all'
      ? 'No ended auctions in your history yet.'
      : 'No auctions ended in the last 14 days. Try "All time" to see older items.';
    root.replaceChildren(el('div', { class: 'empty', textContent: message }));
    return;
  }

  const atEnd = currentEndedPriceMode === 'at-end';

  totalsRoot.replaceChildren();
  if (totals) {
    const symbol = snapshot.stock?.symbol ?? activeSymbol;
    const displaySplit = atEnd ? totals.splitAtEnd : totals.split;
    const sharesSuffix = atEnd ? ' (at end)' : ' (live)';
    const stats = [
      { label: 'Ended listings', value: integer.format(totals.listingsCount) },
      { label: 'Bids', value: integer.format(totals.bidsCount) },
      { label: 'Sum of final bids', value: usd.format(totals.bidUsd) },
      { label: 'Half Cash', value: usd.format(displaySplit.cashUsd) },
      { label: `Half Stock${sharesSuffix}`, value: sharesValue(displaySplit.shares) },
    ];
    for (const stat of stats) {
      const valueEl = el('div', { class: 'stat-value' });
      if (typeof stat.value === 'string') valueEl.textContent = stat.value;
      else valueEl.appendChild(stat.value);
      totalsRoot.appendChild(
        el('div', { class: 'stat' }, [
          el('div', { class: 'stat-label', textContent: stat.label }),
          valueEl,
        ]),
      );
    }
    // When some ended items lack OHLC history, flag the gap so users know
    // the at-end aggregate is a subset.
    if (atEnd && totals.pricedAtEndCount < totals.listingsCount) {
      const missing = totals.listingsCount - totals.pricedAtEndCount;
      totalsRoot.appendChild(
        el('div', { class: 'stat' }, [
          el('div', { class: 'stat-label', textContent: 'Missing end-time price' }),
          el('div', { class: 'stat-value', textContent: integer.format(missing) }),
        ]),
      );
    }
  }

  root.replaceChildren();
  const sorted = sortEndedItems(endedItems, currentSort);
  for (const item of sorted) {
    root.appendChild(renderEndedItem(item));
  }
}

function renderEndedItem(item) {
  const card = el('article', { class: 'item ended-item' });
  card.appendChild(imageGallery([item.imageUrl, ...(item.additionalImages ?? [])], item.title));
  const body = el('div', { class: 'item-body' });
  body.appendChild(
    el('h2', { class: 'item-title' }, [
      el('a', { href: endedEbayUrl(item.itemWebUrl, item.itemId), target: '_blank', rel: 'noopener noreferrer', textContent: item.title }),
    ]),
  );
  const meta = el('div', { class: 'item-meta' });
  meta.appendChild(el('span', { class: 'tag tag-ended', textContent: 'Ended' }));
  if (item.sellerId) {
    meta.appendChild(el('span', { class: sellerBadgeClass(item.sellerId), textContent: `@${item.sellerId}` }));
  }
  body.appendChild(meta);

  const atEnd = currentEndedPriceMode === 'at-end';
  const displaySplit = atEnd ? item.endTimeSplit : item.split;

  // Price line: final price + history icon on row 1, bid count + ended date
  // as atomic chunks on row 2, mirroring the active card.
  const bidRow = el('div', { class: 'item-bid-row' });
  const priceLine = el('div', { class: 'item-bid-price' }, [
    el('div', { class: 'item-bid', textContent: usd.format(item.finalPriceUsd) }),
    historyLink(item.itemId),
  ]);
  bidRow.appendChild(priceLine);
  const stats = el('div', { class: 'item-bid-stats' });
  if (item.finalBidCount !== null && item.finalBidCount !== undefined) {
    stats.appendChild(el('span', { class: 'item-bid-stat', textContent: `${item.finalBidCount} bid${item.finalBidCount === 1 ? '' : 's'}` }));
  }
  const endedDate = item.endedAt ? new Date(item.endedAt) : null;
  if (endedDate) {
    stats.appendChild(el('span', {
      class: 'item-bid-stat',
      textContent: `Ended ${endedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    }));
  }
  if (stats.children.length) bidRow.appendChild(stats);
  body.appendChild(bidRow);

  if (displaySplit) {
    body.appendChild(splitBox(displaySplit.cashUsd, displaySplit.shares));
  }
  card.appendChild(body);
  return card;
}

function renderItems(snapshot, items, bidDiff) {
  const root = document.getElementById('items');
  if (!root) return;

  // FLIP — record old card positions before blowing away the DOM
  const oldRects = new Map();
  root.querySelectorAll('.item[data-item-id]').forEach((card) => {
    oldRects.set(card.dataset.itemId, card.getBoundingClientRect());
  });

  root.replaceChildren();

  if (!items || items.length === 0) {
    root.appendChild(el('div', { class: 'empty', textContent: 'No active listings to show for this filter.' }));
    return;
  }

  const sorted = sortItems(items, currentSort);
  const symbol = snapshot?.stock?.symbol ?? activeSymbol;
  const newCards = [];

  for (const item of sorted) {
    const card = renderItem(item, symbol);
    card.dataset.itemId = item.itemId;

    // Bid-change flash: only when the count actually went up
    const prev = bidDiff.get(item.itemId);
    if (prev !== undefined && item.bidCount !== null && item.bidCount > prev) {
      card.classList.add('bid-updated');
      card.addEventListener('animationend', () => card.classList.remove('bid-updated'), { once: true });
    }

    root.appendChild(card);
    newCards.push({ card, itemId: item.itemId });
  }

  // FLIP — apply inverse transforms so cards appear to start at their old positions
  const movers = [];
  for (const { card, itemId } of newCards) {
    const oldRect = oldRects.get(itemId);
    if (!oldRect) continue;
    const newRect = card.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    movers.push(card);
  }

  // Force reflow, then release transforms (CSS transition does the rest)
  if (movers.length > 0) {
    void root.getBoundingClientRect();
    for (const card of movers) {
      card.classList.add('is-moving');
      card.style.transform = '';
    }
    movers[0].addEventListener('transitionend', () => {
      for (const card of movers) card.classList.remove('is-moving');
    }, { once: true });
  }
}

// Compute "most recent bid" from a (possibly filtered) item list so the card
// respects the active seller filter. Mirrors the server-side last-bid logic
// in composeSnapshot.
function deriveLastBid(items) {
  let best = null;
  for (const item of items) {
    if (!item.lastBidTime || item.priceUsd === null || item.priceUsd === undefined) continue;
    const ts = parseTimestamp(item.lastBidTime);
    if (ts === null) continue;
    if (best === null || ts > best.ts) {
      best = { ts, itemId: item.itemId, title: item.title, bidTime: item.lastBidTime, bidAmount: item.priceUsd };
    }
  }
  if (!best) return null;
  const { ts: _ts, ...rest } = best;
  return rest;
}

function renderMostRecentBid(snapshot, items) {
  const container = document.getElementById('most-recent-bid');
  if (!container) return;
  container.replaceChildren();

  const lastBid = deriveLastBid(items ?? snapshot?.items ?? []);
  if (!lastBid) {
    container.appendChild(
      el('div', { class: 'most-recent-bid-empty', textContent: 'No bids yet.' }),
    );
    return;
  }

  const bid = lastBid;
  const bidItem = (items ?? snapshot?.items ?? []).find((item) => item.itemId === bid.itemId) ?? null;
  const timeAgo = formatRelativeBidAge(bid.bidTime) ?? 'unknown';

  const content = el('div', { class: 'most-recent-bid-content' });
  content.appendChild(
    bidItem?.imageUrl
      ? el('img', {
          class: 'most-recent-bid-thumb',
          src: hiResImg(bidItem.imageUrl),
          alt: bid.title,
          loading: 'lazy',
        })
      : el('div', { class: 'most-recent-bid-thumb most-recent-bid-thumb-placeholder' }),
  );

  const info = el('div', { class: 'most-recent-bid-info' });
  info.appendChild(el('div', { class: 'most-recent-bid-label', textContent: 'Most recent bid' }));
  info.appendChild(
    bidItem?.itemWebUrl
      ? el('a', {
          class: 'most-recent-bid-title-link',
          href: bidItem.itemWebUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          textContent: bid.title,
        })
      : el('div', { class: 'most-recent-bid-title', textContent: bid.title }),
  );
  info.appendChild(el('div', { class: 'most-recent-bid-amount', textContent: usd.format(bid.bidAmount) }));
  info.appendChild(
    el('div', {
      class: 'most-recent-bid-time',
      textContent: timeAgo,
      title: `Most recent bid activity: ${formatLocalTimestamp(bid.bidTime)}. This may differ from when the current displayed bid was reached due to proxy bidding.`,
    }),
  );
  content.appendChild(info);

  const link = el('a', {
    class: 'most-recent-bid-link',
    href: '#',
    textContent: 'Go to item',
  });
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const card = document.querySelector(`[data-item-id="${bid.itemId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight');
      setTimeout(() => card.classList.remove('highlight'), 2000);
    }
  });
  content.appendChild(link);

  container.appendChild(content);
}

function renderError(message) {
  const root = document.getElementById('items');
  if (!root) return;
  root.replaceChildren(el('div', { class: 'error', textContent: message }));
}

// Single entry point for everything that depends on the current seller filter
// or sort: filters items, recomputes totals from the filtered set, then
// renders both active and ended sections. Called on snapshot refresh and on
// filter/sort changes.
function renderFilteredView(snapshot, bidDiff) {
  if (!snapshot) return;
  const stockPrice = snapshot.stock?.price ?? 0;
  const filteredActive = filterBySeller(snapshot.items ?? []);
  // 0-bid ended auctions are unsold listings — they didn't clear and they
  // don't contribute to any of the dollar totals (composeSnapshot already
  // excludes them). Hide them from the visible list too so the ended
  // section doesn't get cluttered with non-events.
  const filteredEnded = filterBySeller(snapshot.endedItems ?? []).filter(
    (i) => (i.finalBidCount ?? 0) > 0,
  );
  renderTotals(snapshot, aggregateActiveTotals(filteredActive, stockPrice));
  renderBrokerage(snapshot, filteredEnded, stockPrice);
  renderMostRecentBid(snapshot, filteredActive);
  renderItems(snapshot, filteredActive, bidDiff);
  renderEndedSection(snapshot, filteredEnded, aggregateEndedTotals(filteredEnded, stockPrice));
}

function updateIntroSymbol(symbol) {
  const display = `$${symbol}`;
  setText(document.getElementById('intro-symbol-2'), display);
}

let lastKnownGoodSymbol = activeSymbol;

async function refresh() {
  try {
    const endedDays = ENDED_WINDOW_DAYS[currentEndedWindow];
    const res = await fetch(`/api/snapshot?symbol=${encodeURIComponent(activeSymbol)}&endedDays=${endedDays}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* ignore non-JSON body */
      }

      if (res.status === 400 && body && body.error === 'invalid_ticker') {
        const rejected = activeSymbol;
        activeSymbol = lastKnownGoodSymbol;
        const input = document.getElementById('ticker-input');
        if (input) {
          input.classList.add('is-invalid');
          input.value = rejected;
          setTimeout(() => input.classList.remove('is-invalid'), 2500);
        }
        renderError(`"${rejected}" isn't a recognized ticker. Try again.`);
        updateIntroSymbol(activeSymbol);
        document.querySelectorAll('.stock-btn').forEach((b) =>
          b.classList.toggle('is-active', b.dataset.symbol === activeSymbol),
        );
        return;
      }

      const detail = body && typeof body.detail === 'string' ? ` (${body.detail})` : '';
      if (res.status === 503) {
        // Usually a transient cold start (the dev service wakes lazily and
        // the first snapshot needs an eBay token + a fresh poll). Show a
        // loading message and retry soon instead of waiting the full poll
        // interval, so the page populates as soon as the server is ready.
        renderError(`Fetching live data — retrying…${detail}`);
        scheduleQuickRetry();
      } else {
        renderError(`Snapshot request failed (HTTP ${res.status}).${detail}`);
      }
      return;
    }
    clearQuickRetry();
    const snapshot = await res.json();
    lastKnownGoodSymbol = activeSymbol;
    saveTickerToStorage(activeSymbol);
    // Update logo state BEFORE any render that calls sharesValue().
    currentTickerLogoUrl = snapshot.tickerLogoUrl ?? null;
    currentTickerSymbol = snapshot.stock?.symbol ?? activeSymbol;
    renderDegradedBanner(snapshot);
    renderTicker(snapshot);
    updateIntroSymbol(snapshot.stock?.symbol ?? activeSymbol);
    renderLastUpdated(snapshot);
    renderPriceSource(snapshot);
    renderFilteredView(snapshot, prevBidCounts);
    lastSnapshot = snapshot;
    prevBidCounts = new Map(
      (snapshot.items ?? []).map((item) => [item.itemId, item.bidCount ?? 0]),
    );
  } catch (err) {
    renderError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    scheduleQuickRetry();
  }
}

// Quick-retry after a transient failure (e.g. cold start), so recovery
// doesn't have to wait a full POLL_MS. One retry in flight at a time; the
// steady interval keeps running underneath.
let retryTimer = null;
function scheduleQuickRetry() {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    refresh();
  }, QUICK_RETRY_MS);
}
function clearQuickRetry() {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

let timerId = null;
function schedule() {
  stop();
  if (document.visibilityState === 'visible') {
    timerId = window.setInterval(refresh, POLL_MS);
  }
}
function stop() {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

// Stock toggle wiring — sync the active pill to the persisted activeSymbol
// on first paint (the HTML hard-codes EBAY as active so the load/refresh
// would otherwise mismatch when GME or a custom ticker is persisted).
document.querySelectorAll('.stock-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.symbol === activeSymbol);
  btn.addEventListener('click', () => {
    const newSymbol = btn.dataset.symbol;
    if (newSymbol === activeSymbol) return;
    activeSymbol = newSymbol;
    document.querySelectorAll('.stock-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    const input = document.getElementById('ticker-input');
    if (input) input.value = '';
    updateIntroSymbol(activeSymbol);
    refresh();
  });
});

// Custom ticker input wiring
const tickerInput = document.getElementById('ticker-input');
if (tickerInput) {
  if (!SUPPORTED_SYMBOLS.includes(activeSymbol)) {
    tickerInput.value = activeSymbol;
  }
  tickerInput.addEventListener('input', () => {
    const cursor = tickerInput.selectionStart;
    const upper = tickerInput.value.toUpperCase();
    if (upper !== tickerInput.value) {
      tickerInput.value = upper;
      if (cursor !== null) tickerInput.setSelectionRange(cursor, cursor);
    }
  });
  tickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const newSymbol = tickerInput.value.trim().toUpperCase();
      if (newSymbol && /^[A-Z][A-Z0-9.\-:]{0,19}$/.test(newSymbol) && newSymbol !== activeSymbol) {
        activeSymbol = newSymbol;
        document.querySelectorAll('.stock-btn').forEach((b) => b.classList.toggle('is-active', false));
        tickerInput.classList.add('is-validating');
        updateIntroSymbol(activeSymbol);
        refresh().finally(() => tickerInput.classList.remove('is-validating'));
      }
    }
  });
  tickerInput.addEventListener('blur', () => {
    if (!SUPPORTED_SYMBOLS.includes(activeSymbol)) {
      tickerInput.value = activeSymbol;
    } else {
      tickerInput.value = '';
    }
  });
}

// Sort button wiring — restore the persisted active button on load, then
// listen for clicks. The is-active class on the default button in HTML
// (ending-soonest) is overwritten here on every load.
document.querySelectorAll('.sort-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.sort === currentSort);
  btn.addEventListener('click', () => {
    if (btn.dataset.sort === currentSort) return;
    currentSort = btn.dataset.sort;
    saveSort(currentSort);
    document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    if (lastSnapshot) renderFilteredView(lastSnapshot, new Map()); // re-sort active + ended; no bid flash
  });
});

// View-mode button wiring. Reflects the persisted choice on initial paint
// and applies it to the containers. Switching modes is a pure CSS class
// swap — no re-render needed since every mode reuses the same card DOM.
document.querySelectorAll('.view-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.view === currentViewMode);
  btn.addEventListener('click', () => {
    if (btn.dataset.view === currentViewMode) return;
    currentViewMode = btn.dataset.view;
    saveViewMode(currentViewMode);
    document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    applyViewMode();
  });
});
applyViewMode();

// Collapsible "About" intro: persist open/closed across loads.
const introAbout = document.getElementById('intro-about');
if (introAbout) {
  if (localStorage.getItem('hchs.aboutOpen') === '1') introAbout.open = true;
  introAbout.addEventListener('toggle', () => {
    localStorage.setItem('hchs.aboutOpen', introAbout.open ? '1' : '0');
  });
}

// Seller filter wiring
document.querySelectorAll('.seller-btn').forEach((btn) => {
  // Reflect the persisted choice on initial paint.
  btn.classList.toggle('is-active', btn.dataset.sellerFilter === currentSellerFilter);
  btn.addEventListener('click', () => {
    if (btn.dataset.sellerFilter === currentSellerFilter) return;
    currentSellerFilter = btn.dataset.sellerFilter;
    saveSellerFilterToStorage(currentSellerFilter);
    document.querySelectorAll('.seller-btn').forEach((b) =>
      b.classList.toggle('is-active', b === btn),
    );

    // Thematic ticker swap: Mine→$GME, Ryan→$EBAY, All→$EBAY. Re-fetch the
    // snapshot for the new symbol if it changed; otherwise just re-filter
    // the cached snapshot in place.
    const preferredTicker = SELLER_FILTER_DEFAULT_TICKER[currentSellerFilter];
    if (preferredTicker && preferredTicker !== activeSymbol) {
      activeSymbol = preferredTicker;
      saveTickerToStorage(activeSymbol);
      document.querySelectorAll('.stock-btn').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.symbol === activeSymbol),
      );
      const tickerInput = document.getElementById('ticker-input');
      if (tickerInput) tickerInput.value = '';
      updateIntroSymbol(activeSymbol);
      // Re-render the filtered view immediately with the cached snapshot so
      // the filter change feels instant, then refresh against the new
      // ticker in the background.
      if (lastSnapshot) renderFilteredView(lastSnapshot, new Map());
      refresh();
    } else if (lastSnapshot) {
      renderFilteredView(lastSnapshot, new Map()); // re-filter; no bid flash
    }
  });
});

// Ended-section "Live vs At end" stock price toggle
document.querySelectorAll('.ended-mode-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.endedMode === currentEndedPriceMode);
  btn.addEventListener('click', () => {
    if (btn.dataset.endedMode === currentEndedPriceMode) return;
    currentEndedPriceMode = btn.dataset.endedMode;
    saveEndedPriceMode(currentEndedPriceMode);
    document.querySelectorAll('.ended-mode-btn').forEach((b) =>
      b.classList.toggle('is-active', b === btn),
    );
    if (lastSnapshot) renderFilteredView(lastSnapshot, new Map()); // re-render ended section
  });
});

// Reflect the "Recently ended" vs "Ended (all time)" heading + help text
// to match whichever window is currently selected.
function updateEndedHeading() {
  const heading = document.getElementById('ended-heading');
  if (heading) {
    heading.textContent = currentEndedWindow === 'all' ? 'Ended' : 'Recently ended';
  }
  const help = document.getElementById('ended-help');
  if (help) {
    help.firstChild.nodeValue = currentEndedWindow === 'all'
      ? '\n          Every auction ever ended in our records. Final price reflects the last\n          observed bid before the auction closed. "At auction end" values each one'
      : '\n          Auctions that have ended in the last 14 days. Final price reflects the last\n          observed bid before the auction closed. "At auction end" values each one';
  }
}
updateEndedHeading();

// Ended-section time-window toggle ("Recently ended" / "All time").
// Unlike the stock-price toggle this REFETCHES the snapshot because the
// server controls which ended rows are returned — passing endedDays on
// the query string. The cache key includes endedDays so each window
// gets its own cached snapshot.
document.querySelectorAll('.ended-window-btn').forEach((btn) => {
  btn.classList.toggle('is-active', btn.dataset.endedWindow === currentEndedWindow);
  btn.addEventListener('click', () => {
    if (btn.dataset.endedWindow === currentEndedWindow) return;
    currentEndedWindow = btn.dataset.endedWindow;
    saveEndedWindow(currentEndedWindow);
    document.querySelectorAll('.ended-window-btn').forEach((b) =>
      b.classList.toggle('is-active', b === btn),
    );
    updateEndedHeading();
    refresh();
  });
});

// Ended section collapse toggle
const endedToggle = document.getElementById('ended-toggle');
if (endedToggle) {
  endedToggle.addEventListener('click', () => {
    const section = document.getElementById('ended-section');
    if (!section) return;
    const collapsed = section.classList.toggle('is-collapsed');
    endedToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    endedToggle.textContent = collapsed ? 'Show' : 'Hide';
  });
}

// Brand-icon click toggles theme. Precedence: localStorage > OS preference > dark default.
const brand = document.querySelector('.brand');
if (brand) {
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    const root = document.documentElement;
    const explicit = root.getAttribute('data-theme');
    const effective =
      explicit ?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = effective === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (_e) {
      /* ignore */
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    schedule();
  } else {
    stop();
  }
});

refresh();
schedule();
