const params = new URLSearchParams(window.location.search);
const itemId = params.get('id') || '';

const loading = document.getElementById('loading');
const errorBanner = document.getElementById('error');
const headerEl = document.getElementById('item-header');
const currentSection = document.getElementById('current-section');
const currentState = document.getElementById('current-state');
const chartSection = document.getElementById('chart-section');
const chartWrap = document.getElementById('chart-wrap');
const chartHelp = document.getElementById('chart-help');
const bidsSection = document.getElementById('bids-section');
const bidsSummary = document.getElementById('bids-summary');
const bidsTable = document.getElementById('bids-table');
const snapshotsSection = document.getElementById('snapshots-section');
const snapshotsTable = document.getElementById('snapshots-table');

function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function fmtCount(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
  loading.hidden = true;
}

function renderHeader(listing) {
  const ebayUrl = listing.itemWebUrl || `https://www.ebay.com/itm/${encodeURIComponent(listing.itemId)}`;
  const img = listing.imageUrl ? `<img src="${escapeHtml(listing.imageUrl)}" alt="" loading="lazy" />` : '';
  headerEl.innerHTML = `
    ${img}
    <div class="item-header-text">
      <h2>${escapeHtml(listing.title || 'Untitled item')}</h2>
      <p class="item-meta">Item ID: <code>${escapeHtml(listing.itemId)}</code></p>
      <p class="item-meta">${listing.isAuction ? 'Auction' : 'Buy-it-now'} · ${listing.endsAt ? 'Ends ' + fmtTime(listing.endsAt) : 'No end time'}</p>
      <p class="item-meta">First seen ${fmtTime(listing.firstSeenAt)} · last seen ${fmtTime(listing.lastSeenAt)}</p>
      <p class="item-meta"><a href="${escapeHtml(ebayUrl)}" target="_blank" rel="noopener noreferrer">View on eBay ↗</a></p>
    </div>
  `;
  headerEl.hidden = false;
}

function renderCurrentState(listing, bids) {
  const activeBids = bids.filter((b) => !b.removedAt).length;
  const removedBids = bids.filter((b) => b.removedAt).length;
  const highestActive = bids
    .filter((b) => !b.removedAt)
    .reduce((max, b) => (b.bidAmountUsd > max ? b.bidAmountUsd : max), 0);
  const highestEver = bids.reduce((max, b) => (b.bidAmountUsd > max ? b.bidAmountUsd : max), 0);

  currentState.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Current price</div>
      <div class="stat-value">${fmtUsd(listing.currentPriceUsd)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Bid count</div>
      <div class="stat-value">${fmtCount(listing.currentBidCount)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Active bids tracked</div>
      <div class="stat-value">${fmtCount(activeBids)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Removed bids</div>
      <div class="stat-value">${fmtCount(removedBids)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Highest active bid</div>
      <div class="stat-value">${fmtUsd(highestActive)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Highest ever seen</div>
      <div class="stat-value">${fmtUsd(highestEver)}</div>
    </div>
  `;
  currentSection.hidden = false;
}

function buildChartPointsFromBids(bids, listing) {
  if (!bids || bids.length === 0) return [];
  const events = [];
  for (const bid of bids) {
    events.push({ time: new Date(bid.bidTime).getTime(), type: 'place', bid });
    if (bid.removedAt) {
      events.push({ time: new Date(bid.removedAt).getTime(), type: 'remove', bid });
    }
  }
  events.sort((a, b) => a.time - b.time);

  const active = new Map();
  const points = [];
  for (const event of events) {
    const key = `${event.bid.bidder}|${event.bid.bidTime}`;
    if (event.type === 'place') {
      active.set(key, event.bid.bidAmountUsd);
    } else {
      active.delete(key);
    }
    const amounts = Array.from(active.values());
    const price = amounts.length > 0 ? Math.max(...amounts) : 0;
    points.push({ t: event.time, price, count: active.size });
  }
  if (listing && points.length > 0) {
    const last = points[points.length - 1];
    if (last.price !== listing.currentPriceUsd || last.count !== listing.currentBidCount) {
      points.push({ t: Date.now(), price: listing.currentPriceUsd, count: listing.currentBidCount });
    }
  }
  return points;
}

function renderChart(snapshots, listing, bids) {
  let points = buildChartPointsFromBids(bids, listing);

  if (points.length < 2 && snapshots && snapshots.length > 0) {
    points = snapshots.map((s) => ({
      t: new Date(s.observedAt).getTime(),
      price: Number(s.currentPriceUsd),
      count: Number(s.currentBidCount),
    }));
    const last = points[points.length - 1];
    if (last && (last.price !== listing.currentPriceUsd || last.count !== listing.currentBidCount)) {
      points.push({ t: Date.now(), price: listing.currentPriceUsd, count: listing.currentBidCount });
    }
  }

  if (points.length < 2) {
    chartWrap.innerHTML = '<p style="opacity: 0.6;">Need at least 2 observations to chart.</p>';
    chartSection.hidden = false;
    return;
  }

  const W = chartWrap.clientWidth || 900;
  const H = chartWrap.clientHeight || 260;
  const PAD = { top: 16, right: 48, bottom: 28, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const priceMin = Math.min(...points.map((p) => p.price));
  const priceMax = Math.max(...points.map((p) => p.price));
  const countMin = Math.min(...points.map((p) => p.count));
  const countMax = Math.max(...points.map((p) => p.count));

  const priceRange = priceMax - priceMin || 1;
  const countRange = countMax - countMin || 1;
  const tRange = tMax - tMin || 1;

  const xFor = (t) => PAD.left + ((t - tMin) / tRange) * innerW;
  const yPriceFor = (p) => PAD.top + innerH - ((p - priceMin) / priceRange) * innerH;
  const yCountFor = (c) => PAD.top + innerH - ((c - countMin) / countRange) * innerH;

  const pricePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t)} ${yPriceFor(p.price)}`).join(' ');
  const countPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t)} ${yCountFor(p.count)}`).join(' ');

  const xAxisLabels = [tMin, (tMin + tMax) / 2, tMax].map((t) => {
    const x = xFor(t);
    const label = new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">${escapeHtml(label)}</text>`;
  }).join('');

  const yLeftLabels = [priceMin, (priceMin + priceMax) / 2, priceMax].map((p) => {
    const y = yPriceFor(p);
    return `<text x="${PAD.left - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="#4caf50" opacity="0.85">${fmtUsd(p)}</text>`;
  }).join('');

  const yRightLabels = [countMin, (countMin + countMax) / 2, countMax].map((c) => {
    const y = yCountFor(c);
    return `<text x="${W - PAD.right + 6}" y="${y + 3}" text-anchor="start" font-size="10" fill="#ffb74d" opacity="0.85">${fmtCount(Math.round(c))}</text>`;
  }).join('');

  const dots = points.map((p, i) => `
    <circle class="chart-dot" data-idx="${i}" cx="${xFor(p.t)}" cy="${yPriceFor(p.price)}" r="4" fill="#4caf50" />
  `).join('');

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <rect x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="rgba(255,255,255,0.02)" />
      <path d="${pricePath}" stroke="#4caf50" stroke-width="2" fill="none" />
      <path d="${countPath}" stroke="#ffb74d" stroke-width="1.5" fill="none" stroke-dasharray="4,3" />
      ${dots}
      ${xAxisLabels}
      ${yLeftLabels}
      ${yRightLabels}
    </svg>
  `;

  chartWrap.querySelectorAll('.chart-dot').forEach((dot) => {
    dot.style.cursor = 'pointer';
    dot.addEventListener('click', () => {
      const idx = Number(dot.dataset.idx);
      const p = points[idx];
      chartHelp.textContent = `${fmtTime(new Date(p.t).toISOString())} — ${fmtUsd(p.price)} · ${fmtCount(p.count)} bids`;
    });
  });

  chartSection.hidden = false;
}

function renderBids(bids) {
  bidsSection.hidden = false;
  if (!bids || bids.length === 0) {
    bidsSummary.textContent = '';
    bidsTable.innerHTML = '<p style="opacity: 0.6;">No bid history captured yet. (Requires eBay Trading API to be configured.)</p>';
    return;
  }
  const active = bids.filter((b) => !b.removedAt).length;
  const removed = bids.filter((b) => b.removedAt).length;
  bidsSummary.textContent = `${bids.length} total · ${active} active · ${removed} removed`;

  const sorted = [...bids].sort((a, b) => (a.bidTime < b.bidTime ? 1 : -1));
  let html = '<table><thead><tr><th>Bid time</th><th>Bidder</th><th class="numeric">Amount</th></tr></thead><tbody>';
  for (let i = 0; i < sorted.length; i++) {
    const bid = sorted[i];
    if (bid.removedAt) {
      const noteId = `note-${i}`;
      html += `<tr class="bid-row is-removed has-note" data-note-id="${noteId}">
        <td>${escapeHtml(fmtTime(bid.bidTime))}</td>
        <td>${escapeHtml(bid.bidder || 'unknown')}</td>
        <td class="numeric">${fmtUsd(bid.bidAmountUsd)}</td>
      </tr>
      <tr class="bid-note-row" id="${noteId}">
        <td colspan="3">
          <button type="button" class="bid-note-toggle" data-note-id="${noteId}" aria-expanded="true">▾</button>
          <span class="bid-note">Bid retracted or canceled — no longer counted toward total. Detected ${escapeHtml(fmtTime(bid.removedAt))}.</span>
        </td>
      </tr>`;
    } else {
      html += `<tr class="bid-row">
        <td>${escapeHtml(fmtTime(bid.bidTime))}</td>
        <td>${escapeHtml(bid.bidder || 'unknown')}</td>
        <td class="numeric">${fmtUsd(bid.bidAmountUsd)}</td>
      </tr>`;
    }
  }
  html += '</tbody></table>';
  bidsTable.innerHTML = html;

  bidsTable.querySelectorAll('.bid-note-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.noteId;
      const noteRow = document.getElementById(noteId);
      const note = noteRow?.querySelector('.bid-note');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      btn.textContent = expanded ? '▸' : '▾';
      if (note) note.hidden = expanded;
    });
  });
}

function renderSnapshots(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    snapshotsSection.hidden = true;
    return;
  }
  const sorted = [...snapshots].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));
  let html = '<table><thead><tr><th>Observed at</th><th class="numeric">Price (USD)</th><th class="numeric">Bid count</th><th>End time</th></tr></thead><tbody>';
  for (const snap of sorted) {
    html += `<tr>
      <td>${escapeHtml(fmtTime(snap.observedAt))}</td>
      <td class="numeric">${fmtUsd(snap.currentPriceUsd)}</td>
      <td class="numeric">${fmtCount(snap.currentBidCount)}</td>
      <td>${escapeHtml(fmtTime(snap.endsAt))}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  snapshotsTable.innerHTML = html;
  snapshotsSection.hidden = false;
}

async function load() {
  if (!itemId || !/^[A-Za-z0-9|.-]{1,64}$/.test(itemId)) {
    showError('Missing or invalid item id in URL.');
    return;
  }
  try {
    const response = await fetch(`/api/item?id=${encodeURIComponent(itemId)}`, { cache: 'no-store' });
    if (response.status === 404) {
      showError(`This server has not seen item ${itemId}. It may have ended before we started tracking, or never been listed by the tracked seller.`);
      return;
    }
    if (!response.ok) {
      showError(`Failed to load item (${response.status}).`);
      return;
    }
    const data = await response.json();
    loading.hidden = true;
    renderHeader(data.listing);
    renderCurrentState(data.listing, data.bids);
    renderChart(data.snapshots, data.listing, data.bids);
    renderBids(data.bids);
    renderSnapshots(data.snapshots);
  } catch (err) {
    showError(`Error: ${err.message}`);
  }
}

load();
