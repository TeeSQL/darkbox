/**
 * Real viem-backed DemoFaucetChain.
 *
 * Talks to the fresh chain over the indexer's HIDDEN_RPC_URL (localhost:8545 on
 * the core) using the sealed minter key. The key is read from config (env-only)
 * and is NEVER logged — only the derived signer address, the recipient, and the
 * resulting tx hash ever leave this module.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DemoFaucetChain } from "./faucet.js";

// Minimal SyntheticUSDC surface: mint(to, amount) onlyMinter + minter() view.
export const syntheticUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function minter() view returns (address)",
]);

export interface ViemChainOptions {
  rpcUrl: string;
  chainId: number;
  minterKey: string; // 0x-prefixed private key (env-only)
  tokenAddress: Address;
}

/**
 * Build a viem chain client. Throws if the minter key is malformed so the route
 * can fall back to a clean "not configured" 503 rather than a half-built client.
 */
export function createViemChain(opts: ViemChainOptions): DemoFaucetChain {
  const key = (opts.minterKey.startsWith("0x") ? opts.minterKey : `0x${opts.minterKey}`) as Hex;
  const account = privateKeyToAccount(key);

  // A minimal chain descriptor is enough for a raw RPC + chainId; we never need
  // block explorers or ENS here.
  const chain = {
    id: opts.chainId,
    name: "darkbox-hidden",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  } as const;

  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });

  return {
    signerAddress(): Address {
      return account.address;
    },
    async readMinter(): Promise<Address> {
      return publicClient.readContract({
        address: opts.tokenAddress,
        abi: syntheticUsdcAbi,
        functionName: "minter",
      });
    },
    async mint(to: Address, amount: bigint): Promise<Hex> {
      const txHash = await walletClient.writeContract({
        address: opts.tokenAddress,
        abi: syntheticUsdcAbi,
        functionName: "mint",
        args: [to, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
    async fundGas(to: Address, weiAmount: bigint): Promise<Hex> {
      // Native ETH drip from the minter (genesis-funded) so the recipient can pay
      // gas to trade. Same account/chain as the mint — viem handles gas/fees.
      const txHash = await walletClient.sendTransaction({ account, chain, to, value: weiAmount });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
  };
}
