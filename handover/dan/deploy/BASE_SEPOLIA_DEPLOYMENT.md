# Base Sepolia Deployment — DarkBoxBridge Testnet

Date: 2026-06-13 UTC
Network: Base Sepolia
Chain ID: `84532`
RPC used: `https://sepolia.base.org`

## Deployer

- Deployer/admin/signer address: `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D`
- Secret location on Ocean box: `/home/xiko/clawd/secrets/darkbox-dan-deployer.env`
- Secret copy in local repo ignored secrets: `/home/xiko/darkbox/.secrets/darkbox-dan-deployer.env`
- Secret location on teebox: `/home/ubuntu/darkbox/.secrets/darkbox-dan-deployer.env`
- Teebox `.env`: `/home/ubuntu/darkbox/.env` contains `DARKBOX_DEPLOYER_ADDRESS` and `DARKBOX_DEPLOYER_PRIVATE_KEY`.

Do not commit or paste the private key.

## Funding

The deployer was funded on Base Sepolia with `0.08 ETH`.

Funding tx:

```text
0x8caccff898902ff25a34404effd17cd74142c370a2e77b7759a9bcee0030919f
```

## Deployment result

Command run from `packages/contracts`:

```bash
PRIVATE_KEY=<dan-deployer-private-key> \
ADMIN_ADDRESS=0x7c2Af79eD218f75664ae23820C35102Fd8560E6D \
SIGNER_ADDRESS=0x7c2Af79eD218f75664ae23820C35102Fd8560E6D \
DEPLOY_MOCK_USDC=true \
forge script script/Deploy.s.sol:DeployPublic \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --chain-id 84532 \
  -vvvv
```

Contracts:

- `DarkBoxBridge`: `0xe0004c955721b3A994E94CCcA86d91Da4Cf2E6f9`
- `MockERC20` test USDC: `0x8C885Cb844362Ed8d161792aEA6745d29d839246`
- Admin: `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D`
- Signer: `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D`

Broadcast artifact:

```text
packages/contracts/broadcast/Deploy.s.sol/84532/run-latest.json
```

Sensitive Foundry cache:

```text
packages/contracts/cache/Deploy.s.sol/84532/run-latest.json
```

## Mainnet Base / Arc status

The deployer exists and is stored, but only Base Sepolia was funded/deployed in this pass. Before mainnet Base or Arc deployment:

1. Fund `0x7c2Af79eD218f75664ae23820C35102Fd8560E6D` on the target network.
2. Confirm final USDC/token address.
3. Replace admin/signer with final multisig/TEE signer addresses.
4. Reconcile existing Base mainnet artifact/config mismatch documented in `ONCHAIN_DEPLOYMENT.md`.
5. Run contract tests and audit gate again.
