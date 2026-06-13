// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shadow-side bridge controller interface (spec section 10).
interface IShadowBridgeController {
    event ShadowAccountMapped(address indexed owner, bytes32 indexed shadowAccount);
    event ShadowMinted(
        bytes32 indexed depositOpId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount
    );
    event ShadowWithdrawalLocked(
        bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount
    );
    event ShadowBurned(
        bytes32 indexed withdrawalId, bytes32 indexed shadowAccount, address indexed asset, uint256 amount
    );

    function mapShadowAccount(address owner, bytes32 shadowAccount) external;

    function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, address asset, uint256 amount)
        external;

    function burnForWithdrawal(
        bytes32 withdrawalId,
        address owner,
        bytes32 shadowAccount,
        address asset,
        uint256 amount,
        bytes32 userCommandHash
    ) external;

    function withdrawableBalance(bytes32 shadowAccount, address asset) external view returns (uint256);
}
