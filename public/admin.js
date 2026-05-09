const STORAGE_KEY = 'hchs.admin.token';

const authScreen = document.getElementById('auth-screen');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const tokenInput = document.getElementById('token-input');
const authError = document.getElementById('auth-error');
const errorBanner = document.getElementById('error');
const loading = document.getElementById('loading');
const summary = document.getElementById('summary');
const hourlyChart = document.getElementById('hourly-chart');
const endpointTable = document.getElementById('endpoint-table');
const statusTable = document.getElementById('status-table');
const envFilter = document.getElementById('env-filter');
const windowFilter = document.getElementById('window-filter');
const refreshBtn = document.getElementById('refresh-btn');
const logoutBtn = document.getElementById('logout-btn');

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

async function fetchStats(token) {
  const params = new URLSearchParams();
  const envValue = envFilter.value;
  if (envValue) params.set('environment', envValue);
  params.set('hours', windowFilter.value || '24');

  const response = await fetch(`/api/admin/stats?${params.toString()}`, {
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

function fmt(n) {
  if (n === null || n === undefined) return '0';
  const num = Number(n);
  return num.toLocaleString(undefined, { maximumFractionDigits: num < 10 ? 2 : 0 });
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
    const isDev = row.environment !== 'production' && row.environment !== 'prod';
    const tagClass = isDev ? 'env-tag dev' : 'env-tag';
    card.innerHTML = `
      <h4>Environment <span class="${tagClass}">${escapeHtml(row.environment)}</span></h4>
      <div class="stat-row"><span class="label">Total requests</span><span class="value">${fmt(row.total_requests)}</span></div>
      <div class="stat-row"><span class="label">Approx. unique IPs</span><span class="value">${fmt(row.approx_unique_ips)}</span></div>
      <div class="stat-row"><span class="label">Peak concurrent</span><span class="value">${fmt(row.peak_concurrent)}</span></div>
      <div class="stat-row"><span class="label">Avg concurrent</span><span class="value">${fmt(row.avg_concurrent)}</span></div>
    `;
    summary.appendChild(card);
  }
}

function renderHourlyChart(data) {
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
    const isDev = bucket.environment !== 'production' && bucket.environment !== 'prod';
    bar.className = isDev ? 'hourly-bar dev' : 'hourly-bar';
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
        unique_ips: 0,
      });
    }
    const entry = counts.get(key);
    entry.requests += Number(row.request_count);
    entry.unique_ips += Number(row.unique_ips);
  }

  const sorted = Array.from(counts.values()).sort((a, b) => b.requests - a.requests);

  if (sorted.length === 0) {
    endpointTable.innerHTML = '<p style="opacity: 0.6;">No data.</p>';
    return;
  }

  let html = '<table><thead><tr><th>Endpoint</th><th>Env</th><th class="numeric">Requests</th><th class="numeric">Unique IPs</th></tr></thead><tbody>';
  for (const row of sorted) {
    const isDev = row.environment !== 'production' && row.environment !== 'prod';
    const pillClass = isDev ? 'env-pill dev' : 'env-pill';
    html += `<tr><td>${escapeHtml(row.endpoint)}</td><td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td><td class="numeric">${fmt(row.requests)}</td><td class="numeric">${fmt(row.unique_ips)}</td></tr>`;
  }
  html += '</tbody></table>';
  endpointTable.innerHTML = html;
}

function renderStatusTable(data) {
  const counts = new Map();
  for (const row of data.hourly) {
    const key = `${row.status_code}|${row.environment}`;
    if (!counts.has(key)) {
      counts.set(key, {
        status: row.status_code,
        environment: row.environment,
        requests: 0,
      });
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
    const isDev = row.environment !== 'production' && row.environment !== 'prod';
    const pillClass = isDev ? 'env-pill dev' : 'env-pill';
    html += `<tr><td>${escapeHtml(String(row.status))}</td><td><span class="${pillClass}">${escapeHtml(row.environment)}</span></td><td class="numeric">${fmt(row.requests)}</td></tr>`;
  }
  html += '</tbody></table>';
  statusTable.innerHTML = html;
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    renderHourlyChart(data);
    renderEndpointTable(data);
    renderStatusTable(data);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      errorBanner.textContent = `Error: ${err.message}`;
      errorBanner.hidden = false;
    }
  } finally {
    loading.hidden = true;
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  saveToken(token);
  authError.hidden = true;
  await loadDashboard();
});

refreshBtn.addEventListener('click', () => {
  loadDashboard();
});

logoutBtn.addEventListener('click', () => {
  clearToken();
  showAuthScreen();
});

envFilter.addEventListener('change', loadDashboard);
windowFilter.addEventListener('change', loadDashboard);

loadDashboard();
