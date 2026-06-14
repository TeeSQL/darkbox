const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const endpointGroups = [
  {
    id: 'source-info',
    title: 'Admin source',
    endpoints: [
      { id: 'source-info', label: 'Admin source info', path: '/api/source-info', critical: true },
    ],
  },
  {
    id: 'snapshot',
    title: 'Operator snapshot',
    endpoints: [
      { id: 'snapshot', label: 'Admin market snapshot', path: '/api/market-snapshot', critical: true },
    ],
  },
  {
    id: 'public',
    title: 'Indexer observer',
    endpoints: [
      { id: 'health', label: 'Indexer health', path: '/public/health', critical: true },
      { id: 'game', label: 'Game', path: '/public/game', critical: true },
      { id: 'markets', label: 'Markets', path: '/public/markets', critical: true },
      { id: 'leaderboard', label: 'Leaderboard', path: '/public/leaderboard' },
      { id: 'activity', label: 'Activity', path: '/public/activity' },
      { id: 'timeseries', label: 'Timeseries', path: '/public/timeseries' },
      { id: 'datapoints', label: 'Datapoints', path: '/public/datapoints' },
      { id: 'reveal-status', label: 'Reveal status', path: '/public/reveal/status' },
    ],
  },
  {
    id: 'agent-feed',
    title: 'Agent feed',
    endpoints: [
      { id: 'agent-feed', label: 'Agent feed JSON', path: '/agent-feed.json' },
    ],
  },
  {
    id: 'operator-pending',
    title: 'Privileged controls — pending auth',
    endpoints: [
      { id: 'hidden-orders', label: 'Hidden orders', path: null, pending: 'Needs authenticated operator API before exposing in Mini App.' },
      { id: 'positions', label: 'Positions / balances', path: null, pending: 'Needs authenticated operator API and reveal-safe policy.' },
      { id: 'market-approval', label: 'Market proposal approvals', path: null, pending: 'Backend approval queue route not wired yet.' },
      { id: 'resolution-dossiers', label: 'Resolution dossiers', path: null, pending: 'Resolver route exists in source branches; not exposed on this deployed Mini App yet.' },
      { id: 'agent-control', label: 'Agent pause / resume / cadence', path: null, pending: 'Control actions need explicit auth + confirmation UI.' },
    ],
  },
];
const endpoints = endpointGroups.flatMap((group) => group.endpoints.map((endpoint) => ({ ...endpoint, group: group.id, groupTitle: group.title })));

function $(selector) { return document.querySelector(selector); }
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
function pretty(value) { return JSON.stringify(value, null, 2); }
function compactNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return String(value ?? '0');
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(number) >= 100000 ? 'compact' : 'standard' }).format(number);
}
async function fetchJson(endpoint) {
  if (!endpoint.path) return { endpoint, ok: false, pending: endpoint.pending };
  const started = performance.now();
  try {
    const response = await fetch(endpoint.path, { cache: 'no-store' });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { endpoint, ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), data: json };
  } catch (error) {
    return { endpoint, ok: false, status: 0, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}
function resultSummary(result) {
  if (result.pending) return result.pending;
  if (result.error) return result.error;
  if (!result.ok) return `HTTP ${result.status}`;
  if (Array.isArray(result.data)) return `${result.data.length} rows`;
  if (result.data && typeof result.data === 'object') {
    const keys = Object.keys(result.data);
    return `${keys.length} keys · ${result.ms}ms`;
  }
  return `${result.ms}ms`;
}
function renderJsonBlock(result) {
  const body = result.pending
    ? { pending: result.pending }
    : result.error
      ? { error: result.error, status: result.status }
      : result.data;
  return `
    <article class="raw-block" id="${escapeHtml(result.endpoint.id)}">
      <div class="raw-head">
        <div><span class="k">${escapeHtml(result.endpoint.groupTitle)}</span><h2>${escapeHtml(result.endpoint.label)}</h2><p>${escapeHtml(result.endpoint.path || 'not wired')}</p></div>
        <span class="raw-status ${result.ok ? 'ok' : result.pending ? 'pending' : 'bad'}">${result.ok ? 'ok' : result.pending ? 'pending' : 'error'}</span>
      </div>
      <div class="raw-meta">${escapeHtml(resultSummary(result))}</div>
      <pre>${escapeHtml(pretty(body))}</pre>
    </article>
  `;
}

async function loadOverview() {
  const [snapshot, health, agentFeed] = await Promise.all([
    fetchJson(endpoints.find((endpoint) => endpoint.id === 'snapshot')),
    fetchJson(endpoints.find((endpoint) => endpoint.id === 'health')),
    fetchJson(endpoints.find((endpoint) => endpoint.id === 'agent-feed')),
  ]);
  const snapshotData = snapshot.ok && snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const activity = snapshotData.activity || {};
  const markets = Array.isArray(snapshotData.markets) ? snapshotData.markets : [];
  const game = snapshotData.game || {};
  const feedData = agentFeed.ok && agentFeed.data && typeof agentFeed.data === 'object' ? agentFeed.data : {};

  const healthEl = $('#admin-health');
  if (healthEl) {
    const bits = [
      `<span class="admin-dot ${health.ok ? 'ok' : 'bad'}"></span>${health.ok ? 'indexer online' : 'indexer unavailable'}`,
      `<span>${escapeHtml(snapshot.ok ? 'snapshot online' : 'snapshot unavailable')}</span>`,
      `<span>${escapeHtml(agentFeed.ok ? 'agent feed online' : 'agent feed unavailable')}</span>`,
      `<span>${new Date().toLocaleTimeString()}</span>`,
    ];
    healthEl.innerHTML = bits.join('');
  }
  const set = (selector, value) => { const el = $(selector); if (el) el.textContent = value; };
  set('#admin-game-status', game.status || game.revealStatus || '—');
  set('#admin-game-note', game.title || 'indexer game payload');
  set('#admin-market-count', compactNumber(activity.activeMarkets ?? markets.length));
  set('#admin-market-note', `${markets.length} market payloads loaded`);
  set('#admin-agent-count', compactNumber(activity.activeAgents ?? feedData.agents ?? feedData.agentCount ?? 0));
  set('#admin-agent-note', feedData.runId ? `run ${feedData.runId}` : 'feed summary / operator-safe aggregate');
  set('#admin-trade-count', compactNumber(activity.totalTrades ?? 0));
  set('#admin-trade-note', `volume ${activity.totalVolume ?? '0'}`);

  const marketsEl = $('#admin-markets');
  if (marketsEl) {
    marketsEl.innerHTML = markets.length ? markets.map((market, index) => `
      <div class="admin-row">
        <span class="rank">${index + 1}</span>
        <strong>${escapeHtml(market.question || market.title || market.marketId || 'Untitled market')}</strong>
        <span>${escapeHtml(market.status || 'unknown')}</span>
        <span>${escapeHtml(String(market.trades ?? 0))} trades</span>
      </div>
    `).join('') : '<div class="admin-empty">no markets loaded</div>';
  }

  const feedEl = $('#admin-agent-feed');
  if (feedEl) {
    const recent = Array.isArray(feedData.recent) ? feedData.recent : Array.isArray(feedData.events) ? feedData.events : Array.isArray(feedData.turns) ? feedData.turns : [];
    feedEl.innerHTML = recent.length ? recent.slice(0, 8).map((row, index) => {
      const item = row && typeof row === 'object' ? row : { value: row };
      return `<div class="admin-row"><span class="rank">${index + 1}</span><strong>${escapeHtml(item.agentId || item.agent || item.daemon || item.type || 'event')}</strong><span>${escapeHtml(item.actionType || item.action || item.status || item.result || '—')}</span><span>${escapeHtml(item.at || item.timestamp || item.createdAt || '')}</span></div>`;
    }).join('') : `<div class="admin-empty">${escapeHtml(agentFeed.ok ? 'feed loaded; no recent rows found' : resultSummary(agentFeed))}</div>`;
  }
}

function setupRawPage() {
  const select = $('#raw-endpoint-select');
  const output = $('#raw-data-sections');
  if (!select || !output) return false;
  select.innerHTML = endpoints.map((endpoint) => `<option value="${escapeHtml(endpoint.id)}">${escapeHtml(endpoint.groupTitle)} / ${escapeHtml(endpoint.label)}</option>`).join('');
  const load = async (selectedOnly = false) => {
    const wanted = selectedOnly ? endpoints.filter((endpoint) => endpoint.id === select.value) : endpoints;
    output.innerHTML = '<div class="admin-empty">loading raw payloads…</div>';
    const results = await Promise.all(wanted.map(fetchJson));
    output.innerHTML = results.map(renderJsonBlock).join('');
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' });
  };
  $('[data-load-selected]')?.addEventListener('click', () => load(true));
  $('[data-load-all]')?.addEventListener('click', () => load(false));
  document.querySelectorAll('[data-admin-refresh]').forEach((button) => button.addEventListener('click', () => load(false)));
  const hash = window.location.hash.replace(/^#/, '');
  if (hash && endpoints.some((endpoint) => endpoint.id === hash || endpoint.group === hash)) {
    const endpoint = endpoints.find((item) => item.id === hash) || endpoints.find((item) => item.group === hash);
    if (endpoint) select.value = endpoint.id;
  }
  load(Boolean(hash && endpoints.some((endpoint) => endpoint.id === hash)));
  return true;
}

if (!setupRawPage()) {
  document.querySelectorAll('[data-admin-refresh]').forEach((button) => button.addEventListener('click', loadOverview));
  loadOverview();
  window.setInterval(loadOverview, 15000);
}
