/**
 * Concrete signer dependencies. All external checks FAIL CLOSED: if a source is
 * not configured, the corresponding check returns the safe (reject) answer so
 * the signer never authorizes a withdrawal it cannot fully verify.
 */
import {
  deriveShadowAccount,
  InMemoryAuthorizationStore,
  type NonceChecker,
  type ShadowBurnVerifier,
  type SigningServiceConfig,
  type SigningServiceDeps,
  type TypedDataSigner,
} from "@darkbox/shared";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

/** Burn verifier backed by an internal confirmation endpoint; else fail-closed. */
function makeBurnVerifier(): ShadowBurnVerifier {
  if (!config.burnVerifyUrl) {
    return { async hasConfirmedBurn() { return false; } }; // fail closed
  }
  return {
    async hasConfirmedBurn({ withdrawalId, shadowBurnRef, amount }) {
      try {
        const res = await fetch(`${config.burnVerifyUrl}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ withdrawalId, shadowBurnRef, amount: amount.toString() }),
        });
        if (!res.ok) return false;
        const j = (await res.json()) as { confirmed?: boolean };
        return j.confirmed === true;
      } catch {
        return false;
      }
    },
  };
}

const USED_NONCES_ABI = [
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Nonce checker reading the public bridge; if unconfigured, treat as used (reject). */
function makeNonceChecker(): NonceChecker {
  if (!config.publicRpcUrl) {
    return { async isNonceUsed() { return true; } }; // fail closed → rejects
  }
  const client = createPublicClient({ transport: http(config.publicRpcUrl) });
  return {
    async isNonceUsed(owner: Address, nonce: bigint) {
      try {
        return (await client.readContract({
          address: config.bridgeAddress,
          abi: USED_NONCES_ABI,
          functionName: "usedNonces",
          args: [owner, nonce],
        })) as boolean;
      } catch {
        return true; // can't verify ⇒ reject
      }
    },
  };
}

export function buildSigningConfig(): SigningServiceConfig {
  return {
    domain: { chainId: config.domainChainId, verifyingContract: config.bridgeAddress },
    authTtlSeconds: config.authTtlSeconds,
    resolveShadowAccount: (command) =>
      deriveShadowAccount(config.gameId, command.owner) as Hex,
  };
}

export function buildSigningDeps(overrides?: Partial<SigningServiceDeps>): SigningServiceDeps {
  if (!config.signerPrivateKey && !overrides?.signer) {
    throw new Error("SIGNER_PRIVATE_KEY is required");
  }
  const signer: TypedDataSigner = overrides?.signer
    ?? privateKeyToAccount(config.signerPrivateKey as `0x${string}`);
  return {
    signer,
    burnVerifier: overrides?.burnVerifier ?? makeBurnVerifier(),
    nonceChecker: overrides?.nonceChecker ?? makeNonceChecker(),
    authStore: overrides?.authStore ?? new InMemoryAuthorizationStore(),
    fundingChecker: overrides?.fundingChecker,
  };
}
