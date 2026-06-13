const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const views = [...document.querySelectorAll('.view')];
const navButtons = [...document.querySelectorAll('[data-go]')];
const input = document.querySelector('#whisper-input');
const voiceButton = document.querySelector('#voice-button');
const voiceStateEl = document.querySelector('#voice-state');
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
const daemonBalanceEl = document.querySelector('#daemon-balance');
const daemonPnlEl = document.querySelector('#daemon-pnl');
const daemonPnlNoteEl = document.querySelector('#daemon-pnl-note');
const daemonStatusEl = document.querySelector('#daemon-status');
const daemonMurmurEl = document.querySelector('#daemon-murmur');
const metricVolumeEl = document.querySelector('#metric-volume');
const metricTradesEl = document.querySelector('#metric-trades');
const metricSealedEl = document.querySelector('#metric-sealed');
const metricFingerprintsEl = document.querySelector('#metric-fingerprints');
const leaderboardRowsEl = document.querySelector('#leaderboard-rows');
const marketRowsEl = document.querySelector('#market-rows');
const stakeButtons = [...document.querySelectorAll('.chip[data-stake]')];
const terminalButton = document.querySelector('#sealed-terminal-button');
const terminalModal = document.querySelector('#sealed-terminal-modal');
const terminalLogEl = document.querySelector('#sealed-terminal-log');
const terminalCloseButtons = [...document.querySelectorAll('[data-close-terminal]')];

const RESULTS_AT = new Date('2026-06-15T00:00:00Z');
const SEALED_LOG_KEY = 'daemonhall:sealed-receipts:v1';
const VISUAL_SEED_KEY = 'daemonhall:visual-seed:v1';
const PUBLIC_MARKET_SEED = 'daemonhall:public-markets:v1';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let listening = false;
let wantedListening = false;
let recognitionBaseText = '';
let recognitionFinalText = '';
let holdTimer = 0;
let holdRecording = false;
let suppressNextVoiceClick = false;
let selectedStake = 5;


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
  '▸ a sealed order learned patience',
  '▸ no one outside saw what changed',
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

function rememberSealedReceipt() {
  const text = input?.value.trim();
  if (!text) return;
  const seed = currentSeed();
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

function renderSealedTerminal() {
  if (!terminalLogEl) return;
  const receipts = readSealedReceipts();
  if (!receipts.length) {
    terminalLogEl.innerHTML = '<div class="terminal-empty">&gt; no sealed receipts yet. whisper once, then come back.</div>';
    return;
  }
  terminalLogEl.innerHTML = receipts.map((row, index) => {
    const when = row.sealedAt ? new Date(row.sealedAt).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'time sealed';
    return `
      <div class="terminal-line">
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

function setSelectedDaemon({ image, name, seed }) {
  selectedDaemon.image = image;
  selectedDaemon.name = name;
  selectedDaemon.seed = seed;
  if (waitDaemonImageEl) {
    if (waitDaemonImageEl.getAttribute('src') !== selectedDaemon.image) waitDaemonImageEl.src = selectedDaemon.image;
    waitDaemonImageEl.alt = `${selectedDaemon.name} daemon portrait`;
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
  const ownName = pick(names, visualSeed);
  const status = pick(statuses, visualSeed, 2);
  if (fingerprintEl) fingerprintEl.textContent = fingerprint(instructionSeed);
  const daemonImage = pick(daemonImages, visualSeed, 5);
  if (daemonNameEl) daemonNameEl.textContent = ownName;
  if (revealDaemonNameEl) revealDaemonNameEl.textContent = ownName;
  if (revealDaemonMetaEl) revealDaemonMetaEl.textContent = `${status} · ${fingerprint(instructionSeed)}`;
  setSelectedDaemon({ image: daemonImage, name: ownName, seed: visualSeed });
  const balance = selectedStake + (h % 900) / 100;
  const pnl = ((hashNumber(`${visualSeed}:pnl`) % 520) - 140) / 100;
  if (daemonBalanceEl) daemonBalanceEl.textContent = `$${balance.toFixed(2)}`;
  if (daemonPnlEl) {
    daemonPnlEl.textContent = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
    daemonPnlEl.classList.toggle('loss', pnl < 0);
  }
  if (daemonPnlNoteEl) daemonPnlNoteEl.textContent = pnl >= 0 ? 'unrealized' : 'drawdown';
  if (daemonStatusEl) daemonStatusEl.textContent = status;
  if (daemonMurmurEl) daemonMurmurEl.textContent = pick(murmurs, visualSeed, 3);
  if (metricVolumeEl) metricVolumeEl.textContent = `$${(10.2 + (h % 7200) / 1000).toFixed(1)}k`;
  if (metricTradesEl) metricTradesEl.textContent = String(220 + (h % 260));
  if (metricSealedEl) metricSealedEl.textContent = String(76 + (h % 35));
  if (metricFingerprintsEl) metricFingerprintsEl.textContent = String(130 + (h % 80));
  renderMarkets(PUBLIC_MARKET_SEED);
  renderLeaderboard(visualSeed, ownName);
}

function renderMarkets(seed) {
  if (!marketRowsEl) return;
  const rows = marketQuestions.map((question, index) => {
    const base = hashNumber(`${seed}:market:${question}`);
    const size = 650 + (base % 5200);
    const trades = 18 + (hashNumber(`${seed}:market:${question}:trades`) % 160);
    return { question, size, trades, score: size };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  marketRowsEl.innerHTML = rows.map((row, index) => `
    <div class="market-row">
      <span class="rank">${index + 1}</span>
      <span class="market-q">${escapeHtml(row.question)}</span>
      <span class="market-size">$${(row.size / 1000).toFixed(1)}k</span>
      <span class="market-trades">${row.trades} trades</span>
    </div>
  `).join('');
}

function renderLeaderboard(seed, ownName) {
  if (!leaderboardRowsEl) return;
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
  leaderboardRowsEl.innerHTML = rows.map((row) => `
    <div class="brow ${row.name === ownName ? 'you' : ''}">
      <span class="rank">${row.rank}</span>
      <span class="dn">${row.name}${row.name === ownName ? ' ◂ you' : ''}</span>
      <span class="pulse"><span class="pct">${row.pulse}</span> · ${row.status}</span>
    </div>
  `).join('');
}

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  renderPrivateState();
  if (id === 'v-whisper') window.setTimeout(() => input?.focus({ preventScroll: true }), 80);
  tg?.HapticFeedback?.impactOccurred?.('light');
}

function formatCountdown(ms) {
  if (ms <= 0) return 'BOXES OPEN NOW';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return days > 0 ? `SEALED · ${days}D ${hh}:${mm}:${ss}` : `SEALED · ${hh}:${mm}:${ss}`;
}

function tickCountdown() {
  const text = formatCountdown(RESULTS_AT.getTime() - Date.now());
  countdownEls.forEach((el) => { el.textContent = text; });
  if (landingCountdownEl) landingCountdownEl.textContent = text.replace(/^SEALED · /, '');
}

function autosize() {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, Math.max(84, window.innerHeight * 0.26))}px`;
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

function setVoiceVisualState(state = 'idle') {
  const active = state === 'recording-toggle' || state === 'recording-hold';
  voiceButton?.classList.toggle('listening', active);
  voiceButton?.classList.toggle('arming', state === 'hold-arming');
  voiceButton?.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (voiceButton) voiceButton.dataset.recordingMode = state;
  if (!voiceStateEl) return;
  voiceStateEl.dataset.state = state;
  voiceStateEl.textContent = {
    idle: 'tap / hold',
    'hold-arming': 'hold…',
    'recording-toggle': 'recording · tap to stop',
    'recording-hold': 'recording · release to stop',
    stopping: 'stopping…',
  }[state] || 'tap / hold';
}

function setVoiceButtonState(active, mode = '') {
  setVoiceVisualState(active ? (mode === 'hold' ? 'recording-hold' : 'recording-toggle') : 'idle');
}

function ensureRecognition() {
  if (recognition || !SpeechRecognition) return recognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.onstart = () => {
    listening = true;
    setVoiceButtonState(true, holdRecording ? 'hold' : 'toggle');
    if (whisperStatus) whisperStatus.textContent = holdRecording ? 'recording while you hold. release to stop.' : 'recording. tap the mic again to stop.';
  };
  recognition.onerror = () => {
    wantedListening = false;
    listening = false;
    setVoiceButtonState(false);
    setVoiceVisualState('idle');
    if (whisperStatus) whisperStatus.textContent = 'voice broke. type or try again.';
  };
  recognition.onend = () => {
    listening = false;
    setVoiceButtonState(false);
    if (wantedListening) {
      window.setTimeout(() => {
        if (!wantedListening || listening) return;
        try { recognition.start(); }
        catch (_) { wantedListening = false; handleInput(); }
      }, 120);
      return;
    }
    handleInput();
  };
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) recognitionFinalText += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    const spoken = `${recognitionFinalText}${interim}`.trim();
    if (input) input.value = [recognitionBaseText, spoken].filter(Boolean).join(recognitionBaseText && spoken ? ' ' : '').trimStart();
    handleInput();
  };
  return recognition;
}

async function beginVoice(mode = 'toggle') {
  if (!SpeechRecognition) {
    try { await requestMicFallback(); }
    catch (_) { if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.'; }
    return false;
  }
  try {
    const allowed = await requestMicAccess(mode === 'hold' ? 'hold to record. release to stop.' : 'mic ready. tap again when done.');
    if (!allowed) return false;
  } catch (_) {
    if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.';
    return false;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) return false;
  recognitionBaseText = input?.value.trim() || '';
  recognitionFinalText = '';
  wantedListening = true;
  try { recognizer.start(); }
  catch (_) {}
  return true;
}

function stopVoice(statusText = 'recording stopped. review before sealing.') {
  wantedListening = false;
  holdRecording = false;
  setVoiceVisualState('stopping');
  if (whisperStatus) whisperStatus.textContent = statusText;
  try { recognition?.stop?.(); }
  catch (_) {}
  if (!listening) setVoiceButtonState(false);
  handleInput();
}

async function startVoice(event) {
  event.preventDefault();
  if (suppressNextVoiceClick) {
    suppressNextVoiceClick = false;
    return;
  }
  if (wantedListening || listening) stopVoice();
  else await beginVoice('toggle');
}

function syncKeyboardState() {
  const viewport = window.visualViewport;
  const keyboardOpen = document.activeElement === input && viewport && viewport.height < window.innerHeight * 0.82;
  document.body.classList.toggle('keyboard-open', Boolean(keyboardOpen || document.activeElement === input));
}

navButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    const next = button.getAttribute('data-go');
    if (next === 'v-seal' && !input?.value.trim()) {
      input?.focus({ preventScroll: true });
      if (whisperStatus) whisperStatus.textContent = 'the hall heard almost nothing. whisper first.';
      return;
    }
    if (!next) return;
    if (next === 'v-seal') rememberSealedReceipt();
    showView(next);
    if (button.dataset.openMic === 'true' && next === 'v-whisper') {
      try { await startVoice({ preventDefault() {} }); }
      catch (_) { if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.'; }
    }
  });
});
stakeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedStake = Number(button.getAttribute('data-stake') || 5);
    stakeButtons.forEach((choice) => choice.classList.toggle('on', choice === button));
    renderPrivateState();
  });
});
input?.addEventListener('input', handleInput);
input?.addEventListener('focus', syncKeyboardState);
input?.addEventListener('blur', () => window.setTimeout(syncKeyboardState, 120));
voiceButton?.addEventListener('pointerdown', (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  if (wantedListening || listening) return;
  voiceButton.setPointerCapture?.(event.pointerId);
  setVoiceVisualState('hold-arming');
  holdTimer = window.setTimeout(async () => {
    holdTimer = 0;
    holdRecording = true;
    suppressNextVoiceClick = true;
    await beginVoice('hold');
  }, 260);
});
voiceButton?.addEventListener('pointerup', (event) => {
  if (holdTimer) {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
    setVoiceVisualState('idle');
    return;
  }
  if (holdRecording) {
    suppressNextVoiceClick = true;
    stopVoice('recording stopped. review before sealing.');
  }
  voiceButton.releasePointerCapture?.(event.pointerId);
});
voiceButton?.addEventListener('pointercancel', () => {
  if (holdTimer) window.clearTimeout(holdTimer);
  holdTimer = 0;
  if (holdRecording) stopVoice('recording cancelled. review before sealing.');
  else setVoiceVisualState('idle');
});
voiceButton?.addEventListener('click', startVoice);
terminalButton?.addEventListener('click', openSealedTerminal);
terminalCloseButtons.forEach((button) => button.addEventListener('click', closeSealedTerminal));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !terminalModal?.hasAttribute('hidden')) closeSealedTerminal();
});
window.visualViewport?.addEventListener('resize', syncKeyboardState);
window.addEventListener('pagehide', () => recognition?.stop?.());

tickCountdown();
window.setInterval(tickCountdown, 1000);
handleInput();
