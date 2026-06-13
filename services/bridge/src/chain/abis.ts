import { parseAbi } from "viem";

/** Public bridge ABI fragments used by the bridge service / smoke test. */
export const darkBoxBridgeAbi = parseAbi([
  "function deposit(bytes32 gameId, address asset, uint256 amount, address beneficiary, bytes32 depositRef) payable",
  "function withdraw(bytes32 gameId, address owner, bytes32 shadowAccount, address asset, uint256 amount, address recipient, uint256 nonce, uint256 deadline, bytes32 userCommandHash, bytes32 shadowBurnRef, bytes serviceSignature)",
  "function emergencyWithdraw(bytes32 gameId, address owner, address asset, uint256 amount, address recipient, bytes32 reason)",
  "function usedNonces(address owner, uint256 nonce) view returns (bool)",
  "function signer() view returns (address)",
  "function setSigner(address newSigner)",
  "function setDepositsPaused(bool paused)",
  "function setWithdrawalsPaused(bool paused)",
  "event DepositReceived(bytes32 indexed gameId, address indexed owner, address indexed asset, uint256 amount, address beneficiary, bytes32 depositRef)",
  "event WithdrawalExecuted(bytes32 indexed gameId, address indexed owner, address indexed asset, uint256 amount, address recipient, uint256 nonce, bytes32 userCommandHash, bytes32 shadowBurnRef)",
]);

/** Shadow bridge controller ABI fragments. */
export const shadowBridgeControllerAbi = parseAbi([
  "function mapShadowAccount(address owner, bytes32 shadowAccount)",
  "function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, address asset, uint256 amount)",
  "function burnForWithdrawal(bytes32 withdrawalId, address owner, bytes32 shadowAccount, address asset, uint256 amount, bytes32 userCommandHash)",
  "function withdrawableBalance(bytes32 shadowAccount, address asset) view returns (uint256)",
  "function balanceOf(bytes32 shadowAccount, address asset) view returns (uint256)",
  "function shadowOf(address owner) view returns (bytes32)",
  "function setLocked(bytes32 shadowAccount, address asset, uint256 newLocked)",
  "event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount)",
  "event ShadowBurned(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount)",
]);

/** Minimal ERC20 ABI for the mock USDC. */
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
]);
