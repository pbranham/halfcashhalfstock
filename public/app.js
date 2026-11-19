import { TICKER_RE } from '/constants.js';
import { imageGallery } from '/gallery.js';
import {
  DAY_MS,
  el,
  endedEbayUrl,
  formatUsd,
  formatUsdOrDash,
  hiResImg,
  HOUR_MS,
  loadChoice,
  MINUTE_MS,
  plural,
  saveChoice,
  shortDate,
} from '/shared.js';

const POLL_MS = 30_000;
const QUICK_RETRY_MS = 4_000;
const STALE_MS = 120_000;

const SUPPORTED_SYMBOLS = ['EBAY', 'GME'];
// "By seller" valuation mode: not a real ticker. The server values each item
// in its seller's paired stock and returns one live price per stock. It has a
// pill but never goes in the custom-ticker input.
const MIXED_SYMBOL = 'MIXED';
function isPillSymbol(s) {
  return SUPPORTED_SYMBOLS.includes(s) || s === MIXED_SYMBOL;
}
let activeSymbol = SUPPORTED_SYMBOLS[0];

const shares = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
// Compact form for narrow split columns on tiles: round to 4 significant
// digits so values like 14.7438 → 14.74 fit on one line beside the logo
// without needing ellipsis. Totals (wide columns) keep the full 4 dp form.
const sharesCompact = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });
const integer = new Intl.NumberFormat('en-US');

// --- Sort & animation state ---
// Sort mode — must match data-sort values on .sort-btn elements in index.html.
const SORT_MODES = ['ending-soonest', 'recent-bid-activity', 'price-low', 'price-high', 'most-bids'];
let currentSort = loadChoice('hchs.sort', SORT_MODES, 'ending-soonest');
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
  all: 'MIXED',
  mine: 'GME',
  ryan: 'EBAY',
};
const SELLER_FILTERS = Object.keys(SELLER_PILL_TO_ID);
let currentSellerFilter = loadChoice('hchs.sellerFilter', SELLER_FILTERS, 'all');

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
let currentEndedPriceMode = loadChoice('hchs.endedPriceMode', ENDED_MODES, 'live');

// --- "The Other Half" enable toggle ---
// On = the brokerage body shows (and, later, per-item P&L on ended cards).
// Off = collapsed to the slim header, reclaiming space. Default on.
function loadOtherHalfEnabled() {
  return localStorage.getItem('hchs.otherHalf') !== 'off';
}
function saveOtherHalfEnabled(on) {
  localStorage.setItem('hchs.otherHalf', on ? 'on' : 'off');
}
let otherHalfEnabled = loadOtherHalfEnabled();

// Reflect the enabled state: show/hide the brokerage body + sync the toggle.
function applyOtherHalfEnabled() {
  const body = document.getElementById('brokerage-body');
  const btn = document.getElementById('brokerage-toggle');
  if (body) body.hidden = !otherHalfEnabled;
  if (btn) {
    btn.textContent = otherHalfEnabled ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', otherHalfEnabled ? 'true' : 'false');
  }
  syncExpandAllButton();
  // The chart measures its container width; if it rendered while collapsed
  // (width 0), redraw now that the body is visible and has a real width.
  if (otherHalfEnabled && lastPerfRender && !lastPerfRender.container.hidden) {
    renderPerformanceChart(lastPerfRender.container, lastPerfRender.series);
  }
}

// Expand-all / collapse-all control: shown only when the brokerage is enabled
// and has 2+ stock positions. Label tracks the current state.
function syncExpandAllButton() {
  const btn = document.getElementById('brokerage-expand');
  if (!btn) return;
  const byTicker = lastBrokerageVM?.byTicker ?? [];
  btn.hidden = !otherHalfEnabled || byTicker.length < 2;
  if (!btn.hidden) {
    const allCollapsed = byTicker.every((r) => collapsedPositions.has(r.ticker));
    btn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  }
}

// --- Ended-section time window ("Recently ended" vs "All time") ---
// The "all" value caps at the server's 36500-day max (~100 years) so we
// effectively fetch everything ever ended. The DB never deletes ended
// listings — they accumulate indefinitely under the listings table — so
// this is the right way to expose the full history.
const ENDED_WINDOWS = ['recent', 'all'];
const ENDED_WINDOW_DAYS = { recent: 14, all: 36500 };
let currentEndedWindow = loadChoice('hchs.endedWindow', ENDED_WINDOWS, 'recent');

// --- Item view mode (list / small / medium / large grid) ---
// All modes share the same renderItem DOM; only a class on the items
// containers changes, so switching is a pure CSS reflow — no re-render.
const VIEW_MODES = ['list', 'grid-sm', 'grid-md', 'grid-lg'];
let currentViewMode = loadChoice('hchs.viewMode', VIEW_MODES, 'grid-md');

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
  if (stored && TICKER_RE.test(stored)) {
    return stored;
  }
  return SUPPORTED_SYMBOLS[0];
}
function saveTickerToStorage(ticker) {
  if (TICKER_RE.test(ticker)) {
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

// Compare two optional numbers with missing values (null) sorted last;
// `desc` puts the larger value first.
function compareNullsLast(x, y, desc = false) {
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return desc ? y - x : x - y;
}

// The price-low / price-high / most-bids orders, shared by active and ended
// lists (`priceOf` / `bidsOf` read each list's fields). Null for other modes.
function sortByPriceOrBids(items, sort, priceOf, bidsOf) {
  const sorted = [...items];
  switch (sort) {
    case 'price-low':
      return sorted.sort((a, b) => (priceOf(a) ?? Infinity) - (priceOf(b) ?? Infinity));
    case 'price-high':
      return sorted.sort((a, b) => (priceOf(b) ?? -Infinity) - (priceOf(a) ?? -Infinity));
    case 'most-bids':
      return sorted.sort((a, b) => (bidsOf(b) ?? 0) - (bidsOf(a) ?? 0));
    default:
      return null;
  }
}

function sortItems(items, sort) {
  const byPriceOrBids = sortByPriceOrBids(items, sort, (i) => i.priceUsd, (i) => i.bidCount);
  if (byPriceOrBids) return byPriceOrBids;
  const sorted = [...items];
  switch (sort) {
    case 'ending-soonest':
      return sorted.sort((a, b) =>
        compareNullsLast(
          a.endsAt ? new Date(a.endsAt).getTime() : null,
          b.endsAt ? new Date(b.endsAt).getTime() : null,
        ),
      );
    case 'recent-bid-activity':
      return sorted.sort((a, b) =>
        compareNullsLast(parseTimestamp(a.lastBidTime), parseTimestamp(b.lastBidTime), true),
      );
    default:
      return sorted;
  }
}

// Apply the same sort selection to ended items. There's no "ending soon" for
// auctions that have already ended, so ending-soonest and recent-bid-activity
// both fall back to "most recently ended first" — the closest semantic match.
function sortEndedItems(items, sort) {
  return (
    sortByPriceOrBids(items, sort, (i) => i.finalPriceUsd, (i) => i.finalBidCount) ??
    [...items].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))
  );
}

// Sum per-item splits into a cash half + a per-ticker shares breakdown.
// `getSplit(item)` returns the relevant pre-computed HalfSplit (live or
// at-end). Cash/stock dollars are additive (USD); shares are grouped by
// item.valuationTicker because you can't add $EBAY shares to $GME shares. In
// normal mode every item shares one ticker, so sharesByTicker has one entry.
function sumSplitsByTicker(items, getSplit) {
  const byTicker = new Map();
  let cashUsd = 0;
  for (const i of items) {
    const s = getSplit(i);
    if (!s) continue;
    cashUsd += s.cashUsd;
    const t = i.valuationTicker || currentTickerSymbol;
    byTicker.set(t, (byTicker.get(t) ?? 0) + s.shares);
  }
  const sharesByTicker = [...byTicker.entries()].map(([ticker, shares]) => ({ ticker, shares }));
  return { cashUsd, sharesByTicker };
}

// Recompute totals from a filtered subset so the on-page numbers reflect the
// active seller filter. Mirrors the server-side composeSnapshot math:
// no-bid items are excluded from the dollar totals (their priceUsd is just
// the starting price, which shouldn't count until someone bids).
function aggregateActiveTotals(items) {
  const priced = items.filter(
    (i) =>
      i.priceUsd !== null && i.priceUsd !== undefined && (i.bidCount ?? 0) > 0,
  );
  const bidUsd = priced.reduce((sum, i) => sum + i.priceUsd, 0);
  const { cashUsd, sharesByTicker } = sumSplitsByTicker(priced, (i) => i.split);
  return {
    listingsCount: items.length,
    pricedCount: priced.length,
    bidsCount: items.reduce((sum, i) => sum + (i.bidCount ?? 0), 0),
    bidUsd,
    cashUsd,
    sharesByTicker,
  };
}

function aggregateEndedTotals(items) {
  // No-bid auctions (finalBidCount === 0) didn't actually clear at any real
  // price, so they shouldn't roll into the ended totals.
  const hasBid = (i) => (i.finalBidCount ?? 0) > 0;

  // Live: every USD-priced item with at least one bid contributes at the
  // current stock price (its seller's stock in "By seller" mode).
  const priced = items.filter((i) => i.split !== null && i.split !== undefined && hasBid(i));
  const bidUsd = priced.reduce((sum, i) => sum + i.finalPriceUsd, 0);
  const live = sumSplitsByTicker(priced, (i) => i.split);

  // At end: each item's pre-computed endTimeSplit. Items missing OHLC history
  // (or with no bid) drop out of this aggregate.
  const pricedAtEnd = items.filter(
    (i) => i.endTimeSplit !== null && i.endTimeSplit !== undefined && hasBid(i),
  );
  const atEnd = sumSplitsByTicker(pricedAtEnd, (i) => i.endTimeSplit);

  return {
    listingsCount: items.length,
    bidsCount: items.reduce((sum, i) => sum + (i.finalBidCount ?? 0), 0),
    bidUsd,
    live,
    atEnd,
    pricedAtEndCount: pricedAtEnd.length,
  };
}

// --- The Other Half ---
// The site's core hypothetical, resolved: if every winning buyer had really
// paid half in stock at the close-of-auction price, here's how that other
// half is doing today. Pure transform of data already on the snapshot — each
// sold item's endTimeSplit (shares + stock-half dollars at its end-time
// close) marked to the live price. One POSITION per stock, made of LOTS
// grouped by the day auctions ended (tax-lot style), each lot funded by the
// auction items whose thumbnails sit beneath it.
// `priceForTicker(ticker)` returns the live price for a stock. In normal mode
// every position resolves the same price; in "By seller" mode each marks to
// its own stock. Cost basis / worth / P&L roll up in USD (additive across
// stocks); shares stay grouped by ticker.
// Attach costBasis / worthNow / pnl / pnlPct to a base object. worthNow null
// (price feed down) makes pnl/pnlPct null too.
function withPnl(base, costBasis, worthNow) {
  const pnl = worthNow !== null ? worthNow - costBasis : null;
  return {
    ...base,
    costBasis,
    worthNow,
    pnl,
    pnlPct: worthNow !== null && costBasis > 0 ? (pnl / costBasis) * 100 : null,
  };
}

// Builds the brokerage view-model. `priceForTicker(ticker)` gives a stock's
// live price; `tickerOrder` (e.g. the snapshot's stock symbols) fixes the row
// order of the per-stock table so it stays stable regardless of the sort pill.
// Positions preserve INPUT order, so callers sort `endedItems` (by the page's
// Sort pill) first. USD figures (cost/worth/P&L) roll up both per-stock and as
// a composite total; shares stay per-stock (you can't add $EBAY to $GME
// shares).
function aggregateBrokerage(endedItems, priceForTicker, tickerOrder = []) {
  const sold = endedItems.filter((i) => (i.finalBidCount ?? 0) > 0);
  const positions = sold
    .filter((i) => i.endTimeSplit && Number.isFinite(i.endTimeSplit.shares))
    .map((i) => {
      const ticker = i.valuationTicker || currentTickerSymbol;
      const livePrice = priceForTicker(ticker);
      const shares = i.endTimeSplit.shares;
      const costBasis = i.endTimeSplit.stockUsd;
      const worthNow = livePrice > 0 ? shares * livePrice : null;
      return {
        itemId: i.itemId,
        title: i.title,
        imageUrl: i.imageUrl,
        endedAt: i.endedAt,
        ticker,
        sellerId: i.sellerId,
        shares,
        closePrice: i.endTimePriceUsd,
        costBasis,
        worthNow,
        pnl: worthNow !== null ? worthNow - costBasis : null,
      };
    });

  // Per-stock rollup. A missing live price counts as 0 worth so one down
  // stock doesn't blank the row (matches the composite total below).
  const groups = new Map();
  for (const p of positions) {
    let g = groups.get(p.ticker);
    if (!g) {
      g = { ticker: p.ticker, shares: 0, costBasis: 0, worthNow: 0, anyWorth: false, count: 0 };
      groups.set(p.ticker, g);
    }
    g.shares += p.shares;
    g.costBasis += p.costBasis;
    g.count += 1;
    if (p.worthNow !== null) {
      g.worthNow += p.worthNow;
      g.anyWorth = true;
    }
  }
  const rank = (t) => {
    const i = tickerOrder.indexOf(t);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byTicker = [...groups.values()]
    .sort((a, b) => rank(a.ticker) - rank(b.ticker))
    .map((g) => {
      const ps = positions.filter((p) => p.ticker === g.ticker);
      const sellers = [...new Set(ps.map((p) => p.sellerId).filter(Boolean))];
      return withPnl(
        { ticker: g.ticker, count: g.count, shares: g.shares, sellers, lots: buildLots(ps) },
        g.costBasis,
        g.anyWorth ? g.worthNow : null,
      );
    });

  const costBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const anyWorth = positions.some((p) => p.worthNow !== null);
  const worthNow = anyWorth ? positions.reduce((sum, p) => sum + (p.worthNow ?? 0), 0) : null;

  return {
    positions,
    excludedCount: sold.length - positions.length,
    byTicker,
    total: withPnl({}, costBasis, worthNow),
  };
}

// Group a stock's positions into LOTS by the local day the auction ended
// (tax-lot style). Each lot sums shares/cost/worth across that day's items and
// keeps their {itemId, imageUrl, title} for the thumbnail strip. Most-recent
// day first, so the position reads newest → oldest.
function buildLots(positions) {
  const byDay = new Map();
  for (const p of positions) {
    const d = new Date(p.endedAt);
    const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let lot = byDay.get(dayMs);
    if (!lot) {
      lot = { dayMs, shares: 0, costBasis: 0, worthNow: 0, anyWorth: false, items: [] };
      byDay.set(dayMs, lot);
    }
    lot.shares += p.shares;
    lot.costBasis += p.costBasis;
    if (p.worthNow !== null) {
      lot.worthNow += p.worthNow;
      lot.anyWorth = true;
    }
    lot.items.push({ itemId: p.itemId, imageUrl: p.imageUrl, title: p.title });
  }
  return [...byDay.values()]
    .sort((a, b) => b.dayMs - a.dayMs)
    .map((lot) =>
      withPnl(
        {
          dayMs: lot.dayMs,
          shares: lot.shares,
          avgPrice: lot.shares > 0 ? lot.costBasis / lot.shares : null,
          items: lot.items,
        },
        lot.costBasis,
        lot.anyWorth ? lot.worthNow : null,
      ),
    );
}

// P&L value as the dollar amount with the percent stacked directly beneath it
// (uniform two-line cell across position / lot / total rows).
function pnlNode(pnl, pct) {
  const up = pnl >= 0;
  const arrow = up ? '\u25b2' : '\u25bc';
  const node = el('span', { class: `pnl ${up ? 'pnl-up' : 'pnl-down'}` });
  node.appendChild(el('span', { class: 'pnl-amt', textContent: `${arrow} ${up ? '+' : '\u2212'}${formatUsd(Math.abs(pnl))}` }));
  if (pct !== null && Number.isFinite(pct)) {
    node.appendChild(el('span', { class: 'pnl-pct', textContent: `(${up ? '+' : ''}${pct.toFixed(1)}%)` }));
  }
  return node;
}

// A single `.stat` card. `value` is a string or a DOM node.
// A `.stat` card: label over a value (text or a node). `valueClass` adds a
// class to the value element.
function statCard(label, value, valueClass = '') {
  const valueEl = el('div', { class: `stat-value${valueClass}` });
  if (typeof value === 'string') valueEl.textContent = value;
  else valueEl.append(...(Array.isArray(value) ? value : [value]));
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', textContent: label }),
    valueEl,
  ]);
}

// A `.stat` card whose value is one shares line per ticker. One line in normal
// mode (reads identically to before); two in "By seller" mode ($EBAY / $GME).
function sharesCard(label, sharesByTicker) {
  const rows = sharesByTicker && sharesByTicker.length
    ? sharesByTicker
    : [{ ticker: currentTickerSymbol, shares: 0 }];
  return statCard(
    label,
    rows.map(({ ticker, shares: n }) => el('div', { class: 'shares-row' }, [sharesValue(n, { ticker })])),
    rows.length > 1 ? ' stat-value-multi' : '',
  );
}

// "$TICKER" + logo cell for the holdings table's Stock column.
function tickerCell(ticker) {
  const cell = el('span', { class: 'bh-ticker' }, [`$${ticker}`]);
  const logo = tickerLogoImg(ticker);
  if (logo) {
    logo.classList.add('bh-logo');
    cell.appendChild(logo);
  }
  return cell;
}

function pnlCell(pnl, pct) {
  return pnl !== null && pnl !== undefined ? pnlNode(pnl, pct) : el('span', { textContent: '—' });
}

// One holdings-table row. Cells are a flat list that flows into the parent
// grid (rows are `display: contents`); numeric cells carry a data-label so the
// mobile stacked layout can prefix "Cost basis: …".
function holdingsRow(cells, { head = false, total = false, rowClass = '' } = {}) {
  const row = el('div', {
    class: `bh-row${head ? ' bh-head' : ''}${total ? ' bh-total' : ''}${rowClass ? ` ${rowClass}` : ''}`,
  });
  for (const c of cells) {
    const span = el('span', c.cls ? { class: c.cls } : {});
    if (c.label) span.setAttribute('data-label', c.label);
    if (typeof c.value === 'string') span.textContent = c.value;
    else if (c.value) span.appendChild(c.value);
    row.appendChild(span);
  }
  return row;
}

// --- Holdings table (positions + expandable lot sub-rows, one grid) ---
// `lastBrokerageVM` + `collapsedPositions` are module-scope so the collapse
// state survives the 30s re-render and a toggle can rebuild just the table.
// Positions default to EXPANDED (their lots showing inline).
let lastBrokerageVM = null;
const collapsedPositions = new Set();

const HOLDINGS_HEAD = ['Stock', 'Shares', 'Avg cost', 'Cost basis', 'Worth today', 'Unrealized P&L'];

// The cells after Stock in a position / lot / total row: shares, average
// cost, cost basis, worth today and P&L, each labelled with its column
// header for the stacked mobile layout.
function holdingsMoneyCells(sharesText, avgCost, r) {
  return [
    { value: sharesText, label: HOLDINGS_HEAD[1] },
    { value: typeof avgCost === 'string' ? avgCost : formatUsdOrDash(avgCost), label: HOLDINGS_HEAD[2] },
    { value: formatUsdOrDash(r.costBasis), label: HOLDINGS_HEAD[3] },
    { value: formatUsdOrDash(r.worthNow), label: HOLDINGS_HEAD[4] },
    { value: pnlCell(r.pnl, r.pnlPct), label: HOLDINGS_HEAD[5] },
  ];
}

// Stock cell of a position row: a disclosure button (caret + $TICKER + logo +
// @seller) that collapses/expands this stock's lots.
function positionStockCell(r, collapsed) {
  const btn = el('button', { class: 'pos-toggle', type: 'button', 'aria-expanded': collapsed ? 'false' : 'true' });
  btn.appendChild(el('span', { class: `pos-caret${collapsed ? ' is-collapsed' : ''}`, 'aria-hidden': 'true', textContent: '▾' }));
  btn.appendChild(tickerCell(r.ticker));
  if (r.sellers.length) {
    btn.appendChild(el('span', { class: 'pos-seller', textContent: r.sellers.map((s) => `@${s}`).join(', ') }));
  }
  btn.addEventListener('click', () => {
    if (collapsedPositions.has(r.ticker)) collapsedPositions.delete(r.ticker);
    else collapsedPositions.add(r.ticker);
    renderHoldings();
  });
  return btn;
}

// Full-width row of ALL the lot's funding-auction thumbnails (each → item
// page). Uncapped — it wraps onto as many rows as it needs.
function lotThumbRow(lot) {
  const row = el('div', { class: 'lot-thumbs-row' });
  for (const it of lot.items) {
    const a = el('a', {
      class: 'lot-thumb',
      href: `/item.html?id=${encodeURIComponent(it.itemId)}`,
      title: it.title,
      'aria-label': it.title,
    });
    if (it.imageUrl) a.appendChild(el('img', { src: hiResImg(it.imageUrl, 140), alt: it.title, loading: 'lazy' }));
    row.appendChild(a);
  }
  return row;
}

// The unified holdings table: per-stock position rows (expandable) with their
// day-lots as indented sub-rows in the SAME columns + a thumbnail row each,
// then a composite Total (only when 2+ stocks). Rebuilt from lastBrokerageVM
// on every collapse toggle.
function renderHoldings() {
  const container = document.getElementById('brokerage-table');
  if (!container || !lastBrokerageVM) return;
  const { byTicker, total } = lastBrokerageVM;
  const grid = el('div', { class: 'brokerage-holdings' });
  grid.appendChild(
    holdingsRow(HOLDINGS_HEAD.map((h, i) => ({ value: h, cls: i === 0 ? 'bh-stock' : '' })), { head: true }),
  );
  for (const r of byTicker) {
    grid.appendChild(el('div', { class: 'bh-sep' }));
    const collapsed = collapsedPositions.has(r.ticker);
    const avg = r.shares > 0 ? r.costBasis / r.shares : null;
    grid.appendChild(
      holdingsRow(
        [{ value: positionStockCell(r, collapsed), cls: 'bh-stock' }, ...holdingsMoneyCells(shares.format(r.shares), avg, r)],
        { rowClass: 'bh-pos' },
      ),
    );
    if (collapsed) continue;
    for (const lot of r.lots) {
      const dateStr = shortDate(lot.dayMs);
      grid.appendChild(
        holdingsRow(
          [
            { value: dateStr, cls: 'bh-stock bh-lot-date' },
            ...holdingsMoneyCells(sharesCompact.format(lot.shares), lot.avgPrice, lot),
          ],
          { rowClass: 'bh-lot' },
        ),
      );
      grid.appendChild(lotThumbRow(lot));
      // The thumbnail strip spans all columns but the last (P&L). Drop an empty
      // filler into that trailing cell so grid auto-flow starts the next lot on
      // a fresh row instead of backfilling it (which shifted later lots over).
      grid.appendChild(el('span', { class: 'bh-fill', 'aria-hidden': 'true' }));
    }
  }
  if (byTicker.length > 1) {
    grid.appendChild(el('div', { class: 'bh-sep bh-sep-strong' }));
    grid.appendChild(
      holdingsRow(
        [{ value: 'Total', cls: 'bh-stock' }, ...holdingsMoneyCells('—', '—', total)],
        { total: true },
      ),
    );
  }
  container.replaceChildren(grid);
  syncExpandAllButton();
}

// --- Performance over time (The Other Half) ---
// Daily OHLC history, fetched once and reused; the chart reconstructs from it
// client-side so the seller filter / chart mode re-derive instantly.
let ohlcHistory = null;
let lastPerfRender = null; // { container, series } for re-render on resize/toggle

// The absolute "line" chart was dropped — it read poorly on its own; "pct"
// (relative return) replaced it. 'line' is migrated to 'pct' on load below.
const CHART_TYPES = ['area', 'pct', 'candle'];
const SERIES_COLOR = { EBAY: '#5aa9e6', GME: '#c792ea' };
function seriesColor(key) {
  return SERIES_COLOR[key] || '#8b93a7';
}
const CHART_ICONS = {
  area:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 13 L5 7 L9 9 L15 3 V15 H1 Z" fill="currentColor" opacity="0.45"/><path d="M1 13 L5 7 L9 9 L15 3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  pct:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><line x1="1" y1="8.5" x2="15" y2="8.5" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.6"/><polyline points="1,11 5,5 9,9 15,3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  candle:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><line x1="4.5" y1="1.5" x2="4.5" y2="14.5" stroke="currentColor" stroke-width="1"/><rect x="3" y="5" width="3" height="6" fill="currentColor"/><line x1="11.5" y1="3" x2="11.5" y2="13" stroke="currentColor" stroke-width="1"/><rect x="10" y="6" width="3" height="5" fill="currentColor"/></svg>',
};

let chartType = (() => {
  const v = localStorage.getItem('hchs.otherHalf.chartType');
  if (v === 'line') return 'pct'; // migrate the removed line chart to %
  return CHART_TYPES.includes(v) ? v : 'area';
})();
function setChartType(v) {
  if (!CHART_TYPES.includes(v) || v === chartType) return;
  chartType = v;
  localStorage.setItem('hchs.otherHalf.chartType', v);
  if (lastPerfRender) renderPerformanceChart(lastPerfRender.container, lastPerfRender.series);
}

// Series the legend can hide (line/area only): 'total' + each ticker.
let hiddenSeries = new Set((localStorage.getItem('hchs.otherHalf.hidden') || '').split(',').filter(Boolean));
function toggleSeries(key) {
  if (hiddenSeries.has(key)) hiddenSeries.delete(key);
  else hiddenSeries.add(key);
  localStorage.setItem('hchs.otherHalf.hidden', [...hiddenSeries].join(','));
  if (lastPerfRender) renderPerformanceChart(lastPerfRender.container, lastPerfRender.series);
}

async function refreshOhlcHistory() {
  try {
    const res = await fetch(`/api/ohlc-history?tickers=${SUPPORTED_SYMBOLS.join(',')}&days=240`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = await res.json();
    ohlcHistory = body.ohlc ?? {};
    // Redraw now that history is available (the chart was skipped until now).
    if (lastSnapshot) renderFilteredView(lastSnapshot, new Map());
  } catch {
    /* leave ohlcHistory null; the chart just stays hidden */
  }
}

// Reconstruct the portfolio over time. For each day since the earliest lot:
// per-stock value (active shares × that stock's close), the total, cost basis,
// and a composite portfolio OHLC candle (shares-weighted combine of the
// stocks' daily bars — high/low are approximations since the stocks' intraday
// extremes don't co-occur). A final live point (no candle) ties the last value
// to "worth today". Returns null when there isn't enough history (≥2 points).
function buildPerformanceSeries(positions, history, priceForTicker, nowMs) {
  if (!history) return null;
  const lots = positions
    .filter((p) => Array.isArray(history[p.ticker]) && history[p.ticker].length > 0)
    .map((p) => ({ t: Date.parse(p.endedAt), ticker: p.ticker, shares: p.shares, cost: p.costBasis }))
    .filter((a) => Number.isFinite(a.t))
    .sort((a, b) => a.t - b.t);
  if (lots.length === 0) return null;
  const firstT = lots[0].t;
  const tickers = [...new Set(lots.map((a) => a.ticker))];
  const grid = [...new Set(tickers.flatMap((tk) => history[tk].map((c) => c.t)))]
    .filter((t) => t >= firstT)
    .sort((a, b) => a - b);

  // Pointer sweep: bar[tk] = the most recent daily bar at or before `t`.
  const ptr = {};
  const bar = {};
  for (const tk of tickers) {
    ptr[tk] = 0;
    bar[tk] = null;
  }
  const advanceTo = (t) => {
    for (const tk of tickers) {
      const arr = history[tk];
      while (ptr[tk] < arr.length && arr[ptr[tk]].t <= t) {
        bar[tk] = arr[ptr[tk]];
        ptr[tk] += 1;
      }
    }
  };

  // What the lots ending at or before `t` add up to: total cost, and shares +
  // cost per ticker.
  const heldAt = (t) => {
    const shares = {};
    const costByTicker = {};
    let cost = 0;
    for (const a of lots) {
      if (a.t > t) break; // sorted; nothing later contributes yet
      cost += a.cost;
      shares[a.ticker] = (shares[a.ticker] ?? 0) + a.shares;
      costByTicker[a.ticker] = (costByTicker[a.ticker] ?? 0) + a.cost;
    }
    return { shares, costByTicker, cost };
  };

  const points = [];
  let prevCost = -1;
  for (const t of grid) {
    advanceTo(t);
    const { shares, costByTicker, cost } = heldAt(t);
    const byTicker = {};
    const closeByTicker = {};
    let value = 0;
    let o = 0;
    let h = 0;
    let l = 0;
    let c = 0;
    let ok = true;
    for (const tk of tickers) {
      const sh = shares[tk] ?? 0;
      const b = bar[tk];
      closeByTicker[tk] = b ? b.c : null;
      if (sh === 0) {
        byTicker[tk] = 0;
        continue;
      }
      if (!b) {
        ok = false; // history doesn't reach this day for a held stock yet
        break;
      }
      byTicker[tk] = sh * b.c;
      value += sh * b.c;
      o += sh * b.o;
      h += sh * b.h;
      l += sh * b.l;
      c += sh * b.c;
    }
    if (!ok) continue;
    points.push({
      t,
      value,
      cost,
      byTicker,
      costByTicker,
      closeByTicker,
      candle: { o, h, l, c },
      isLot: prevCost < 0 ? true : cost > prevCost + 1e-9,
    });
    prevCost = cost;
  }

  // Final live point (line/area only; no candle) — matches "worth today".
  const nowBy = {};
  const nowCloseBy = {};
  const { shares: nowShares, costByTicker: nowCostBy, cost: nowCost } = heldAt(Infinity);
  let nowValue = 0;
  let nowOk = true;
  for (const tk of tickers) {
    const sh = nowShares[tk] ?? 0;
    const lp = priceForTicker(tk);
    if (sh > 0 && !(lp > 0)) {
      nowOk = false;
      break;
    }
    nowBy[tk] = sh * (lp > 0 ? lp : 0);
    nowCloseBy[tk] = lp > 0 ? lp : null;
    nowValue += nowBy[tk];
  }
  if (nowOk && (points.length === 0 || nowMs > points[points.length - 1].t)) {
    points.push({
      t: nowMs,
      value: nowValue,
      cost: nowCost,
      byTicker: nowBy,
      costByTicker: nowCostBy,
      closeByTicker: nowCloseBy,
      candle: null,
      isLot: false,
      now: true,
    });
  }

  return points.length >= 2 ? { points, tickers } : null;
}

// Legend chip (line/area only): toggles a series; ticker chips carry a close
// that updates on hover.
function legendChip(key, label, color, priceSpan) {
  const chip = el('button', { class: `perf-chip${hiddenSeries.has(key) ? ' is-off' : ''}`, type: 'button' });
  const sw = el('span', { class: 'perf-swatch' });
  if (color) sw.style.background = color;
  else sw.classList.add('perf-swatch-total');
  chip.appendChild(sw);
  chip.appendChild(el('span', { textContent: label }));
  if (priceSpan) chip.appendChild(priceSpan);
  chip.addEventListener('click', () => toggleSeries(key));
  return chip;
}

// Chart-type toggle buttons (area / line / candlestick).
function buildChartTypes(type) {
  const types = el('div', { class: 'perf-types' });
  for (const t of CHART_TYPES) {
    const b = el('button', { class: `perf-type-btn${t === type ? ' is-active' : ''}`, type: 'button', title: t, 'aria-label': `${t} chart` });
    b.innerHTML = CHART_ICONS[t];
    b.addEventListener('click', () => setChartType(t));
    types.appendChild(b);
  }
  return types;
}

function renderPerformanceChart(container, series) {
  const pts = series.points;
  const tickers = series.tickers;
  const type = chartType;
  const W = Math.max(320, Math.round(container.clientWidth || 700));
  const H = 200;
  const padL = 10;
  const padR = 10;
  const padT = 14;
  const padB = 22;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  // Legend-driven scope: which stocks the cost line / readout / y-domain
  // reflect. 'Total' (or candlestick) means the whole portfolio; otherwise just
  // the visible component stocks. Hiding everything falls back to Total. This
  // is what makes isolating a small stock readable — and stops the total-cost
  // line from dragging the axis negative.
  const visible = tickers.filter((tk) => !hiddenSeries.has(tk));
  const showTotal = !hiddenSeries.has('total');
  const useTotal = type === 'candle' || showTotal || visible.length === 0;
  const sumBy = (map) => {
    let s = 0;
    for (const tk of visible) s += map[tk] ?? 0;
    return s;
  };
  const scopeValue = (p) => (useTotal ? p.value : sumBy(p.byTicker));
  const scopeCost = (p) => (useTotal ? p.cost : sumBy(p.costByTicker));
  const stackTop = (p) => sumBy(p.byTicker);
  // "%" mode plots return vs cost basis (value/cost − 1), so $EBAY and $GME are
  // comparable regardless of absolute size. ret() guards divide-by-zero;
  // scopePlotV is the y-value of the scope's main line in the active mode.
  const ret = (v, c) => (c > 0 ? v / c - 1 : 0);
  const isPct = type === 'pct';
  const compVal = (p, tk) => (isPct ? ret(p.byTicker[tk] ?? 0, p.costByTicker[tk] ?? 0) : (p.byTicker[tk] ?? 0));
  const scopePlotV = (p) => (isPct ? ret(scopeValue(p), scopeCost(p)) : scopeValue(p));

  const candlePts = pts.filter((p) => p.candle);
  const plot = type === 'candle' ? candlePts : pts;

  // Toolbar (built first so an early return still shows the controls).
  const priceSpans = {};
  const legend = el('div', { class: 'perf-legend' });
  if (type !== 'candle') {
    legend.appendChild(legendChip('total', 'Total', null, null));
    for (const tk of tickers) {
      const ps = el('span', { class: 'perf-chip-price' });
      priceSpans[tk] = ps;
      legend.appendChild(legendChip(tk, `$${tk}`, seriesColor(tk), ps));
    }
  }
  const toolbar = el('div', { class: 'perf-toolbar' }, [legend, buildChartTypes(type)]);

  if (plot.length < 2) {
    container.replaceChildren(toolbar);
    lastPerfRender = { container, series };
    return;
  }
  const defaultPt = plot[plot.length - 1];
  const t0 = plot[0].t;
  const t1 = plot[plot.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);

  // Y domain — always zoomed to what's actually drawn (area no longer pinned to
  // 0) and clamped ≥ 0 so an isolated small stock can't push the axis negative.
  let lo = Infinity;
  let hi = -Infinity;
  const fit = (v) => {
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  };
  for (const p of plot) {
    if (type === 'candle') {
      fit(scopeCost(p));
      fit(p.candle.h);
      fit(p.candle.l);
    } else if (type === 'area') {
      fit(scopeCost(p));
      fit(stackTop(p));
      if (useTotal) fit(p.value);
    } else if (isPct) {
      fit(0); // the 0% (break-even) baseline
      if (useTotal) fit(scopePlotV(p));
      for (const tk of visible) fit(compVal(p, tk));
    } else {
      fit(scopeCost(p));
      if (useTotal) fit(p.value);
      for (const tk of visible) fit(p.byTicker[tk] ?? 0);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    lo = Number.isFinite(lo) ? lo - 1 : 0;
    hi = Number.isFinite(hi) ? hi + 1 : 1;
  }
  const vp = (hi - lo) * 0.08;
  // % returns can be negative; absolute-$ axes clamp at 0.
  lo = isPct ? lo - vp : Math.max(0, lo - vp);
  hi += vp;

  const X = (t) => padL + ((t - t0) / tSpan) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const linePath = (acc) => plot.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(acc(p)).toFixed(1)}`).join(' ');

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: String(H), class: 'perf-chart' });
  // Reference line: the cost-basis line in $ modes; a flat 0% (break-even) line
  // in % mode.
  if (isPct) {
    svg.appendChild(mk('line', { class: 'perf-cost', x1: X(t0).toFixed(1), x2: X(t1).toFixed(1), y1: Y(0).toFixed(1), y2: Y(0).toFixed(1) }));
  } else {
    svg.appendChild(mk('path', { class: 'perf-cost', d: linePath((p) => scopeCost(p)) }));
  }

  if (type === 'area') {
    if (visible.length === 0) {
      let d = '';
      plot.forEach((p, i) => {
        d += `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.value).toFixed(1)}`;
      });
      d += `L${X(t1).toFixed(1)} ${Y(lo).toFixed(1)} L${X(t0).toFixed(1)} ${Y(lo).toFixed(1)} Z`;
      svg.appendChild(mk('path', { class: 'perf-total-fill', d }));
    } else {
      // Stacked, but proportional within the zoomed band [lo, stackTop] so the
      // shape stays readable when one stock dwarfs another.
      const valAt = (p, share) => {
        const st = stackTop(p);
        return lo + share * (st - lo);
      };
      let cum = plot.map(() => 0);
      for (const tk of visible) {
        const next = plot.map((p, i) => {
          const st = stackTop(p);
          return cum[i] + (st > 0 ? (p.byTicker[tk] ?? 0) / st : 0);
        });
        let d = '';
        plot.forEach((p, i) => {
          d += `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(valAt(p, next[i])).toFixed(1)}`;
        });
        for (let i = plot.length - 1; i >= 0; i--) d += `L${X(plot[i].t).toFixed(1)} ${Y(valAt(plot[i], cum[i])).toFixed(1)}`;
        svg.appendChild(mk('path', { d: `${d}Z`, fill: seriesColor(tk), 'fill-opacity': '0.45', stroke: seriesColor(tk), 'stroke-width': '1' }));
        cum = next;
      }
    }
    if (useTotal) svg.appendChild(mk('path', { class: 'perf-total-line', d: linePath((p) => p.value) }));
  } else if (type === 'candle') {
    const cw = Math.max(2, Math.min(13, ((W - padL - padR) / candlePts.length) * 0.6));
    for (const p of candlePts) {
      const x = X(p.t);
      const cls = p.candle.c >= p.candle.o ? 'perf-candle-up' : 'perf-candle-down';
      svg.appendChild(mk('line', { class: cls, x1: x.toFixed(1), x2: x.toFixed(1), y1: Y(p.candle.h).toFixed(1), y2: Y(p.candle.l).toFixed(1) }));
      const yTop = Math.min(Y(p.candle.o), Y(p.candle.c));
      const bh = Math.max(1, Math.abs(Y(p.candle.o) - Y(p.candle.c)));
      svg.appendChild(mk('rect', { class: cls, x: (x - cw / 2).toFixed(1), y: yTop.toFixed(1), width: cw.toFixed(1), height: bh.toFixed(1) }));
    }
  } else {
    // line OR pct — same shape; compVal/scopePlotV swap absolute $ for return.
    for (const tk of visible) {
      svg.appendChild(mk('path', { d: linePath((p) => compVal(p, tk)), fill: 'none', stroke: seriesColor(tk), 'stroke-width': '1.4' }));
    }
    if (useTotal) {
      const lastP = plot[plot.length - 1];
      const down = scopeCost(lastP) > scopeValue(lastP);
      svg.appendChild(mk('path', { class: `perf-value${down ? ' is-down' : ''}`, d: linePath((p) => scopePlotV(p)) }));
      for (const p of plot) if (p.isLot) svg.appendChild(mk('circle', { class: `perf-lot${down ? ' is-down' : ''}`, cx: X(p.t).toFixed(1), cy: Y(scopePlotV(p)).toFixed(1), r: '2.6' }));
      svg.appendChild(mk('circle', { class: `perf-now${down ? ' is-down' : ''}`, cx: X(lastP.t).toFixed(1), cy: Y(scopePlotV(lastP)).toFixed(1), r: '3.2' }));
    }
  }

  const fmtY = isPct ? (v) => `${(v * 100).toFixed(v >= 0.1 || v <= -0.1 ? 0 : 1)}%` : (v) => formatUsd(v);
  svg.appendChild(mk('text', { class: 'perf-axis', x: String(padL), y: String(padT - 3) })).textContent = fmtY(hi);
  svg.appendChild(mk('text', { class: 'perf-axis', x: String(padL), y: String(H - padB + 12) })).textContent = fmtY(lo);
  const dRange = mk('text', { class: 'perf-axis perf-axis-end', x: String(W - padR), y: String(H - padB + 12) });
  dRange.textContent = `${shortDate(t0)} – ${type === 'candle' ? shortDate(t1) : 'today'}`;
  svg.appendChild(dRange);

  const guide = mk('line', { class: 'perf-guide', x1: '0', y1: String(padT), x2: '0', y2: String(H - padB), opacity: '0' });
  const sdot = mk('circle', { class: 'perf-scrub-dot', r: '3.5', opacity: '0' });
  svg.appendChild(guide);
  svg.appendChild(sdot);

  const readout = el('div', { class: 'perf-readout' });
  const setLegendPrices = (p) => {
    for (const tk of tickers) {
      const sp = priceSpans[tk];
      if (!sp) continue;
      const cl = p.closeByTicker ? p.closeByTicker[tk] : null;
      sp.textContent = cl != null ? formatUsd(cl) : '—';
    }
  };
  const setReadout = (p) => {
    const v = scopeValue(p);
    const c = scopeCost(p);
    const pnl = v - c;
    const pct = c > 0 ? (pnl / c) * 100 : null;
    readout.replaceChildren(
      el('span', { class: 'perf-ro-date', textContent: p.now ? 'Today' : shortDate(p.t) }),
      el('span', { class: 'perf-ro-val', textContent: formatUsd(v) }),
      pnlNode(pnl, pct),
    );
    setLegendPrices(p);
  };
  setReadout(defaultPt);

  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return defaultPt;
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = plot[0];
    let bd = Infinity;
    for (const p of plot) {
      const dx = Math.abs(X(p.t) - px);
      if (dx < bd) {
        bd = dx;
        best = p;
      }
    }
    return best;
  };
  const move = (clientX) => {
    const p = nearest(clientX);
    const px = X(p.t).toFixed(1);
    guide.setAttribute('x1', px);
    guide.setAttribute('x2', px);
    guide.setAttribute('opacity', '1');
    sdot.setAttribute('cx', px);
    sdot.setAttribute('cy', Y(scopePlotV(p)).toFixed(1));
    sdot.setAttribute('opacity', '1');
    setReadout(p);
  };
  const clearScrub = () => {
    guide.setAttribute('opacity', '0');
    sdot.setAttribute('opacity', '0');
    setReadout(defaultPt);
  };
  svg.addEventListener('mousemove', (e) => move(e.clientX));
  svg.addEventListener('mouseleave', clearScrub);
  svg.addEventListener('touchmove', (e) => {
    if (e.touches[0]) move(e.touches[0].clientX);
  }, { passive: true });
  svg.addEventListener('touchend', clearScrub);

  container.replaceChildren(toolbar, readout, svg);
  lastPerfRender = { container, series };
}


// Open auctions aren't realized lots, so they sit OUTSIDE the position — a
// quiet "what's pending" line: total bids + the shares they'd buy at today's
// price if they closed now.
function renderPendingCallout(el2, filteredActive, priceForTicker) {
  const live = filteredActive.filter((i) => (i.bidCount ?? 0) > 0 && i.priceUsd != null);
  if (live.length === 0) {
    el2.hidden = true;
    return;
  }
  let cost = 0;
  const byTicker = new Map();
  for (const i of live) {
    const half = i.priceUsd / 2;
    cost += half;
    const tk = i.valuationTicker || currentTickerSymbol;
    const lp = priceForTicker(tk);
    if (lp > 0) byTicker.set(tk, (byTicker.get(tk) ?? 0) + half / lp);
  }
  const sharesStr = [...byTicker.entries()].map(([tk, sh]) => `+${sharesCompact.format(sh)} $${tk}`).join(' · ');
  setText(
    el2,
    `${plural(live.length, 'open auction')} · ${formatUsd(cost)} in bids${sharesStr ? ` → ${sharesStr} if they close now` : ''}`,
  );
  el2.hidden = false;
}

function renderBrokerage(snapshot, filteredEnded, filteredActive, priceForTicker) {
  const section = document.getElementById('brokerage-section');
  if (!section) return;
  const tickerOrder = (snapshot.stocks ?? [snapshot.stock]).filter(Boolean).map((q) => q.symbol);
  // Sort positions by the page's Sort pill (same logic as the ended list) so
  // the Statement orders/regroups in lockstep with the rest of the page.
  const sortedEnded = sortEndedItems(filteredEnded, currentSort);
  const b = aggregateBrokerage(sortedEnded, priceForTicker, tickerOrder);
  // Nothing sold with an end-time price yet (or price feed down) — the
  // hypothetical has nothing to say; hide rather than show dashes.
  if (b.positions.length === 0 || b.total.worthNow === null) {
    section.hidden = true;
    return;
  }
  // One unified table: per-stock position rows (the summary) with their
  // day-lots expandable inline beneath, then a composite Total. The old
  // separate "Position detail" section rolls into this table now.
  const multi = b.byTicker.length > 1;
  const only = b.byTicker[0];

  setText(
    document.getElementById('brokerage-tagline'),
    multi
      ? 'If every buyer had really paid half in stock \u2014 Ryan\u2019s in $EBAY, mine in $GME \u2014 here\u2019s how that other half is doing today:'
      : `If every buyer had really paid half in $${only?.ticker ?? activeSymbol} stock, here\u2019s how that other half is doing today:`,
  );

  lastBrokerageVM = b;
  renderHoldings();

  // Performance-over-time chart (hidden until daily OHLC history is available).
  const chart = document.getElementById('brokerage-chart');
  if (chart) {
    const series = buildPerformanceSeries(b.positions, ohlcHistory, priceForTicker, Date.now());
    if (series) {
      chart.hidden = false;
      renderPerformanceChart(chart, series);
    } else {
      chart.hidden = true;
      chart.replaceChildren();
      lastPerfRender = null;
    }
  }

  const pending = document.getElementById('brokerage-pending');
  if (pending) renderPendingCallout(pending, filteredActive ?? [], priceForTicker);

  const footnote = document.getElementById('brokerage-footnote');
  if (b.excludedCount > 0) {
    setText(footnote, `${plural(b.excludedCount, 'sold item')} excluded \u2014 no stock price on record for the moment the auction ended.`);
    footnote.hidden = false;
  } else {
    footnote.hidden = true;
  }

  section.hidden = false;
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function timeRemaining(endsAt) {
  if (!endsAt) return '';
  const ms = new Date(endsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'ended';
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
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
  // One quote in normal mode; one per stock in "By seller" mode ($EBAY, $GME).
  let stocks =
    snapshot?.valuationMode === 'mixed' && Array.isArray(snapshot.stocks) && snapshot.stocks.length
      ? snapshot.stocks
      : [snapshot?.stock].filter(Boolean);
  if (stocks.length === 0) {
    stocks = [{ symbol: activeSymbol === MIXED_SYMBOL ? 'EBAY' : activeSymbol, price: null, asOf: null }];
  }
  const quotesWrap = ticker.querySelector('.ticker-quotes');
  if (quotesWrap) {
    quotesWrap.classList.toggle('is-multi', stocks.length > 1);
    quotesWrap.replaceChildren(
      ...stocks.map((q) =>
        el('div', { class: 'ticker-quote' }, [
          el('span', { class: 'ticker-symbol', textContent: `$${q.symbol}` }),
          el('span', { class: 'ticker-price', textContent: q.price ? formatUsd(q.price) : '—' }),
        ]),
      ),
    );
  }
  const generated = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  const isStale = generated ? Date.now() - generated.getTime() > STALE_MS : false;
  ticker.classList.toggle('is-stale', isStale);
  const marketOpen = isUsMarketOpen();
  setText(ticker.querySelector('.ticker-status'), marketOpen ? '' : 'Market closed');
  // Price-feed timestamp lives directly below the market-status line so the
  // user can tell at a glance how stale the stock value is (especially over
  // a weekend, when the close from Friday afternoon should be unambiguous).
  // Both stocks are US equities sharing one market clock — show the freshest
  // as-of across them.
  const asOfMs = stocks.map((q) => (q.asOf ? Date.parse(q.asOf) : NaN)).filter((n) => !Number.isNaN(n));
  const asOf = asOfMs.length ? new Date(Math.max(...asOfMs)) : null;
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
  const { listingsCount, bidsCount, bidUsd, cashUsd, sharesByTicker } = totals;
  root.appendChild(statCard('Active listings', integer.format(listingsCount)));
  root.appendChild(statCard('Bids', integer.format(bidsCount ?? 0)));
  root.appendChild(statCard('Sum of current bids', formatUsd(bidUsd)));
  root.appendChild(statCard('Half Cash', formatUsd(cashUsd)));
  root.appendChild(sharesCard('Half Stock', sharesByTicker));
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

// Ticker-logo state, refreshed from each /api/snapshot response. `logosEnabled`
// reflects whether the server has a logo.dev token; per-ticker URLs are built
// on demand (the proxy keys off ?symbol=) so "By seller" mode can show each
// stock's own logo. currentTickerSymbol is the single active symbol used as a
// default when an item carries no valuationTicker.
let logosEnabled = false;
let currentTickerSymbol = '';

// Logo proxy URL for a ticker, or null when logos are disabled.
function logoUrlFor(ticker) {
  if (!logosEnabled || !ticker) return null;
  return `/api/ticker-logo?symbol=${encodeURIComponent(ticker)}`;
}

// The ticker logo <img>, or null when no logo is configured. Callers decide
// the fallback: the inline "shares" unit (sharesUnit) or simply nothing (the
// split's "Half Stock" label, which already names the asset).
function tickerLogoImg(ticker) {
  const url = logoUrlFor(ticker);
  if (!url) return null;
  return el('img', {
    class: 'ticker-logo',
    src: url,
    alt: ticker,
    title: ticker,
    loading: 'lazy',
  });
}

// The "unit" trailing the shares value — the ticker logo when available
// (mirrors a currency glyph), otherwise the spelled-out word "shares". The
// img onerror handler downgrades to the text unit if the logo fails to
// load (network error, unknown ticker, etc.) without leaving a broken icon.
function sharesUnit(ticker) {
  const img = tickerLogoImg(ticker);
  if (img) {
    img.addEventListener('error', () => {
      img.replaceWith(el('span', { class: 'unit', textContent: 'shares' }));
    });
    return img;
  }
  return el('span', { class: 'unit', textContent: 'shares' });
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
function splitBox(cashUsd, sharesAmount, ticker) {
  const split = el('div', { class: 'item-split' });
  split.appendChild(
    el('div', { class: 'split-half' }, [
      el('span', { class: 'label', textContent: 'Half Cash' }),
      el('span', { class: 'value', textContent: formatUsd(cashUsd) }),
    ]),
  );
  split.appendChild(
    el('div', { class: 'split-half' }, [
      el('span', { class: 'label', textContent: 'Half Stock' }),
      el('span', { class: 'value' }, [sharesValue(sharesAmount, { compact: true, ticker })]),
    ]),
  );
  return split;
}

// Format a shares amount as "{N} <unit>" where the unit is the ticker logo
// or the word "shares". `compact: true` uses 4 significant digits (for
// narrow tile splits); default uses the full 4-decimal form (for totals).
// `ticker` selects which stock's logo to show (defaults to the active one).
function sharesValue(n, { compact = false, ticker = currentTickerSymbol } = {}) {
  return el('span', {}, [
    compact ? sharesCompact.format(n) : shares.format(n),
    sharesUnit(ticker),
  ]);
}

// "N bid(s)", or null when the count is unknown.
function bidsText(n) {
  if (n === null || n === undefined) return null;
  return plural(n, 'bid');
}

// The listing card shared by active and ended tiles: gallery, linked title,
// tag + seller badge, a price line (large price + history icon) with its
// stats stacked beside it, and the half/half split when there is one.
function listingCard(item, { cardClass, href, tag, priceText, stats, split }) {
  const card = el('article', { class: cardClass });
  card.appendChild(imageGallery([item.imageUrl, ...(item.additionalImages ?? [])], item.title));
  const body = el('div', { class: 'item-body' });
  body.appendChild(
    el('h2', { class: 'item-title' }, [
      el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: item.title }),
    ]),
  );
  const meta = el('div', { class: 'item-meta' });
  meta.appendChild(tag);
  if (item.sellerId) {
    meta.appendChild(el('span', { class: sellerBadgeClass(item.sellerId), textContent: `@${item.sellerId}` }));
  }
  body.appendChild(meta);

  // Price line: the large price on the left, with the stats (bid count +
  // time left / ended date) stacked beside it as atomic chunks, and the
  // history icon pinned to the far right.
  const bidRow = el('div', { class: 'item-bid-row' });
  const priceLine = el('div', { class: 'item-bid-price' }, [
    el('div', { class: 'item-bid', textContent: priceText }),
    historyLink(item.itemId),
  ]);
  bidRow.appendChild(priceLine);
  const statsEl = el('div', { class: 'item-bid-stats' });
  for (const text of stats) {
    if (text) statsEl.appendChild(el('span', { class: 'item-bid-stat', textContent: text }));
  }
  if (statsEl.children.length) bidRow.appendChild(statsEl);
  body.appendChild(bidRow);
  if (split) {
    body.appendChild(splitBox(split.cashUsd, split.shares, item.valuationTicker));
  }
  card.appendChild(body);
  return card;
}

function renderItem(item) {
  return listingCard(item, {
    cardClass: 'item',
    href: item.itemWebUrl,
    tag: saleTag(item.isAuction),
    priceText: item.priceUsd != null ? formatUsd(item.priceUsd) : '—',
    stats: [bidsText(item.bidCount), timeRemaining(item.endsAt)],
    split: item.split,
  });
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
    const display = atEnd ? totals.atEnd : totals.live;
    const sharesSuffix = atEnd ? ' (at end)' : ' (live)';
    totalsRoot.appendChild(statCard('Ended listings', integer.format(totals.listingsCount)));
    totalsRoot.appendChild(statCard('Bids', integer.format(totals.bidsCount)));
    totalsRoot.appendChild(statCard('Sum of final bids', formatUsd(totals.bidUsd)));
    totalsRoot.appendChild(statCard('Half Cash', formatUsd(display.cashUsd)));
    totalsRoot.appendChild(sharesCard(`Half Stock${sharesSuffix}`, display.sharesByTicker));
    // When some ended items lack OHLC history, flag the gap so users know
    // the at-end aggregate is a subset.
    if (atEnd && totals.pricedAtEndCount < totals.listingsCount) {
      const missing = totals.listingsCount - totals.pricedAtEndCount;
      totalsRoot.appendChild(statCard('Missing end-time price', integer.format(missing)));
    }
  }

  root.replaceChildren();
  const sorted = sortEndedItems(endedItems, currentSort);
  for (const item of sorted) {
    root.appendChild(renderEndedItem(item));
  }
}

function renderEndedItem(item) {
  const atEnd = currentEndedPriceMode === 'at-end';
  const endedDate = item.endedAt ? new Date(item.endedAt) : null;
  return listingCard(item, {
    cardClass: 'item ended-item',
    href: endedEbayUrl(item.itemWebUrl, item.itemId),
    tag: el('span', { class: 'tag tag-ended', textContent: 'Ended' }),
    priceText: formatUsd(item.finalPriceUsd),
    stats: [
      bidsText(item.finalBidCount),
      endedDate ? `Ended ${shortDate(endedDate)}` : null,
    ],
    split: atEnd ? item.endTimeSplit : item.split,
  });
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
    const card = renderItem(item);
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
  info.appendChild(el('div', { class: 'most-recent-bid-amount', textContent: formatUsd(bid.bidAmount) }));
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
// Live price lookup by ticker. One quote in normal mode; one per stock in
// "By seller" mode. Unknown tickers fall back to the primary quote's price so
// a stray valuationTicker never zeroes a split.
function priceForTickerFromSnapshot(snapshot) {
  const quotes = (snapshot.stocks ?? [snapshot.stock]).filter(Boolean);
  const byTicker = new Map(quotes.map((q) => [q.symbol, q.price ?? 0]));
  const fallback = snapshot.stock?.price ?? 0;
  return (ticker) => byTicker.get(ticker) ?? fallback;
}

function renderFilteredView(snapshot, bidDiff) {
  if (!snapshot) return;
  const priceForTicker = priceForTickerFromSnapshot(snapshot);
  const filteredActive = filterBySeller(snapshot.items ?? []);
  // 0-bid ended auctions are unsold listings — they didn't clear and they
  // don't contribute to any of the dollar totals (composeSnapshot already
  // excludes them). Hide them from the visible list too so the ended
  // section doesn't get cluttered with non-events.
  const filteredEnded = filterBySeller(snapshot.endedItems ?? []).filter(
    (i) => (i.finalBidCount ?? 0) > 0,
  );
  renderTotals(snapshot, aggregateActiveTotals(filteredActive));
  renderBrokerage(snapshot, filteredEnded, filteredActive, priceForTicker);
  renderMostRecentBid(snapshot, filteredActive);
  renderItems(snapshot, filteredActive, bidDiff);
  renderEndedSection(snapshot, filteredEnded, aggregateEndedTotals(filteredEnded));
}

function updateIntroSymbol(symbol) {
  const display = symbol === MIXED_SYMBOL ? '$EBAY + $GME' : `$${symbol}`;
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
    logosEnabled = Boolean(snapshot.tickerLogoUrl);
    currentTickerSymbol = snapshot.stock?.symbol ?? (activeSymbol === MIXED_SYMBOL ? 'EBAY' : activeSymbol);
    renderDegradedBanner(snapshot);
    renderTicker(snapshot);
    updateIntroSymbol(snapshot.valuationMode === 'mixed' ? MIXED_SYMBOL : (snapshot.stock?.symbol ?? activeSymbol));
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

// Pill groups (`.seller-btn`, `.stock-btn`, `.view-btn`, ...): mark the pill
// whose data-<key> equals `value` active and the rest inactive.
function syncPills(selector, key, value) {
  document.querySelectorAll(selector).forEach((b) => b.classList.toggle('is-active', b.dataset[key] === value));
}

// Wire a pill group: reflect `current()` on first paint; a click on a
// different pill marks it active and calls `onPick(value)`.
function wirePills(selector, key, current, onPick) {
  syncPills(selector, key, current());
  document.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset[key];
      if (value === current()) return;
      syncPills(selector, key, value);
      onPick(value);
    });
  });
}

// Stock toggle wiring — sync the active pill to the persisted activeSymbol
// on first paint (the HTML hard-codes EBAY as active so the load/refresh
// would otherwise mismatch when GME or a custom ticker is persisted).
wirePills('.stock-btn', 'symbol', () => activeSymbol, (symbol) => {
  activeSymbol = symbol;
  const input = document.getElementById('ticker-input');
  if (input) input.value = '';
  updateIntroSymbol(activeSymbol);
  refresh();
});

// Custom ticker input wiring
const tickerInput = document.getElementById('ticker-input');
if (tickerInput) {
  if (!isPillSymbol(activeSymbol)) {
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
      if (newSymbol && TICKER_RE.test(newSymbol) && newSymbol !== activeSymbol) {
        activeSymbol = newSymbol;
        syncPills('.stock-btn', 'symbol', activeSymbol); // a custom ticker matches no pill
        tickerInput.classList.add('is-validating');
        updateIntroSymbol(activeSymbol);
        refresh().finally(() => tickerInput.classList.remove('is-validating'));
      }
    }
  });
  tickerInput.addEventListener('blur', () => {
    if (!isPillSymbol(activeSymbol)) {
      tickerInput.value = activeSymbol;
    } else {
      tickerInput.value = '';
    }
  });
}

// Sort wiring — pills on desktop, a <select> on phones (five pills ate
// two rows of a narrow screen). Both controls drive the same state and
// stay in sync; CSS decides which is visible.
function applySort(mode) {
  if (!SORT_MODES.includes(mode) || mode === currentSort) return;
  currentSort = mode;
  saveChoice('hchs.sort', SORT_MODES, currentSort);
  syncSortControls();
  if (lastSnapshot) renderFilteredView(lastSnapshot, new Map()); // re-sort active + ended; no bid flash
}
function syncSortControls() {
  document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.sort === currentSort));
  const sel = document.getElementById('sort-select');
  if (sel) sel.value = currentSort;
}
document.querySelectorAll('.sort-btn').forEach((btn) => {
  btn.addEventListener('click', () => applySort(btn.dataset.sort));
});
const sortSelect = document.getElementById('sort-select');
if (sortSelect) sortSelect.addEventListener('change', () => applySort(sortSelect.value));
syncSortControls();

// View-mode button wiring. Reflects the persisted choice on initial paint
// and applies it to the containers. Switching modes is a pure CSS class
// swap — no re-render needed since every mode reuses the same card DOM.
wirePills('.view-btn', 'view', () => currentViewMode, (mode) => {
  currentViewMode = mode;
  saveChoice('hchs.viewMode', VIEW_MODES, currentViewMode);
  applyViewMode();
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
wirePills('.seller-btn', 'sellerFilter', () => currentSellerFilter, (filter) => {
  currentSellerFilter = filter;
  saveChoice('hchs.sellerFilter', SELLER_FILTERS, currentSellerFilter);

  // Thematic ticker swap: Mine→$GME, Ryan→$EBAY, All→$EBAY. Re-fetch the
  // snapshot for the new symbol if it changed; otherwise just re-filter
  // the cached snapshot in place.
  const preferredTicker = SELLER_FILTER_DEFAULT_TICKER[currentSellerFilter];
  if (preferredTicker && preferredTicker !== activeSymbol) {
    activeSymbol = preferredTicker;
    saveTickerToStorage(activeSymbol);
    syncPills('.stock-btn', 'symbol', activeSymbol);
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

// Ended-section "Live vs At end" stock price toggle
wirePills('.ended-mode-btn', 'endedMode', () => currentEndedPriceMode, (mode) => {
  currentEndedPriceMode = mode;
  saveChoice('hchs.endedPriceMode', ENDED_MODES, currentEndedPriceMode);
  if (lastSnapshot) renderFilteredView(lastSnapshot, new Map()); // re-render ended section
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
wirePills('.ended-window-btn', 'endedWindow', () => currentEndedWindow, (win) => {
  currentEndedWindow = win;
  saveChoice('hchs.endedWindow', ENDED_WINDOWS, currentEndedWindow);
  updateEndedHeading();
  refresh();
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

// "The Other Half" enable toggle — collapse/expand the brokerage, persisted.
const brokerageToggle = document.getElementById('brokerage-toggle');
if (brokerageToggle) {
  brokerageToggle.addEventListener('click', () => {
    otherHalfEnabled = !otherHalfEnabled;
    saveOtherHalfEnabled(otherHalfEnabled);
    applyOtherHalfEnabled();
  });
}

// Expand-all / collapse-all every position in the holdings table at once.
const brokerageExpand = document.getElementById('brokerage-expand');
if (brokerageExpand) {
  brokerageExpand.addEventListener('click', () => {
    if (!lastBrokerageVM) return;
    const tickers = lastBrokerageVM.byTicker.map((r) => r.ticker);
    const allCollapsed = tickers.every((t) => collapsedPositions.has(t));
    if (allCollapsed) collapsedPositions.clear();
    else tickers.forEach((t) => collapsedPositions.add(t));
    renderHoldings();
  });
}
applyOtherHalfEnabled();

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
refreshOhlcHistory();

// Re-render the performance chart on resize (it's measured to the container
// width). Debounced; only when a chart is currently shown.
let perfResizeTimer = null;
window.addEventListener('resize', () => {
  if (perfResizeTimer !== null) return;
  perfResizeTimer = window.setTimeout(() => {
    perfResizeTimer = null;
    if (lastPerfRender && !lastPerfRender.container.hidden) {
      renderPerformanceChart(lastPerfRender.container, lastPerfRender.series);
    }
  }, 200);
});
