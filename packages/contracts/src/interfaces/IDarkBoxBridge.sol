// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public bridge/escrow interface (spec section 9).
interface IDarkBoxBridge {
    event AgentRegistered(
        bytes32 indexed gameId,
        bytes32 indexed agentId,
        address indexed owner,
        bytes32 shadowAccount,
        string ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    );

    event DepositReceived(
        bytes32 indexed gameId,
        address indexed owner,
        address indexed asset,
        uint256 amount,
        address beneficiary,
        bytes32 depositRef
    );

    event WithdrawalExecuted(
        bytes32 indexed gameId,
        address indexed owner,
        address indexed asset,
        uint256 amount,
        address recipient,
        uint256 nonce,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef
    );

    event EmergencyWithdrawal(
        bytes32 indexed gameId,
        address indexed owner,
        address indexed asset,
        uint256 amount,
        address recipient,
        bytes32 reason
    );

    receive() external payable;

    function registerAgent(
        bytes32 gameId,
        bytes32 agentId,
        bytes32 shadowAccount,
        string calldata ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    ) external;

    function deposit(bytes32 gameId, address asset, uint256 amount, address beneficiary, bytes32 depositRef)
        external
        payable;

    function withdraw(
        bytes32 gameId,
        address owner,
        bytes32 shadowAccount,
        address asset,
        uint256 amount,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef,
        bytes calldata serviceSignature
    ) external;

    function emergencyWithdraw(
        bytes32 gameId,
        address owner,
        address asset,
        uint256 amount,
        address recipient,
        bytes32 reason
    ) external;
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}
