import { Deposit, DepositError, getDisplayMessage } from '@swype-org/deposit';

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  initDataUnsafe?: { user?: { id?: number; username?: string; first_name?: string; last_name?: string } };
  HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void };
};

const BASE_USDC = {
  chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  bridge: '0x55E84818FCEDc3E892A22b46715Ee2B4A947E138',
};

const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const form = document.querySelector<HTMLFormElement>('#flow-form');
const statusEl = document.querySelector<HTMLElement>('#status');
const outputEl = document.querySelector<HTMLElement>('#output');
const createButton = document.querySelector<HTMLButtonElement>('#create');

const deposit = new Deposit({
  signer: '/api/blink/sign-payment',
  debug: true,
  enableFullWidget: true,
});

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
  if (!user?.id) return 'telegram:unknown';
  const name = user.username || [user.first_name, user.last_name].filter(Boolean).join('-') || 'telegram-user';
  return `telegram:${user.id}:${name}`;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form) return;
  const data = new FormData(form);
  const amount = Number(data.get('amount'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 25) {
    setStatus('Enter a test amount between 1 and 25 USDC.', 'error');
    return;
  }

  createButton?.setAttribute('disabled', 'true');
  setStatus('Opening hosted cross-chain deposit flow…');
  try {
    const result = await deposit.requestDeposit({
      amount,
      chainId: BASE_USDC.chainId,
      address: BASE_USDC.bridge,
      token: BASE_USDC.token,
      callbackScheme: null,
      reference: `darkbox-crosschain-${Date.now()}`,
      metadata: {
        surface: 'telegram-miniapp',
        experiment: 'cross-chain-deposit',
        telegramOwner: getTelegramOwner(),
        destination: 'darkbox-base-usdc-bridge',
      },
    });
    setOutput(result);
    setStatus(`Hosted flow completed: ${result.transfer.id} (${result.transfer.status}). Watcher should credit after Base settlement.`);
  } catch (error) {
    const message = error instanceof DepositError ? getDisplayMessage(error) : error instanceof Error ? error.message : String(error);
    setStatus(`Cross-chain deposit failed: ${message}`, 'error');
  } finally {
    createButton?.removeAttribute('disabled');
  }
});

window.addEventListener('pagehide', () => deposit.destroy());
