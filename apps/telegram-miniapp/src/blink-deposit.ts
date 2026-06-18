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
const closeButton = document.querySelector<HTMLButtonElement>('#close');
const container = document.querySelector<HTMLElement>('#blink-container');

const deposit = new Deposit({
  signer: '/api/blink/sign-payment',
  containerElement: container ?? undefined,
  debug: true,
  preload: false,
});

let blockerDismissedForCurrentFlow = false;
let blockerFlowActive = false;
let blockerUnlockAt = 0;
let blockerCloseVisibleAt = 0;
let blockerUnlockTimer: number | undefined;
let blockerCloseTimer: number | undefined;

function clearBlockerTimers() {
  if (blockerUnlockTimer !== undefined) window.clearTimeout(blockerUnlockTimer);
  if (blockerCloseTimer !== undefined) window.clearTimeout(blockerCloseTimer);
  blockerUnlockTimer = undefined;
  blockerCloseTimer = undefined;
}

function removeBlinkButtonBlockers() {
  document.querySelectorAll('.blink-dead-button-blocker').forEach((node) => node.remove());
}

function updateAllBlockerAffordances() {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>('.blink-dead-button-blocker').forEach((blocker) => {
    blocker.classList.toggle('is-dismissible', now >= blockerUnlockAt);
    blocker.classList.toggle('show-close', now >= blockerCloseVisibleAt);
  });
}

function scheduleBlockerAffordances() {
  clearBlockerTimers();
  blockerUnlockTimer = window.setTimeout(updateAllBlockerAffordances, Math.max(0, blockerUnlockAt - Date.now()));
  blockerCloseTimer = window.setTimeout(updateAllBlockerAffordances, Math.max(0, blockerCloseVisibleAt - Date.now()));
}

function blockBrokenBlinkButton(containerEl: Element) {
  if (!blockerFlowActive || blockerDismissedForCurrentFlow) return;
  if (containerEl.querySelector('.blink-dead-button-blocker')) return;
  const blocker = document.createElement('button');
  blocker.type = 'button';
  blocker.className = 'blink-dead-button-blocker';
  blocker.innerHTML = '<span>👇 click below 👇</span><span class="blink-dead-button-x" aria-hidden="true">×</span>';

  const dismiss = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < blockerUnlockAt) {
      setStatus('Hold up — the overlay unlocks after 5 seconds so people do not accidentally tap the broken Blink button.');
      return;
    }
    blockerDismissedForCurrentFlow = true;
    clearBlockerTimers();
    removeBlinkButtonBlockers();
    setStatus('Overlay dismissed. Tap the Blink control you wanted again.');
  };
  blocker.addEventListener('click', dismiss);
  blocker.addEventListener('pointerdown', (event) => event.stopPropagation());
  blocker.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: false });
  containerEl.appendChild(blocker);
  updateAllBlockerAffordances();
}

function installBlinkButtonBlockers() {
  if (!blockerFlowActive || blockerDismissedForCurrentFlow) return;
  document.querySelectorAll('[data-blink-container]').forEach(blockBrokenBlinkButton);
}

const blinkDomObserver = new MutationObserver(installBlinkButtonBlockers);
blinkDomObserver.observe(document.body, { childList: true, subtree: true });

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

deposit.on('status-change', (status) => {
  if (status === 'signer-loading') setStatus('Preparing signed Blink deposit request…');
  if (status === 'iframe-active') {
    blockerFlowActive = true;
    blockerUnlockAt = Date.now() + 5_000;
    blockerCloseVisibleAt = Date.now() + 10_000;
    scheduleBlockerAffordances();
    installBlinkButtonBlockers();
    setStatus('Blink iframe is open. The blocker unlocks after 5 seconds.');
  }
});

deposit.on('close', () => {
  blockerFlowActive = false;
  blockerDismissedForCurrentFlow = false;
  clearBlockerTimers();
  removeBlinkButtonBlockers();
  setStatus('Blink iframe closed.');
});
deposit.on('error', (error) => {
  setStatus(`Blink deposit failed: ${getDisplayMessage(error)}`, 'error');
});

deposit.on('complete', (result) => {
  setOutput(result);
  setStatus(`Blink transfer complete: ${result.transfer.id} (${result.transfer.status}). Watcher should credit after Base settlement.`);
});

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
  blockerFlowActive = false;
  blockerDismissedForCurrentFlow = false;
  clearBlockerTimers();
  removeBlinkButtonBlockers();
  setStatus('Opening Blink QR deposit flow…');
  try {
    const result = await deposit.requestDeposit({
      amount,
      chainId: BASE_USDC.chainId,
      address: BASE_USDC.bridge,
      token: BASE_USDC.token,
      callbackScheme: null,
      reference: `darkbox-blink-qr-${Date.now()}`,
      metadata: {
        surface: 'telegram-miniapp',
        experiment: 'blink-qr-only-deposit',
        telegramOwner: getTelegramOwner(),
        destination: 'darkbox-base-usdc-bridge',
        fullWidget: 'default',
      },
    });
    setOutput(result);
    setStatus(`Blink transfer complete: ${result.transfer.id} (${result.transfer.status}). Watcher should credit after Base settlement.`);
  } catch (error) {
    const message = error instanceof DepositError ? getDisplayMessage(error) : error instanceof Error ? error.message : String(error);
    setStatus(`Blink deposit failed: ${message}`, 'error');
  } finally {
    createButton?.removeAttribute('disabled');
  }
});

closeButton?.addEventListener('click', () => deposit.close());
window.addEventListener('pagehide', () => {
  blinkDomObserver.disconnect();
  clearBlockerTimers();
  deposit.destroy();
});
