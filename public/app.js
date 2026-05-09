const POLL_MS = 30_000;
const STALE_MS = 120_000;

const SUPPORTED_SYMBOLS = ['EBAY', 'GME'];
let activeSymbol = SUPPORTED_SYMBOLS[0];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const shares = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat('en-US');

// --- Sort & animation state ---
let currentSort = 'ending-soonest';
let lastSnapshot = null;
let prevBidCounts = new Map(); // itemId → bidCount from last successful render

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

function setText(el, text) {
  if (el) el.textContent = text;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'href' || k === 'target' || k === 'rel' || k === 'src' || k === 'alt' || k === 'loading') {
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
  const status = isUsMarketOpen() ? '' : 'market closed';
  setText(ticker.querySelector('.ticker-status'), status);
}

function renderLastUpdated(snapshot) {
  const el = document.getElementById('last-updated');
  if (!el) return;
  const generated = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  if (!generated) {
    setText(el, '');
    return;
  }
  setText(el, `Updated ${generated.toLocaleTimeString()}`);
}

function renderPriceSource(snapshot) {
  const el = document.getElementById('price-source');
  if (!el) return;
  const source = snapshot?.stock?.source;
  setText(el, source === 'finnhub' ? 'Finnhub' : source === 'yahoo' ? 'Yahoo Finance' : 'Finnhub or Yahoo Finance');
}

function renderTotals(snapshot) {
  const root = document.getElementById('totals');
  if (!root) return;
  root.replaceChildren();
  if (!snapshot) return;
  const { listingsCount, pricedCount, bidsCount, bidUsd, split } = snapshot.totals;
  const symbol = snapshot.stock?.symbol ?? activeSymbol;
  const items = [
    { label: 'Active listings', value: integer.format(listingsCount) },
    { label: 'Total bids', value: integer.format(bidsCount ?? 0) },
    { label: 'Sum of current bids', value: usd.format(bidUsd) },
    { label: 'Total cash half', value: usd.format(split.cashUsd) },
    { label: `Total ${symbol} shares`, value: shares.format(split.shares) },
  ];
  for (const stat of items) {
    root.appendChild(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-label', textContent: stat.label }),
        el('div', { class: 'stat-value', textContent: stat.value }),
      ]),
    );
  }
  if (pricedCount < listingsCount) {
    root.appendChild(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-label', textContent: 'Excluded (currency)' }),
        el('div', { class: 'stat-value', textContent: integer.format(listingsCount - pricedCount) }),
      ]),
    );
  }
}

function renderItem(item, symbol) {
  const card = el('article', { class: 'item' });
  const img = item.imageUrl
    ? el('img', { class: 'item-image', src: item.imageUrl, alt: item.title, loading: 'lazy' })
    : el('div', { class: 'item-image' });
  card.appendChild(img);
  const body = el('div', { class: 'item-body' });
  body.appendChild(
    el('h2', { class: 'item-title' }, [
      el('a', { href: item.itemWebUrl, target: '_blank', rel: 'noopener noreferrer', textContent: item.title }),
    ]),
  );
  const meta = el('div', { class: 'item-meta' });
  meta.appendChild(el('span', { class: item.isAuction ? 'tag tag-auction' : 'tag', textContent: item.isAuction ? 'Auction' : 'Buy it now' }));
  if (item.bidCount !== null && item.bidCount !== undefined) {
    meta.appendChild(el('span', { textContent: `${item.bidCount} bid${item.bidCount === 1 ? '' : 's'}` }));
  }
  const remaining = timeRemaining(item.endsAt);
  if (remaining) meta.appendChild(el('span', { textContent: remaining }));
  body.appendChild(meta);

  const bidRow = el('div', { class: 'item-bid-row' });
  bidRow.appendChild(
    el('div', { class: 'item-bid', textContent: item.priceUsd != null ? usd.format(item.priceUsd) : '—' }),
  );
  const bidAge = formatRelativeBidAge(item.lastBidTime);
  if (bidAge) {
    bidRow.appendChild(
      el('span', {
        class: 'item-bid-time',
        textContent: bidAge,
        title: `Most recent bid activity: ${formatLocalTimestamp(item.lastBidTime)}. This may differ from when the current displayed bid was reached due to proxy bidding.`,
      }),
    );
  }
  body.appendChild(bidRow);
  if (item.split) {
    const split = el('div', { class: 'item-split' });
    split.appendChild(el('div', { class: 'label', textContent: 'Cash half' }));
    split.appendChild(el('div', { class: 'label', textContent: `${symbol} shares` }));
    split.appendChild(el('div', { class: 'value', textContent: usd.format(item.split.cashUsd) }));
    split.appendChild(el('div', { class: 'value', textContent: shares.format(item.split.shares) }));
    body.appendChild(split);
  }
  card.appendChild(body);
  return card;
}

function renderItems(snapshot, bidDiff) {
  const root = document.getElementById('items');
  if (!root) return;

  // FLIP — record old card positions before blowing away the DOM
  const oldRects = new Map();
  root.querySelectorAll('.item[data-item-id]').forEach((card) => {
    oldRects.set(card.dataset.itemId, card.getBoundingClientRect());
  });

  root.replaceChildren();

  const items = snapshot?.items ?? [];
  if (items.length === 0) {
    root.appendChild(el('div', { class: 'empty', textContent: 'No active listings right now.' }));
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

function renderMostRecentBid(snapshot) {
  const container = document.getElementById('most-recent-bid');
  if (!container) return;
  container.replaceChildren();

  if (!snapshot?.lastBid) {
    container.appendChild(
      el('div', { class: 'most-recent-bid-empty', textContent: 'No bids yet.' }),
    );
    return;
  }

  const bid = snapshot.lastBid;
  const bidItem = (snapshot.items ?? []).find((item) => item.itemId === bid.itemId) ?? null;
  const timeAgo = formatRelativeBidAge(bid.bidTime) ?? 'unknown';

  const content = el('div', { class: 'most-recent-bid-content' });
  content.appendChild(
    bidItem?.imageUrl
      ? el('img', {
          class: 'most-recent-bid-thumb',
          src: bidItem.imageUrl,
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

function updateIntroSymbol(symbol) {
  const display = `$${symbol}`;
  setText(document.getElementById('intro-symbol'), display);
  setText(document.getElementById('intro-symbol-2'), display);
}

let lastKnownGoodSymbol = activeSymbol;

async function refresh() {
  try {
    const res = await fetch(`/api/snapshot?symbol=${encodeURIComponent(activeSymbol)}`, { headers: { Accept: 'application/json' } });
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
      renderError(
        res.status === 503
          ? `Server can't reach eBay or the price provider right now.${detail}`
          : `Snapshot request failed (HTTP ${res.status}).${detail}`,
      );
      return;
    }
    const snapshot = await res.json();
    lastKnownGoodSymbol = activeSymbol;
    saveTickerToStorage(activeSymbol);
    renderTicker(snapshot);
    updateIntroSymbol(snapshot.stock?.symbol ?? activeSymbol);
    renderLastUpdated(snapshot);
    renderPriceSource(snapshot);
    renderTotals(snapshot);
    renderMostRecentBid(snapshot);
    renderItems(snapshot, prevBidCounts);
    lastSnapshot = snapshot;
    prevBidCounts = new Map(
      (snapshot.items ?? []).map((item) => [item.itemId, item.bidCount ?? 0]),
    );
  } catch (err) {
    renderError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
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

// Stock toggle wiring
document.querySelectorAll('.stock-btn').forEach((btn) => {
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

// Sort button wiring
document.querySelectorAll('.sort-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.sort === currentSort) return;
    currentSort = btn.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    if (lastSnapshot) renderItems(lastSnapshot, new Map()); // re-sort; no bid flash
  });
});

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
