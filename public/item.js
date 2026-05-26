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

// Append eBay's no-redirect parameter so ended catalog-linked listings show
// the original page instead of redirecting to "similar items".
function endedEbayUrl(itemWebUrl, itemId) {
  const base = itemWebUrl || ebayItemUrl(itemId);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}nordt=true&orig_cvip=true`;
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

// eBay's bid-increment table (USD). Returns the increment applied when
// raising a current bid to outbid a proxy at the given amount.
// See https://www.ebay.com/help/buying/bidding/automatic-bidding
const EBAY_BID_INCREMENTS = [
  [0, 0.05],
  [0.99, 0.25],
  [4.99, 0.50],
  [24.99, 1.00],
  [99.99, 2.50],
  [249.99, 5.00],
  [499.99, 10.00],
  [999.99, 25.00],
  [2499.99, 50.00],
  [4999.99, 100.00],
];
function ebayBidIncrement(amount) {
  let increment = 0.05;
  for (const [threshold, inc] of EBAY_BID_INCREMENTS) {
    if (amount > threshold) increment = inc;
  }
  return increment;
}

// Reconstruct the auction's visible current price over time from the active
// max-bids in the database. The price displayed on eBay's listing page at
// any moment is determined by the SECOND-highest max bid plus one
// increment, capped at the highest max — NOT the highest max itself
// (which is held in reserve by the proxy bidding system).
//
// Worked example: leader has hidden max $39. Someone bids $11. Visible
// jumps to $11.50 ($11 + 50¢ increment), not to $39. eBay's bid-history
// page emits a "proxy bid" row at that $11.50 amount for the leader; we
// derive the same number ourselves so we don't need to store those rows.
//
// Retracted bids: at the retraction timestamp we remove that bid from the
// pool and recompute. If the retracted bidder was the leader, the visible
// price typically drops to the new second-highest + increment.
function buildChartPointsFromBids(bids, listing) {
  if (!bids || bids.length === 0) return { points: [], maxDots: [], retractionMarkers: [] };

  const events = [];
  for (const bid of bids) {
    events.push({
      time: new Date(bid.bidTime).getTime(),
      type: 'place',
      bidder: bid.bidder,
      amount: bid.bidAmountUsd,
      placedAt: bid.bidTime,
    });
    if (bid.removedAt) {
      events.push({
        time: new Date(bid.removedAt).getTime(),
        type: 'remove',
        bidder: bid.bidder,
        amount: bid.bidAmountUsd,
        placedAt: bid.bidTime,
      });
    }
  }
  events.sort((a, b) => a.time - b.time);

  // Track all currently-active max bids grouped by bidder. A single bidder
  // can have multiple active bids if they raised their max multiple times;
  // their "effective max" is the highest active amount among them.
  const bidderBids = new Map();
  const points = [];
  // Max dots: hollow markers stacked at the current leader's placement
  // timestamp, one per distinct defensive proxy level their max was
  // forced to. Visualizes "how hard this max defended" — a tall stack
  // means many escalations against rising competition; a single dot
  // means immediately outbid. This mirrors what eBay's bid-history page
  // shows publicly (every proxy row is timestamped at the original
  // max-placement time). Dots tied to a specifically-retracted placement
  // get tagged so the renderer can fade them.
  const maxDots = [];
  let lastLeader = null;
  let lastLeaderPlacedAt = null;
  let lastVisible = NaN;

  // Index of bids that ended up retracted, keyed by "<bidder>|<bidTimeISO>"
  // so we can tag any defense dot whose owning placement got pulled.
  const retractedPlacementKeys = new Set();
  for (const bid of bids) {
    if (bid.removedAt) retractedPlacementKeys.add(`${bid.bidder}|${bid.bidTime}`);
  }

  for (const event of events) {
    const list = bidderBids.get(event.bidder) ?? [];
    if (event.type === 'place') {
      list.push({ amount: event.amount, placedAt: event.placedAt });
      bidderBids.set(event.bidder, list);
    } else {
      const idx = list.findIndex((b) => b.amount === event.amount && b.placedAt === event.placedAt);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) bidderBids.delete(event.bidder);
      else bidderBids.set(event.bidder, list);
    }

    let activeCount = 0;
    const maxes = [];
    for (const [bidder, items] of bidderBids) {
      activeCount += items.length;
      const top = items.reduce((acc, b) => (b.amount > acc.amount ? b : acc));
      maxes.push({ bidder, amount: top.amount, placedAt: top.placedAt });
    }
    maxes.sort((a, b) => b.amount - a.amount);

    let visiblePrice = 0;
    let leaderPlacedAt = null;
    if (maxes.length === 1) {
      visiblePrice = maxes[0].amount;
      leaderPlacedAt = maxes[0].placedAt;
    } else if (maxes.length >= 2) {
      const [highest, second] = maxes;
      visiblePrice = Math.min(highest.amount, second.amount + ebayBidIncrement(second.amount));
      leaderPlacedAt = highest.placedAt;
    }

    const leader = maxes[0]?.bidder ?? null;
    if (
      leader &&
      leaderPlacedAt &&
      (leader !== lastLeader ||
        leaderPlacedAt !== lastLeaderPlacedAt ||
        visiblePrice !== lastVisible)
    ) {
      const retracted = retractedPlacementKeys.has(`${leader}|${leaderPlacedAt}`);
      maxDots.push({ t: new Date(leaderPlacedAt).getTime(), price: visiblePrice, retracted });
    }
    lastLeader = leader;
    lastLeaderPlacedAt = leaderPlacedAt;
    lastVisible = visiblePrice;

    points.push({ t: event.time, price: visiblePrice, count: activeCount });
  }

  // Retraction markers: one per retracted bid. The renderer draws a
  // dashed line at the bid's max amount from placement to retraction,
  // a hollow placement circle on the left, and an × on the right.
  // eBay's retraction table publicly discloses the retracted max
  // amount, so showing it at this level reveals nothing extra.
  const retractionMarkers = bids
    .filter((b) => b.removedAt)
    .map((b) => ({
      placedAt: new Date(b.bidTime).getTime(),
      retractedAt: new Date(b.removedAt).getTime(),
      maxAmount: b.bidAmountUsd,
    }));

  // Bridge to live state: if the listing's current price disagrees with our
  // last reconstructed point (e.g. a fresh bid landed between our last
  // import and now), append a "now" point so the chart catches up.
  if (listing && points.length > 0) {
    const last = points[points.length - 1];
    if (last.price !== listing.currentPriceUsd || last.count !== listing.currentBidCount) {
      points.push({ t: Date.now(), price: listing.currentPriceUsd, count: listing.currentBidCount });
    }
  }
  return { points, maxDots, retractionMarkers };
}

let chartState = null;

// Axis scale state, persisted across page loads. Y has two modes (linear ↔
// log); X has three (linear datetime → log from first bid → log to latest
// bid). "Log to latest" stretches the most recent bid events across the
// right half of the chart, which is the killer mode for auctions ending
// in a sniping flurry. Note that "latest bid" is the latest bid IN OUR
// DATA — for a live auction with the scheduled end still in the future,
// this is not the same as the auction's scheduled end timestamp; we use
// the data's tMax so the chart doesn't squash all activity to the left
// edge while waiting out unused future time.
const Y_SCALES = ['linear', 'log'];
const X_SCALES = ['linear', 'log-start', 'log-end'];
// Short directional labels for the in-SVG axis annotations. The arrows
// indicate which end of the time range the log scale stretches.
const X_SCALE_LABELS = {
  linear: 'linear',
  'log-start': 'log →',
  'log-end': '← log',
};
const chartScale = {
  y: Y_SCALES.includes(localStorage.getItem('hchs.chart.yScale'))
    ? localStorage.getItem('hchs.chart.yScale')
    : 'linear',
  x: X_SCALES.includes(localStorage.getItem('hchs.chart.xScale'))
    ? localStorage.getItem('hchs.chart.xScale')
    : 'linear',
};
function persistChartScale(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_e) {
    /* storage disabled — non-fatal */
  }
}
function cycleYScale() {
  const idx = Y_SCALES.indexOf(chartScale.y);
  chartScale.y = Y_SCALES[(idx + 1) % Y_SCALES.length];
  persistChartScale('hchs.chart.yScale', chartScale.y);
  drawChart();
}
function cycleXScale() {
  const idx = X_SCALES.indexOf(chartScale.x);
  chartScale.x = X_SCALES[(idx + 1) % X_SCALES.length];
  persistChartScale('hchs.chart.xScale', chartScale.x);
  drawChart();
}

// Picks an x-axis time step from a fixed ladder so labels stay readable
// regardless of chart width. Targets ~5 labels on narrow screens (mobile),
// ~7 mid-size, ~9 desktop — chosen so adjacent labels never run into each
// other when rendered at the chart's font size. Step is the largest ladder
// value at or below ideal range/targetCount.
function generateTimeLabels(tMin, tMax, chartWidth = 900) {
  const range = tMax - tMin;
  const minuteMs = 60_000;
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;
  const targetCount = chartWidth < 500 ? 5 : chartWidth < 800 ? 7 : 9;
  const ladder = [
    minuteMs, 2 * minuteMs, 5 * minuteMs, 10 * minuteMs, 15 * minuteMs, 30 * minuteMs,
    hourMs, 2 * hourMs, 3 * hourMs, 6 * hourMs, 12 * hourMs,
    dayMs, 2 * dayMs, 3 * dayMs, 7 * dayMs, 14 * dayMs, 30 * dayMs,
  ];
  // Smallest ladder step that fits within the target count. We iterate from
  // finest to coarsest and pick the first that keeps the label count under
  // budget — preferring more detail over less, but never overcrowding.
  let stepMs = ladder[ladder.length - 1];
  for (const s of ladder) {
    if (range / s <= targetCount) {
      stepMs = s;
      break;
    }
  }
  const useDateFormat = stepMs >= 12 * hourMs;

  const start = new Date(tMin);
  if (useDateFormat) {
    start.setHours(0, 0, 0, 0);
    if (start.getTime() < tMin) start.setDate(start.getDate() + 1);
  } else {
    // Round up to next step boundary so labels land on tidy times (e.g.
    // top of the hour for a 1h step, multiples of 5m for a 5m step).
    start.setSeconds(0, 0);
    start.setTime(Math.ceil(start.getTime() / stepMs) * stepMs);
  }

  const labels = [];
  for (let t = start.getTime(); t <= tMax; t += stepMs) {
    const d = new Date(t);
    labels.push({
      t,
      primary: useDateFormat
        ? d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
        : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      secondary: null,
      isDayBoundary: d.getHours() === 0 && d.getMinutes() === 0,
    });
  }
  return labels;
}

// Bin bid-placement timestamps into time buckets sized to the chart's
// pixel width. Targets ~30 bars across the chart (one bar per ~30px),
// snapping the bucket width to a human-readable ladder (5s, 30s, 1m,
// 5m, …) so a bar always represents a sensible chunk of time. Returns
// the chosen bucket width and a sparse list of {t, count} entries for
// non-empty buckets — empty buckets are simply skipped (no bar drawn).
function computeVolumeBuckets(placementTimestamps, tMin, tMax, chartWidth) {
  const range = tMax - tMin;
  if (range <= 0 || placementTimestamps.length === 0) return { bucketMs: 1, buckets: [] };
  const targetBarCount = Math.max(8, Math.min(50, Math.floor(chartWidth / 30)));
  const idealBucketMs = range / targetBarCount;
  const ladder = [
    1000, 5000, 10_000, 30_000,
    60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000,
    24 * 60 * 60_000, 2 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000,
  ];
  let bucketMs = ladder[ladder.length - 1];
  for (const s of ladder) {
    if (s >= idealBucketMs) {
      bucketMs = s;
      break;
    }
  }
  const counts = new Map();
  for (const t of placementTimestamps) {
    const bucketStart = Math.floor((t - tMin) / bucketMs) * bucketMs + tMin;
    counts.set(bucketStart, (counts.get(bucketStart) || 0) + 1);
  }
  const buckets = Array.from(counts.entries())
    .map(([t, count]) => ({ t, count }))
    .sort((a, b) => a.t - b.t);
  return { bucketMs, buckets };
}

// Log-scale x-axis labels: pick durations from a human ladder (1m, 10m,
// 1h, 1d, 1w) that fall inside the chart's time range, plus an explicit
// "start" / "end" anchor at the appropriate boundary. The same ladder
// serves both log-start and log-end modes — the duration values are
// offset from tMin (log-start) or tMax (log-end) when their tick
// positions get computed by the caller's xFor.
function generateLogTimeLabels(tMin, tMax, mode) {
  const range = tMax - tMin;
  const minuteMs = 60_000;
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;
  const ladder = [
    { ms: minuteMs, label: '1m' },
    { ms: 10 * minuteMs, label: '10m' },
    { ms: hourMs, label: '1h' },
    { ms: 6 * hourMs, label: '6h' },
    { ms: dayMs, label: '1d' },
    { ms: 7 * dayMs, label: '1w' },
  ];
  const labels = [];
  for (const tick of ladder) {
    if (tick.ms >= range) break;
    if (mode === 'log-start') {
      labels.push({ t: tMin + tick.ms, primary: tick.label, isDayBoundary: false });
    } else {
      // log-end: time-until-end. Prepend so labels read left-to-right.
      labels.unshift({ t: tMax - tick.ms, primary: tick.label, isDayBoundary: false });
    }
  }
  if (mode === 'log-start') {
    labels.unshift({ t: tMin, primary: 'start', isDayBoundary: false });
  } else {
    labels.push({ t: tMax, primary: 'end', isDayBoundary: false });
  }
  return labels;
}

function renderChart(snapshots, listing, bids) {
  let { points, maxDots, retractionMarkers } = buildChartPointsFromBids(bids, listing);

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
    // No bid-level data → no max dots or retraction markers to draw.
    maxDots = [];
    retractionMarkers = [];
  }

  if (points.length < 2) {
    chartWrap.innerHTML = '<p style="opacity: 0.6;">Need at least 2 observations to chart.</p>';
    chartSection.hidden = false;
    chartState = null;
    return;
  }

  chartState = { points, maxDots, retractionMarkers, listing };
  // Reveal the chart section BEFORE measuring the wrap's width — otherwise
  // chartWrap.clientWidth is 0 (because the parent is hidden) and drawChart
  // falls back to its 900px default, leaving a phantom right margin once
  // the section actually appears. Reading offsetWidth forces a synchronous
  // layout so the subsequent draw sees the real value.
  chartSection.hidden = false;
  void chartWrap.offsetWidth;
  drawChart();
}

function defaultChartHelp(points) {
  const last = points[points.length - 1];
  return `${fmtTime(new Date(last.t).toISOString())} — ${fmtUsd(last.price)} · ${fmtCount(last.count)} bids · Drag along the chart to scrub.`;
}

function drawChart() {
  if (!chartState) return;
  const { points, maxDots = [], retractionMarkers = [], listing } = chartState;
  const W = chartWrap.clientWidth || 900;
  // Bump H + PAD.bottom from the original 280/36 to make room below the
  // x-axis tick labels for the time-mode label without clipping.
  const H = 296;
  const PAD = { top: 16, right: 56, bottom: 52, left: 68 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  // Include maxDots and retraction maxes in the y-axis range so neither
  // a tall defense stack nor a parked-then-pulled max is clipped off.
  const allPrices = [
    ...points.map((p) => p.price),
    ...maxDots.map((d) => d.price),
    ...retractionMarkers.map((r) => r.maxAmount),
  ];
  const priceMin = Math.min(...allPrices);
  const priceMax = Math.max(...allPrices);
  const countMin = Math.min(...points.map((p) => p.count));
  const countMax = Math.max(...points.map((p) => p.count));

  const priceRange = priceMax - priceMin || 1;
  const countRange = countMax - countMin || 1;
  const tRange = tMax - tMin || 1;

  // Y price: linear or log10. Clamp inputs to 0.01 to avoid log(0) when
  // the chart spans values that include or approach zero.
  const LOG_FLOOR = 0.01;
  const logMin = Math.log10(Math.max(LOG_FLOOR, priceMin));
  const logMax = Math.log10(Math.max(LOG_FLOOR, priceMax));
  const logRange = logMax - logMin || 1;

  // X time: linear, log-time-since-start, or log-time-until-end. The
  // "+1" inside log10 keeps the function defined at the endpoint where
  // the elapsed-or-remaining time is zero.
  const logTRange = Math.log10(Math.max(1, tRange + 1));
  const xFor = (() => {
    if (chartScale.x === 'log-start') {
      return (t) => {
        const v = Math.log10(Math.max(1, t - tMin + 1));
        return PAD.left + (v / logTRange) * innerW;
      };
    }
    if (chartScale.x === 'log-end') {
      return (t) => {
        const v = Math.log10(Math.max(1, tMax - t + 1));
        return PAD.left + innerW - (v / logTRange) * innerW;
      };
    }
    return (t) => PAD.left + ((t - tMin) / tRange) * innerW;
  })();
  const yPriceFor = chartScale.y === 'log'
    ? (p) => PAD.top + innerH - ((Math.log10(Math.max(LOG_FLOOR, p)) - logMin) / logRange) * innerH
    : (p) => PAD.top + innerH - ((p - priceMin) / priceRange) * innerH;
  // Bid count occupies only the bottom slice of the chart height so the
  // secondary axis doesn't visually compete with the price line. Without
  // this cap, both series converged in the top-right corner — busy and
  // misleading. 40% leaves the count area as a "shadow" at the bottom
  // while preserving the rising-step signal.
  const COUNT_AXIS_FRACTION = 0.4;
  const countAxisH = innerH * COUNT_AXIS_FRACTION;
  const yCountFor = (c) => PAD.top + innerH - ((c - countMin) / countRange) * countAxisH;

  const pricePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.t).toFixed(1)} ${yPriceFor(p.price).toFixed(1)}`).join(' ');

  // Volume histogram + cumulative line, stock-chart style. Volume bars
  // bin actual bid PLACEMENT events (retractions don't count as new
  // activity) into time buckets sized for the current chart width. Bar
  // heights are scaled within their own bottom-25%-of-chart strip
  // (relative volume comparison only; the right-side count axis labels
  // the cumulative line). Cumulative bid count is rendered as a thin
  // line on top — same step-path shape as before, no area fill.
  const VOLUME_AXIS_FRACTION = 0.25;
  const volumeAxisH = innerH * VOLUME_AXIS_FRACTION;
  const chartBottomY = PAD.top + innerH;
  const placements = bids.map((b) => new Date(b.bidTime).getTime()).filter((t) => t >= tMin && t <= tMax);
  const { bucketMs, buckets } = computeVolumeBuckets(placements, tMin, tMax, innerW);
  const volumeMaxCount = buckets.length === 0 ? 1 : Math.max(1, ...buckets.map((b) => b.count));
  const yVolumeFor = (count) => chartBottomY - (count / volumeMaxCount) * volumeAxisH;
  const volumeBars = buckets.map((b) => {
    const x1 = xFor(b.t);
    const x2 = xFor(b.t + bucketMs);
    const width = Math.max(1, x2 - x1 - 1);
    const y = yVolumeFor(b.count);
    const height = chartBottomY - y;
    return `<rect x="${x1.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="#ffb74d" opacity="0.42" />`;
  }).join('');

  // Cumulative count: step path (no area fill).
  const countLineSegments = [];
  for (let i = 0; i < points.length; i++) {
    const x = xFor(points[i].t).toFixed(1);
    const y = yCountFor(points[i].count).toFixed(1);
    if (i === 0) {
      countLineSegments.push(`M ${x} ${y}`);
    } else {
      const prevY = yCountFor(points[i - 1].count).toFixed(1);
      countLineSegments.push(`L ${x} ${prevY}`, `L ${x} ${y}`);
    }
  }
  const countLinePath = countLineSegments.join(' ');

  const timeLabels = chartScale.x === 'linear'
    ? generateTimeLabels(tMin, tMax, W)
    : generateLogTimeLabels(tMin, tMax, chartScale.x);

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
    return `<text x="${clampedX.toFixed(1)}" y="${H - 28}" text-anchor="middle" font-size="12" font-weight="500" fill="currentColor" opacity="0.85">${escapeHtml(l.primary)}</text>`;
  }).join('');

  // Linear Y ticks: just min/mid/max. Log Y ticks: powers of 10 within
  // range plus the actual max so the top of the data is anchored.
  const yTickValues = (() => {
    if (chartScale.y !== 'log') {
      return [priceMin, priceMin + priceRange / 2, priceMax];
    }
    const ticks = [];
    const lo = Math.floor(Math.log10(Math.max(LOG_FLOOR, priceMin)));
    const hi = Math.ceil(Math.log10(Math.max(LOG_FLOOR, priceMax)));
    for (let exp = lo; exp <= hi; exp++) {
      const v = Math.pow(10, exp);
      if (v >= priceMin * 0.99 && v <= priceMax * 1.01) ticks.push(v);
    }
    if (ticks.length === 0 || ticks[ticks.length - 1] < priceMax * 0.95) {
      ticks.push(priceMax);
    }
    return ticks;
  })();
  const yLeftLabels = yTickValues.map((p) => {
    const y = yPriceFor(p);
    return `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="500" fill="#4caf50" opacity="0.95">${fmtUsd(p)}</text>`;
  }).join('');

  // Y-axis click target + mode badge. Transparent rect catches clicks
  // anywhere in the left label band so any axis label is hittable; the
  // small "linear"/"log" text at the top signals the current mode and
  // hints the band is interactive.
  // Axis-mode labels live next to their respective axes inside the SVG.
  // Each is paired with a transparent click rectangle covering the full
  // margin (left strip for Y, bottom strip for X) so the tap target is
  // forgiving on mobile. The mode-label text uses opacity for "subtle but
  // present"; cursor: pointer signals the band is interactive.
  //
  // Y label is rotated -90° on the far left of the SVG, in the empty
  // column to the left of the dollar tick labels (which sit at
  // x = PAD.left - 8). The rotated text occupies a narrow vertical
  // ribbon centered around x = 12, so there's no overlap with the
  // dollar values regardless of how wide they get.
  const yCenterY = (PAD.top + innerH / 2).toFixed(1);
  const yScaleBadge = `
    <rect class="chart-y-hit" x="0" y="${PAD.top}" width="${PAD.left}" height="${innerH}" fill="transparent" style="cursor: pointer;" />
    <text class="chart-y-mode" x="12" y="${yCenterY}" text-anchor="middle" transform="rotate(-90 12 ${yCenterY})" font-size="11" fill="currentColor" opacity="0.55" style="pointer-events: none;">$: ${chartScale.y}</text>
  `;
  // X label sits below the x-axis tick labels in the extra PAD.bottom
  // we added. Centered horizontally so it feels like a true axis title.
  const xScaleBadge = `
    <rect class="chart-x-hit" x="${PAD.left}" y="${PAD.top + innerH}" width="${innerW}" height="${PAD.bottom}" fill="transparent" style="cursor: pointer;" />
    <text class="chart-x-mode" x="${(PAD.left + innerW / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.55" style="pointer-events: none;">time: ${X_SCALE_LABELS[chartScale.x]}</text>
  `;

  const yRightLabels = [countMin, countMin + countRange / 2, countMax].map((c) => {
    const y = yCountFor(c);
    return `<text x="${W - PAD.right + 8}" y="${(y + 4).toFixed(1)}" text-anchor="start" font-size="12" font-weight="500" fill="#ffb74d" opacity="0.95">${fmtCount(Math.round(c))}</text>`;
  }).join('');

  const dots = points.map((p, i) => `
    <circle class="chart-dot" data-idx="${i}" cx="${xFor(p.t).toFixed(1)}" cy="${yPriceFor(p.price).toFixed(1)}" r="3.5" fill="#4caf50" />
  `).join('');

  // Hollow circles stacked at the bidder's max-placement timestamp,
  // one per proxy-defense level their max was forced to. Drawn BEFORE
  // the solid dots so the solid leader-dot sits on top when they
  // coincide. Retracted dots use a muted gray + lower opacity so they
  // recede visually without disappearing entirely.
  const maxDotMarkers = maxDots.map((d) => {
    if (d.retracted) {
      return `<circle class="chart-max-dot is-retracted" cx="${xFor(d.t).toFixed(1)}" cy="${yPriceFor(d.price).toFixed(1)}" r="2.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.28" pointer-events="none" />`;
    }
    return `<circle class="chart-max-dot" cx="${xFor(d.t).toFixed(1)}" cy="${yPriceFor(d.price).toFixed(1)}" r="2.5" fill="none" stroke="#4caf50" stroke-width="1.2" opacity="0.5" pointer-events="none" />`;
  }).join('');

  // Retraction markers: a hollow placement circle at (placedAt, max), a
  // dashed gray line stretching rightward to the retraction timestamp,
  // and an × at the right endpoint. All in muted "currentColor" so the
  // annotation reads as separate from the active green palette.
  const retractionMarkerSvg = retractionMarkers.map((r) => {
    const x1 = xFor(r.placedAt).toFixed(1);
    const x2 = xFor(r.retractedAt).toFixed(1);
    const y = yPriceFor(r.maxAmount).toFixed(1);
    const xSize = 4; // half-width of the × glyph
    return `
      <circle cx="${x1}" cy="${y}" r="3.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55" pointer-events="none" />
      <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="currentColor" stroke-width="1.1" stroke-dasharray="4,3" opacity="0.4" pointer-events="none" />
      <line x1="${Number(x2) - xSize}" y1="${Number(y) - xSize}" x2="${Number(x2) + xSize}" y2="${Number(y) + xSize}" stroke="currentColor" stroke-width="1.6" opacity="0.65" pointer-events="none" />
      <line x1="${Number(x2) - xSize}" y1="${Number(y) + xSize}" x2="${Number(x2) + xSize}" y2="${Number(y) - xSize}" stroke="currentColor" stroke-width="1.6" opacity="0.65" pointer-events="none" />
    `;
  }).join('');

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <rect x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="rgba(255,255,255,0.02)" />
      ${volumeBars}
      <path d="${countLinePath}" stroke="#ffd54f" stroke-width="1" fill="none" opacity="0.55" />
      ${gridLines}
      ${maxDotMarkers}
      ${retractionMarkerSvg}
      <path d="${pricePath}" stroke="#4caf50" stroke-width="2" fill="none" />
      ${dots}
      <line class="chart-guide" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + innerH}" stroke="#fff" stroke-width="1" stroke-dasharray="3,3" opacity="0" pointer-events="none" />
      <circle class="chart-marker-price" cx="0" cy="0" r="6" fill="#a5e8b6" stroke="#0d1f15" stroke-width="2" opacity="0" pointer-events="none" />
      <circle class="chart-marker-count" cx="0" cy="0" r="5" fill="#ffd54f" stroke="#0d1f15" stroke-width="2" opacity="0" pointer-events="none" />
      <rect class="chart-hit" x="${PAD.left}" y="${PAD.top}" width="${innerW}" height="${innerH}" fill="transparent" />
      ${xAxisLabels}
      ${yLeftLabels}
      ${yRightLabels}
      ${yScaleBadge}
      ${xScaleBadge}
    </svg>
  `;

  const svg = chartWrap.querySelector('svg');
  const guide = svg.querySelector('.chart-guide');
  const markerPrice = svg.querySelector('.chart-marker-price');
  const markerCount = svg.querySelector('.chart-marker-count');
  const hitArea = svg.querySelector('.chart-hit');
  const yHit = svg.querySelector('.chart-y-hit');
  if (yHit) yHit.addEventListener('click', cycleYScale);
  const xHit = svg.querySelector('.chart-x-hit');
  if (xHit) xHit.addEventListener('click', cycleXScale);

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

async function adminRequest(action, extraBody = {}) {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);
  if (!token) {
    adminOutput.hidden = false;
    adminOutput.textContent = 'No admin token. Log in at /admin first.';
    return null;
  }
  adminOutput.hidden = false;
  adminOutput.textContent = `Running ${action}...`;
  try {
    const response = await fetch('/api/admin/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, itemId, ...extraBody }),
    });
    const data = await response.json();
    adminOutput.textContent = JSON.stringify(data, null, 2);
    return data;
  } catch (err) {
    adminOutput.textContent = `Error: ${err.message}`;
    return null;
  }
}

if (inspectBtn) inspectBtn.addEventListener('click', () => adminRequest('inspect_bid_history'));
if (rebackfillBtn) rebackfillBtn.addEventListener('click', () => adminRequest('rebackfill_one'));

const importBtn = document.getElementById('import-btn');
const importHtml = document.getElementById('import-html');
if (importBtn && importHtml) {
  importBtn.addEventListener('click', async () => {
    const html = importHtml.value;
    if (!html || html.trim().length === 0) {
      adminOutput.hidden = false;
      adminOutput.textContent = 'Paste the bid-history HTML before clicking Import.';
      return;
    }
    const result = await adminRequest('import_viewbids_html', { html });
    // On a successful import, refresh the page data so the bid table reflects
    // the newly reconciled rows without a full reload.
    if (result && result.status === 'imported') {
      importHtml.value = '';
      load();
    }
  });
}

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
