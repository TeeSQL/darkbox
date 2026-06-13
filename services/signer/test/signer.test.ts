import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Configure before importing the service (config reads env at import).
process.env["SIGNER_PRIVATE_KEY"] =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env["PUBLIC_CHAIN_ID"] = "84532";
process.env["BRIDGE_ADDRESS"] = "0xe0004c955721b3A994E94CCcA86d91Da4Cf2E6f9";
process.env["GAME_ID"] = "0x0000000000000000000000000000000000000000000000000000000000000001";
process.env["SIGNER_BRIDGE_TOKEN"] = "bridge-secret";

const { buildServer } = await import("../src/server.js");
const shared = await import("@darkbox/shared");
const { privateKeyToAccount } = await import("viem/accounts");

const DOMAIN = { chainId: 84532, verifyingContract: process.env["BRIDGE_ADDRESS"] as `0x${string}` };
const GAME_ID = process.env["GAME_ID"] as `0x${string}`;
const BURN_REF = ("0x" + "11".repeat(32)) as `0x${string}`;

const user = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

async function signedRequest() {
  const owner = user.address;
  const shadowAccount = shared.deriveShadowAccount(GAME_ID, owner);
  const command = {
    gameId: GAME_ID,
    owner,
    shadowAccount,
    amount: 1_000_000n,
    recipient: owner,
    destinationChainId: 84532n,
    destinationBridge: process.env["BRIDGE_ADDRESS"] as `0x${string}`,
    nonce: 7n,
    deadline: 9_999_999_999n,
    shadowChainId: 88813n,
  };
  const signature = await user.signTypedData({
    domain: shared.bridgeDomain(DOMAIN),
    types: shared.WITHDRAW_COMMAND_TYPES,
    primaryType: "WithdrawCommand",
    message: command,
  });
  const wire = {
    gameId: command.gameId,
    owner: command.owner,
    shadowAccount: command.shadowAccount,
    amount: command.amount.toString(),
    recipient: command.recipient,
    destinationChainId: command.destinationChainId.toString(),
    destinationBridge: command.destinationBridge,
    nonce: command.nonce.toString(),
    deadline: command.deadline.toString(),
    shadowChainId: command.shadowChainId.toString(),
  };
  return { command: wire, signature, shadowBurnRef: BURN_REF };
}

const okBurn = { async hasConfirmedBurn() { return true; } };
const noBurn = { async hasConfirmedBurn() { return false; } };
const nonceUnused = { async isNonceUsed() { return false; } };
const nonceUsed = { async isNonceUsed() { return true; } };

const headers = { "x-bridge-token": "bridge-secret" };
let body: Awaited<ReturnType<typeof signedRequest>>;
before(async () => {
  body = await signedRequest();
});

test("signs a valid withdrawal when all checks pass", async () => {
  const app = buildServer({ burnVerifier: okBurn, nonceChecker: nonceUnused });
  const res = await app.inject({ method: "POST", url: "/internal/sign-withdrawal", headers, payload: body });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.match(j.signature, /^0x[0-9a-f]+$/);
  assert.equal(j.payload.owner.toLowerCase(), user.address.toLowerCase());
  await app.close();
});

test("rejects without the bridge token (401)", async () => {
  const app = buildServer({ burnVerifier: okBurn, nonceChecker: nonceUnused });
  const res = await app.inject({ method: "POST", url: "/internal/sign-withdrawal", payload: body });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("rejects when the shadow burn is not confirmed (422)", async () => {
  const app = buildServer({ burnVerifier: noBurn, nonceChecker: nonceUnused });
  const res = await app.inject({ method: "POST", url: "/internal/sign-withdrawal", headers, payload: body });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().reason, "burn_not_confirmed");
  await app.close();
});

test("rejects when the nonce is already used (422)", async () => {
  const app = buildServer({ burnVerifier: okBurn, nonceChecker: nonceUsed });
  const res = await app.inject({ method: "POST", url: "/internal/sign-withdrawal", headers, payload: body });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().reason, "nonce_used");
  await app.close();
});

test("rejects a tampered user signature (422)", async () => {
  const app = buildServer({ burnVerifier: okBurn, nonceChecker: nonceUnused });
  const tampered = { ...body, command: { ...body.command, amount: "999999999" } };
  const res = await app.inject({ method: "POST", url: "/internal/sign-withdrawal", headers, payload: tampered });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().reason, /bad_user_signature|wrong_owner/);
  await app.close();
});
