const POLL_MS = 30_000;
const STALE_MS = 120_000;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd4 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const shares = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat('en-US');

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

function renderTicker(snapshot) {
  const ticker = document.getElementById('ticker');
  if (!ticker) return;
  const price = snapshot?.stock?.price;
  const source = snapshot?.stock?.source ?? '';
  const asOf = snapshot?.stock?.asOf ? new Date(snapshot.stock.asOf) : null;
  setText(ticker.querySelector('.ticker-price'), price ? usd.format(price) : '—');
  const generated = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;
  const isStale = generated ? Date.now() - generated.getTime() > STALE_MS : false;
  ticker.classList.toggle('is-stale', isStale);
  const meta = [];
  if (source) meta.push(source);
  if (asOf) meta.push(`as of ${asOf.toLocaleTimeString()}`);
  setText(ticker.querySelector('.ticker-meta'), meta.length ? `(${meta.join(' · ')})` : '');
}

function renderTotals(snapshot) {
  const root = document.getElementById('totals');
  if (!root) return;
  root.replaceChildren();
  if (!snapshot) return;
  const { listingsCount, pricedCount, bidUsd, split } = snapshot.totals;
  const items = [
    { label: 'Active listings', value: integer.format(listingsCount) },
    { label: 'Sum of current bids', value: usd.format(bidUsd) },
    { label: 'Total cash half', value: usd.format(split.cashUsd) },
    { label: 'Total EBAY shares', value: shares.format(split.shares) },
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

function renderItem(item) {
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
  body.appendChild(
    el('div', { class: 'item-bid', textContent: item.priceUsd != null ? usd.format(item.priceUsd) : '—' }),
  );
  if (item.split) {
    const split = el('div', { class: 'item-split' });
    split.appendChild(el('div', { class: 'label', textContent: 'Cash half' }));
    split.appendChild(el('div', { class: 'label', textContent: 'EBAY shares' }));
    split.appendChild(el('div', { class: 'value', textContent: usd.format(item.split.cashUsd) }));
    split.appendChild(el('div', { class: 'value', textContent: shares.format(item.split.shares) }));
    split.appendChild(el('div', { class: 'label', textContent: 'Stock half' }));
    split.appendChild(el('div', { class: 'label', textContent: '@ live EBAY' }));
    split.appendChild(el('div', { class: 'value', textContent: usd.format(item.split.stockUsd) }));
    split.appendChild(el('div', { class: 'value', textContent: usd4.format(item.split.stockUsd / Math.max(item.split.shares, 1e-9)) }));
    body.appendChild(split);
  }
  card.appendChild(body);
  return card;
}

function renderItems(snapshot) {
  const root = document.getElementById('items');
  if (!root) return;
  root.replaceChildren();
  const items = snapshot?.items ?? [];
  if (items.length === 0) {
    root.appendChild(el('div', { class: 'empty', textContent: 'No active listings right now.' }));
    return;
  }
  for (const item of items) root.appendChild(renderItem(item));
}

function renderError(message) {
  const root = document.getElementById('items');
  if (!root) return;
  root.replaceChildren(el('div', { class: 'error', textContent: message }));
}

async function refresh() {
  try {
    const res = await fetch('/api/snapshot', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      renderError(
        res.status === 503
          ? 'Server can\'t reach eBay or the price provider right now. Try again shortly.'
          : `Snapshot request failed (HTTP ${res.status}).`,
      );
      return;
    }
    const snapshot = await res.json();
    renderTicker(snapshot);
    renderTotals(snapshot);
    renderItems(snapshot);
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
