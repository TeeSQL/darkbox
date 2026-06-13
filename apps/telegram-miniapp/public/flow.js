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

const RESULTS_AT = new Date('2026-06-15T00:00:00Z');
const defaultStatus = 'only you hear this.';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
let listening = false;
let flowEntered = false;
let terminalEntered = false;
let darkAnswered = false;

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
function enterFlow() {
  if (flowEntered) return;
  flowEntered = true;
  stage.dataset.loop = 'threshold-copy';
  window.setTimeout(enterTerminal, 2600);
}

function answerGlyph(seed) {
  const glyphs = ['∴', '◇', '◌', '⌁', '✦', '☉', '⟡', '◍'];
  let sum = 0;
  for (const ch of seed) sum = (sum + ch.charCodeAt(0)) % 997;
  return glyphs[sum % glyphs.length];
}
function sealedMask(seed) {
  let sum = 0;
  for (const ch of seed) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return ['██████', '███•██', '██•███', '████•█'][sum % 4];
}
function enterDarkAnswer() {
  if (darkAnswered) return;
  darkAnswered = true;
  stopListening();
  const whisper = input.value.trim();
  if (presenceSigilEl) presenceSigilEl.textContent = answerGlyph(whisper);
  if (sealedNameEl) sealedNameEl.textContent = sealedMask(whisper);
  stage.dataset.loop = 'dark-answer';
}

function enterTerminal() {
  if (terminalEntered) return;
  terminalEntered = true;
  stage.dataset.loop = 'terminal';
  window.setTimeout(() => input.focus({ preventScroll: true }), 980);
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
window.addEventListener('pagehide', stopListening);
tickCountdown();
window.setInterval(tickCountdown, 1000);
autosize();
