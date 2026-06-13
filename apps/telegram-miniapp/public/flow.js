const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const views = [...document.querySelectorAll('.view')];
const navButtons = [...document.querySelectorAll('[data-go]')];
const input = document.querySelector('#whisper-input');
const voiceButton = document.querySelector('#voice-button');
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
const daemonBalanceEl = document.querySelector('#daemon-balance');
const daemonStatusEl = document.querySelector('#daemon-status');
const daemonMurmurEl = document.querySelector('#daemon-murmur');
const metricVolumeEl = document.querySelector('#metric-volume');
const metricTradesEl = document.querySelector('#metric-trades');
const metricSealedEl = document.querySelector('#metric-sealed');
const metricFingerprintsEl = document.querySelector('#metric-fingerprints');
const leaderboardRowsEl = document.querySelector('#leaderboard-rows');
const stakeButtons = [...document.querySelectorAll('.chip[data-stake]')];

const RESULTS_AT = new Date('2026-06-15T00:00:00Z');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let listening = false;
let selectedStake = 5;


const daemonImages = [
  '/daemons/murmur-01.webp', '/daemons/sable-02.webp', '/daemons/veil-03.webp', '/daemons/null-04.webp',
  '/daemons/rasp-05.webp', '/daemons/crown-06.webp', '/daemons/gloam-07.webp', '/daemons/wisp-08.webp',
  '/daemons/hex-09.webp', '/daemons/ash-10.webp', '/daemons/nix-11.webp', '/daemons/omen-12.webp',
  '/daemons/rune-13.webp', '/daemons/grin-14.webp', '/daemons/lilt-15.webp', '/daemons/rook-16.webp',
  '/daemons/vesper-17.webp', '/daemons/knell-18.webp', '/daemons/vant-19.webp', '/daemons/thorn-20.webp',
];

const names = ['hopiumd', 'fomod', 'rugd', 'greedd', 'panicd', 'copiumd', 'lateforkd', 'doubtd'];
const statuses = ['circling', 'running', 'sleeping', 'listening', 'quiet', 'zombie'];
const murmurs = [
  '▸ a daemon laughed without opening its mouth',
  '▸ something moved behind the wall',
  '▸ the hall counted wrong, then counted again',
  '▸ a sealed order learned patience',
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

function currentSeed() {
  return `${input?.value.trim() || 'silence'}:${selectedStake}`;
}

function renderPrivateState() {
  const seed = currentSeed();
  const h = hashNumber(seed);
  const ownName = pick(names, seed);
  const status = pick(statuses, seed, 2);
  if (fingerprintEl) fingerprintEl.textContent = fingerprint(seed);
  const daemonImage = pick(daemonImages, seed, 5);
  if (daemonNameEl) daemonNameEl.textContent = ownName;
  if (revealDaemonNameEl) revealDaemonNameEl.textContent = ownName;
  if (revealDaemonMetaEl) revealDaemonMetaEl.textContent = `${status} · ${fingerprint(seed)}`;
  window.dispatchEvent(new CustomEvent('daemonhall:reveal', { detail: { image: daemonImage, name: ownName, seed } }));
  if (daemonBalanceEl) daemonBalanceEl.innerHTML = `$${(selectedStake + (h % 900) / 100).toFixed(2)} <span class="tell">· only you</span>`;
  if (daemonStatusEl) daemonStatusEl.textContent = status;
  if (daemonMurmurEl) daemonMurmurEl.textContent = pick(murmurs, seed, 3);
  if (metricVolumeEl) metricVolumeEl.textContent = `$${(10.2 + (h % 7200) / 1000).toFixed(1)}k`;
  if (metricTradesEl) metricTradesEl.textContent = String(220 + (h % 260));
  if (metricSealedEl) metricSealedEl.textContent = String(76 + (h % 35));
  if (metricFingerprintsEl) metricFingerprintsEl.textContent = String(130 + (h % 80));
  renderLeaderboard(seed, ownName);
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

async function requestMicFallback() {
  if (!navigator.mediaDevices?.getUserMedia) {
    if (whisperStatus) whisperStatus.textContent = 'voice unavailable here. type the whisper.';
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  stream.getTracks().forEach((track) => track.stop());
  if (whisperStatus) whisperStatus.textContent = 'mic allowed. speech transcription is unavailable here. type the final whisper.';
}

async function startVoice(event) {
  event.preventDefault();
  if (!SpeechRecognition) {
    try { await requestMicFallback(); }
    catch (_) { if (whisperStatus) whisperStatus.textContent = 'mic denied. type the whisper instead.'; }
    return;
  }
  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => {
      listening = true;
      voiceButton?.classList.add('listening');
      if (whisperStatus) whisperStatus.textContent = 'listening. speak it low.';
    };
    recognition.onerror = () => {
      listening = false;
      voiceButton?.classList.remove('listening');
      if (whisperStatus) whisperStatus.textContent = 'voice broke. type or try again.';
    };
    recognition.onend = () => {
      listening = false;
      voiceButton?.classList.remove('listening');
      handleInput();
    };
    recognition.onresult = (event) => {
      let transcript = '';
      for (const result of event.results) transcript += result[0].transcript;
      if (input) input.value = transcript.trimStart();
      handleInput();
    };
  }
  if (listening) recognition.stop();
  else recognition.start();
}

function syncKeyboardState() {
  const viewport = window.visualViewport;
  const keyboardOpen = document.activeElement === input && viewport && viewport.height < window.innerHeight * 0.82;
  document.body.classList.toggle('keyboard-open', Boolean(keyboardOpen || document.activeElement === input));
}

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const next = button.getAttribute('data-go');
    if (next === 'v-seal' && !input?.value.trim()) {
      input?.focus({ preventScroll: true });
      if (whisperStatus) whisperStatus.textContent = 'the hall heard almost nothing. whisper first.';
      return;
    }
    if (next) showView(next);
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
voiceButton?.addEventListener('click', startVoice);
window.visualViewport?.addEventListener('resize', syncKeyboardState);
window.addEventListener('pagehide', () => recognition?.stop?.());

tickCountdown();
window.setInterval(tickCountdown, 1000);
handleInput();
