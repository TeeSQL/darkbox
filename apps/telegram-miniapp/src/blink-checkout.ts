/**
 * Inline "Feed the daemon" Blink checkout for the seal screen.
 *
 * Layers on top of the existing funding flow: a returning player (already
 * claimed the $5 promo) deposits their own USDC without leaving the Mini App.
 * It reuses the shared gateway client (`window.DarkboxGateway`) for the authed
 * order + reconciliation, and opens Blink's hosted iframe inline:
 *
 *   1. window.DarkboxGateway.createDepositIntent({ amount }) → authed order,
 *      bound to the player's owner+shadowAccount with a tagged exactDepositAmount;
 *   2. open Blink for that exact amount → the Base USDC bridge escrow;
 *   3. poll window.DarkboxGateway.getDeposit(id) until credited.
 *
 * Graceful degradation: if the order has no `exactDepositAmount` (the gateway
 * CVM hasn't been redeployed with the functional deposit routes yet), it shows
 * "deposits opening soon" instead of opening a broken Blink window.
 *
 * flow.js (plain JS) drives this via `window.DarkboxFeed.open()`.
 */
import { Deposit, DepositError, getDisplayMessage } from '@swype-org/deposit';

type TelegramWebApp = {
  initDataUnsafe?: { user?: { id?: number; username?: string; first_name?: string; last_name?: string } };
  HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void };
};

type DepositOrder = {
  depositOpId: string;
  status?: string;
  exactDepositAmount?: string;
  depositAddress?: string;
  tokenAddress?: string;
  chainId?: number;
  depositRef?: string;
  beneficiary?: string;
  shadowAccount?: string;
};

type GatewayClient = {
  createDepositIntent: (opts: { amount: string }) => Promise<DepositOrder>;
  getDeposit: (depositOpId: string) => Promise<DepositOrder>;
};

const MIN_USDC = 1;
// Blink signer is locked to $25 and the gateway reserves ~$0.01 for the
// reconciliation tag, so the most a player can request is $24.99.
const MAX_USDC = 24.99;
// Base USDC bridge escrow + token, used for the client-side fallback order when
// the gateway can't issue a tagged order yet (so the Blink payment still works).
const BASE_USDC_BRIDGE = '0x55E84818FCEDc3E892A22b46715Ee2B4A947E138';
const BASE_USDC_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 4 * 60_000;

const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
function haptic(style: 'light' | 'medium' | 'heavy') { tg?.HapticFeedback?.impactOccurred?.(style); }
function telegramOwner(): string {
  const user = tg?.initDataUnsafe?.user;
  if (!user?.id) return 'telegram:unknown';
  const name = user.username || [user.first_name, user.last_name].filter(Boolean).join('-') || 'telegram-user';
  return `telegram:${user.id}:${name}`;
}
function gw(): GatewayClient | null {
  return (window as unknown as { DarkboxGateway?: GatewayClient }).DarkboxGateway ?? null;
}

// ─── Modal (built lazily, styled via styles.css) ──────────────────────────────
let modalEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let amountInput: HTMLInputElement | null = null;
let submitBtn: HTMLButtonElement | null = null;
let containerEl: HTMLElement | null = null;
let deposit: Deposit | null = null;
let pollTimer: number | undefined;
let currentOrder: DepositOrder | null = null;
let onCreditedCb: ((order: DepositOrder) => void) | null = null;

function setStatus(message: string, tone: 'ok' | 'error' | 'work' = 'ok') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  haptic(tone === 'error' ? 'heavy' : 'light');
}

function ensureModal(): void {
  if (modalEl) return;
  const modal = document.createElement('div');
  modal.className = 'feed-modal';
  modal.id = 'feed-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'feed-modal-title');
  modal.hidden = true;
  modal.innerHTML = `
    <button class="feed-scrim" type="button" data-feed-close aria-label="Close feed the daemon"></button>
    <section class="feed-panel">
      <div class="feed-head">
        <span class="feed-kicker">FEED THE DAEMON</span>
        <button class="feed-close" type="button" data-feed-close aria-label="Close">&times;</button>
      </div>
      <h2 id="feed-modal-title">give it more to chew on.</h2>
      <p class="feed-copy">USDC you feed settles to <em>your</em> daemon's account — the same account you control. Pay from any chain with Blink.</p>
      <form class="feed-form" id="feed-form">
        <label class="feed-label" for="feed-amount">Amount · USDC</label>
        <input id="feed-amount" name="amount" class="feed-amount" type="number" inputmode="decimal"
               min="${MIN_USDC}" max="${MAX_USDC}" step="0.01" value="20.00" autocomplete="off" />
        <button id="feed-submit" class="feed-submit" type="submit">open blink &rarr;</button>
      </form>
      <div id="feed-status" class="feed-status" data-tone="ok">Pick an amount, then pay in the Blink window.</div>
      <div id="feed-blink" class="feed-blink" data-blink-container></div>
    </section>
  `;
  document.body.appendChild(modal);
  modalEl = modal;
  statusEl = modal.querySelector<HTMLElement>('#feed-status');
  amountInput = modal.querySelector<HTMLInputElement>('#feed-amount');
  submitBtn = modal.querySelector<HTMLButtonElement>('#feed-submit');
  containerEl = modal.querySelector<HTMLElement>('#feed-blink');
  modal.querySelectorAll<HTMLElement>('[data-feed-close]').forEach((el) => el.addEventListener('click', close));
  modal.querySelector<HTMLFormElement>('#feed-form')?.addEventListener('submit', onSubmit);

  deposit = new Deposit({
    signer: '/api/blink/sign-payment',
    containerElement: containerEl ?? undefined,
    debug: false,
    preload: false,
  });
  deposit.on('error', (error) => setStatus(`Blink failed: ${getDisplayMessage(error)}`, 'error'));
}

// ─── Blink "dead button" overlay blocker (Blink's iframe briefly renders a broken control) ──
let blockerActive = false;
let blockerDismissed = false;
let blockerUnlockAt = 0;
let blockerObserver: MutationObserver | null = null;
function removeBlockers() { document.querySelectorAll('.feed-blink-blocker').forEach((n) => n.remove()); }
function installBlockers() {
  if (!blockerActive || blockerDismissed || !containerEl) return;
  if (containerEl.querySelector('.feed-blink-blocker')) return;
  const blocker = document.createElement('button');
  blocker.type = 'button';
  blocker.className = 'feed-blink-blocker';
  blocker.innerHTML = '<span>👇 use the deposit details below 👇</span>';
  blocker.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < blockerUnlockAt) { setStatus('Hold on — the overlay unlocks in a moment.', 'work'); return; }
    blockerDismissed = true;
    removeBlockers();
  });
  blocker.addEventListener('pointerdown', (e) => e.stopPropagation());
  containerEl.appendChild(blocker);
}
function startBlockerWatch() {
  blockerActive = true; blockerDismissed = false; blockerUnlockAt = Date.now() + 5000;
  if (!blockerObserver) { blockerObserver = new MutationObserver(installBlockers); blockerObserver.observe(document.body, { childList: true, subtree: true }); }
  installBlockers();
}
function stopBlockerWatch() { blockerActive = false; removeBlockers(); blockerObserver?.disconnect(); blockerObserver = null; }

// ─── Reconciliation polling ───────────────────────────────────────────────────
function stopPolling() { if (pollTimer !== undefined) window.clearTimeout(pollTimer); pollTimer = undefined; }
function describe(status: string | undefined): { text: string; tone: 'ok' | 'work' } {
  switch (status) {
    case 'credited': return { text: 'Fed. Your daemon has the funds — sealed to your account.', tone: 'ok' };
    case 'expired': return { text: 'This order expired before settlement. You can start a new feed.', tone: 'work' };
    default: return { text: 'Settling on Base… reconciling your deposit to your account.', tone: 'work' };
  }
}
function pollDepositStatus(depositOpId: string, deadline: number): void {
  const client = gw();
  if (!client) return;
  stopPolling();
  pollTimer = window.setTimeout(async () => {
    try {
      const order = await client.getDeposit(depositOpId);
      currentOrder = order;
      const { text, tone } = describe(order.status);
      setStatus(text, tone);
      if (order.status === 'credited') { onCreditedCb?.(order); return; }
      if (order.status === 'expired') return;
      if (Date.now() < deadline) pollDepositStatus(depositOpId, deadline);
    } catch (_error) {
      if (Date.now() < deadline) pollDepositStatus(depositOpId, deadline);
    }
  }, POLL_INTERVAL_MS);
}

// ─── Flow ─────────────────────────────────────────────────────────────────────
async function onSubmit(event: Event) {
  event.preventDefault();
  const client = gw();
  if (!deposit || !amountInput) return;
  if (!client) { setStatus('Deposits are not available here yet.', 'error'); return; }
  const amount = Number(amountInput.value);
  if (!Number.isFinite(amount) || amount < MIN_USDC || amount > MAX_USDC) {
    setStatus(`Enter an amount between ${MIN_USDC} and ${MAX_USDC} USDC.`, 'error');
    return;
  }

  submitBtn?.setAttribute('disabled', 'true');
  stopPolling();
  removeBlockers();
  setStatus('Creating your signed deposit order…', 'work');

  try {
    // Prefer the authed gateway order; if the gateway can't issue one yet (stub /
    // not redeployed, or it errors), fall back to a client-side order to the Base
    // USDC bridge so the Blink payment still works for a demo. Reconciliation
    // (crediting) follows once the functional gateway/bridge is live.
    let order: DepositOrder | null = null;
    try {
      order = await client.createDepositIntent({ amount: amount.toFixed(2) });
    } catch (e) {
      const body = (e as { body?: { error?: string; cap?: string; maxRequestable?: string } }).body;
      if (body?.error === 'amount_exceeds_cap') {
        setStatus(`Max deposit is $${body.maxRequestable ?? MAX_USDC} (demo cap $${body.cap ?? '25'}).`, 'error');
        submitBtn?.removeAttribute('disabled');
        return;
      }
      // otherwise fall through to the client-side fallback
    }
    currentOrder = order;

    const gatewayReady = Boolean(order && order.exactDepositAmount && order.depositAddress && order.tokenAddress);
    const effective: DepositOrder = gatewayReady && order ? order : {
      depositOpId: (order && order.depositOpId) || `dbx-demo-${Date.now()}`,
      exactDepositAmount: amount.toFixed(2),
      depositAddress: BASE_USDC_BRIDGE,
      tokenAddress: BASE_USDC_TOKEN,
      chainId: 8453,
      depositRef: (order && order.depositRef) || `dbx-demo-${Date.now()}`,
      beneficiary: (order && order.beneficiary) || '',
      shadowAccount: (order && order.shadowAccount) || '',
    };

    setStatus('Opening Blink — pay the amount shown.', 'work');
    startBlockerWatch();
    const result = await deposit.requestDeposit({
      amount: Number(effective.exactDepositAmount),
      chainId: effective.chainId ?? 8453,
      address: effective.depositAddress as string,
      token: effective.tokenAddress as string,
      callbackScheme: null,
      reference: effective.depositRef ?? effective.depositOpId,
      metadata: {
        surface: 'telegram-miniapp',
        flow: 'feed-the-daemon',
        depositOpId: effective.depositOpId,
        telegramOwner: telegramOwner(),
        beneficiary: effective.beneficiary ?? '',
        shadowAccount: effective.shadowAccount ?? '',
      },
    });
    stopBlockerWatch();

    setStatus(`Transfer submitted (${result.transfer.id}). Settling on Base…`, 'work');
    if (gatewayReady && order) pollDepositStatus(order.depositOpId, Date.now() + POLL_TIMEOUT_MS);
  } catch (error) {
    stopBlockerWatch();
    const message = error instanceof DepositError ? getDisplayMessage(error)
      : error instanceof Error ? error.message : String(error);
    setStatus(`Could not start the deposit: ${message}`, 'error');
  } finally {
    submitBtn?.removeAttribute('disabled');
  }
}

function open(options?: { amount?: number; onCredited?: (order: DepositOrder) => void }): void {
  ensureModal();
  if (!modalEl) return;
  onCreditedCb = options?.onCredited ?? null;
  if (options?.amount && amountInput) amountInput.value = options.amount.toFixed(2);
  modalEl.hidden = false;
  document.body.classList.add('feed-open');
  setStatus(gw() ? 'Pick an amount, then pay in the Blink window.' : 'Deposits are not available here yet.', gw() ? 'ok' : 'work');
  haptic('medium');
  window.setTimeout(() => amountInput?.focus(), 60);
}

function close(): void {
  stopPolling();
  stopBlockerWatch();
  try { deposit?.close(); } catch (_error) { /* iframe may already be gone */ }
  if (modalEl) modalEl.hidden = true;
  document.body.classList.remove('feed-open');
}

declare global {
  interface Window {
    DarkboxFeed?: { open: typeof open; close: typeof close; lastOrder: () => DepositOrder | null };
  }
}
window.DarkboxFeed = { open, close, lastOrder: () => currentOrder };
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && modalEl && !modalEl.hidden) close(); });
window.addEventListener('pagehide', () => { stopPolling(); stopBlockerWatch(); try { deposit?.destroy(); } catch (_error) { /* noop */ } });
