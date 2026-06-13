type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  initDataUnsafe?: { user?: { id?: number; username?: string; first_name?: string; last_name?: string } };
  HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void };
};

const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const form = document.querySelector<HTMLFormElement>('#flow-form');
const statusEl = document.querySelector<HTMLElement>('#status');
const outputEl = document.querySelector<HTMLElement>('#output');
const createButton = document.querySelector<HTMLButtonElement>('#create');

function setStatus(message: string, tone: 'ok' | 'error' = 'ok') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', tone === 'error');
  tg?.HapticFeedback?.impactOccurred?.(tone === 'error' ? 'heavy' : 'light');
}

function setOutput(value: unknown) {
  if (outputEl) outputEl.textContent = JSON.stringify(value, null, 2);
}

function getTelegramOwner() {
  const user = tg?.initDataUnsafe?.user;
  if (!user?.id) return 'web-test-user';
  return user.username ? `telegram:${user.id}:${user.username}` : `telegram:${user.id}`;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form) return;
  const data = new FormData(form);
  const amount = Number(data.get('amount'));
  const beneficiary = String(data.get('beneficiary') ?? '').trim();
  const gameId = String(data.get('gameId') ?? '').trim();
  const memo = String(data.get('memo') ?? '').trim();
  createButton?.setAttribute('disabled', 'true');
  setStatus('Creating Dynamic Flow deposit intent…');
  try {
    const response = await fetch('/api/dynamic-flow/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, beneficiary, gameId, memo, telegramOwner: getTelegramOwner() }),
    });
    const body = await response.json().catch(() => ({}));
    setOutput(body);
    if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
    setStatus(body.mode === 'live'
      ? 'Live Dynamic Flow transaction created. Continue with returned transaction/session data.'
      : 'Dry run created. Add Dynamic credentials to turn this into a live checkout.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    createButton?.removeAttribute('disabled');
  }
});
