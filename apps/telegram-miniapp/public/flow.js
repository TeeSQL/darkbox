const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const views = [...document.querySelectorAll('.view')];
const navButtons = [...document.querySelectorAll('[data-go]')];
const input = document.querySelector('#whisper-input');
const voiceButton = document.querySelector('#voice-button');
const voiceStateEl = document.querySelector('#voice-state');
const terminalInput = document.querySelector('#terminal-whisper-input');
const terminalVoiceButton = document.querySelector('#terminal-voice-button');
const terminalVoiceStateEl = document.querySelector('#terminal-voice-state');
const terminalSealButton = document.querySelector('#terminal-seal-whisper');
const terminalWhisperStatus = document.querySelector('#terminal-whisper-status');
const sealWhisperButton = document.querySelector('#seal-whisper');
const whisperStatus = document.querySelector('#whisper-status');
const landingCountdownEl = document.querySelector('#landing-countdown');
const countdownEls = [
  document.querySelector('#whisper-countdown'),
  document.querySelector('#seal-countdown'),
  document.querySelector('#reveal-countdown'),
  document.querySelector('#wait-countdown'),
  document.querySelector('#hall-countdown'),
].filter(Boolean);
const fingerprintEl = document.querySelector('#fingerprint');
const daemonNameEl = document.querySelector('#daemon-name');
const revealDaemonNameEl = document.querySelector('#reveal-daemon-name');
const revealDaemonMetaEl = document.querySelector('#reveal-daemon-meta');
const waitDaemonImageEl = document.querySelector('#daemon-wait-image');
const waitDaemonVideoEl = document.querySelector('#daemon-wait-video');
const daemonBalanceEl = document.querySelector('#daemon-balance');
const daemonPnlEl = document.querySelector('#daemon-pnl');
const daemonPnlNoteEl = document.querySelector('#daemon-pnl-note');
const daemonStatusEl = document.querySelector('#daemon-status');
const daemonMurmurEl = document.querySelector('#daemon-murmur');
const daemonActivityLineEl = document.querySelector('#daemon-activity-line');
const stakeEncourageEl = document.querySelector('#stake-encourage');
const metricVolumeEl = document.querySelector('#metric-volume');
const metricTradesEl = document.querySelector('#metric-trades');
const metricSealedEl = document.querySelector('#metric-sealed');
const metricFingerprintsEl = document.querySelector('#metric-fingerprints');
const leaderboardRowsEl = document.querySelector('#leaderboard-rows');
const marketRowsEl = document.querySelector('#market-rows');
const hallBigWinEl = document.querySelector('#hall-big-win');
const hallNewMarketEl = document.querySelector('#hall-new-market');
const hallNewMarketMetaEl = document.querySelector('#hall-new-market-meta');
const notifyToggle = document.querySelector('#notify-toggle');
const stakeButtons = [...document.querySelectorAll('.chip[data-stake]')];
const chipsEl = document.querySelector('.chips');
const feedCtaEl = document.querySelector('#feed-cta');
const terminalButton = document.querySelector('#sealed-terminal-button');
const terminalModal = document.querySelector('#sealed-terminal-modal');
const terminalLogEl = document.querySelector('#sealed-terminal-log');
const terminalCloseButtons = [...document.querySelectorAll('[data-close-terminal]')];

const RESULTS_AT = new Date('2026-06-15T00:00:00Z');
const SEALED_LOG_KEY = 'daemonhall:sealed-receipts:v1';
const VISUAL_SEED_KEY = 'daemonhall:visual-seed:v1';
const PUBLIC_MARKET_SEED = 'daemonhall:public-markets:v1';
const NOTIFY_PREF_KEY = 'daemonhall:notify-demo:v1';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let listening = false;
let wantedListening = false;
let recognitionBaseText = '';
let recognitionFinalText = '';
let selectedStake = 5;

// ── Live backend wiring ────────────────────────────────────────────────────
// `window.DarkboxGateway` is the shared, tested client (src/gateway-boot.ts),
// pointed same-origin in prod: `/api/*` (authed Telegram initData) and
// `/public/*` both proxy to the gateway TEE, which reaches the CVM indexer over
// the mesh. Every render below falls back to the local hash-mock when a call
// fails, so the hall never breaks if the gateway is briefly unreachable.
const REGISTERED_NAME_KEY = 'daemonhall:registered-name:v1';
const live = {
  self: null,        // SelfStatus — owner/shadow account, balance, lock, registration
  leaderboard: null, // LeaderboardRow[] from /public/leaderboard
  game: null,        // GameStats from /public/game
  activity: null,    // ActivityStats from /public/activity
  markets: null,     // PublicMarket[] from /public/markets
  promoCredit: null, // { currency, amount, type } from claimInvite()
  online: false,     // gateway/public API reachable → live data is authoritative
  claimed: false,    // ran claimInvite() this session
  committed: false,  // sealed a whisper to the mesh this session
};

function gw() {
  return (typeof window !== 'undefined' && window.DarkboxGateway) || null;
}

function persistedRegisteredName() {
  try { return localStorage.getItem(REGISTERED_NAME_KEY) || ''; }
  catch (_) { return ''; }
}

function rememberRegisteredName(name) {
  try { if (name) localStorage.setItem(REGISTERED_NAME_KEY, name); }
  catch (_) {}
}

function myLeaderboardRow() {
  if (!live.leaderboard || !live.self) return null;
  const id = live.self.agentId;
  return live.leaderboard.find((row) => row.agentId && id && row.agentId === id) || null;
}

// The daemon's name as the server knows it. Prefers a server-authored name
// (ensName / agentName / daemonName from self-status — once the gateway returns
// them) then the name the player registered, and finally a STABLE name anchored
// to the server-issued agentId (not the random per-session mock). Returns null
// when unauthenticated so the offline preview keeps its mock name.
function serverDaemonName() {
  const s = live.self;
  if (!s) return null;
  if (s.daemonName) return s.daemonName;
  if (s.ensName) return s.ensName;
  if (s.agentName) return s.agentName;
  const persisted = persistedRegisteredName();
  if (persisted) return persisted;
  if (s.agentId) return pick(names, s.agentId); // deterministic, stable per account
  return null;
}

// Pull the player's account from the gateway and, on first entry, claim the $5
// promo. This is what permanently auths the user and assigns their shadow-chain
// account (idempotent — safe to call every load).
async function refreshSelf() {
  const client = gw();
  if (!client) return;
  try {
    let self = await client.selfStatus();
    // Always claim (idempotent): grants the $5 promo on first entry and, crucially,
    // returns the credit AMOUNT even on repeat visits — self/status only exposes
    // fundingStatus + the (locked, $0) withdrawable, never the promo amount itself.
    try {
      const claim = await client.claimInvite();
      if (claim && claim.agentFundingCredit) {
        live.promoCredit = claim.agentFundingCredit; // { currency, amount, type }
        live.claimed = true;
      }
      self = await client.selfStatus();
    } catch (_) { /* promo closed/frozen, or already settled — keep self as-is */ }
    live.self = self;
    applyReturningState(self);
    renderPrivateState();
    // Returning player (has a registered daemon) → jump straight to the daemon
    // screen if they're still sitting on the landing page.
    if (self && self.registrationStatus === 'registered') {
      markOnboarded();
      const active = document.querySelector('.view.active');
      if (active && active.id === 'v-landing') showView('v-wait');
    }
  } catch (_) {
    // unauthenticated (no initData) or gateway down → keep the mock.
  }
}

// First round → "$5 on the house" (the stake chips). Once the promo's been
// claimed, the house stake is spent: swap the chips for "Feed the daemon", which
// opens the inline Blink deposit popup (window.DarkboxFeed).
function isReturningPlayer(self) {
  return Boolean(self && (self.enteredViaInvite || self.fundingStatus === 'promo_funded'));
}

function applyReturningState(self) {
  const returning = isReturningPlayer(self);
  if (chipsEl) chipsEl.hidden = true; // chips retired; funding is the $5 house + Feed the daemon
  applyFeedGate(); // feed button only for allowlisted/opted-in users
  const promoLine = document.querySelector('#seal-promo-line');
  if (promoLine) {
    promoLine.innerHTML = returning
      ? 'your <strong>$5 is in play</strong> — feed more to go bigger'
      : '<strong>your first $5 is on the house</strong> — free to play';
  }
}

function openFeedDeposit() {
  if (!window.DarkboxFeed) {
    if (stakeSubEl) stakeSubEl.textContent = 'the deposit window failed to load. reload and try again.';
    return;
  }
  window.DarkboxFeed.open({
    onCredited: () => { refreshSelf(); },
  });
}

// ── Returning players skip onboarding (whisper/seal/reveal) → straight to wait
const ONBOARDED_KEY = 'daemonhall:onboarded:v1';
function isOnboarded() {
  try { return localStorage.getItem(ONBOARDED_KEY) === '1'; } catch (_) { return false; }
}
function markOnboarded() {
  try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch (_) {}
}

// ── "Feed the daemon" deposit is gated for the demo: only allowlisted Telegram
// ids, or a device opted in with ?feed=1. Hidden for everyone else.
const FEED_ALLOWLIST = [475212779]; // Telegram numeric user ids allowed to deposit (demo)
function syncFeedFlagFromUrl() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('feed') === '1') localStorage.setItem('daemonhall:feed', '1');
    if (p.get('feed') === '0') localStorage.removeItem('daemonhall:feed');
  } catch (_) {}
}
function isFeedAllowed() {
  try { if (localStorage.getItem('daemonhall:feed') === '1') return true; } catch (_) {}
  const id = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return Boolean(id && FEED_ALLOWLIST.includes(id));
}
function applyFeedGate() {
  if (isFeedAllowed()) {
    if (feedCtaEl) feedCtaEl.hidden = false;
    if (addHeatCard) addHeatCard.hidden = false;
    return;
  }
  // Everyone else: pull the deposit buttons + every "add more funds" reference
  // out of the DOM entirely (not just hidden).
  feedCtaEl?.remove();
  addHeatCard?.remove();
  document.querySelector('#seal-feed-bullet')?.remove();
  const sub = document.querySelector('#stake-sub');
  if (sub) sub.textContent = 'you can change its orders any time.';
}

async function refreshPublic() {
  const client = gw();
  if (!client) return;
  const [leaderboard, game, activity, markets] = await Promise.all([
    client.leaderboard().catch(() => null),
    client.game().catch(() => null),
    client.activity().catch(() => null),
    client.markets().catch(() => null),
  ]);
  // game/activity/markets return null on failure (leaderboard returns [] on
  // failure, so it can't signal reachability). Any non-null ⇒ the gateway is up,
  // and live data — including legitimately EMPTY results — is authoritative.
  const online = game != null || activity != null || markets != null;
  if (online) {
    live.online = true;
    live.leaderboard = Array.isArray(leaderboard) ? leaderboard : [];
    if (game) live.game = game;
    if (activity) live.activity = activity;
    if (markets) live.markets = markets;
  }
  renderPrivateState();
}

// Seal a whisper to the CVM mesh: draft → confirm (commitment hash) → register
// the daemon name. Returns the instruction commitment hash, or null on failure
// (caller keeps the local redacted-receipt UX either way).
async function commitWhisperToMesh(text) {
  const client = gw();
  if (!client || !text) return null;
  try {
    const agentName = selectedDaemon.name || persistedRegisteredName() || 'daemon';
    const result = await client.runJoinFlow({ agentName, whisperText: text });
    live.committed = true;
    rememberRegisteredName(agentName);
    if (result?.after) { live.self = result.after; }
    renderPrivateState();
    return result?.confirmed?.instructionHash || null;
  } catch (_) {
    return null;
  }
}

// Records a deposit intent against the player's account and returns the real
// public bridge-escrow address the transfer should target. This moves NO money
// — it's attribution + the address the funding lab (Blink/Dynamic) deposits to.
// The bridge watcher credits shadow USDC once the on-chain transfer confirms.
const deposit = { intent: null };
async function prepareDeposit(amountUsd) {
  const client = gw();
  if (!client || !(amountUsd > 0)) return null;
  try {
    const intent = await client.createDepositIntent({ amount: String(amountUsd) });
    deposit.intent = intent;
    return intent;
  } catch (_) {
    return null;
  }
}

// ── Funding CTA: deep-link the stake chips to the live funding lab ──────────
const addHeatCard = document.querySelector('#add-heat-card');
const stakeSubEl = document.querySelector('#stake-sub');

function fundingTopUp() {
  // Hosted Blink flow caps test deposits at 25 USDC; clamp the top-up to it.
  return Math.min(Math.max(0, selectedStake - 5), 25);
}

function openFundingLab() {
  const amt = fundingTopUp();
  if (amt <= 0) return;
  // Same-origin: the funding lab routes USDC through the hosted flow into the
  // Base USDC bridge; the watcher credits shadow balance to this Telegram user.
  window.location.href = `/dynamic-flow.html?amount=${amt}`;
}

function syncFundingCta() {
  if (stakeSubEl) {
    stakeSubEl.textContent = isFeedAllowed()
      ? 'you can change its orders and top up any time.'
      : 'you can change its orders any time.';
  }
  if (!addHeatCard || !addHeatCard.isConnected) return;
  const fundable = selectedStake > 5 && Boolean(gw());
  addHeatCard.classList.toggle('fundable', fundable);
  if (fundable) {
    addHeatCard.setAttribute('role', 'button');
    addHeatCard.setAttribute('tabindex', '0');
    addHeatCard.setAttribute('aria-label', `Fund $${fundingTopUp()} to your daemon via the Base bridge`);
  } else {
    addHeatCard.removeAttribute('role');
    addHeatCard.removeAttribute('tabindex');
    addHeatCard.removeAttribute('aria-label');
  }
}

addHeatCard?.addEventListener('click', () => { if (isFeedAllowed()) openFeedDeposit(); });
addHeatCard?.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && isFeedAllowed()) {
    event.preventDefault();
    openFeedDeposit();
  }
});

function bootLive() {
  if (!gw()) return;
  refreshSelf();
  refreshPublic();
  syncFundingCta();
  window.setInterval(refreshPublic, 15000);
}


const daemonImages = [
  '/daemons/murmur-01.webp', '/daemons/sable-02.webp', '/daemons/veil-03.webp', '/daemons/null-04.webp',
  '/daemons/rasp-05.webp', '/daemons/crown-06.webp', '/daemons/gloam-07.webp', '/daemons/wisp-08.webp',
  '/daemons/hex-09.webp', '/daemons/ash-10.webp', '/daemons/nix-11.webp', '/daemons/omen-12.webp',
  '/daemons/rune-13.webp', '/daemons/grin-14.webp', '/daemons/lilt-15.webp', '/daemons/rook-16.webp',
  '/daemons/vesper-17.webp', '/daemons/knell-18.webp', '/daemons/vant-19.webp', '/daemons/thorn-20.webp',
];
const defaultDaemonImage = '/daemons/rasp-05.webp';
const selectedDaemon = { image: defaultDaemonImage, name: 'hopiumd', seed: 'silence:5' };
let dispatchedRevealKey = '';

const names = ['hopiumd', 'fomod', 'rugd', 'greedd', 'panicd', 'copiumd', 'lateforkd', 'doubtd'];
const statuses = ['circling', 'running', 'sleeping', 'listening', 'quiet', 'zombie'];
const murmurs = [
  '▸ a daemon laughed without opening its mouth',
  '▸ something moved behind the wall',
  '▸ the hall counted wrong, then counted again',
  '▸ a sealed instinct learned patience',
  '▸ no one outside saw what changed',
];
const activityLines = [
  'your daemon will keep trading for you until reveal. Trying to answer questions... who will win the hackathon?',
  'it is whisper-quiet here; the hall is not.',
  'inside the dark hall, your daemon is fighting for your PnL.',
  'your daemon can react while your screen is dark.',
];
const marketQuestions = [
  'Will a dark horse win the demo day?',
  'Will the winning team use a TEE?',
  'Will judges reward consumer UX over infra?',
  'Will any agent leak its strategy before reveal?',
  'Will the final market resolve on time?',
  'Will the crowd favorite finish top three?',
  'Will a tiny team beat a funded team?',
];
const stakeEncouragement = {
  5: 'house stake is live. add funds when you want more heat.',
  25: '+$25 gives your daemon more room to move.',
  100: '+$100 makes every public signal feel louder.',
};

function hashNumber(seed) {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pick(list, seed, offset = 0) {
  return list[hashNumber(`${seed}:${offset}`) % list.length];
}

function fingerprint(seed) {
  const a = hashNumber(seed).toString(16).padStart(8, '0');
  const b = hashNumber(`${seed}:seal`).toString(16).padStart(8, '0');
  return `0x${a}...${b.slice(-6)}`;
}

function signedPercent(seed, offset) {
  const raw = hashNumber(`${seed}:pulse:${offset}`) % 3800;
  const value = (raw - 1200) / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatUsdK(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(n < 100 ? 2 : 0)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch]));
}

function readSealedReceipts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEALED_LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeSealedReceipts(receipts) {
  try { localStorage.setItem(SEALED_LOG_KEY, JSON.stringify(receipts.slice(0, 18))); }
  catch (_) {}
}

function rememberSealedReceipt(textOverride) {
  const text = (textOverride ?? input?.value ?? '').trim();
  if (!text) return;
  const seed = `${text}:${selectedStake}`;
  const fp = fingerprint(seed);
  const receipts = readSealedReceipts().filter((row) => row.fingerprint !== fp);
  receipts.unshift({
    fingerprint: fp,
    daemon: selectedDaemon.name,
    stake: selectedStake,
    sealedAt: new Date().toISOString(),
  });
  writeSealedReceipts(receipts);
}

function renderSealedTerminal(animateTop) {
  if (!terminalLogEl) return;
  const receipts = readSealedReceipts();
  if (!receipts.length) {
    terminalLogEl.innerHTML = '<div class="terminal-empty">&gt; no sealed receipts yet. whisper once, then come back.</div>';
    return;
  }
  terminalLogEl.innerHTML = receipts.map((row, index) => {
    const when = row.sealedAt ? new Date(row.sealedAt).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'time sealed';
    return `
      <div class="terminal-line${animateTop && index === 0 ? ' is-new' : ''}">
        <span class="terminal-prompt">${String(index + 1).padStart(2, '0')}&gt;</span>
        <span class="terminal-main">
          ${escapeHtml(row.fingerprint || '0xsealed')} · ${escapeHtml(row.daemon || 'daemon')} · $${escapeHtml(row.stake || 5)}
          <span class="terminal-meta">${escapeHtml(when)} · <span class="terminal-redacted">message redacted forever</span></span>
        </span>
      </div>
    `;
  }).join('');
}

function openSealedTerminal() {
  renderSealedTerminal();
  terminalModal?.removeAttribute('hidden');
  document.body.classList.add('terminal-open');
}

function closeSealedTerminal() {
  terminalModal?.setAttribute('hidden', '');
  document.body.classList.remove('terminal-open');
}

function currentSeed() {
  return `${input?.value.trim() || 'silence'}:${selectedStake}`;
}

function stableVisualSeed() {
  try {
    let seed = sessionStorage.getItem(VISUAL_SEED_KEY);
    if (!seed) {
      seed = `visual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(VISUAL_SEED_KEY, seed);
    }
    return `${seed}:${selectedStake}`;
  } catch (_) {
    return `visual:fallback:${selectedStake}`;
  }
}

function daemonVideoFor(image) {
  return image.replace('/daemons/', '/daemons/videos/').replace(/\.(webp|png|jpe?g)$/i, '.mp4');
}

function setSelectedDaemon({ image, name, seed }) {
  selectedDaemon.image = image;
  selectedDaemon.name = name;
  selectedDaemon.seed = seed;
  if (waitDaemonImageEl) {
    if (waitDaemonImageEl.getAttribute('src') !== selectedDaemon.image) waitDaemonImageEl.src = selectedDaemon.image;
    waitDaemonImageEl.alt = `${selectedDaemon.name} daemon portrait`;
  }
  if (waitDaemonVideoEl) {
    const videoSrc = daemonVideoFor(selectedDaemon.image);
    waitDaemonVideoEl.poster = selectedDaemon.image;
    waitDaemonVideoEl.setAttribute('aria-label', `${selectedDaemon.name} daemon animation`);
    waitDaemonVideoEl.oncanplay = () => {
      waitDaemonVideoEl.hidden = false;
      waitDaemonVideoEl.play().catch(() => {});
    };
    waitDaemonVideoEl.onerror = () => {
      waitDaemonVideoEl.hidden = true;
      waitDaemonVideoEl.removeAttribute('src');
    };
    if (waitDaemonVideoEl.getAttribute('src') !== videoSrc) {
      waitDaemonVideoEl.hidden = true;
      waitDaemonVideoEl.src = videoSrc;
      waitDaemonVideoEl.load();
    }
  }
  const revealKey = `${selectedDaemon.image}|${selectedDaemon.name}|${selectedDaemon.seed}`;
  if (revealKey !== dispatchedRevealKey) {
    dispatchedRevealKey = revealKey;
    window.dispatchEvent(new CustomEvent('daemonhall:reveal', { detail: selectedDaemon }));
  }
}

function renderPrivateState() {
  const instructionSeed = currentSeed();
  const visualSeed = stableVisualSeed();
  const h = hashNumber(visualSeed);
  // Server-anchored daemon name when authed (stable, tied to the account); the
  // random mock name only when there's no gateway (offline / non-Telegram).
  const ownName = serverDaemonName() || pick(names, visualSeed);
  const status = pick(statuses, visualSeed, 2);
  if (fingerprintEl) fingerprintEl.textContent = fingerprint(instructionSeed);
  const daemonImage = pick(daemonImages, visualSeed, 5);
  if (daemonNameEl) daemonNameEl.textContent = ownName;
  if (revealDaemonNameEl) revealDaemonNameEl.textContent = ownName;
  if (revealDaemonMetaEl) revealDaemonMetaEl.textContent = `${status} · ${fingerprint(instructionSeed)}`;
  setSelectedDaemon({ image: daemonImage, name: ownName, seed: visualSeed });
  // Balance + PnL. When authed (real account) BOTH come from the backend — never
  // mix a real balance with a mock PnL. The hash-mock is only for the no-gateway
  // (non-Telegram / offline) preview.
  let balance = selectedStake + (h % 900) / 100;
  let pnl = ((hashNumber(`${visualSeed}:pnl`) % 520) - 140) / 100;
  let pnlNote = pnl >= 0 ? 'unrealized' : 'drawdown';
  if (live.self) {
    // ── Balance: the indexer's holdings when it has a row for this account (the
    // CVM-reported balance), else the $5 promo. Using "indexer when present, else
    // promo" avoids double-counting once the bridge mints the promo on-chain. ──
    let real = 0;
    let known = false;
    const idx = Number(live.self.shadowBalance);
    if (live.self.shadowBalance != null && Number.isFinite(idx) && idx > 0) {
      real = idx; known = true; // indexer is authoritative when it holds a balance
    } else if (live.promoCredit && live.self.fundingStatus === 'promo_funded') {
      const p = Number(live.promoCredit.amount);
      if (Number.isFinite(p)) { real = p; known = true; } // promo (not yet minted to the indexer)
    } else {
      const wb = live.self.withdrawableAvailableBalance;
      if (wb != null && Number.isFinite(Number(wb))) { real = Number(wb); known = true; }
    }
    if (known) balance = real;

    // ── PnL: the indexer's realized PnL → leaderboard row → $0 (untraded). A real
    // account with an untouched $5 must read +$0.00, never a mock number. ──────
    pnl = 0;
    pnlNote = 'no trades yet';
    const rpIdx = Number(live.self.realizedPnl);
    if (live.self.realizedPnl != null && Number.isFinite(rpIdx) && rpIdx !== 0) {
      pnl = rpIdx; pnlNote = rpIdx >= 0 ? 'realized' : 'drawdown';
    } else {
      const liveRow = myLeaderboardRow();
      if (liveRow && liveRow.pnl != null) {
        const rp = Number(liveRow.pnl);
        if (Number.isFinite(rp)) { pnl = rp; pnlNote = rp >= 0 ? 'realized' : 'drawdown'; }
      }
    }
  }
  // Real instruction fingerprint once a whisper is committed to the mesh.
  if (live.self && live.self.instructionCommitmentHash && fingerprintEl) {
    const fh = live.self.instructionCommitmentHash;
    fingerprintEl.textContent = `${fh.slice(0, 8)}...${fh.slice(-6)}`;
  }
  if (daemonBalanceEl) daemonBalanceEl.textContent = `$${balance.toFixed(2)}`;
  if (daemonPnlEl) {
    daemonPnlEl.textContent = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
    daemonPnlEl.classList.toggle('loss', pnl < 0);
  }
  if (daemonPnlNoteEl) daemonPnlNoteEl.textContent = pnlNote;
  if (daemonStatusEl) daemonStatusEl.textContent = status;
  if (daemonMurmurEl) daemonMurmurEl.textContent = pick(murmurs, visualSeed, 3);
  if (daemonActivityLineEl) daemonActivityLineEl.textContent = pick(activityLines, visualSeed, 4);
  if (stakeEncourageEl) stakeEncourageEl.textContent = stakeEncouragement[selectedStake] || 'add funds when you want more heat.';
  // Aggregate tiles: live indexer counters when connected (honest, even at zero),
  // mock only when the public API is unreachable.
  const g = live.game;
  if (live.online) {
    if (metricVolumeEl) metricVolumeEl.textContent = formatUsdK(g ? g.total_volume_usdc : 0);
    if (metricTradesEl) metricTradesEl.textContent = String((g && g.total_trades) ?? 0);
    if (metricSealedEl) metricSealedEl.textContent = String((g && g.active_markets) ?? 0); // MARKETS
    if (metricFingerprintsEl) metricFingerprintsEl.textContent = String((g && g.active_agents) ?? 0); // DAEMONS
  } else {
    if (metricVolumeEl) metricVolumeEl.textContent = `$${(10.2 + (h % 7200) / 1000).toFixed(1)}k`;
    if (metricTradesEl) metricTradesEl.textContent = String(220 + (h % 260));
    if (metricSealedEl) metricSealedEl.textContent = String(6 + (h % 10)); // MARKETS (mock)
    if (metricFingerprintsEl) metricFingerprintsEl.textContent = String(76 + (h % 35)); // DAEMONS (mock)
  }
  renderMarkets(PUBLIC_MARKET_SEED);
  renderLeaderboard(visualSeed, ownName);
}

function renderLiveMarkets() {
  if (!marketRowsEl) return;
  const all = live.markets || [];
  if (!all.length) {
    marketRowsEl.innerHTML = '<div class="market-row empty"><span class="market-q">no markets open yet — the hall is still sealing.</span></div>';
    if (hallNewMarketEl) hallNewMarketEl.textContent = 'awaiting first market';
    if (hallNewMarketMetaEl) hallNewMarketMetaEl.textContent = 'the box is still sealed.';
    return;
  }
  const open = all.filter((m) => (m.status || '').toLowerCase() !== 'resolved');
  const rows = (open.length ? open : all).slice(0, 5);
  const newest = [...all].sort((a, b) => Number(b.created_at_ts || 0) - Number(a.created_at_ts || 0))[0];
  if (hallNewMarketEl && newest) hallNewMarketEl.textContent = newest.question;
  if (hallNewMarketMetaEl && newest) {
    const ageMin = Math.max(0, Math.round((Date.now() / 1000 - Number(newest.created_at_ts || 0)) / 60));
    hallNewMarketMetaEl.textContent = Number.isFinite(ageMin) ? `opened ${ageMin}m ago.` : 'live market.';
  }
  marketRowsEl.innerHTML = rows.map((row, index) => {
    const yes = row.latest_yes_price ?? row.latest_trade_price;
    const priceLabel = yes != null ? `${Math.round(Number(yes) * 100)}¢ yes` : (row.status || 'Active');
    return `
    <div class="market-row">
      <span class="rank">${index + 1}</span>
      <span class="market-q">${escapeHtml(row.question)}${(row.status || '').toLowerCase() === 'active' ? '<span class="market-badge">LIVE</span>' : ''}</span>
      <span class="market-size">${escapeHtml(priceLabel)}</span>
      <span class="market-trades">${escapeHtml(row.status || 'Active')}</span>
    </div>
  `;
  }).join('');
}

function renderMarkets(seed) {
  if (!marketRowsEl) return;
  if (live.online) { renderLiveMarkets(); return; }
  const rows = marketQuestions.map((question, index) => {
    const base = hashNumber(`${seed}:market:${question}`);
    const size = 650 + (base % 5200);
    const trades = 18 + (hashNumber(`${seed}:market:${question}:trades`) % 160);
    const age = 4 + (hashNumber(`${seed}:market:${question}:age`) % 44);
    return { question, size, trades, age, fresh: index > 2 && age < 24, score: size + (age < 12 ? 950 : 0) };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  const newest = rows.slice().sort((a, b) => a.age - b.age)[0];
  if (hallNewMarketEl && newest) hallNewMarketEl.textContent = newest.question;
  if (hallNewMarketMetaEl && newest) hallNewMarketMetaEl.textContent = `opened ${newest.age}m ago.`;
  marketRowsEl.innerHTML = rows.map((row, index) => `
    <div class="market-row">
      <span class="rank">${index + 1}</span>
      <span class="market-q">${escapeHtml(row.question)}${row.fresh ? '<span class="market-badge">NEW</span>' : ''}</span>
      <span class="market-size">$${(row.size / 1000).toFixed(1)}k</span>
      <span class="market-trades">${row.trades} trades</span>
    </div>
  `).join('');
}

function shortAgent(id) {
  if (!id) return 'daemon';
  return id.startsWith('0x') && id.length > 12 ? `${id.slice(2, 8)}` : id;
}

function renderLiveLeaderboard() {
  if (!leaderboardRowsEl) return;
  if (!(live.leaderboard || []).length) {
    leaderboardRowsEl.innerHTML = '<div class="brow empty"><span class="dn">no daemons ranked yet — the board fills as daemons trade.</span></div>';
    if (hallBigWinEl) hallBigWinEl.textContent = 'no moves yet';
    return;
  }
  const myId = live.self && live.self.agentId;
  const rows = (live.leaderboard || []).slice(0, 6).map((row) => {
    const pctRaw = row.pnlPct != null ? Number(row.pnlPct) : null;
    const pulse = pctRaw != null && Number.isFinite(pctRaw)
      ? `${pctRaw >= 0 ? '+' : ''}${pctRaw.toFixed(2)}%`
      : `$${Number(row.pnl || 0).toFixed(2)}`;
    return {
      name: row.ensName || shortAgent(row.agentId),
      pulse,
      rank: row.rank,
      mine: Boolean(myId && row.agentId === myId),
    };
  });
  const winner = rows[0];
  if (hallBigWinEl && winner) hallBigWinEl.textContent = `${winner.name} ${winner.pulse}`;
  leaderboardRowsEl.innerHTML = rows.map((row) => `
    <div class="brow ${row.mine ? 'you' : ''}">
      <span class="rank">${row.rank}</span>
      <span class="dn">${escapeHtml(row.name)}${row.mine ? ' ◂ you' : ''}</span>
      <span class="pulse"><span class="pct">${escapeHtml(row.pulse)}</span></span>
    </div>
  `).join('');
}

function renderLeaderboard(seed, ownName) {
  if (!leaderboardRowsEl) return;
  if (live.online) { renderLiveLeaderboard(); return; }
  const rows = [ownName, ...names.filter((name) => name !== ownName)]
    .slice(0, 6)
    .map((name, index) => ({
      name,
      pulse: signedPercent(`${seed}:${name}`, index),
      status: pick(statuses, `${seed}:${name}`, index),
      score: hashNumber(`${seed}:${name}:rank`),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const winner = rows.find((row) => row.pulse.startsWith('+')) || rows[0];
  if (hallBigWinEl && winner) hallBigWinEl.textContent = `${winner.name} ${winner.pulse}`;
  leaderboardRowsEl.innerHTML = rows.map((row) => `
    <div class="brow ${row.name === ownName ? 'you' : ''}">
      <span class="rank">${row.rank}</span>
      <span class="dn">${row.name}${row.name === ownName ? ' ◂ you' : ''}</span>
      <span class="pulse"><span class="pct">${row.pulse}</span> · ${row.status}</span>
    </div>
  `).join('');
}

function syncNotifyToggle() {
  if (!notifyToggle) return;
  let enabled = true;
  try { enabled = localStorage.getItem(NOTIFY_PREF_KEY) !== '0'; }
  catch (_) {}
  notifyToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  notifyToggle.textContent = enabled ? 'on' : 'off';
}

// ── Whisper intro: a living thread ────────────────────────────────────────
// One line types a sentence, holds, erases it, types the next — like the hall
// thinking out loud — then settles on the ask. The field stays usable the
// whole time. Accent words keep their colour (provably blind = violet,
// confesses = ember).
let convoTyped = false;

const WHISPER_THREAD = [
  [{ t: 'everybody here are ' }, { t: 'provably blind', c: 'c-blind' }, { t: '.' }],
  [{ t: 'daemon', c: 'c-blind' }, { t: ' walks into the hall alone.' }],
  [{ t: 'and on Sunday, 5:00 PM, it ' }, { t: 'confesses', c: 'c-confess' }, { t: '.' }],
];
const WHISPER_FINAL = [{ t: 'whisper your ' }, { t: 'daemon', c: 'c-blind' }, { t: "'s orders." }];

function typeSegments(el, segs, done) {
  el.textContent = '';
  el.classList.add('typing');
  let si = 0;
  let ci = 0;
  let span = null;
  (function step() {
    if (si >= segs.length) { done(); return; }
    const seg = segs[si];
    if (ci === 0) {
      span = document.createElement('span');
      if (seg.c) span.className = seg.c;
      el.appendChild(span);
    }
    const ch = seg.t[ci];
    span.textContent += ch;
    ci += 1;
    if (ci >= seg.t.length) { si += 1; ci = 0; }
    window.setTimeout(step, ch === ' ' ? 95 : 58);
  })();
}

function eraseEl(el, done) {
  el.classList.add('typing');
  (function step() {
    const span = el.lastElementChild;
    if (!span) { el.textContent = ''; done(); return; }
    if (span.textContent.length > 1) span.textContent = span.textContent.slice(0, -1);
    else span.remove();
    window.setTimeout(step, 22);
  })();
}

function typeWhisperConvo() {
  if (convoTyped) return;
  const el = document.querySelector('#whisper-thread');
  if (!el) return;
  convoTyped = true;

  let i = 0;
  function nextTransient() {
    if (i >= WHISPER_THREAD.length) {
      el.className = 'cline';
      typeSegments(el, WHISPER_FINAL, () => el.classList.remove('typing'));
      return;
    }
    el.className = 'cline';
    typeSegments(el, WHISPER_THREAD[i], () => {
      window.setTimeout(() => eraseEl(el, () => { i += 1; nextTransient(); }), 950);
    });
  }
  el.className = 'cline';
  el.textContent = '';
  window.setTimeout(nextTransient, 260);
}

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  renderPrivateState();
  if (id === 'v-wait') markOnboarded(); // reached the daemon screen → onboarded
  if (id === 'v-whisper') {
    window.setTimeout(() => input?.focus({ preventScroll: true }), 80);
    typeWhisperConvo();
  }
  tg?.HapticFeedback?.impactOccurred?.('light');
}

function formatCountdown(ms) {
  if (ms <= 0) return 'BOXES OPEN NOW';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `SEALED · ${hh}:${mm}:${ss}`;
}

function tickCountdown() {
  const text = formatCountdown(RESULTS_AT.getTime() - Date.now());
  countdownEls.forEach((el) => { el.textContent = text; });
  if (landingCountdownEl) landingCountdownEl.textContent = text.replace(/^SEALED · /, '');
}

function autosize() {
  // Composer height is fixed so the mic target never shifts while the user talks/types.
  if (!input) return;
  input.style.height = '';
}

function handleInput() {
  autosize();
  const hasText = Boolean(input?.value.trim());
  if (sealWhisperButton) sealWhisperButton.disabled = !hasText;
  if (whisperStatus) {
    whisperStatus.innerHTML = hasText
      ? 'read it back. you can seal it when it says what you mean.<br /><span class="tell">only your key reveals your private truth.</span>'
      : 'read it back. you can\'t unsay it.<br /><span class="tell">no one else will ever hear this — not the players, not the house.</span>';
  }
  renderPrivateState();
}


function autosizeTerminal() {
  // Keep terminal composer stable too; long messages scroll inside the field.
  if (!terminalInput) return;
  terminalInput.style.height = '';
}

function handleTerminalInput() {
  autosizeTerminal();
  const hasText = Boolean(terminalInput?.value.trim());
  if (terminalSealButton) terminalSealButton.disabled = !hasText;
}

function sealTerminalWhisper() {
  const text = terminalInput?.value.trim();
  if (!text) {
    terminalInput?.focus({ preventScroll: true });
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'the daemon needs an order first.';
    return;
  }
  rememberSealedReceipt(text);
  // Commit the order to the CVM mesh (draft → confirm → register). Non-blocking:
  // the redacted-receipt UX is the same whether or not the gateway is reachable.
  commitWhisperToMesh(text).then((hash) => {
    if (hash && terminalWhisperStatus) {
      terminalWhisperStatus.textContent = 'sealed to the mesh. commitment recorded · message redacted forever.';
    }
  });
  if (terminalInput) terminalInput.value = '';
  handleTerminalInput();
  renderSealedTerminal(true); // slide the new receipt in at the top
  if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'sealed to your existing daemon. message redacted forever.';
}

function hasMicGrantThisSession() {
  try { return sessionStorage.getItem('daemonhall:mic-ok-this-session') === '1'; }
  catch (_) { return false; }
}

function rememberMicGrantThisSession() {
  try { sessionStorage.setItem('daemonhall:mic-ok-this-session', '1'); } catch (_) {}
  window.dispatchEvent(new CustomEvent('daemonhall:mic-granted-this-session'));
}

async function requestMicAccess(allowedText) {
  if (hasMicGrantThisSession()) {
    rememberMicGrantThisSession();
    if (allowedText && whisperStatus) whisperStatus.textContent = allowedText;
    return true;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    if (whisperStatus) whisperStatus.textContent = 'voice unavailable here. type the whisper.';
    return false;
  }
  if (whisperStatus) whisperStatus.textContent = 'asking for microphone access…';
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach((track) => track.stop());
  rememberMicGrantThisSession();
  if (allowedText && whisperStatus) whisperStatus.textContent = allowedText;
  return true;
}

async function requestMicFallback() {
  await requestMicAccess('mic allowed. speech transcription is unavailable here. type the final whisper.');
}

function setMainMicGrantState(allowed = hasMicGrantThisSession()) {
  voiceButton?.classList.remove('listening', 'arming');
  voiceButton?.setAttribute('aria-pressed', 'false');
  if (!voiceStateEl) return;
  voiceStateEl.dataset.state = allowed ? 'mic-allowed' : 'idle';
  voiceStateEl.textContent = allowed ? 'mic allowed' : 'allow mic';
}

function setTerminalVoiceState(state = 'idle') {
  const active = state === 'recording-toggle';
  terminalVoiceButton?.classList.toggle('listening', active);
  terminalVoiceButton?.classList.remove('arming');
  terminalVoiceButton?.setAttribute('aria-pressed', active ? 'true' : 'false');
  terminalVoiceButton?.setAttribute('aria-label', active ? 'Stop terminal recording' : 'Start terminal recording');
  if (terminalVoiceButton) terminalVoiceButton.dataset.recordingMode = state;
  if (terminalVoiceStateEl) {
    terminalVoiceStateEl.dataset.state = state;
    terminalVoiceStateEl.textContent = {
      idle: 'off',
      'recording-toggle': 'recording · click to stop',
      stopping: 'stopping…',
    }[state] || 'off';
  }
  if (terminalWhisperStatus && active) terminalWhisperStatus.textContent = 'recording in private terminal. click mic again to stop.';
}

function setVoiceButtonState(active) {
  setTerminalVoiceState(active ? 'recording-toggle' : 'idle');
}

function ensureRecognition() {
  if (recognition || !SpeechRecognition) return recognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.onstart = () => {
    listening = true;
    setVoiceButtonState(true);
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'recording in private terminal. click mic again to stop.';
  };
  recognition.onerror = () => {
    wantedListening = false;
    listening = false;
    setVoiceButtonState(false);
    setTerminalVoiceState('idle');
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'voice broke. type or try again.';
  };
  recognition.onend = () => {
    listening = false;
    setVoiceButtonState(false);
    if (wantedListening) {
      window.setTimeout(() => {
        if (!wantedListening || listening) return;
        try { recognition.start(); }
        catch (_) { wantedListening = false; handleTerminalInput(); }
      }, 120);
      return;
    }
    handleTerminalInput();
  };
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) recognitionFinalText += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    const spoken = `${recognitionFinalText}${interim}`.trim();
    if (terminalInput) terminalInput.value = [recognitionBaseText, spoken].filter(Boolean).join(recognitionBaseText && spoken ? ' ' : '').trimStart();
    handleTerminalInput();
  };
  return recognition;
}

async function beginVoice() {
  if (!SpeechRecognition) {
    try { await requestMicFallback(); }
    catch (_) { if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'mic denied. type instead.'; }
    return false;
  }
  try {
    const allowed = await requestMicAccess('mic ready. terminal recording starts now.');
    if (!allowed) return false;
  } catch (_) {
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'mic denied. type instead.';
    return false;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) return false;
  recognitionBaseText = terminalInput?.value.trim() || '';
  recognitionFinalText = '';
  wantedListening = true;
  try { recognizer.start(); }
  catch (_) {}
  return true;
}

function stopVoice(statusText = 'recording stopped. review before sealing.') {
  wantedListening = false;
  setTerminalVoiceState('stopping');
  if (terminalWhisperStatus) terminalWhisperStatus.textContent = statusText;
  try { recognition?.stop?.(); }
  catch (_) {}
  if (!listening) setVoiceButtonState(false);
  handleTerminalInput();
}

// Terminal mic: same server-STT path as the main whisper mic, targeting the
// terminal input (Telegram-Android can't run Web Speech → record + /api/stt).
let tsttStream = null;
let tsttRecorder = null;
let tsttChunks = [];
let tsttRecording = false;

async function startTerminalServerStt() {
  try {
    tsttStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'mic denied. type instead.';
    return;
  }
  tsttChunks = [];
  tsttRecording = true;
  setTerminalVoiceState('recording-toggle');
  try {
    tsttRecorder = new MediaRecorder(tsttStream);
  } catch (_) {
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'recording — type to finish.';
    return;
  }
  tsttRecorder.ondataavailable = (e) => { if (e.data && e.data.size) tsttChunks.push(e.data); };
  tsttRecorder.onstop = () => { void transcribeTerminalStt(); };
  try { tsttRecorder.start(); } catch (_) {}
  if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'recording. tap the mic again when you’re done.';
}

function stopTerminalServerStt() {
  tsttRecording = false;
  setTerminalVoiceState('idle');
  try { if (tsttRecorder && tsttRecorder.state !== 'inactive') tsttRecorder.stop(); } catch (_) {}
}

async function transcribeTerminalStt() {
  const stream = tsttStream;
  tsttStream = null;
  const releaseMic = () => { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {} };
  const chunks = tsttChunks;
  tsttChunks = [];
  if (!chunks.length) { releaseMic(); return; }
  const type = (tsttRecorder && tsttRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(chunks, { type });
  releaseMic();
  if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'transcribing…';
  terminalVoiceButton?.classList.add('transcribing');
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': type }, body: blob });
    const j = await res.json().catch(() => ({}));
    const text = (j && typeof j.text === 'string') ? j.text.trim() : '';
    if (text) {
      const base = terminalInput?.value.trim() || '';
      if (terminalInput) terminalInput.value = base ? `${base} ${text}` : text;
      handleTerminalInput();
      if (terminalWhisperStatus) terminalWhisperStatus.textContent = '';
    } else if (terminalWhisperStatus) {
      terminalWhisperStatus.textContent = 'couldn’t make out words — try again or type.';
    }
  } catch (_) {
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'transcription failed — type instead.';
  } finally {
    terminalVoiceButton?.classList.remove('transcribing');
  }
}

async function startVoice(event) {
  event.preventDefault();
  if (USE_SERVER_STT) {
    if (tsttRecording) stopTerminalServerStt();
    else await startTerminalServerStt();
    return;
  }
  if (wantedListening || listening) stopVoice();
  else await beginVoice();
}

async function grantMicForVisuals(event) {
  event?.preventDefault?.();
  // On Telegram-Android we request the mic only when recording actually starts
  // (avoids a redundant permission prompt on screen entry → the "double prompt").
  if (USE_SERVER_STT) return;
  try {
    const allowed = await requestMicAccess('mic allowed. terminal recording stays off until you press its mic.');
    setMainMicGrantState(Boolean(allowed));
    if (whisperStatus && allowed) whisperStatus.textContent = 'keep your voice down. everyone in here does.';
  } catch (_) {
    setMainMicGrantState(false);
    if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.';
  }
}

// ── Main whisper mic: tap-to-toggle + hold-to-talk (web + miniapp) ─────────
// Fast tap  → latch recording on; tap again to stop.
// Press &   → hold-to-talk; recording lasts until release.
//   hold > HOLD_THRESHOLD_MS
const HOLD_THRESHOLD_MS = 1000;
let mainRecognition;
let mainListening = false; // recognizer actually running
let mainWanted = false; // we want it running (drives auto-restart)
let mainBaseText = '';
let mainFinalText = '';
let mainStream = null; // fallback open-mic stream when SpeechRecognition is absent
let mainStarted = false; // SpeechRecognition actually began (vs an instant webview failure)
let mainMode = 'idle'; // 'idle' | 'recording'
let micPressTimer = null;
let micHoldMode = false; // current press has crossed 1s → hold-to-talk (release stops)
let micPressWillStop = false; // this gesture is a tap-to-stop on an active recording
// Telegram's Android webview can't run the Web Speech API, so there we record
// audio and transcribe server-side via /api/stt (Venice stt-xai-v1). iOS/desktop/
// Android-Chrome keep the live SpeechRecognition path (which works there).
const USE_SERVER_STT = Boolean(tg && tg.platform === 'android');
let sttStream = null;
let sttRecorder = null;
let sttChunks = [];

function setMainVoiceState(state) {
  // state: 'idle' | 'recording' | 'hold'
  const active = state !== 'idle';
  voiceButton?.classList.toggle('listening', active);
  voiceButton?.setAttribute('aria-pressed', active ? 'true' : 'false');
  voiceButton?.setAttribute('aria-label', active ? 'Stop recording' : 'Record whisper');
  if (voiceButton) voiceButton.dataset.recordingMode = state;
  if (voiceStateEl) {
    const granted = hasMicGrantThisSession();
    voiceStateEl.dataset.state = active ? 'recording' : granted ? 'mic-allowed' : 'idle';
    voiceStateEl.textContent = {
      idle: granted ? 'mic allowed' : 'allow mic',
      recording: 'recording · tap to stop',
      hold: 'recording · release to stop',
    }[state] || (granted ? 'mic allowed' : 'allow mic');
  }
}

function ensureMainRecognition() {
  if (mainRecognition || !SpeechRecognition) return mainRecognition;
  mainRecognition = new SpeechRecognition();
  mainRecognition.lang = 'en-US';
  mainRecognition.interimResults = true;
  mainRecognition.continuous = true;
  mainRecognition.onstart = () => { mainListening = true; mainStarted = true; };
  mainRecognition.onerror = () => {
    mainListening = false;
    // Android system webviews often expose SpeechRecognition but can't run it
    // (errors like 'service-not-allowed'/'network'/'audio-capture') and fail
    // before ever starting. If it never got going, fall back to the open-mic +
    // type-to-finish path (the same one iOS uses) instead of dying.
    if (!mainStarted && mainWanted && mainMode === 'recording') {
      mainWanted = false;
      void startOpenMicFallback();
      return;
    }
    mainWanted = false;
    mainMode = 'idle';
    setMainVoiceState('idle');
    if (whisperStatus) whisperStatus.textContent = 'voice broke. type or try again.';
  };
  mainRecognition.onend = () => {
    mainListening = false;
    // Only auto-restart a recognizer that actually ran. A webview that ends
    // immediately without ever starting would otherwise loop forever — fall back.
    if (mainWanted && mainStarted) {
      window.setTimeout(() => {
        if (!mainWanted || mainListening) return;
        try { mainRecognition.start(); } catch (_) { mainWanted = false; }
      }, 120);
      return;
    }
    if (mainWanted && !mainStarted && mainMode === 'recording') {
      mainWanted = false;
      void startOpenMicFallback();
      return;
    }
    setMainVoiceState('idle');
  };
  mainRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) mainFinalText += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    const spoken = `${mainFinalText}${interim}`.trim();
    if (input) input.value = [mainBaseText, spoken].filter(Boolean).join(mainBaseText && spoken ? ' ' : '').trimStart();
    handleInput();
  };
  return mainRecognition;
}

// Open an honest open-mic stream and let the user type to finish. This is the
// path iOS Telegram (no SpeechRecognition) uses; Android falls back to it when
// the webview's SpeechRecognition can't actually run.
async function startOpenMicFallback() {
  try {
    mainStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    mainStream = null;
    mainMode = 'idle';
    setMainVoiceState('idle');
    if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.';
    return false;
  }
  rememberMicGrantThisSession();
  setMainMicGrantState(true);
  mainMode = 'recording';
  setMainVoiceState('recording');
  if (whisperStatus) whisperStatus.textContent = 'recording. transcription unavailable here — type to finish.';
  return true;
}

// Telegram-Android: record audio with MediaRecorder and transcribe it
// server-side on stop; the words land in the textarea. Each recording acquires
// its own stream and stops it on finish (reusing a kept-alive stream broke
// recording in the Telegram webview), so the webview re-prompts per recording.
async function startServerStt() {
  try {
    sttStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    sttStream = null;
    mainMode = 'idle';
    setMainVoiceState('idle');
    if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.';
    return false;
  }
  // NB: do NOT call rememberMicGrantThisSession()/setMainMicGrantState() here —
  // the former dispatches an event that wakes the landing + wait mic-reactive
  // visuals (a SECOND getUserMedia → the double permission prompt), and the
  // latter strips the 'listening' class, hiding the recording state.
  sttChunks = [];
  try {
    sttRecorder = new MediaRecorder(sttStream);
  } catch (_) {
    // No MediaRecorder → keep the mic open and let the user type.
    if (whisperStatus) whisperStatus.textContent = 'recording. transcription unavailable here — type to finish.';
    return true;
  }
  sttRecorder.ondataavailable = (e) => { if (e.data && e.data.size) sttChunks.push(e.data); };
  sttRecorder.onstop = () => { void transcribeStt(); };
  try { sttRecorder.start(); } catch (_) {}
  if (whisperStatus) whisperStatus.textContent = 'recording. tap the mic again when you’re done.';
  return true;
}

async function transcribeStt() {
  const stream = sttStream;
  sttStream = null;
  const releaseMic = () => { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {} };
  const chunks = sttChunks;
  sttChunks = [];
  if (!chunks.length) { releaseMic(); if (whisperStatus) whisperStatus.textContent = 'nothing recorded. try again or type.'; return; }
  const type = (sttRecorder && sttRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(chunks, { type });
  releaseMic();
  if (whisperStatus) whisperStatus.textContent = 'transcribing…';
  voiceButton?.classList.add('transcribing'); // spinner while STT runs
  try {
    const res = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': type }, body: blob });
    const j = await res.json().catch(() => ({}));
    const text = (j && typeof j.text === 'string') ? j.text.trim() : '';
    if (text) {
      const base = input?.value.trim() || '';
      if (input) input.value = base ? `${base} ${text}` : text;
      handleInput();
      if (whisperStatus) whisperStatus.textContent = 'transcribed. edit it, or seal the whisper.';
    } else {
      if (whisperStatus) whisperStatus.textContent = 'couldn’t make out words — try again or type.';
    }
  } catch (_) {
    if (whisperStatus) whisperStatus.textContent = 'transcription failed — type your whisper.';
  } finally {
    voiceButton?.classList.remove('transcribing');
  }
}

async function startMainRecording() {
  if (mainMode === 'recording') return true;
  mainMode = 'recording';
  mainStarted = false;
  setMainVoiceState('recording');

  if (USE_SERVER_STT) return startServerStt();

  // Prefer SpeechRecognition for live transcription, but do NOT pre-acquire the
  // mic with getUserMedia first: on Android that double-acquires the mic (two
  // permission prompts) and SpeechRecognition then fails to start, so nothing
  // records — while iOS (no SpeechRecognition) already worked via open-mic.
  // SpeechRecognition.start() requests its own mic permission; if it can't run
  // (common in Android system webviews) onerror/onend fall back to open-mic.
  const recognizer = ensureMainRecognition();
  if (recognizer) {
    mainBaseText = input?.value.trim() || '';
    mainFinalText = '';
    mainWanted = true;
    try {
      recognizer.start();
      if (whisperStatus) whisperStatus.textContent = 'recording. speak your order.';
      return true;
    } catch (_) {
      // start() threw synchronously (already started / unsupported) → fall back.
      mainWanted = false;
    }
  }
  return startOpenMicFallback();
}

function stopMainRecording(statusText = 'recording stopped. review before sealing.') {
  if (mainMode === 'idle') return;
  mainMode = 'idle';
  mainWanted = false;
  mainStarted = false;
  if (USE_SERVER_STT) {
    // Stopping triggers MediaRecorder.onstop → transcribeStt(), which updates the
    // status and fills the textarea, so don't overwrite the status here.
    try { if (sttRecorder && sttRecorder.state !== 'inactive') sttRecorder.stop(); } catch (_) {}
    setMainVoiceState('idle');
    return;
  }
  try { mainRecognition?.stop?.(); } catch (_) {}
  if (mainStream) {
    mainStream.getTracks().forEach((track) => track.stop());
    mainStream = null;
  }
  setMainVoiceState('idle');
  if (whisperStatus) whisperStatus.textContent = statusText;
  handleInput();
}

function onMicPointerDown(event) {
  event.preventDefault(); // keep textarea focus so the keyboard/layout doesn't jump
  try { voiceButton?.setPointerCapture?.(event.pointerId); } catch (_) {}
  if (mainMode === 'recording') {
    // A press on an already-recording mic ends it on release (tap-to-stop).
    micPressWillStop = true;
    return;
  }
  micPressWillStop = false;
  micHoldMode = false;
  // Recording starts immediately on press — same for tap and hold.
  startMainRecording();
  setMainVoiceState('recording');
  // If the finger is still down after 1s, this press becomes hold-to-talk.
  micPressTimer = window.setTimeout(() => {
    micPressTimer = null;
    if (mainMode === 'idle') return; // stopped / denied meanwhile
    micHoldMode = true;
    setMainVoiceState('hold');
  }, HOLD_THRESHOLD_MS);
}

function onMicPointerUp() {
  if (micPressTimer) { window.clearTimeout(micPressTimer); micPressTimer = null; }
  if (micPressWillStop) {
    micPressWillStop = false;
    stopMainRecording();
    return;
  }
  if (micHoldMode) {
    micHoldMode = false;
    stopMainRecording(); // held past 1s → release ends recording
  } else {
    setMainVoiceState('recording'); // released within 1s → latch until next tap
  }
}

function syncKeyboardState() {
  const viewport = window.visualViewport;
  // Only top-align for a REAL on-screen keyboard (viewport shrinks). Focus alone
  // (e.g. desktop, or tapping the mic) must not re-align, or the composer hops.
  const keyboardOpen = document.activeElement === input && viewport && viewport.height < window.innerHeight * 0.82;
  document.body.classList.toggle('keyboard-open', Boolean(keyboardOpen));
}

navButtons.forEach((button) => {
  // Non-<button> nav controls (e.g. the wordmark home link) need keyboard support.
  if (button.tagName !== 'BUTTON') {
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        button.click();
      }
    });
  }
  button.addEventListener('click', async () => {
    const next = button.getAttribute('data-go');
    if (next === 'v-seal' && !input?.value.trim()) {
      input?.focus({ preventScroll: true });
      if (whisperStatus) whisperStatus.textContent = 'the hall heard almost nothing. whisper first.';
      return;
    }
    if (!next) return;
    if (next === 'v-seal') {
      rememberSealedReceipt();
      // Seal the pact for real: whisper → commitment → daemon registration in the
      // CVM mesh. Fire-and-forget; the reveal screen flows regardless.
      commitWhisperToMesh((input?.value || '').trim());
    }
    showView(next);
    if (button.dataset.openMic === 'true' && next === 'v-whisper') {
      try { await grantMicForVisuals({ preventDefault() {} }); }
      catch (_) { if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.'; }
    }
  });
});
stakeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedStake = Number(button.getAttribute('data-stake') || 5);
    stakeButtons.forEach((choice) => choice.classList.toggle('on', choice === button));
    renderPrivateState();
    syncFundingCta();
    // Above the house stake, ready a real deposit intent against the live bridge
    // escrow so the funding step can move USDC and credit shadow balance.
    if (selectedStake > 5 && gw()) {
      const topUp = fundingTopUp();
      prepareDeposit(topUp).then((intent) => {
        if (intent && stakeEncourageEl) {
          stakeEncourageEl.textContent = `tap to fund $${topUp} to your daemon via the Base bridge.`;
        }
      });
    }
  });
});
feedCtaEl?.addEventListener('click', openFeedDeposit);
input?.addEventListener('input', handleInput);
input?.addEventListener('focus', syncKeyboardState);
input?.addEventListener('blur', () => window.setTimeout(syncKeyboardState, 120));
// Two-mode mic: tap to latch recording, hold (≥600ms) for push-to-talk.
// pointerdown preventDefault also keeps textarea focus, so the keyboard/layout
// doesn't jump. Works for both web and the Telegram Mini App webview.
voiceButton?.addEventListener('pointerdown', onMicPointerDown);
voiceButton?.addEventListener('pointerup', onMicPointerUp);
voiceButton?.addEventListener('pointercancel', onMicPointerUp);
voiceButton?.addEventListener('contextmenu', (event) => event.preventDefault());
terminalInput?.addEventListener('input', handleTerminalInput);
terminalSealButton?.addEventListener('click', sealTerminalWhisper);
terminalVoiceButton?.addEventListener('click', startVoice);
terminalButton?.addEventListener('click', openSealedTerminal);
terminalCloseButtons.forEach((button) => button.addEventListener('click', closeSealedTerminal));
notifyToggle?.addEventListener('click', () => {
  const enabled = notifyToggle.getAttribute('aria-pressed') !== 'true';
  try { localStorage.setItem(NOTIFY_PREF_KEY, enabled ? '1' : '0'); }
  catch (_) {}
  syncNotifyToggle();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !terminalModal?.hasAttribute('hidden')) closeSealedTerminal();
});
window.visualViewport?.addEventListener('resize', syncKeyboardState);
window.addEventListener('pagehide', () => recognition?.stop?.());

tickCountdown();
window.setInterval(tickCountdown, 1000);
syncNotifyToggle();
setMainMicGrantState();
setTerminalVoiceState('idle');
handleInput();
handleTerminalInput();

// Pull live account + public data once the gateway client is on window. If the
// bundle that defines it hasn't executed yet, wait for its ready signal.
syncFeedFlagFromUrl();
applyFeedGate();
if (isOnboarded()) showView('v-wait'); // returning player → straight to the daemon screen
if (gw()) bootLive();
else window.addEventListener('darkbox:gateway-ready', bootLive, { once: true });
