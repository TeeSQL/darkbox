/**
 * End-to-end smoke test for the DarkBox deposit + withdrawal vertical slice
 * against live chains (spec section 17 "End-to-end").
 *
 * Public chain  = a real testnet (or local anvil) hosting `DarkBoxBridge` + USDC.
 * Shadow chain  = a local anvil hosting `ShadowBridgeController`.
 * (For a fully local run both can be the same anvil RPC.)
 *
 * It plays the bridge service + signing service against deployed contracts:
 *   deposit USDC -> shadow mint -> withdrawable balance -> sign command ->
 *   forced burn -> signing-service authorization -> public withdraw.
 *
 * All inputs come from env (see printed requirements / .env.smoke.example).
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  WithdrawalState,
  bridgeDomain,
  deriveShadowAccount,
  WITHDRAW_COMMAND_TYPES,
  type WithdrawCommand,
} from "@darkbox/shared";
import {
  DepositCoordinator,
  InMemoryAuthorizationStore,
  InMemoryBridgeStore,
  SigningService,
  ViemNonceChecker,
  ViemShadowBurnSubmitter,
  ViemShadowMintSubmitter,
  WithdrawalCoordinator,
  darkBoxBridgeAbi,
  erc20Abi,
  normalizeDepositEvent,
} from "../src/index.js";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\nMissing required env: ${name}`);
    printRequirements();
    process.exit(1);
  }
  return v;
}

function printRequirements() {
  console.error(`
Required env for the smoke test:
  PUBLIC_RPC_URL                    public chain RPC (testnet or local anvil)
  SHADOW_RPC_URL                    shadow chain RPC (local anvil; may equal PUBLIC_RPC_URL)
  BASE_CHAIN_ID                     public chain id (e.g. 84532 for Base Sepolia)
  SHADOW_CHAIN_ID                   shadow chain id (e.g. 31337 for anvil)
  BRIDGE_ADDRESS                    deployed DarkBoxBridge
  SHADOW_BRIDGE_CONTROLLER_ADDRESS  deployed ShadowBridgeController
  USDC_ADDRESS                      ERC20 used as USDC (the deployed mock works)
  GAME_ID                           bytes32 game id
  USER_PRIVATE_KEY                  depositor/withdrawer (needs gas + USDC)
  COORDINATOR_PRIVATE_KEY           shadow controller coordinator (needs shadow gas)
  SIGNER_PRIVATE_KEY                signing-service key (MUST match bridge signer)
Optional:
  RECIPIENT_ADDRESS                 withdrawal recipient (default: user)
  AMOUNT_USDC                       deposit amount in whole USDC (default: 100)
  WITHDRAW_USDC                     withdraw amount in whole USDC (default: 40)
  CONFIRMATIONS_REQUIRED            default 1
  USDC_IS_MINTABLE                  "true" to mint test USDC to the user first
`);
}

function chain(id: number, rpc: string) {
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

async function main() {
  const publicRpc = reqEnv("PUBLIC_RPC_URL");
  const shadowRpc = reqEnv("SHADOW_RPC_URL");
  const publicChainId = Number(reqEnv("BASE_CHAIN_ID"));
  const shadowChainId = Number(reqEnv("SHADOW_CHAIN_ID"));
  const bridge = reqEnv("BRIDGE_ADDRESS") as Address;
  const controller = reqEnv("SHADOW_BRIDGE_CONTROLLER_ADDRESS") as Address;
  const usdc = reqEnv("USDC_ADDRESS") as Address;
  const gameId = reqEnv("GAME_ID") as Hex;

  const userAccount = privateKeyToAccount(reqEnv("USER_PRIVATE_KEY") as Hex);
  const coordinatorAccount = privateKeyToAccount(
    reqEnv("COORDINATOR_PRIVATE_KEY") as Hex,
  );
  const signerAccount = privateKeyToAccount(reqEnv("SIGNER_PRIVATE_KEY") as Hex);
  const recipient = (process.env.RECIPIENT_ADDRESS || userAccount.address) as Address;

  const depositAmount = BigInt(process.env.AMOUNT_USDC ?? "100") * 1_000_000n;
  const withdrawAmount = BigInt(process.env.WITHDRAW_USDC ?? "40") * 1_000_000n;
  const confirmations = Number(process.env.CONFIRMATIONS_REQUIRED ?? "1");

  const publicClient = createPublicClient({
    chain: chain(publicChainId, publicRpc),
    transport: http(publicRpc),
  });
  const shadowClient = createPublicClient({
    chain: chain(shadowChainId, shadowRpc),
    transport: http(shadowRpc),
  });
  const userWallet = createWalletClient({
    account: userAccount,
    chain: chain(publicChainId, publicRpc),
    transport: http(publicRpc),
  });
  const coordinatorWallet = createWalletClient({
    account: coordinatorAccount,
    chain: chain(shadowChainId, shadowRpc),
    transport: http(shadowRpc),
  });
  // The coordinator also acts as the test-USDC minter on the PUBLIC chain.
  const minterPublicWallet = createWalletClient({
    account: coordinatorAccount,
    chain: chain(publicChainId, publicRpc),
    transport: http(publicRpc),
  });

  const log = (s: string) => console.log(s);
  log(`\n=== DarkBox deposit/withdrawal smoke test ===`);
  log(`public chain ${publicChainId} @ ${publicRpc}`);
  log(`shadow chain ${shadowChainId} @ ${shadowRpc}`);
  log(`user=${userAccount.address} recipient=${recipient}`);

  // --- 0. optionally mint test USDC to the user ---
  if (process.env.USDC_IS_MINTABLE === "true") {
    const hash = await minterPublicWallet.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "mint",
      args: [userAccount.address, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`minted ${depositAmount} test USDC to user (tx ${hash})`);
  }

  // --- 1. user approves + deposits ---
  const approveHash = await userWallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [bridge, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const depositHash = await userWallet.writeContract({
    address: bridge,
    abi: darkBoxBridgeAbi,
    functionName: "deposit",
    args: [gameId, usdc, depositAmount, userAccount.address, `0x${"00".repeat(32)}`],
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositHash,
  });
  log(`\n[1] deposit tx ${depositHash} (block ${depositReceipt.blockNumber})`);

  // parse DepositReceived to build the canonical observation
  const depositLog = depositReceipt.logs.find(
    (l) => l.address.toLowerCase() === bridge.toLowerCase(),
  );
  if (!depositLog) throw new Error("DepositReceived not found in receipt");
  const decoded = decodeEventLog({
    abi: darkBoxBridgeAbi,
    data: depositLog.data,
    topics: depositLog.topics,
  });
  if (decoded.eventName !== "DepositReceived") throw new Error("unexpected event");
  log(`    DepositReceived amount=${decoded.args.amount} beneficiary=${decoded.args.beneficiary}`);

  const observation = normalizeDepositEvent(
    { chainId: publicChainId, bridgeAddress: bridge },
    {
      kind: "deposit_event",
      asset: usdc,
      from: userAccount.address,
      beneficiary: decoded.args.beneficiary,
      amount: decoded.args.amount,
      txHash: depositHash,
      logIndex: depositLog.logIndex,
      confirmations,
    },
  );

  // --- 2. bridge service: confirm -> map -> idempotent shadow mint ---
  const store = new InMemoryBridgeStore();
  const minter = new ViemShadowMintSubmitter({
    publicClient: shadowClient,
    walletClient: coordinatorWallet,
    controller,
  });
  const depositCoord = new DepositCoordinator(
    { gameId, confirmationsRequired: confirmations },
    store,
    minter,
  );
  const depositRecord = await depositCoord.process(
    observation,
    Math.floor(Date.now() / 1000),
  );
  log(`\n[2] shadow mint state=${depositRecord.state} tx=${depositRecord.shadowMintTxHash}`);

  const shadowAccount = deriveShadowAccount(gameId, userAccount.address);
  const burner = new ViemShadowBurnSubmitter({
    publicClient: shadowClient,
    walletClient: coordinatorWallet,
    controller,
    confirmations,
  });
  const withdrawable = await burner.withdrawableBalance(shadowAccount, usdc);
  log(`    withdrawableBalance=${withdrawable}`);
  if (withdrawable < depositAmount) throw new Error("mint did not credit shadow account");

  // --- 3. user signs the EIP-712 withdrawal command ---
  const domain = { chainId: publicChainId, verifyingContract: bridge };
  const nowSec = Math.floor(Date.now() / 1000);
  const command: WithdrawCommand = {
    gameId,
    owner: userAccount.address,
    shadowAccount,
    asset: usdc,
    amount: withdrawAmount,
    recipient,
    nonce: BigInt(nowSec), // any unused nonce
    deadline: BigInt(nowSec + 3600),
    shadowChainId: BigInt(shadowChainId),
  };
  const userSig = await userAccount.signTypedData({
    domain: bridgeDomain(domain),
    types: WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: command,
  });
  log(`\n[3] user signed WithdrawCommand for ${withdrawAmount} (nonce ${command.nonce})`);

  // --- 4. coordinator: forced burn -> signing-service authorization ---
  const signingService = new SigningService(
    { domain, resolveShadowAccount: (c) => deriveShadowAccount(gameId, c.owner) },
    {
      signer: signerAccount,
      burnVerifier: burner,
      nonceChecker: new ViemNonceChecker(publicClient, bridge),
      authStore: new InMemoryAuthorizationStore(),
    },
  );
  const withdrawalCoord = new WithdrawalCoordinator(
    { domain, gameId, shadowChainId: BigInt(shadowChainId) },
    store,
    burner,
    signingService,
  );
  const result = await withdrawalCoord.submit(command, userSig, nowSec);
  if (result.status !== WithdrawalState.ServiceSigned || !result.authorization) {
    throw new Error(`unexpected withdrawal status: ${result.status}`);
  }
  log(`\n[4] shadow burn ref=${result.shadowBurnRef}`);
  log(`    signing service authorized; auth deadline=${result.authorization.payload.deadline}`);

  // --- 5. user submits the public withdraw(...) ---
  const a = result.authorization.payload;
  const withdrawHash = await userWallet.writeContract({
    address: bridge,
    abi: darkBoxBridgeAbi,
    functionName: "withdraw",
    args: [
      a.gameId,
      a.owner,
      a.shadowAccount,
      a.asset,
      a.amount,
      a.recipient,
      a.nonce,
      a.deadline,
      a.userCommandHash,
      a.shadowBurnRef,
      result.authorization.signature,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
  log(`\n[5] public withdraw tx ${withdrawHash}`);

  const recipientBalance = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient],
  });
  const remainingShadow = await burner.withdrawableBalance(shadowAccount, usdc);
  log(`\n=== RESULT ===`);
  log(`recipient USDC balance: ${recipientBalance} (expected >= ${withdrawAmount})`);
  log(`remaining shadow withdrawable: ${remainingShadow} (expected ${depositAmount - withdrawAmount})`);
  if (recipientBalance < withdrawAmount) throw new Error("recipient was not paid");
  if (remainingShadow !== depositAmount - withdrawAmount) {
    throw new Error("shadow accounting mismatch");
  }
  log(`\n✅ smoke test passed: deposit -> mint -> burn -> authorization -> withdraw reconciled`);
}

main().catch((err) => {
  console.error("\n❌ smoke test failed:", err);
  process.exit(1);
});
