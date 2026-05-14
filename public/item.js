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

function ebayItemUrl(itemId) {
  if (!itemId) return 'https://www.ebay.com/';
  const parts = String(itemId).split('|');
  const legacyNumber = parts.length >= 2 && parts[1] ? parts[1] : itemId;
  return `https://www.ebay.com/itm/${encodeURIComponent(legacyNumber)}`;
}

function endedEbayUrl(itemWebUrl, itemId) {
  const base = itemWebUrl || ebayItemUrl(itemId);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}orig_cvip=true`;
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
  const ebayUrl = listing.endedAt
    ? endedEbayUrl(listing.itemWebUrl, listing.itemId)
    : (listing.itemWebUrl || ebayItemUrl(listing.itemId));
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

let chartState = null;

function generateTimeLabels(tMin, tMax) {
  const range = tMax - tMin;
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;
  const labels = [];

  if (range < hourMs * 12) {
    const stepMs = range < hourMs * 2 ? hourMs / 2 : hourMs;
    const start = new Date(tMin);
    start.setMinutes(0, 0, 0);
    if (start.getTime() < tMin) start.setTime(start.getTime() + stepMs);
    for (let t = start.getTime(); t <= tMax; t += stepMs) {
      const d = new Date(t);
      labels.push({
        t,
        primary: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        secondary: null,
        isDayBoundary: d.getHours() === 0 && d.getMinutes() === 0,
      });
    }
  } else {
    const rangeDays = range / dayMs;
    const stepDays = Math.max(1, Math.ceil(rangeDays / 8));
    const start = new Date(tMin);
    start.setHours(0, 0, 0, 0);
    if (start.getTime() < tMin) start.setDate(start.getDate() + 1);
    for (let t = start.getTime(); t <= tMax; t += stepDays * dayMs) {
      const d = new Date(t);
      labels.push({
        t,
        primary: d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
        secondary: null,
        isDayBoundary: true,
      });
    }
  }
  return labels;
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
    chartState = null;
    return;
  }

  chartState = { points, listing };
  drawChart();
  chartSection.hidden = false;
}

function defaultChartHelp(points) {
  const last = points[points.length - 1];
  return `${fmtTime(new Date(last.t).toISOString())} — ${fmtUsd(last.price)} · ${fmtCount(last.count)} bids · Drag along the chart to scrub.`;
}

function drawChart() {
  if (!chartState) return;
  const { points, listing } = chartState;
  const W = chartWrap.clientWidth || 900;
  const H = 280;
  const PAD = { top: 16, right: 56, bottom: 36, left: 68 };
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

  const pricePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t).toFixed(1)} ${yPriceFor(p.price).toFixed(1)}`).join(' ');
  const countPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t).toFixed(1)} ${yCountFor(p.count).toFixed(1)}`).join(' ');

  const timeLabels = generateTimeLabels(tMin, tMax);

  const gridLines = timeLabels
    .filter((l) => l.t > tMin && l.t < tMax)
    .map((l) => {
      const x = xFor(l.t);
      const stroke = l.isDayBoundary ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
      return `<line x1="${x.toFixed(1)}" y1="${PAD.top}" x2="${x.toFixed(1)}" y2="${PAD.top + innerH}" stroke="${stroke}" stroke-width="1" />`;
    }).join('');

  const xAxisLabels = timeLabels.map((l) => {
    const x = xFor(l.t);
    const clampedX = Math.max(PAD.left + 4, Math.min(W - PAD.right - 4, x));
    return `<text x="${clampedX.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="12" font-weight="500" fill="currentColor" opacity="0.85">${escapeHtml(l.primary)}</text>`;
  }).join('');

  const yLeftLabels = [priceMin, priceMin + priceRange / 2, priceMax].map((p) => {
    const y = yPriceFor(p);
    return `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="500" fill="#4caf50" opacity="0.95">${fmtUsd(p)}</text>`;
  }).join('');

  const yRightLabels = [countMin, countMin + countRange / 2, countMax].map((c) => {
    const y = yCountFor(c);
    return `<text x="${W - PAD.right + 8}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="12" font-weight="500" fill="#ffb74d" opacity="0.95">${fmtCount(Math.round(c))}</text>`;
  }).join('');

  const dots = points.map((p, i) => `
    <circle class="chart-dot" data-idx="${i}" cx="${xFor(p.t).toFixed(1)}" cy="${yPriceFor(p.price).toFixed(1)}" r="3.5" fill="#4caf50" />
  `).join('');

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <rect x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="rgba(255,255,255,0.02)" />
      ${gridLines}
      <path d="${pricePath}" stroke="#4caf50" stroke-width="2" fill="none" />
      <path d="${countPath}" stroke="#ffb74d" stroke-width="1.5" fill="none" stroke-dasharray="4,3" />
      ${dots}
      <line class="chart-guide" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + innerH}" stroke="#fff" stroke-width="1" stroke-dasharray="3,3" opacity="0" pointer-events="none" />
      <circle class="chart-marker-price" cx="0" cy="0" r="6" fill="#a5e8b6" stroke="#0d1f15" stroke-width="2" opacity="0" pointer-events="none" />
      <circle class="chart-marker-count" cx="0" cy="0" r="5" fill="#ffd54f" stroke="#0d1f15" stroke-width="2" opacity="0" pointer-events="none" />
      <rect class="chart-hit" x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="transparent" />
      ${xAxisLabels}
      ${yLeftLabels}
      ${yRightLabels}
    </svg>
  `;

  const svg = chartWrap.querySelector('svg');
  const guide = svg.querySelector('.chart-guide');
  const markerPrice = svg.querySelector('.chart-marker-price');
  const markerCount = svg.querySelector('.chart-marker-count');
  const hitArea = svg.querySelector('.chart-hit');

  const updateFromX = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const svgX = ratio * W;
    let closestIdx = 0;
    let closestDx = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(xFor(points[i].t) - svgX);
      if (dx < closestDx) {
        closestDx = dx;
        closestIdx = i;
      }
    }
    const p = points[closestIdx];
    const px = xFor(p.t);
    guide.setAttribute('x1', px);
    guide.setAttribute('x2', px);
    guide.setAttribute('opacity', '0.6');
    markerPrice.setAttribute('cx', px);
    markerPrice.setAttribute('cy', yPriceFor(p.price));
    markerPrice.setAttribute('opacity', '1');
    markerCount.setAttribute('cx', px);
    markerCount.setAttribute('cy', yCountFor(p.count));
    markerCount.setAttribute('opacity', '1');
    chartHelp.textContent = `${fmtTime(new Date(p.t).toISOString())} — ${fmtUsd(p.price)} · ${fmtCount(p.count)} bids`;
  };

  const resetSelection = () => {
    guide.setAttribute('opacity', '0');
    markerPrice.setAttribute('opacity', '0');
    markerCount.setAttribute('opacity', '0');
    chartHelp.textContent = defaultChartHelp(points);
  };

  hitArea.style.cursor = 'crosshair';
  hitArea.addEventListener('mousemove', (e) => updateFromX(e.clientX));
  hitArea.addEventListener('touchstart', (e) => {
    if (e.touches[0]) {
      updateFromX(e.touches[0].clientX);
      e.preventDefault();
    }
  }, { passive: false });
  hitArea.addEventListener('touchmove', (e) => {
    if (e.touches[0]) {
      updateFromX(e.touches[0].clientX);
      e.preventDefault();
    }
  }, { passive: false });

  chartWrap.querySelectorAll('.chart-dot').forEach((dot) => {
    dot.style.cursor = 'pointer';
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(dot.dataset.idx);
      const p = points[idx];
      const px = xFor(p.t);
      guide.setAttribute('x1', px);
      guide.setAttribute('x2', px);
      guide.setAttribute('opacity', '0.6');
      markerPrice.setAttribute('cx', px);
      markerPrice.setAttribute('cy', yPriceFor(p.price));
      markerPrice.setAttribute('opacity', '1');
      markerCount.setAttribute('cx', px);
      markerCount.setAttribute('cy', yCountFor(p.count));
      markerCount.setAttribute('opacity', '1');
      chartHelp.textContent = `${fmtTime(new Date(p.t).toISOString())} — ${fmtUsd(p.price)} · ${fmtCount(p.count)} bids`;
    });
  });

  chartHelp.textContent = defaultChartHelp(points);

  if (chartState) chartState.resetSelection = resetSelection;
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
      html += `<tr class="bid-row is-removed has-note">
        <td><button type="button" class="bid-note-toggle" data-note-id="${noteId}" aria-expanded="true" aria-label="Toggle removal note">▾</button><span class="bid-strike">${escapeHtml(fmtTime(bid.bidTime))}</span></td>
        <td><span class="bid-strike">${escapeHtml(bid.bidder || 'unknown')}</span></td>
        <td class="numeric"><span class="bid-strike">${fmtUsd(bid.bidAmountUsd)}</span></td>
      </tr>
      <tr class="bid-note-row" id="${noteId}">
        <td colspan="3" class="bid-note-cell">
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
      if (!noteRow) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      btn.textContent = expanded ? '▸' : '▾';
      noteRow.hidden = expanded;
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

const ADMIN_TOKEN_KEY = 'hchs.admin.token';
const adminSection = document.getElementById('admin-section');
const inspectBtn = document.getElementById('inspect-btn');
const rebackfillBtn = document.getElementById('rebackfill-btn');
const adminOutput = document.getElementById('admin-output');

function hasAdminToken() {
  return !!localStorage.getItem(ADMIN_TOKEN_KEY);
}

async function adminRequest(action) {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);
  if (!token) {
    adminOutput.hidden = false;
    adminOutput.textContent = 'No admin token. Log in at /admin first.';
    return;
  }
  adminOutput.hidden = false;
  adminOutput.textContent = `Running ${action}...`;
  try {
    const response = await fetch('/api/admin/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, itemId }),
    });
    const data = await response.json();
    adminOutput.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    adminOutput.textContent = `Error: ${err.message}`;
  }
}

if (inspectBtn) inspectBtn.addEventListener('click', () => adminRequest('inspect_bid_history'));
if (rebackfillBtn) rebackfillBtn.addEventListener('click', () => adminRequest('rebackfill_one'));

function maybeShowAdminSection() {
  if (adminSection && hasAdminToken()) adminSection.hidden = false;
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
    maybeShowAdminSection();
  } catch (err) {
    showError(`Error: ${err.message}`);
  }
}

document.addEventListener('click', (e) => {
  if (chartState && chartState.resetSelection && chartSection && !chartSection.contains(e.target)) {
    chartState.resetSelection();
  }
});

document.addEventListener('touchstart', (e) => {
  const target = e.target;
  if (chartState && chartState.resetSelection && chartSection && target && !chartSection.contains(target)) {
    chartState.resetSelection();
  }
}, { passive: true });

let resizeTimeout = null;
window.addEventListener('resize', () => {
  if (resizeTimeout) clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (chartState) drawChart();
  }, 150);
});

load();
