#!/usr/bin/env tsx
/**
 * DarkBox demo noise agents.
 *
 * KISS proof runner for the live demo: derive a few deterministic wallets,
 * fund them with native gas + real ERC20 sUSDC, then create visible on-chain
 * activity against active markets. This deliberately bypasses the old
 * ShadowBridgeController/faucet-worker ledger because Frontier/markets trade
 * ERC20 balances.
 *
 * Required env (inside CVM/overseer env):
 *   HIDDEN_RPC_URL=http://localhost:8545
 *   HIDDEN_CHAIN_ID=88813
 *   NOISE_FUNDER_KEY=0x...              # sealed deployer/minter/gas key; never logged
 *   MARKET_FACTORY_ADDRESS=0x...
 *   SYNTHETIC_USDC_ADDRESS=0x...
 *
 * Optional env:
 *   GATEWAY_URL=https://...-8080.dstack-base-prod5.phala.network
 *   NOISE_AGENT_SEED=darkbox-noise-demo
 *   NOISE_AGENT_COUNT=4
 *   NOISE_MINT_AMOUNT=25000000          # 25 sUSDC each, 6 decimals
 *   NOISE_SPLIT_AMOUNT=1000000          # 1 sUSDC split each run
 *   NOISE_GAS_AMOUNT_WEI=20000000000000000  # 0.02 ETH
 *   NOISE_PLACE_ORDERS=true             # best-effort Frontier deposit after split
 *   NOISE_MARKET_ID=0x...               # override market; otherwise first active/canonical market
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function minter() view returns (address)",
]);

const factoryAbi = parseAbi([
  "function getMarket(bytes32 marketId) view returns (address)",
  "function getBooks(bytes32 marketId) view returns (address yesBook, address noBook)",
]);

const marketAbi = parseAbi([
  "function split(uint256 amount,address receiver) returns (uint256 yesAmount,uint256 noAmount)",
  "function yesToken() view returns (address)",
  "function noToken() view returns (address)",
  "function status() view returns (uint8)",
]);

const bookAbi = parseAbi([
  "function deposit(int24 lower,int24 upper,uint128 liquidity) returns (uint256 positionId)",
  "function currentTick() view returns (int24)",
  "function tickSpacing() view returns (int24)",
]);

interface PublicMarket {
  market_id: Hex;
  question?: string;
  status?: string;
  lifecycle_status?: string;
  resolved_outcome?: string | null;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function asAddress(name: string, value: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  return value as Address;
}

function asHex32(name: string, value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is not bytes32: ${value}`);
  return value as Hex;
}

function deriveNoiseKey(seed: string, i: number): Hex {
  return keccak256(toBytes(`${seed}:${i}`));
}

async function main(): Promise<void> {
  const rpcUrl = env("HIDDEN_RPC_URL");
  const chainId = Number(env("HIDDEN_CHAIN_ID", "88813"));
  const gatewayUrl = env(
    "GATEWAY_URL",
    "https://d52dd8da602484730a36c648ae09672b6e2b1334-8080.dstack-base-prod5.phala.network",
  ).replace(/\/$/, "");
  const funderKey = env("NOISE_FUNDER_KEY").startsWith("0x")
    ? (env("NOISE_FUNDER_KEY") as Hex)
    : (`0x${env("NOISE_FUNDER_KEY")}` as Hex);
  const marketFactory = asAddress("MARKET_FACTORY_ADDRESS", env("MARKET_FACTORY_ADDRESS"));
  const sUsdc = asAddress("SYNTHETIC_USDC_ADDRESS", env("SYNTHETIC_USDC_ADDRESS"));
  const count = Number(env("NOISE_AGENT_COUNT", "4"));
  const seed = env("NOISE_AGENT_SEED", "darkbox-noise-demo");
  const mintAmount = BigInt(env("NOISE_MINT_AMOUNT", "25000000"));
  const splitAmount = BigInt(env("NOISE_SPLIT_AMOUNT", "1000000"));
  const gasAmount = BigInt(env("NOISE_GAS_AMOUNT_WEI", "20000000000000000"));
  const placeOrders = env("NOISE_PLACE_ORDERS", "true") !== "false";

  const chain = {
    id: chainId,
    name: "darkbox-hidden",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const funder = privateKeyToAccount(funderKey);
  const funderWallet = createWalletClient({ account: funder, chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });

  const minter = await publicClient.readContract({ address: sUsdc, abi: erc20Abi, functionName: "minter" });
  if (minter.toLowerCase() !== funder.address.toLowerCase()) {
    throw new Error(`NOISE_FUNDER_KEY signer ${funder.address} is not SyntheticUSDC.minter() ${minter}`);
  }

  const markets = (await fetch(`${gatewayUrl}/public/markets`).then((r) => {
    if (!r.ok) throw new Error(`GET /public/markets failed: ${r.status}`);
    return r.json();
  })) as PublicMarket[];
  const overrideMarket = process.env["NOISE_MARKET_ID"] ? asHex32("NOISE_MARKET_ID", process.env["NOISE_MARKET_ID"]!) : null;
  const chosen = overrideMarket
    ? markets.find((m) => m.market_id.toLowerCase() === overrideMarket.toLowerCase()) ?? ({ market_id: overrideMarket } as PublicMarket)
    : markets.find((m) => m.lifecycle_status === "active" && /canonical/i.test(m.question ?? "")) ??
      markets.find((m) => m.lifecycle_status === "active") ??
      markets[0];
  if (!chosen) throw new Error("No market available from /public/markets");
  const marketId = asHex32("market_id", chosen.market_id);
  const market = await publicClient.readContract({ address: marketFactory, abi: factoryAbi, functionName: "getMarket", args: [marketId] });
  if (market === "0x0000000000000000000000000000000000000000") throw new Error(`Factory has no market for ${marketId}`);
  const [yesBook, noBook] = await publicClient.readContract({ address: marketFactory, abi: factoryAbi, functionName: "getBooks", args: [marketId] });
  const yesToken = await publicClient.readContract({ address: market, abi: marketAbi, functionName: "yesToken" });
  const noToken = await publicClient.readContract({ address: market, abi: marketAbi, functionName: "noToken" });

  console.log("[noise] market", { marketId, question: chosen.question, market, yesBook, noBook, sUsdc });

  for (let i = 0; i < count; i += 1) {
    const account = privateKeyToAccount(deriveNoiseKey(seed, i));
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }) });
    console.log(`[noise:${i}] wallet ${account.address}`);

    const nativeBal = await publicClient.getBalance({ address: account.address });
    if (nativeBal < gasAmount / 2n) {
      const tx = await funderWallet.sendTransaction({ to: account.address, value: gasAmount });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`[noise:${i}] gas funded tx=${tx}`);
    }

    const bal = await publicClient.readContract({ address: sUsdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (bal < splitAmount * 2n) {
      const tx = await funderWallet.writeContract({ address: sUsdc, abi: erc20Abi, functionName: "mint", args: [account.address, mintAmount] });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`[noise:${i}] minted sUSDC tx=${tx}`);
    }

    const allowance = await publicClient.readContract({ address: sUsdc, abi: erc20Abi, functionName: "allowance", args: [account.address, market] });
    if (allowance < splitAmount) {
      const tx = await wallet.writeContract({ address: sUsdc, abi: erc20Abi, functionName: "approve", args: [market, mintAmount] });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`[noise:${i}] approved market tx=${tx}`);
    }

    const splitTx = await wallet.writeContract({ address: market, abi: marketAbi, functionName: "split", args: [splitAmount, account.address] });
    await publicClient.waitForTransactionReceipt({ hash: splitTx });
    console.log(`[noise:${i}] split ${splitAmount} tx=${splitTx}`);

    if (placeOrders) {
      const useYes = i % 2 === 0;
      const token = useYes ? yesToken : noToken;
      const book = useYes ? yesBook : noBook;
      try {
        const orderLiquidity = splitAmount / 10n;
        const tokenAllowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, book] });
        if (tokenAllowance < orderLiquidity) {
          const approveTx = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [book, orderLiquidity] });
          await publicClient.waitForTransactionReceipt({ hash: approveTx });
          console.log(`[noise:${i}] approved ${useYes ? "YES" : "NO"} book tx=${approveTx}`);
        }
        const currentTick = await publicClient.readContract({ address: book, abi: bookAbi, functionName: "currentTick" });
        const spacing = await publicClient.readContract({ address: book, abi: bookAbi, functionName: "tickSpacing" });
        const lower = currentTick + spacing;
        const upper = lower + spacing;
        const depositTx = await wallet.writeContract({ address: book, abi: bookAbi, functionName: "deposit", args: [lower, upper, orderLiquidity] });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        console.log(`[noise:${i}] deposited ${useYes ? "YES" : "NO"} order tx=${depositTx}`);
      } catch (err) {
        console.warn(`[noise:${i}] book deposit skipped:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const refreshed = await fetch(`${gatewayUrl}/public/leaderboard`).then((r) => r.text()).catch((err) => `leaderboard fetch failed: ${err}`);
  console.log("[noise] done. leaderboard sample:", refreshed.slice(0, 1000));
}

main().catch((err) => {
  console.error("[noise] fatal", err);
  process.exit(1);
});
