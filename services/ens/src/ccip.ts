/**
 * ERC-3668 (CCIP-Read) gateway for the DarkBox offchain ENS resolver.
 *
 * An `OffchainResolver` set as the resolver for `darkbox.eth` reverts client
 * lookups with `OffchainLookup`, pointing the client at this gateway. The
 * client calls us with `(sender, data)` where:
 *   - `sender` is the resolver contract address
 *   - `data`   is `IResolverService.resolve(bytes name, bytes data)` calldata
 *
 * We decode the wrapped resolver call (`text(node,key)` / `addr(node)`),
 * answer it from the in-memory {@link EnsRegistry}, and return an
 * EIP-191/`0x1900`-style signed response that `OffchainResolver.resolveWithProof`
 * verifies against the configured signer. The signature format mirrors the
 * canonical ensdomains `SignatureVerifier.makeSignatureHash`:
 *
 *   keccak256(0x1900 ‖ resolver ‖ expires(uint64) ‖ keccak256(request) ‖ keccak256(result))
 *
 * Records live entirely offchain (in the registry), so issuing
 * `<agent>.darkbox.eth` costs zero gas per agent.
 */
import {
  type Address,
  type Hex,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  numberToHex,
  parseAbi,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { EnsRegistry } from './records.js';

/** `IResolverService.resolve(bytes name, bytes data)` — what the gateway receives. */
const RESOLVE_SERVICE_ABI = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes)']);

/** The wrapped resolver methods we answer. */
const RESOLVER_ABI = parseAbi([
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
]);

export interface GatewayConfig {
  /** 0x-prefixed private key for the gateway signer (must match OffchainResolver's signer). */
  privateKey: Hex;
  /** Seconds a signed answer stays valid. */
  ttlSeconds: number;
  /** Clock injection for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

export class CcipGateway {
  private readonly account;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly registry: EnsRegistry, config: GatewayConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.ttl = config.ttlSeconds;
    this.now = config.now ?? (() => Date.now());
  }

  /** Address the OffchainResolver must trust as a signer. */
  get signerAddress(): Address {
    return this.account.address;
  }

  /**
   * Handle one CCIP-Read call.
   * @param sender resolver contract address (lowercased or checksummed hex)
   * @param data   `resolve(name, data)` calldata from the OffchainLookup
   * @returns abi.encode(result bytes, expires uint64, signature bytes)
   */
  async resolve(sender: Address, data: Hex): Promise<Hex> {
    const { args } = decodeFunctionData({ abi: RESOLVE_SERVICE_ABI, data });
    const [dnsName, inner] = args as [Hex, Hex];
    const name = decodeDnsName(dnsName);
    const result = this.answer(name, inner);

    const expires = BigInt(Math.floor(this.now() / 1000) + this.ttl);
    const digest = keccak256(
      concatHex([
        '0x1900',
        sender,
        numberToHex(expires, { size: 8 }),
        keccak256(data),
        keccak256(result),
      ]),
    );
    const signature = await this.account.sign({ hash: digest });

    return encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, signature],
    );
  }

  /** Resolve the wrapped call to its ABI-encoded return value. */
  private answer(name: string, inner: Hex): Hex {
    const decoded = decodeFunctionData({ abi: RESOLVER_ABI, data: inner });
    const record = this.registry.get(name);

    if (decoded.functionName === 'text') {
      const [, key] = decoded.args as [Hex, string];
      const value = record?.texts[key] ?? '';
      return encodeAbiParameters([{ type: 'string' }], [value]);
    }
    // addr(node): we don't custody agent EVM addresses here, so resolve to the
    // record owner if it parses as an address, else the zero address.
    const owner = record?.owner;
    const addr = owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? (owner as Address) : zeroAddress;
    return encodeAbiParameters([{ type: 'address' }], [addr]);
  }
}

/** Decode DNS wire-format name (length-prefixed labels, 0x00 terminated) to a dotted string. */
export function decodeDnsName(encoded: Hex): string {
  const bytes = hexToBytes(encoded);
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i++]!;
    if (len === 0) break;
    labels.push(new TextDecoder().decode(bytes.slice(i, i + len)));
    i += len;
  }
  return labels.join('.');
}
