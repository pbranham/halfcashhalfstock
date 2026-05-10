const STORAGE_KEY = 'hchs.admin.token';
const REFRESH_INTERVAL_MS = 30_000;
const LIVE_REFRESH_INTERVAL_MS = 5_000;

const authScreen = document.getElementById('auth-screen');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const tokenInput = document.getElementById('token-input');
const authError = document.getElementById('auth-error');
const errorBanner = document.getElementById('error');
const loading = document.getElementById('loading');
const summary = document.getElementById('summary');
const sessionsTable = document.getElementById('sessions-table');
const hourlyChart = document.getElementById('hourly-chart');
const hourlyTitle = document.getElementById('hourly-title');
const endpointTable = document.getElementById('endpoint-table');
const statusTable = document.getElementById('status-table');
const uaTable = document.getElementById('ua-table');
const liveGrid = document.getElementById('live-grid');
const liveUpdated = document.getElementById('live-updated');
const envFilter = document.getElementById('env-filter');
const windowFilter = document.getElementById('window-filter');
const refreshBtn = document.getElementById('refresh-btn');
const logoutBtn = document.getElementById('logout-btn');
const autoRefreshToggle = document.getElementById('auto-refresh');

let dashboardRefreshTimer = null;
let liveRefreshTimer = null;

function getToken() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

function saveToken(token) {
  localStorage.setItem(STORAGE_KEY, token);
}

function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

function showAuthScreen(message) {
  authScreen.hidden = false;
  dashboard.hidden = true;
  stopAutoRefresh();
  if (message) {
    authError.textContent = message;
    authError.hidden = false;
  } else {
    authError.hidden = true;
  }
}

function showDashboard() {
  authScreen.hidden = true;
  dashboard.hidden = false;
}

async function apiFetch(path, token) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    clearToken();
    showAuthScreen('Invalid token. Try again.');
    throw new Error('unauthorized');
  }
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchStats(token) {
  const params = new URLSearchParams();
  const envValue = envFilter.value;
  if (envValue) params.set('environment', envValue);
  params.set('hours', windowFilter.value || '24');
  return apiFetch(`/api/admin/stats?${params.toString()}`, token);
}

async function fetchLive(token) {
  return apiFetch('/api/admin/live', token);
}

function fmt(n) {
  if (n === null || n === undefined) return '0';
  const num = Number(n);
  return num.toLocaleString(undefined, { maximumFractionDigits: num < 10 ? 2 : 0 });
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isDevEnv(env) {
  return env !== 'production' && env !== 'prod';
}

function renderLive(data) {
  const ua = data.uaBreakdownLast5Min || { bot: 0, mobile: 0, desktop: 0, other: 0 };
  const totalUa = ua.bot + ua.mobile + ua.desktop + ua.other;
  const pct = (n) => (totalUa > 0 ? (n / totalUa) * 100 : 0);

  liveGrid.innerHTML = `
    <div class="live-stat">
      <div class="live-value">${fmt(data.currentConcurrent)}</div>
      <div class="live-label">Concurrent now</div>
    </div>
    <div class="live-stat">
      <div class="live-value">${fmt(data.activeSessionCount)}</div>
      <div class="live-label">Active sessions</div>
    </div>
    <div class="live-stat">
      <div class="live-value">${fmt(data.requestsLast1Min)}</div>
      <div class="live-label">Requests / min</div>
    </div>
    <div class="live-stat">
      <div class="live-value">${fmt(data.requestsLast5Min)}</div>
      <div class="live-label">Requests / 5 min</div>
    </div>
    <div class="live-stat">
      <div class="live-value">${fmt(data.uniqueIpsLast5Min)}</div>
      <div class="live-label">Unique IPs / 5 min</div>
    </div>
    <div class="live-stat">
      <div class="live-label" style="margin-bottom: 0.4rem;">Client types (5 min)</div>
      <div class="live-ua-bar">
        <div class="live-ua-segment desktop" style="width: ${pct(ua.desktop)}%"></div>
        <div class="live-ua-segment mobile" style="width: ${pct(ua.mobile)}%"></div>
        <div class="live-ua-segment bot" style="width: ${pct(ua.bot)}%"></div>
        <div class="live-ua-segment other" style="width: ${pct(ua.other)}%"></div>
      </div>
      <div class="live-ua-legend">
        <span><span class="swatch" style="background:#388e3c"></span>Desktop ${fmt(ua.desktop)}</span>
        <span><span class="swatch" style="background:#1976d2"></span>Mobile ${fmt(ua.mobile)}</span>
        <span><span class="swatch" style="background:#d32f2f"></span>Bot ${fmt(ua.bot)}</span>
        <span><span class="swatch" style="background:#757575"></span>Other ${fmt(ua.other)}</span>
      </div>
    </div>
  `;
  const time = new Date(data.asOf || Date.now()).toLocaleTimeString();
  liveUpdated.textContent = `· updated ${time}`;
}

function renderSummary(data) {
  summary.innerHTML = '';
  if (!data.summary || data.summary.length === 0) {
    summary.innerHTML = '<div class="summary-card"><p>No data yet for this window.</p></div>';
    return;
  }
  for (const row of data.summary) {
    const card = document.createElement('div');
    card.className = 'summary-card';
    const tagClass = isDevEnv(row.environment) ? 'env-tag dev' : 'env-tag';
    const total = (row.bot_count || 0) + (row.mobile_count || 0) + (row.desktop_count || 0) + (row.other_count || 0);
    const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
    card.innerHTML = `
      <h4>Environment <span class="${tagClass}">${escapeHtml(row.environment)}</span></h4>
      <div class="stat-row"><span class="label">Total requests</span><span class="value">${fmt(row.total_requests)}</span></div>
      <div class="stat-row"><span class="label">Unique visitors</span><span class="value">${fmt(row.unique_ips)}</span></div>
      <div class="stat-row"><span class="label">Peak concurrent</span><span class="value">${fmt(row.peak_concurrent)}</span></div>
      <div class="stat-row"><span class="label">Avg concurrent</span><span class="value">${fmt(row.avg_concurrent)}</span></div>
      <div class="stat-row"><span class="label">Desktop / Mobile / Bot</span><span class="value">${pct(row.desktop_count)}% / ${pct(row.mobile_count)}% / ${pct(row.bot_count)}%</span></div>
    `;
    summary.appendChild(card);
  }
}

function renderSessions(data) {
  if (!data.sessions || data.sessions.length === 0) {
    sessionsTable.innerHTML = '<p style="opacity: 0.6;">No session data yet.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Env</th><th class="numeric">Sessions</th><th class="numeric">Avg duration</th><th class="numeric">Avg requests</th><th class="numeric">Bounce rate</th></tr></thead><tbody>';
  for (const row of data.sessions) {
    const pillClass = isDevEnv(row.environment) ? 'env-pill dev' : 'env-pill';
    const bounceRate = row.total_sessions > 0
      ? Math.round((row.bounce_count / row.total_sessions) * 100)
      : 0;
    html += `<tr>
      <td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td>
      <td class="numeric">${fmt(row.total_sessions)}</td>
      <td class="numeric">${fmtDuration(Number(row.avg_duration_seconds))}</td>
      <td class="numeric">${fmt(row.avg_requests_per_session)}</td>
      <td class="numeric">${bounceRate}%</td>
    </tr>`;
  }
  html += '</tbody></table>';
  sessionsTable.innerHTML = html;
}

function renderHourlyChart(data) {
  const intervalLabel = data.interval === 'day'
    ? 'Requests by day'
    : data.interval === '5min'
    ? 'Requests by 5-minute bucket'
    : 'Requests by hour';
  hourlyTitle.textContent = intervalLabel;
  hourlyChart.innerHTML = '';
  if (!data.hourly || data.hourly.length === 0) {
    hourlyChart.innerHTML = '<p style="opacity: 0.6;">No requests in this window.</p>';
    return;
  }

  const buckets = new Map();
  for (const row of data.hourly) {
    const key = `${row.hour}|${row.environment}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        hour: row.hour,
        environment: row.environment,
        count: 0,
      });
    }
    buckets.get(key).count += Number(row.request_count);
  }

  const sorted = Array.from(buckets.values()).sort((a, b) =>
    a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0,
  );
  const maxCount = Math.max(...sorted.map((b) => b.count), 1);

  for (const bucket of sorted) {
    const bar = document.createElement('div');
    bar.className = isDevEnv(bucket.environment) ? 'hourly-bar dev' : 'hourly-bar';
    const heightPct = Math.max(2, (bucket.count / maxCount) * 100);
    bar.style.height = `${heightPct}%`;
    const date = new Date(bucket.hour);
    const label = `${date.toLocaleString()} — ${bucket.environment}: ${bucket.count} req`;
    bar.setAttribute('data-label', label);
    hourlyChart.appendChild(bar);
  }
}

function renderEndpointTable(data) {
  const counts = new Map();
  for (const row of data.hourly) {
    const key = `${row.endpoint}|${row.environment}`;
    if (!counts.has(key)) {
      counts.set(key, {
        endpoint: row.endpoint,
        environment: row.environment,
        requests: 0,
      });
    }
    counts.get(key).requests += Number(row.request_count);
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.requests - a.requests);
  if (sorted.length === 0) {
    endpointTable.innerHTML = '<p style="opacity: 0.6;">No data.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Endpoint</th><th>Env</th><th class="numeric">Requests</th></tr></thead><tbody>';
  for (const row of sorted) {
    const pillClass = isDevEnv(row.environment) ? 'env-pill dev' : 'env-pill';
    html += `<tr><td>${escapeHtml(row.endpoint)}</td><td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td><td class="numeric">${fmt(row.requests)}</td></tr>`;
  }
  html += '</tbody></table>';
  endpointTable.innerHTML = html;
}

function renderStatusTable(data) {
  const counts = new Map();
  for (const row of data.hourly) {
    const key = `${row.status_code}|${row.environment}`;
    if (!counts.has(key)) {
      counts.set(key, { status: row.status_code, environment: row.environment, requests: 0 });
    }
    counts.get(key).requests += Number(row.request_count);
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.requests - a.requests);
  if (sorted.length === 0) {
    statusTable.innerHTML = '<p style="opacity: 0.6;">No data.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Status</th><th>Env</th><th class="numeric">Requests</th></tr></thead><tbody>';
  for (const row of sorted) {
    const pillClass = isDevEnv(row.environment) ? 'env-pill dev' : 'env-pill';
    html += `<tr><td>${escapeHtml(String(row.status))}</td><td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td><td class="numeric">${fmt(row.requests)}</td></tr>`;
  }
  html += '</tbody></table>';
  statusTable.innerHTML = html;
}

function renderUaTable(data) {
  const counts = new Map();
  for (const row of data.hourly) {
    const key = row.environment;
    if (!counts.has(key)) {
      counts.set(key, {
        environment: row.environment,
        bot: 0, mobile: 0, desktop: 0, other: 0, total: 0,
      });
    }
    const entry = counts.get(key);
    entry.bot += Number(row.bot_count) || 0;
    entry.mobile += Number(row.mobile_count) || 0;
    entry.desktop += Number(row.desktop_count) || 0;
    entry.other += Number(row.other_count) || 0;
    entry.total += Number(row.request_count) || 0;
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.total - a.total);
  if (sorted.length === 0) {
    uaTable.innerHTML = '<p style="opacity: 0.6;">No data.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Env</th><th class="numeric">Desktop</th><th class="numeric">Mobile</th><th class="numeric">Bot</th><th class="numeric">Other</th></tr></thead><tbody>';
  for (const row of sorted) {
    const pillClass = isDevEnv(row.environment) ? 'env-pill dev' : 'env-pill';
    html += `<tr>
      <td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td>
      <td class="numeric">${fmt(row.desktop)}</td>
      <td class="numeric">${fmt(row.mobile)}</td>
      <td class="numeric">${fmt(row.bot)}</td>
      <td class="numeric">${fmt(row.other)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  uaTable.innerHTML = html;
}

function populateEnvFilter(data) {
  const current = envFilter.value;
  envFilter.innerHTML = '<option value="">All environments</option>';
  for (const env of data.environments || []) {
    const opt = document.createElement('option');
    opt.value = env;
    opt.textContent = env;
    envFilter.appendChild(opt);
  }
  envFilter.value = current;
}

async function loadDashboard() {
  const token = getToken();
  if (!token) {
    showAuthScreen();
    return;
  }
  loading.hidden = false;
  errorBanner.hidden = true;
  showDashboard();
  try {
    const data = await fetchStats(token);
    populateEnvFilter(data);
    renderSummary(data);
    renderSessions(data);
    renderHourlyChart(data);
    renderEndpointTable(data);
    renderStatusTable(data);
    renderUaTable(data);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      errorBanner.textContent = `Error: ${err.message}`;
      errorBanner.hidden = false;
    }
  } finally {
    loading.hidden = true;
  }
}

async function loadLive() {
  const token = getToken();
  if (!token) return;
  try {
    const data = await fetchLive(token);
    renderLive(data);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      console.error('live fetch failed', err);
    }
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefreshToggle.checked) return;
  dashboardRefreshTimer = setInterval(loadDashboard, REFRESH_INTERVAL_MS);
  liveRefreshTimer = setInterval(loadLive, LIVE_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (dashboardRefreshTimer) {
    clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
  if (liveRefreshTimer) {
    clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  saveToken(token);
  authError.hidden = true;
  await loadDashboard();
  await loadLive();
  startAutoRefresh();
});

refreshBtn.addEventListener('click', () => {
  loadDashboard();
  loadLive();
});

logoutBtn.addEventListener('click', () => {
  clearToken();
  showAuthScreen();
});

envFilter.addEventListener('change', loadDashboard);
windowFilter.addEventListener('change', loadDashboard);
autoRefreshToggle.addEventListener('change', startAutoRefresh);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else if (autoRefreshToggle.checked && !dashboard.hidden) {
    loadDashboard();
    loadLive();
    startAutoRefresh();
  }
});

(async function init() {
  await loadDashboard();
  await loadLive();
  if (!dashboard.hidden) startAutoRefresh();
})();
