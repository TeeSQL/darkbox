import { Deposit, DepositError, getDisplayMessage } from '@swype-org/deposit';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready?: () => void;
        expand?: () => void;
        platform?: string;
        version?: string;
        HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void };
      };
    };
  }
}

const BASE_USDC = {
  chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  bridge: '0x55E84818FCEDc3E892A22b46715Ee2B4A947E138',
};

const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const startButton = document.querySelector<HTMLButtonElement>('#start');
const stopButton = document.querySelector<HTMLButtonElement>('#stop');
const statusEl = document.querySelector<HTMLElement>('#status');
const detailsEl = document.querySelector<HTMLElement>('#details');
const bar = document.querySelector<HTMLElement>('#bar');
const micTab = document.querySelector<HTMLButtonElement>('#mic-tab');
const blinkTab = document.querySelector<HTMLButtonElement>('#blink-tab');
const agentsTab = document.querySelector<HTMLButtonElement>('#agents-tab');
const snapshotTab = document.querySelector<HTMLButtonElement>('#snapshot-tab');
const micPanel = document.querySelector<HTMLElement>('#mic-panel');
const blinkPanel = document.querySelector<HTMLElement>('#blink-panel');
const agentsPanel = document.querySelector<HTMLElement>('#agents-panel');
const snapshotPanel = document.querySelector<HTMLElement>('#snapshot-panel');
const agentFeedStatus = document.querySelector<HTMLElement>('#agent-feed-status');
const agentFeedLiveDot = document.querySelector<HTMLElement>('#agent-feed-live-dot');
const agentFeedStats = document.querySelector<HTMLElement>('#agent-feed-stats');
const agentFeedList = document.querySelector<HTMLElement>('#agent-feed-list');
const agentFeedRefresh = document.querySelector<HTMLButtonElement>('#agent-feed-refresh');
const snapshotStatus = document.querySelector<HTMLElement>('#snapshot-status');
const snapshotLiveDot = document.querySelector<HTMLElement>('#snapshot-live-dot');
const snapshotSummary = document.querySelector<HTMLElement>('#snapshot-summary');
const snapshotMarkets = document.querySelector<HTMLElement>('#snapshot-markets');
const snapshotLeaderboard = document.querySelector<HTMLElement>('#snapshot-leaderboard');
const snapshotRefresh = document.querySelector<HTMLButtonElement>('#snapshot-refresh');
const blinkAmount = document.querySelector<HTMLInputElement>('#blink-amount');
const blinkAddress = document.querySelector<HTMLInputElement>('#blink-address');
const blinkDepositButton = document.querySelector<HTMLButtonElement>('#blink-deposit');
const blinkStatus = document.querySelector<HTMLElement>('#blink-status');

let stream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let raf: number | undefined;

const deposit = new Deposit({
  signer: '/api/blink/sign-payment',
  debug: true,
  enableFullWidget: true,
});

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
  tg?.HapticFeedback?.impactOccurred?.('light');
}

function setDetails(lines: Array<string | undefined>) {
  if (detailsEl) detailsEl.textContent = lines.filter(Boolean).join('\n');
}

function showTab(tab: 'mic' | 'blink' | 'agents' | 'snapshot') {
  micTab?.classList.toggle('active', tab === 'mic');
  blinkTab?.classList.toggle('active', tab === 'blink');
  agentsTab?.classList.toggle('active', tab === 'agents');
  snapshotTab?.classList.toggle('active', tab === 'snapshot');
  micPanel?.classList.toggle('active', tab === 'mic');
  blinkPanel?.classList.toggle('active', tab === 'blink');
  agentsPanel?.classList.toggle('active', tab === 'agents');
  snapshotPanel?.classList.toggle('active', tab === 'snapshot');
  if (tab === 'agents') void loadAgentFeed();
  if (tab === 'snapshot') void loadMarketSnapshot();
}

function stopMic() {
  if (raf) cancelAnimationFrame(raf);
  raf = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  audioContext?.close?.();
  audioContext = undefined;
  if (bar) bar.style.width = '0%';
  if (startButton) startButton.disabled = false;
  if (stopButton) stopButton.disabled = true;
  setStatus('Stopped. Mic tracks released.');
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser does not expose navigator.mediaDevices.getUserMedia.');
    setDetails([
      `User agent: ${navigator.userAgent}`,
      `Telegram platform: ${tg?.platform ?? 'unknown'}`,
    ]);
    return;
  }

  if (startButton) startButton.disabled = true;
  setStatus('Requesting microphone permission…');

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};

    setStatus('Microphone access works. Speak and watch the level move.');
    setDetails([
      `Telegram platform: ${tg?.platform ?? 'unknown'}`,
      `Track label: ${track?.label || 'available, label hidden'}`,
      `Sample rate: ${settings.sampleRate ?? 'unknown'}`,
      `Echo cancellation: ${settings.echoCancellation ?? 'unknown'}`,
    ]);

    if (stopButton) stopButton.disabled = false;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / data.length);
      if (bar) bar.style.width = `${Math.min(100, Math.round(rms * 280))}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (startButton) startButton.disabled = false;
    setStatus(`Microphone request failed: ${err.name}`);
    setDetails([
      err.message,
      `Protocol: ${location.protocol}`,
      `Telegram platform: ${tg?.platform ?? 'unknown'}`,
      `User agent: ${navigator.userAgent}`,
    ]);
  }
}


type AgentFeedTurn = {
  at: string;
  turn: number;
  agentId: string;
  ok: boolean;
  actionTypes: string[];
  billboard?: string | null;
};

type AgentFeed = {
  generatedAt: string;
  runId: string;
  runnerUp: boolean;
  model: string;
  totals: {
    events: number;
    ok: number;
    errors: number;
    actions: Record<string, number>;
  };
  latest: AgentFeedTurn[];
};

type MarketSnapshotMarket = {
  marketId: string;
  question: string;
  status: string;
  closesAt?: string | null;
  updatedAt?: string | null;
  yesShare: number;
  noShare: number;
  volume?: string | null;
  trades?: number | null;
};

type MarketSnapshot = {
  generatedAt: string;
  sourceUpdatedAt?: string | null;
  game?: { title?: string; status?: string; revealStatus?: string } | null;
  activity?: {
    activeMarkets?: number;
    activeAgents?: number;
    totalTrades?: number;
    totalVolume?: string;
    totalDeposits?: string;
  } | null;
  markets: MarketSnapshotMarket[];
  leaderboard: Array<{ rank: number; displayName: string; ensName?: string | null; pnl: string }>;
};

function formatAge(iso: string): string {
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs)) return 'unknown age';
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function shortAgent(agentId: string): string {
  return agentId.replace(/^venice-grok-41-fast-/, '').replace(/^agent-/, 'daemon ');
}

function formatUsd(value: string | number | null | undefined): string {
  const amount = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: amount < 10 ? 2 : 0 }).format(amount);
}

function formatNumber(value: number | string | null | undefined): string {
  const amount = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(amount);
}

function safePercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderMarketSnapshot(snapshot: MarketSnapshot) {
  const generatedAge = formatAge(snapshot.generatedAt);
  const stale = Date.now() - Date.parse(snapshot.generatedAt) > 45_000;
  const title = snapshot.game?.title || 'DarkBox';
  const gameStatus = snapshot.game?.status ? ` · ${snapshot.game.status}` : '';
  snapshotStatus && (snapshotStatus.textContent = `${title}${gameStatus} · updated ${generatedAge}`);
  snapshotLiveDot?.classList.toggle('stale', stale);

  const activity = snapshot.activity ?? {};
  if (snapshotSummary) {
    snapshotSummary.innerHTML = `
      <div class="stat"><span>Markets</span><strong>${formatNumber(activity.activeMarkets ?? snapshot.markets.length)}</strong></div>
      <div class="stat"><span>Trades</span><strong>${formatNumber(activity.totalTrades)}</strong></div>
      <div class="stat"><span>Volume</span><strong>${formatUsd(activity.totalVolume)}</strong></div>
      <div class="stat"><span>Agents</span><strong>${formatNumber(activity.activeAgents)}</strong></div>
    `;
  }

  if (snapshotMarkets) {
    snapshotMarkets.textContent = '';
    if (!snapshot.markets.length) {
      snapshotMarkets.textContent = 'No public markets available yet.';
    } else {
      for (const market of snapshot.markets.slice(0, 8)) {
        const yes = safePercent(market.yesShare);
        const no = safePercent(market.noShare);
        const closeText = market.closesAt ? `closes ${formatAge(market.closesAt).replace(' ago', '')}` : 'no close time';
        const article = document.createElement('article');
        article.className = `market-card ${market.status.toLowerCase().includes('active') || market.status.toLowerCase().includes('open') ? 'active' : ''}`;
        article.innerHTML = `
          <p class="market-question"></p>
          <div class="market-meta">
            <span class="market-pill">${market.status || 'unknown'}</span>
            <span class="market-pill">${closeText}</span>
            <span class="market-pill">${formatUsd(market.volume)} vol</span>
            <span class="market-pill">${formatNumber(market.trades)} trades</span>
          </div>
          <div class="market-bars">
            <div class="market-bar-line"><span>YES</span><div class="market-bar-track"><div class="market-bar-fill" style="width:${yes}%"></div></div><strong>${yes}%</strong></div>
            <div class="market-bar-line"><span>NO</span><div class="market-bar-track"><div class="market-bar-fill" style="width:${no}%"></div></div><strong>${no}%</strong></div>
          </div>
        `;
        article.querySelector('.market-question')!.textContent = market.question;
        snapshotMarkets.append(article);
      }
    }
  }

  if (snapshotLeaderboard) {
    snapshotLeaderboard.textContent = '';
    if (!snapshot.leaderboard.length) {
      snapshotLeaderboard.textContent = 'No public leaderboard entries yet.';
    } else {
      for (const entry of snapshot.leaderboard.slice(0, 5)) {
        const pnl = Number(entry.pnl);
        const row = document.createElement('div');
        row.className = 'leaderboard-row';
        row.innerHTML = `
          <span class="leaderboard-rank">${entry.rank}</span>
          <span class="leaderboard-name"></span>
          <strong class="leaderboard-pnl ${pnl >= 0 ? 'positive' : 'negative'}">${formatUsd(entry.pnl)}</strong>
        `;
        row.querySelector('.leaderboard-name')!.textContent = entry.ensName || entry.displayName;
        snapshotLeaderboard.append(row);
      }
    }
  }
}

function renderAgentFeed(feed: AgentFeed) {
  const generatedAge = formatAge(feed.generatedAt);
  const stale = Date.now() - Date.parse(feed.generatedAt) > 45_000;
  agentFeedStatus && (agentFeedStatus.textContent = `${feed.runnerUp ? 'Runner live' : 'Runner down'} · ${feed.model} · updated ${generatedAge}`);
  agentFeedLiveDot?.classList.toggle('stale', stale || !feed.runnerUp);

  if (agentFeedStats) {
    const actionSummary = Object.entries(feed.totals.actions ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name.replace('_', ' ')} ×${count}`)
      .join(', ') || 'none';
    agentFeedStats.innerHTML = `
      <div class="stat"><span>Run</span><strong>${feed.runId || '—'}</strong></div>
      <div class="stat"><span>Turns</span><strong>${feed.totals.ok}/${feed.totals.events} ok</strong></div>
      <div class="stat"><span>Actions</span><strong>${actionSummary}</strong></div>
    `;
  }

  if (!agentFeedList) return;
  agentFeedList.textContent = '';
  if (!feed.latest.length) {
    agentFeedList.textContent = 'No agent turns yet.';
    return;
  }

  for (const turn of feed.latest.slice().reverse()) {
    const row = document.createElement('article');
    row.className = `feed-item ${turn.ok ? '' : 'error'}`;

    const meta = document.createElement('div');
    meta.className = 'feed-meta';
    meta.textContent = `turn ${turn.turn} · ${shortAgent(turn.agentId)} · ${new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

    const action = document.createElement('div');
    action.className = 'feed-action';
    action.textContent = `${turn.ok ? '✓' : '×'} ${turn.actionTypes.map((item) => item.replace('_', ' ')).join(', ') || 'no action'}`;

    row.append(meta, action);
    if (turn.billboard) {
      const billboard = document.createElement('blockquote');
      billboard.textContent = turn.billboard;
      row.append(billboard);
    }
    agentFeedList.append(row);
  }
}

async function loadAgentFeed() {
  try {
    const response = await fetch(`/agent-feed.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`feed returned ${response.status}`);
    renderAgentFeed((await response.json()) as AgentFeed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentFeedStatus && (agentFeedStatus.textContent = `Feed unavailable: ${message}`);
    agentFeedLiveDot?.classList.add('stale');
  }
}

async function loadMarketSnapshot() {
  try {
    const response = await fetch(`/api/market-snapshot?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`snapshot returned ${response.status}`);
    renderMarketSnapshot((await response.json()) as MarketSnapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snapshotStatus && (snapshotStatus.textContent = `Snapshot unavailable: ${message}`);
    snapshotLiveDot?.classList.add('stale');
  }
}

async function requestBlinkDeposit() {
  const amount = Number(blinkAmount?.value ?? '0');
  const address = blinkAddress?.value.trim() ?? '';

  if (!Number.isFinite(amount) || amount <= 0) {
    if (blinkStatus) blinkStatus.textContent = 'Enter a positive amount.';
    return;
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    if (blinkStatus) blinkStatus.textContent = 'Enter a valid EVM destination wallet address.';
    return;
  }

  if (blinkDepositButton) blinkDepositButton.disabled = true;
  if (blinkStatus) blinkStatus.textContent = 'Opening Blink deposit flow…';

  try {
    const result = await deposit.requestDeposit({
      amount,
      chainId: BASE_USDC.chainId,
      address,
      token: BASE_USDC.token,
      callbackScheme: null,
      reference: `darkbox-${Date.now()}`,
      metadata: {
        surface: 'telegram-miniapp',
        experiment: 'blink-deposit',
      },
    });
    if (blinkStatus) {
      blinkStatus.textContent = `Blink transfer complete: ${result.transfer.id} (${result.transfer.status})`;
    }
  } catch (error) {
    const message = error instanceof DepositError ? getDisplayMessage(error) : error instanceof Error ? error.message : String(error);
    if (blinkStatus) blinkStatus.textContent = `Blink deposit failed: ${message}`;
  } finally {
    if (blinkDepositButton) blinkDepositButton.disabled = false;
  }
}

micTab?.addEventListener('click', () => showTab('mic'));
blinkTab?.addEventListener('click', () => showTab('blink'));
agentsTab?.addEventListener('click', () => showTab('agents'));
snapshotTab?.addEventListener('click', () => showTab('snapshot'));
agentFeedRefresh?.addEventListener('click', () => loadAgentFeed());
snapshotRefresh?.addEventListener('click', () => loadMarketSnapshot());
setInterval(loadAgentFeed, 10_000);
setInterval(loadMarketSnapshot, 10_000);
void loadAgentFeed();
void loadMarketSnapshot();
startButton?.addEventListener('click', startMic);
stopButton?.addEventListener('click', stopMic);
blinkDepositButton?.addEventListener('click', requestBlinkDeposit);
window.addEventListener('pagehide', () => {
  stopMic();
  deposit.destroy();
});

if (blinkAddress) blinkAddress.value = BASE_USDC.bridge;

setDetails([
  `Protocol: ${location.protocol}`,
  `Telegram platform: ${tg?.platform ?? 'unknown'}`,
  `WebApp version: ${tg?.version ?? 'not in Telegram'}`,
]);
