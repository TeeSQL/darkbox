#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type AgentIdentity = {
  agentId: string;
  address: Address;
  shadowAccount: Hex;
};

type IdentityFile = { agents: AgentIdentity[] };

type DeploymentFile = {
  darkbox?: { syntheticUSDC?: Address; marketFactory?: Address };
  canonicalMarket?: { marketId?: Hex; market?: Address };
};

const shadowBridgeControllerAbi = parseAbi([
  'function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, uint256 amount)',
  'function withdrawableBalance(bytes32 shadowAccount) view returns (uint256)',
  'event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount)',
]);

const marketAbi = parseAbi([
  'function split(uint256 amount, address receiver) external returns (uint256 yesAmount, uint256 noAmount)',
]);

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((v) => v.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1) return process.argv[idx + 1] ?? fallback;
  return fallback;
}

function req(name: string, value?: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function chain(id: number, rpc: string) {
  return defineChain({
    id,
    name: `hidden-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function findExistingMint(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  controller: Address;
  depositOpId: Hex;
  fromBlock: bigint;
}): Promise<Hex | null> {
  const logs = await params.publicClient.getLogs({
    address: params.controller,
    event: shadowBridgeControllerAbi[2],
    args: { depositOpId: params.depositOpId },
    fromBlock: params.fromBlock,
    toBlock: 'latest',
  });
  return logs[0]?.transactionHash ?? null;
}

async function main() {
  const rpcUrl = req('HIDDEN_RPC_URL', arg('rpc-url', process.env.HIDDEN_RPC_URL));
  const chainId = Number(req('HIDDEN_CHAIN_ID', arg('chain-id', process.env.HIDDEN_CHAIN_ID ?? '88813')));
  const controller = getAddress(req('SHADOW_BRIDGE_CONTROLLER_ADDRESS', arg('controller', process.env.SHADOW_BRIDGE_CONTROLLER_ADDRESS)));
  const coordinatorPrivateKey = req('COORDINATOR_PRIVATE_KEY', arg('private-key', process.env.COORDINATOR_PRIVATE_KEY)) as Hex;
  const fromBlock = BigInt(arg('from-block', process.env.FROM_BLOCK ?? '0')!);
  const identitiesPath = path.resolve(arg('identities', 'services/agents/config/agent-identities.json')!);
  const deploymentsPath = path.resolve(arg('deployments', 'packages/contracts/deployments/darkbox-latest.json')!);
  const marketAddressArg = arg('market', process.env.DARKBOX_MARKET_ADDRESS);
  const splitAmountUnits = arg('split-usdc', process.env.SPLIT_USDC ?? '1');
  const mintAmountUnits = arg('mint-usdc', process.env.MINT_USDC ?? '5');
  const count = Number(arg('count', process.env.DEMO_AGENT_COUNT ?? '3'));
  const dryRun = process.argv.includes('--dry-run');

  const units = 1_000_000n;
  const mintAmount = BigInt(Math.round(Number(mintAmountUnits) * 1_000_000));
  const splitAmount = BigInt(Math.round(Number(splitAmountUnits) * 1_000_000));

  if (!Number.isFinite(count) || count <= 0) throw new Error('count must be positive');
  if (mintAmount <= 0n) throw new Error('mint amount must be > 0');
  if (splitAmount < 0n) throw new Error('split amount must be >= 0');

  const identities = (await readJson<IdentityFile>(identitiesPath)).agents.slice(0, count);
  if (identities.length === 0) throw new Error('no agent identities found');

  const deployments = await readJson<DeploymentFile>(deploymentsPath);
  const marketAddress = getAddress(marketAddressArg ?? req('canonical market', deployments.canonicalMarket?.market));
  const susdc = getAddress(req('syntheticUSDC', deployments.darkbox?.syntheticUSDC));

  const account = privateKeyToAccount(coordinatorPrivateKey);
  const net = chain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain: net, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: net, transport: http(rpcUrl) });

  const plan = identities.map((agent, index) => ({
    agentId: agent.agentId,
    address: agent.address,
    shadowAccount: agent.shadowAccount,
    mintOpId: `0x${(BigInt('0x' + Buffer.from(`darkbox:demo-noise:v1:${agent.agentId}:${agent.address.toLowerCase()}`).toString('hex')) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0')}` as Hex,
    splitAmount,
    mintAmount,
    ordinal: index + 1,
  }));

  if (dryRun) {
    console.log(JSON.stringify({
      mode: 'dry_run',
      coordinator: account.address,
      rpcUrl,
      chainId,
      controller,
      susdc,
      marketAddress,
      plan: plan.map((p) => ({ ...p, mintAmount: p.mintAmount.toString(), splitAmount: p.splitAmount.toString() })),
    }, null, 2));
    return;
  }

  const results: Array<Record<string, unknown>> = [];

  for (const item of plan) {
    const existingMint = await findExistingMint({ publicClient, controller, depositOpId: item.mintOpId, fromBlock });
    let mintTx = existingMint;
    if (!mintTx) {
      const { request } = await publicClient.simulateContract({
        account,
        address: controller,
        abi: shadowBridgeControllerAbi,
        functionName: 'mintShadow',
        args: [item.mintOpId, item.address, item.shadowAccount, item.mintAmount],
      });
      mintTx = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: mintTx });
    }

    const withdrawable = await publicClient.readContract({
      address: controller,
      abi: shadowBridgeControllerAbi,
      functionName: 'withdrawableBalance',
      args: [item.shadowAccount],
    });

    let splitTx: Hex | null = null;
    if (item.splitAmount > 0n) {
      const { request } = await publicClient.simulateContract({
        account,
        address: marketAddress,
        abi: marketAbi,
        functionName: 'split',
        args: [item.splitAmount, item.address],
      });
      splitTx = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: splitTx });
    }

    const susdcBalance = await publicClient.readContract({
      address: susdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [item.address],
    });

    results.push({
      agentId: item.agentId,
      address: item.address,
      shadowAccount: item.shadowAccount,
      mintOpId: item.mintOpId,
      mintTx,
      splitTx,
      withdrawable: withdrawable.toString(),
      walletSusdc: susdcBalance.toString(),
      mintedUsdc: formatUnits(item.mintAmount, 6),
      splitUsdc: formatUnits(item.splitAmount, 6),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    coordinator: account.address,
    rpcUrl,
    chainId,
    controller,
    susdc,
    marketAddress,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
