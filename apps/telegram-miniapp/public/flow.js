const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const stage = document.querySelector('.stage');
const input = document.querySelector('#whisper-input');
const mic = document.querySelector('#mic');
const statusEl = document.querySelector('#whisper-status');
const continueButton = document.querySelector('#continue');
const countdownEl = document.querySelector('#results-countdown');
const sealedNameEl = document.querySelector('#sealed-name');
const presenceSigilEl = document.querySelector('#presence-sigil');
const openPactButton = document.querySelector('#open-pact');
const sealPactButton = document.querySelector('#seal-pact');
const sendDaemonButton = document.querySelector('#send-daemon');
const restartButton = document.querySelector('#restart-flow');
const stakeButtons = [...document.querySelectorAll('.stake-choice')];
const fingerprintEl = document.querySelector('#fingerprint');
const revealFingerprintEl = document.querySelector('#reveal-fingerprint');
const daemonNameEl = document.querySelector('#daemon-name');
const daemonEpithetEl = document.querySelector('#daemon-epithet');
const daemonOriginEl = document.querySelector('#daemon-origin');
const waitDaemonNameEl = document.querySelector('#wait-daemon-name');
const waitStatusEl = document.querySelector('#wait-status');
const waitMurmurEl = document.querySelector('#wait-murmur');
const privateBalanceEl = document.querySelector('#private-balance');
const metricVolumeEl = document.querySelector('#metric-volume');
const metricTradesEl = document.querySelector('#metric-trades');
const metricBoxesEl = document.querySelector('#metric-boxes');
const metricFingerprintsEl = document.querySelector('#metric-fingerprints');
const leaderboardRowsEl = document.querySelector('#leaderboard-rows');

const RESULTS_AT = new Date('2026-06-15T00:00:00Z');
const defaultStatus = 'only you hear this.';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let listening = false;
let flowEntered = false;
let terminalEntered = false;
let darkAnswered = false;
let selectedStake = 5;
let currentDaemon = null;

const names = ['fomod', 'hopiumd', 'rugd', 'panicd', 'greedd', 'lateforkd', 'copex', 'whisprd', 'doubtd', 'moonwaitd'];
const epithets = [
  'THE LATECOMER, FIRST OF ITS PANIC',
  'STILL BELIEVING AFTER THE LIGHTS WENT OUT',
  'TRUSTED THE WRONG GATE AND CALLED IT ALPHA',
  'SWEETEST MOUTH IN THE WRONG MARKET',
  'BORN SHORT, PRAYING LONG',
  'THE ONE WHO READ THE ROOM TOO LATE',
  'WALKS IN CIRCLES UNTIL PROFIT LOOKS LIKE FATE',
  'A LITTLE TOO BRAVE FOR THE SIZE OF ITS BAG',
];
const statuses = ['running', 'listening', 'circling', 'hungry', 'quiet', 'committed', 'still believing', 'overclocked'];
const leaderboardNames = ['fomod', 'hopiumd', 'greedd', 'panicd', 'rugd', 'copiumd', 'lateforkd', 'doubtd'];

const murmurs = [
  '▸ something moved behind the wall',
  '▸ a daemon laughed without opening its mouth',
  '▸ the hall counted wrong, then counted again',
  '▸ a sealed order learned patience',
  '▸ box 88 made a sound like teeth',
  '▸ no one outside saw what changed',
];

function hashNumber(seed) {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function pick(list, seed, offset = 0) { return list[(hashNumber(`${seed}:${offset}`)) % list.length]; }
function tinyFingerprint(seed) {
  const h1 = hashNumber(seed).toString(16).padStart(8, '0');
  const h2 = hashNumber(`${seed}:seal`).toString(16).padStart(8, '0');
  const h3 = hashNumber(`${seed}:key`).toString(16).padStart(8, '0');
  return `0x${h1}${h2}${h3}`;
}

function signedPercent(seed, offset = 0) {
  const raw = hashNumber(`${seed}:pulse:${offset}`) % 4200;
  const value = (raw - 1600) / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
function paintHallMetrics(seed) {
  const h = hashNumber(seed || 'silence');
  if (privateBalanceEl) privateBalanceEl.textContent = `$${(5 + (h % 900) / 100).toFixed(2)} decrypted`;
  if (metricVolumeEl) metricVolumeEl.textContent = `$${(8.2 + (h % 9200) / 1000).toFixed(1)}k`;
  if (metricTradesEl) metricTradesEl.textContent = String(180 + (h % 260));
  if (metricBoxesEl) metricBoxesEl.textContent = String(64 + (h % 41));
  if (metricFingerprintsEl) metricFingerprintsEl.textContent = String(120 + (h % 90));
}
function paintLeaderboard(seed) {
  if (!leaderboardRowsEl) return;
  const ownName = currentDaemon?.name || pick(names, seed);
  const rows = [ownName, ...leaderboardNames.filter((name) => name !== ownName)]
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
    <p class="${row.name === ownName ? 'is-user' : ''}">
      <span>${row.rank}</span>
      <strong>${row.name}</strong>
      <em>${row.pulse} · ${row.status}</em>
    </p>
  `).join('');
}

function formatCountdown(ms) {
  if (ms <= 0) return 'boxes open now';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return days > 0 ? `boxes open in ${days}d ${hh}:${mm}:${ss}` : `boxes open in ${hh}:${mm}:${ss}`;
}
function tickCountdown() {
  if (countdownEl) countdownEl.textContent = formatCountdown(RESULTS_AT.getTime() - Date.now());
}
function setStatus(text) { statusEl.textContent = text || defaultStatus; }
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.28)}px`;
}
function answerGlyph(seed) {
  const glyphs = ['∴', '◇', '◌', '⌁', '✦', '☉', '⟡', '◍'];
  return pick(glyphs, seed);
}
function sealedMask(seed) {
  return pick(['██████', '███•██', '██•███', '████•█'], seed, 1);
}
function buildDaemon() {
  const whisper = input.value.trim() || 'silence';
  const fp = tinyFingerprint(`${whisper}:${selectedStake}`);
  const name = pick(names, whisper);
  const epithet = pick(epithets, whisper, 2);
  const phrase = whisper.toLowerCase().replace(/\s+/g, ' ').slice(0, 64);
  const origin = phrase.length > 12
    ? `born from “${phrase}${whisper.length > 64 ? '…' : ''}” and already pretending it was a plan.`
    : 'born from a whisper too small to admit what it wanted.';
  currentDaemon = {
    name,
    epithet,
    origin,
    fingerprint: fp,
    status: pick(statuses, whisper, 3),
    murmur: pick(murmurs, whisper, 4),
  };
  return currentDaemon;
}
function paintDaemon() {
  const daemon = currentDaemon || buildDaemon();
  if (fingerprintEl) fingerprintEl.textContent = `${daemon.fingerprint.slice(0, 8)}…${daemon.fingerprint.slice(-6)}`;
  if (revealFingerprintEl) revealFingerprintEl.textContent = `${daemon.fingerprint.slice(0, 10)}…${daemon.fingerprint.slice(-8)}`;
  if (daemonNameEl) daemonNameEl.textContent = daemon.name;
  if (daemonEpithetEl) daemonEpithetEl.textContent = daemon.epithet;
  if (daemonOriginEl) daemonOriginEl.textContent = daemon.origin;
  if (waitDaemonNameEl) waitDaemonNameEl.textContent = daemon.name;
  if (waitStatusEl) waitStatusEl.textContent = daemon.status;
  if (waitMurmurEl) waitMurmurEl.textContent = daemon.murmur;
  paintHallMetrics(input.value.trim() || daemon.name);
  paintLeaderboard(input.value.trim() || daemon.name);
}
function enterFlow() {
  if (flowEntered) return;
  flowEntered = true;
  stage.dataset.loop = 'threshold-copy';
  window.setTimeout(enterTerminal, 2600);
}
function enterTerminal() {
  if (terminalEntered) return;
  terminalEntered = true;
  stage.dataset.loop = 'terminal';
  window.setTimeout(() => input.focus({ preventScroll: true }), 980);
}
function enterDarkAnswer() {
  if (darkAnswered) return;
  darkAnswered = true;
  stopListening();
  const whisper = input.value.trim();
  currentDaemon = null;
  buildDaemon();
  paintDaemon();
  if (presenceSigilEl) presenceSigilEl.textContent = answerGlyph(whisper);
  if (sealedNameEl) sealedNameEl.textContent = sealedMask(whisper);
  stage.dataset.loop = 'dark-answer';
}
function enterPact() {
  buildDaemon();
  paintDaemon();
  stage.dataset.loop = 'pact';
}
function enterReveal() {
  paintDaemon();
  stage.dataset.loop = 'daemon-reveal';
}
function enterWaitRoom() {
  paintDaemon();
  stage.dataset.loop = 'wait-room';
}
function restartFlow(event) {
  event?.stopPropagation?.();
  stopListening();
  input.value = '';
  currentDaemon = null;
  darkAnswered = false;
  handleInput();
  stage.dataset.loop = 'terminal';
  window.setTimeout(() => input.focus({ preventScroll: true }), 260);
}
async function requestMicFallback() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('voice unavailable here. type the whisper.');
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach((track) => track.stop());
  setStatus('mic allowed. speech transcription is unavailable here. type the final whisper.');
}
function stopListening() {
  if (recognition && listening) recognition.stop();
  listening = false;
  mic.classList.remove('listening');
}
async function startVoice(event) {
  event.stopPropagation();
  if (!flowEntered) enterFlow();
  if (!terminalEntered) enterTerminal();
  if (!SpeechRecognition) {
    try { await requestMicFallback(); }
    catch (_) { setStatus('mic denied. type the whisper instead.'); }
    return;
  }
  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => {
      listening = true;
      mic.classList.add('listening');
      setStatus('listening. speak it low.');
    };
    recognition.onerror = (event) => {
      listening = false;
      mic.classList.remove('listening');
      setStatus(event.error === 'not-allowed' ? 'mic denied. type the whisper instead.' : 'voice broke. type or try again.');
    };
    recognition.onend = () => {
      listening = false;
      mic.classList.remove('listening');
      setStatus(input.value.trim() ? 'review the text before the dark answers.' : defaultStatus);
    };
    recognition.onresult = (event) => {
      let transcript = '';
      for (const result of event.results) transcript += result[0].transcript;
      input.value = transcript.trimStart();
      handleInput();
    };
  }
  if (listening) stopListening();
  else recognition.start();
}
function handleInput() {
  autosize();
  darkAnswered = false;
  currentDaemon = null;
  const hasText = input.value.trim().length > 0;
  continueButton.classList.toggle('ready', hasText);
  setStatus(hasText ? 'review the text before the dark answers.' : defaultStatus);
}
function handleContinue(event) {
  event.stopPropagation();
  if (!input.value.trim()) {
    setStatus('the hall heard almost nothing. whisper first.');
    input.focus();
    return;
  }
  setStatus('something answered. its true name is sealed.');
  enterDarkAnswer();
}

window.addEventListener('click', () => { if (!flowEntered) enterFlow(); });
window.addEventListener('touchstart', () => { if (!flowEntered) enterFlow(); }, { passive: true });
window.addEventListener('wheel', (event) => { if (event.deltaY > 8 && !flowEntered) enterFlow(); }, { passive: true });
window.addEventListener('keydown', (event) => { if (!flowEntered && ['Enter', ' ', 'ArrowDown'].includes(event.key)) enterFlow(); });
input.addEventListener('click', (event) => event.stopPropagation());
input.addEventListener('input', handleInput);
mic.addEventListener('click', startVoice);
continueButton.addEventListener('click', handleContinue);
openPactButton?.addEventListener('click', (event) => { event.stopPropagation(); enterPact(); });
sealPactButton?.addEventListener('click', (event) => { event.stopPropagation(); enterReveal(); });
sendDaemonButton?.addEventListener('click', (event) => { event.stopPropagation(); enterWaitRoom(); });
restartButton?.addEventListener('click', restartFlow);
stakeButtons.forEach((button) => button.addEventListener('click', (event) => {
  event.stopPropagation();
  selectedStake = Number(button.dataset.stake || 5);
  stakeButtons.forEach((choice) => choice.classList.toggle('active', choice === button));
  buildDaemon();
  paintDaemon();
}));
window.addEventListener('pagehide', stopListening);
tickCountdown();
window.setInterval(tickCountdown, 1000);
autosize();
