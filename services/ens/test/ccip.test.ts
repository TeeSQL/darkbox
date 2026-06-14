import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Hex,
  concatHex,
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  recoverAddress,
  stringToHex,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CcipGateway, decodeDnsName } from '../src/ccip.js';
import { EnsRegistry, PRE_GAME_KEYS } from '../src/records.js';

// Deterministic test signer key (well-known anvil key #0).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const RESOLVER = '0x1111111111111111111111111111111111111111';
const NODE = '0x' + '00'.repeat(32) as Hex; // node is unused by the gateway (lookup is by name)

const RESOLVE_SERVICE_ABI = [
  { name: 'resolve', type: 'function', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
] as const;
const RESOLVER_ABI = [
  { name: 'text', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;

function dnsEncode(name: string): Hex {
  const parts = name.split('.').map((label) => {
    const bytes = stringToHex(label).slice(2);
    return numberToHex(label.length, { size: 1 }).slice(2) + bytes;
  });
  return ('0x' + parts.join('') + '00') as Hex;
}

function preGameTexts(): Record<string, string> {
  return Object.fromEntries(PRE_GAME_KEYS.map((key) => [key, `v:${key}`]));
}

function seededRegistry(): EnsRegistry {
  const registry = new EnsRegistry();
  registry.register('alice.darkbox.eth', '0x00000000000000000000000000000000000000aa', preGameTexts());
  return registry;
}

/** Re-implements OffchainResolver.resolveWithProof's verification in TS. */
async function verify(sender: Hex, request: Hex, response: Hex): Promise<{ signer: Hex; result: Hex }> {
  const [result, expires, sig] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    response,
  ) as [Hex, bigint, Hex];
  const digest = keccak256(
    concatHex(['0x1900', sender, numberToHex(expires, { size: 8 }), keccak256(request), keccak256(result)]),
  );
  const signer = await recoverAddress({ hash: digest, signature: sig });
  return { signer, result };
}

test('text() resolves the darkbox record and the proof verifies against the configured signer', async () => {
  const gateway = new CcipGateway(seededRegistry(), { privateKey: PK, ttlSeconds: 300, now: () => 1_700_000_000_000 });
  const inner = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'text', args: [NODE, 'darkbox:gameId'] });
  const request = encodeFunctionData({ abi: RESOLVE_SERVICE_ABI, functionName: 'resolve', args: [dnsEncode('alice.darkbox.eth'), inner] });

  const response = await gateway.resolve(RESOLVER, request);
  const { signer, result } = await verify(RESOLVER, request, response);

  assert.equal(signer.toLowerCase(), privateKeyToAccount(PK).address.toLowerCase());
  const [value] = decodeAbiParameters([{ type: 'string' }], result) as [string];
  assert.equal(value, 'v:darkbox:gameId');
});

test('text() for an unknown name resolves to empty string (still signed)', async () => {
  const gateway = new CcipGateway(seededRegistry(), { privateKey: PK, ttlSeconds: 300 });
  const inner = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'text', args: [NODE, 'darkbox:gameId'] });
  const request = encodeFunctionData({ abi: RESOLVE_SERVICE_ABI, functionName: 'resolve', args: [dnsEncode('ghost.darkbox.eth'), inner] });

  const { signer, result } = await verify(RESOLVER, request, await gateway.resolve(RESOLVER, request));
  assert.equal(signer.toLowerCase(), privateKeyToAccount(PK).address.toLowerCase());
  const [value] = decodeAbiParameters([{ type: 'string' }], result) as [string];
  assert.equal(value, '');
});

test('addr() resolves to the record owner', async () => {
  const gateway = new CcipGateway(seededRegistry(), { privateKey: PK, ttlSeconds: 300 });
  const inner = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'addr', args: [NODE] });
  const request = encodeFunctionData({ abi: RESOLVE_SERVICE_ABI, functionName: 'resolve', args: [dnsEncode('alice.darkbox.eth'), inner] });

  const { result } = await verify(RESOLVER, request, await gateway.resolve(RESOLVER, request));
  const [addr] = decodeAbiParameters([{ type: 'address' }], result) as [Hex];
  assert.equal(addr.toLowerCase(), '0x00000000000000000000000000000000000000aa');
});

test('decodeDnsName round-trips', () => {
  assert.equal(decodeDnsName(dnsEncode('alice.darkbox.eth')), 'alice.darkbox.eth');
});
