// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shadow-side bridge controller interface (spec section 10).
/// @dev USDC-only MVP: the shadow ledger tracks a single asset (shadow USDC),
///      so mint/burn/balance carry no asset parameter.
interface IShadowBridgeController {
    event ShadowAccountMapped(address indexed owner, bytes32 indexed shadowAccount);
    event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount);
    event ShadowWithdrawalLocked(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, uint256 amount);
    event ShadowBurned(bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, uint256 amount);

    function mapShadowAccount(address owner, bytes32 shadowAccount) external;

    function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, uint256 amount) external;

    function burnForWithdrawal(
        bytes32 withdrawalId,
        address owner,
        bytes32 shadowAccount,
        uint256 amount,
        bytes32 userCommandHash
    ) external;

    function withdrawableBalance(bytes32 shadowAccount) external view returns (uint256);
}
