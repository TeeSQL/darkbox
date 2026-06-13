type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  initDataUnsafe?: { user?: { id?: number; username?: string; first_name?: string; last_name?: string } };
  HapticFeedback?: { impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void };
};

type FlowState = {
  transactionId?: string;
  sessionToken?: string;
};

const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

const form = document.querySelector<HTMLFormElement>('#flow-form');
const statusEl = document.querySelector<HTMLElement>('#status');
const outputEl = document.querySelector<HTMLElement>('#output');
const createButton = document.querySelector<HTMLButtonElement>('#create');
const payStep = document.querySelector<HTMLElement>('#pay-step');
const payStatusEl = document.querySelector<HTMLElement>('#pay-status');
const prepareButton = document.querySelector<HTMLButtonElement>('#prepare');
const fromAddressEl = document.querySelector<HTMLInputElement>('#fromAddress');
const fromTokenAddressEl = document.querySelector<HTMLInputElement>('#fromTokenAddress');

const flowState: FlowState = {};

function setStatus(message: string, tone: 'ok' | 'error' = 'ok') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', tone === 'error');
  tg?.HapticFeedback?.impactOccurred?.(tone === 'error' ? 'heavy' : 'light');
}

function setPayStatus(message: string, tone: 'ok' | 'error' = 'ok') {
  if (!payStatusEl) return;
  payStatusEl.textContent = message;
  payStatusEl.classList.toggle('error', tone === 'error');
  payStatusEl.classList.toggle('warning', tone !== 'error');
}

function setOutput(value: unknown) {
  if (outputEl) outputEl.textContent = JSON.stringify(value, null, 2);
}

async function postJson(path: string, payload: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? body.dynamic?.error ?? `Request failed with ${response.status}`);
  return body;
}

function getTelegramOwner() {
  const user = tg?.initDataUnsafe?.user;
  if (!user?.id) return 'web-test-user';
  return user.username ? `telegram:${user.id}:${user.username}` : `telegram:${user.id}`;
}

function summarizePrepared(prepared: any) {
  const tx = prepared?.dynamic?.quote?.signingPayload?.evmTransaction ?? prepared?.dynamic?.transaction?.quote?.signingPayload?.evmTransaction;
  const approval = prepared?.dynamic?.quote?.signingPayload?.evmApproval ?? prepared?.dynamic?.transaction?.quote?.signingPayload?.evmApproval;
  return {
    humanInstructions: [
      'Do not manually transfer to a random address.',
      approval ? '1. First sign the ERC-20 approval shown in evmApproval.' : '1. No separate ERC-20 approval was returned.',
      tx ? '2. Then sign/send the evmTransaction exactly as returned by Dynamic.' : '2. Dynamic did not return an EVM transaction payload yet.',
      '3. After wallet broadcast, report the tx hash to Dynamic /broadcast so settlement can be tracked.',
    ],
    approval,
    transactionToSign: tx,
    raw: prepared,
  };
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
  setStatus('Creating live Dynamic Flow deposit transaction…');
  try {
    const body = await postJson('/api/dynamic-flow/intents', { amount, beneficiary, gameId, memo, telegramOwner: getTelegramOwner() });
    setOutput(body);
    if (body.mode !== 'live') {
      setStatus('Dry run only: Dynamic env/checkout is not configured.', 'error');
      return;
    }
    flowState.transactionId = body.dynamic?.transaction?.id;
    flowState.sessionToken = body.dynamic?.sessionToken;
    if (!flowState.transactionId || !flowState.sessionToken) throw new Error('Dynamic response did not include transaction id/session token');
    payStep?.classList.remove('hidden');
    setStatus('Step 1 done. No money moved yet — continue to Step 2 for the exact wallet tx to sign.');
    setPayStatus(`Ready for payer wallet. Dynamic transaction: ${flowState.transactionId}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    createButton?.removeAttribute('disabled');
  }
});

prepareButton?.addEventListener('click', async () => {
  if (!flowState.transactionId || !flowState.sessionToken) {
    setPayStatus('Create a Dynamic transaction first.', 'error');
    return;
  }
  const fromAddress = fromAddressEl?.value.trim() ?? '';
  const fromTokenAddress = fromTokenAddressEl?.value.trim() ?? '';
  prepareButton.setAttribute('disabled', 'true');
  setPayStatus('Attaching source wallet, getting quote, preparing signing payload…');
  try {
    const shared = { transactionId: flowState.transactionId, sessionToken: flowState.sessionToken };
    const source = await postJson('/api/dynamic-flow/source', { ...shared, fromAddress, fromChainId: '8453', fromChainName: 'EVM' });
    const quote = await postJson('/api/dynamic-flow/quote', { ...shared, fromTokenAddress });
    const prepared = await postJson('/api/dynamic-flow/prepare', shared);
    setOutput({ source, quote, prepared: summarizePrepared(prepared) });
    setPayStatus('Prepared. The Result panel now shows the exact approval/transaction payload the payer wallet must sign.');
  } catch (error) {
    setPayStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    prepareButton.removeAttribute('disabled');
  }
});
