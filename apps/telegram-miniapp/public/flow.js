const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const views = [...document.querySelectorAll('.view')];
const navButtons = [...document.querySelectorAll('[data-go]')];
const input = document.querySelector('#whisper-input');
const voiceButton = document.querySelector('#voice-button');
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
let activeVoiceTarget = 'terminal';
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
  '▸ a sealed instinct learned patience',
  '▸ no one outside saw what changed',
];
const activityLines = [
  'your daemon keeps moving after you close the phone.',
  'it is whisper-quiet here; the hall is not.',
  'the room outside keeps making markets without showing its hands.',
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
  if (daemonActivityLineEl) daemonActivityLineEl.textContent = pick(activityLines, visualSeed, 4);
  if (stakeEncourageEl) stakeEncourageEl.textContent = stakeEncouragement[selectedStake] || 'add funds when you want more heat.';
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
  if (!terminalWhisperStatus || wantedListening || listening) return;
  terminalWhisperStatus.textContent = hasText
    ? 'review it. sealing will redact the words forever.'
    : 'click the mic to record. click again to stop.';
}

function sealTerminalWhisper() {
  const text = terminalInput?.value.trim();
  if (!text) {
    terminalInput?.focus({ preventScroll: true });
    if (terminalWhisperStatus) terminalWhisperStatus.textContent = 'the daemon needs an order first.';
    return;
  }
  rememberSealedReceipt(text);
  if (terminalInput) terminalInput.value = '';
  handleTerminalInput();
  renderSealedTerminal();
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

let mainMicPulseTimer = 0;

function pulseMainMicButton(duration = 900) {
  if (!voiceButton) return;
  window.clearTimeout(mainMicPulseTimer);
  voiceButton.classList.remove('arming');
  voiceButton.classList.add('listening');
  voiceButton.setAttribute('aria-pressed', 'true');
  mainMicPulseTimer = window.setTimeout(() => {
    voiceButton.classList.remove('listening', 'arming');
    voiceButton.setAttribute('aria-pressed', 'false');
  }, duration);
}

function setMainMicGrantState() {
  voiceButton?.classList.remove('listening', 'arming');
  voiceButton?.setAttribute('aria-pressed', 'false');
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

function setMainVoiceState(state = 'idle') {
  const active = state === 'recording-hold';
  window.clearTimeout(mainMicPulseTimer);
  voiceButton?.classList.toggle('listening', active);
  voiceButton?.classList.toggle('arming', state === 'arming');
  voiceButton?.setAttribute('aria-pressed', active || state === 'arming' ? 'true' : 'false');
  voiceButton?.setAttribute('aria-label', active ? 'Release to stop recording' : 'Hold to speak');
  if (whisperStatus && active) whisperStatus.textContent = 'recording. release the mic to stop.';
}

function setVoiceButtonState(active) {
  if (activeVoiceTarget === 'main') {
    setMainVoiceState(active ? 'recording-hold' : 'idle');
    return;
  }
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
    const status = activeVoiceTarget === 'main' ? whisperStatus : terminalWhisperStatus;
    if (status) status.textContent = activeVoiceTarget === 'main'
      ? 'recording. release the mic to stop.'
      : 'recording in private terminal. click mic again to stop.';
  };
  recognition.onerror = () => {
    wantedListening = false;
    listening = false;
    setVoiceButtonState(false);
    setTerminalVoiceState('idle');
    setMainVoiceState('idle');
    const status = activeVoiceTarget === 'main' ? whisperStatus : terminalWhisperStatus;
    if (status) status.textContent = 'voice broke. type or try again.';
  };
  recognition.onend = () => {
    listening = false;
    setVoiceButtonState(false);
    if (wantedListening) {
      window.setTimeout(() => {
        if (!wantedListening || listening) return;
        try { recognition.start(); }
        catch (_) {
          wantedListening = false;
          if (activeVoiceTarget === 'main') handleInput();
          else handleTerminalInput();
        }
      }, 120);
      return;
    }
    if (activeVoiceTarget === 'main') handleInput();
    else handleTerminalInput();
  };
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) recognitionFinalText += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    const spoken = `${recognitionFinalText}${interim}`.trim();
    const targetInput = activeVoiceTarget === 'main' ? input : terminalInput;
    if (targetInput) targetInput.value = [recognitionBaseText, spoken].filter(Boolean).join(recognitionBaseText && spoken ? ' ' : '').trimStart();
    if (activeVoiceTarget === 'main') handleInput();
    else handleTerminalInput();
  };
  return recognition;
}

async function beginVoice(target = 'terminal') {
  activeVoiceTarget = target;
  const status = target === 'main' ? whisperStatus : terminalWhisperStatus;
  if (!SpeechRecognition) {
    try { await requestMicFallback(); }
    catch (_) { if (status) status.textContent = 'mic denied. type instead.'; }
    return false;
  }
  try {
    const allowed = await requestMicAccess(target === 'main' ? 'mic ready. hold to speak.' : 'mic ready. terminal recording starts now.');
    if (!allowed) return false;
  } catch (_) {
    if (status) status.textContent = 'mic denied. type instead.';
    return false;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) return false;
  const targetInput = target === 'main' ? input : terminalInput;
  recognitionBaseText = targetInput?.value.trim() || '';
  recognitionFinalText = '';
  wantedListening = true;
  try { recognizer.start(); }
  catch (_) {}
  return true;
}

function stopVoice(statusText = 'recording stopped. review before sealing.') {
  const target = activeVoiceTarget;
  wantedListening = false;
  if (target === 'terminal') setTerminalVoiceState('stopping');
  else setMainVoiceState('idle');
  const status = target === 'main' ? whisperStatus : terminalWhisperStatus;
  if (status) status.textContent = statusText;
  try { recognition?.stop?.(); }
  catch (_) {}
  if (!listening) setVoiceButtonState(false);
  if (target === 'main') handleInput();
  else handleTerminalInput();
}

async function startVoice(event) {
  event.preventDefault();
  if (wantedListening || listening) stopVoice();
  else await beginVoice('terminal');
}

let mainHoldStartTimer = 0;
let mainHoldActive = false;

function clearMainHoldTimer() {
  window.clearTimeout(mainHoldStartTimer);
  mainHoldStartTimer = 0;
}

function startMainHoldToSpeak(event) {
  if (!voiceButton) return;
  event.preventDefault();
  clearMainHoldTimer();
  mainHoldActive = false;
  setMainVoiceState('arming');
  mainHoldStartTimer = window.setTimeout(async () => {
    mainHoldActive = true;
    await beginVoice('main');
  }, 180);
}

function stopMainHoldToSpeak(event) {
  if (!voiceButton) return;
  event?.preventDefault?.();
  if (mainHoldStartTimer && !mainHoldActive) {
    clearMainHoldTimer();
    void grantMicForVisuals({ preventDefault() {} });
    return;
  }
  clearMainHoldTimer();
  if (mainHoldActive) {
    mainHoldActive = false;
    if (activeVoiceTarget === 'main') stopVoice('recording stopped. review before sealing.');
  }
}

async function grantMicForVisuals(event) {
  event?.preventDefault?.();
  window.clearTimeout(mainMicPulseTimer);
  voiceButton?.classList.remove('listening');
  voiceButton?.classList.add('arming');
  voiceButton?.setAttribute('aria-pressed', 'true');
  try {
    const allowed = await requestMicAccess('mic ready. your daemon will react when the hall opens.');
    if (allowed) {
      pulseMainMicButton();
      if (whisperStatus) whisperStatus.textContent = 'mic ready. your daemon will react when the hall opens.';
    } else {
      setMainMicGrantState();
    }
  } catch (_) {
    setMainMicGrantState();
    if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.';
  }
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
  });
});
input?.addEventListener('input', handleInput);
input?.addEventListener('focus', syncKeyboardState);
input?.addEventListener('blur', () => window.setTimeout(syncKeyboardState, 120));
voiceButton?.addEventListener('pointerdown', startMainHoldToSpeak);
voiceButton?.addEventListener('pointerup', stopMainHoldToSpeak);
voiceButton?.addEventListener('pointercancel', stopMainHoldToSpeak);
voiceButton?.addEventListener('pointerleave', (event) => { if (mainHoldActive) stopMainHoldToSpeak(event); });
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
