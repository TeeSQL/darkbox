import { createSign, randomUUID } from 'node:crypto';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*$/;

export type BlinkSignerRequest = {
  amount?: unknown;
  chainId?: unknown;
  address?: unknown;
  token?: unknown;
  callbackScheme?: unknown;
  version?: unknown;
  reference?: unknown;
  metadata?: unknown;
};

export type BlinkSignerResponse = {
  merchantId: string;
  payload: string;
  signature: string;
  preview: {
    amount: number;
    chainId: number;
    address: string;
    token: string;
    idempotencyKey: string;
  };
};

export function validateBlinkSignerRequest(body: BlinkSignerRequest): string[] {
  const errors: string[] = [];
  const { amount, chainId, address, token, callbackScheme, version } = body;

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    errors.push('amount must be a positive number.');
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    errors.push('chainId must be a positive integer.');
  }
  if (typeof address !== 'string' || !EVM_ADDRESS_RE.test(address)) {
    errors.push('address must be a 0x-prefixed, 40-character hex string.');
  }
  if (typeof token !== 'string' || !EVM_ADDRESS_RE.test(token)) {
    errors.push('token must be a 0x-prefixed, 40-character hex contract address.');
  }
  if (callbackScheme !== null && callbackScheme !== undefined && (typeof callbackScheme !== 'string' || !URI_SCHEME_RE.test(callbackScheme))) {
    errors.push('callbackScheme must be null or a valid URI scheme.');
  }
  if (version !== undefined && typeof version !== 'string') {
    errors.push('version must be a string when provided.');
  }

  return errors;
}

export function signBlinkDepositRequest(params: {
  merchantId: string;
  privateKeyPem: string;
  request: BlinkSignerRequest;
  allowed?: {
    chainId?: number;
    address?: string;
    token?: string;
    maxAmount?: number;
  };
}): BlinkSignerResponse {
  const errors = validateBlinkSignerRequest(params.request);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }

  const amount = params.request.amount as number;
  const chainId = params.request.chainId as number;
  const address = params.request.address as string;
  const token = params.request.token as string;

  if (params.allowed?.maxAmount !== undefined && amount > params.allowed.maxAmount) {
    throw new Error(`amount exceeds configured maximum of ${params.allowed.maxAmount}.`);
  }
  if (params.allowed?.chainId !== undefined && chainId !== params.allowed.chainId) {
    throw new Error('chainId is not allowed by this signer.');
  }
  if (params.allowed?.address && address.toLowerCase() !== params.allowed.address.toLowerCase()) {
    throw new Error('destination address is not allowed by this signer.');
  }
  if (params.allowed?.token && token.toLowerCase() !== params.allowed.token.toLowerCase()) {
    throw new Error('token is not allowed by this signer.');
  }
  const callbackScheme = (params.request.callbackScheme ?? null) as string | null;
  const version = (params.request.version as string | undefined) ?? 'v1';
  const idempotencyKey = randomUUID();
  const signatureTimestamp = new Date().toISOString();

  // Field order follows Blink signer docs.
  const payloadObject = {
    amount,
    chainId,
    address,
    token,
    idempotencyKey,
    callbackScheme,
    signatureTimestamp,
    version,
  };

  const payload = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64url');
  const signer = createSign('SHA256');
  signer.update(payload);
  signer.end();
  const signature = signer.sign(params.privateKeyPem).toString('base64url');

  return {
    merchantId: params.merchantId,
    payload,
    signature,
    preview: { amount, chainId, address, token, idempotencyKey },
  };
}
