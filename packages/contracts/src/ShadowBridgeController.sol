// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IShadowBridgeController} from "./interfaces/IShadowBridgeController.sol";

/// @title ShadowBridgeController
/// @notice Canonical owner <-> shadow-account registry and the shadow-USDC
///         ledger for bridged funds. Only the bridge coordinator may map,
///         mint, or burn (spec section 5.1).
/// @dev USDC-only MVP. Shadow accounts are identified by `bytes32` (per the
///      deterministic `keccak256(abi.encode(gameId, owner))` derivation), so
///      balances are an internal ledger keyed by shadowAccount rather than an
///      address-based ERC20. A single asset (shadow USDC) is tracked.
contract ShadowBridgeController is IShadowBridgeController {
    /// @notice The bridge coordinator key (only authorized caller).
    address public coordinator;

    // --- owner <-> shadow account mapping (one-to-one, immutable once set) ---
    mapping(address => bytes32) public shadowOf; // owner => shadowAccount
    mapping(bytes32 => address) public ownerOf; // shadowAccount => owner

    // --- shadow USDC ledger ---
    mapping(bytes32 => uint256) internal _balance; // shadowAccount => amount
    /// @notice Amount locked in open orders / collateral / pending transfers.
    ///         Set by the market/coordinator layer; excluded from withdrawable.
    mapping(bytes32 => uint256) public locked;

    // --- idempotency / replay guards ---
    mapping(bytes32 => bool) public mintProcessed; // depositOpId => done
    mapping(bytes32 => bool) public withdrawalProcessed; // withdrawalId => done

    event CoordinatorUpdated(address indexed previousCoordinator, address indexed newCoordinator);
    event LockedUpdated(bytes32 indexed shadowAccount, uint256 newLocked);

    error NotCoordinator();
    error MappingExists();
    error MappingMismatch();
    error AlreadyMinted();
    error AlreadyWithdrawn();
    error InsufficientAvailable();
    error ZeroShadowAccount();

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator();
        _;
    }

    constructor(address _coordinator) {
        require(_coordinator != address(0), "coordinator=0");
        coordinator = _coordinator;
    }

    function setCoordinator(address newCoordinator) external onlyCoordinator {
        require(newCoordinator != address(0), "coordinator=0");
        emit CoordinatorUpdated(coordinator, newCoordinator);
        coordinator = newCoordinator;
    }

    // ---------------------------------------------------------------------
    // Mapping
    // ---------------------------------------------------------------------

    /// @inheritdoc IShadowBridgeController
    function mapShadowAccount(address owner, bytes32 shadowAccount) external onlyCoordinator {
        _ensureMapping(owner, shadowAccount);
    }

    /// @dev Creates the mapping if absent; reverts if it conflicts with an
    ///      existing one. Idempotent for an identical (owner, shadowAccount).
    function _ensureMapping(address owner, bytes32 shadowAccount) internal {
        if (shadowAccount == bytes32(0)) revert ZeroShadowAccount();

        bytes32 existingShadow = shadowOf[owner];
        address existingOwner = ownerOf[shadowAccount];

        if (existingShadow == bytes32(0) && existingOwner == address(0)) {
            shadowOf[owner] = shadowAccount;
            ownerOf[shadowAccount] = owner;
            emit ShadowAccountMapped(owner, shadowAccount);
            return;
        }
        // Already mapped: must match exactly (immutable, one-to-one).
        if (existingShadow != shadowAccount || existingOwner != owner) revert MappingMismatch();
    }

    // ---------------------------------------------------------------------
    // Mint (deposit credit)
    // ---------------------------------------------------------------------

    /// @inheritdoc IShadowBridgeController
    /// @dev Idempotent per `depositOpId`; a second call with the same id reverts.
    ///      Auto-creates the owner<->shadow mapping on first deposit (spec 1.1).
    function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, uint256 amount)
        external
        onlyCoordinator
    {
        if (mintProcessed[depositOpId]) revert AlreadyMinted();
        mintProcessed[depositOpId] = true;

        _ensureMapping(owner, shadowAccount);
        _balance[shadowAccount] += amount;

        emit ShadowMinted(depositOpId, shadowAccount, amount);
    }

    // ---------------------------------------------------------------------
    // Burn (withdrawal)
    // ---------------------------------------------------------------------

    /// @inheritdoc IShadowBridgeController
    /// @dev Only consumes withdrawable available balance; never liquidates
    ///      locked/collateralized funds. Reverts on reused `withdrawalId`.
    function burnForWithdrawal(
        bytes32 withdrawalId,
        address owner,
        bytes32 shadowAccount,
        uint256 amount,
        bytes32 userCommandHash
    ) external onlyCoordinator {
        if (withdrawalProcessed[withdrawalId]) revert AlreadyWithdrawn();

        // Mapping must already exist and match.
        if (shadowOf[owner] != shadowAccount || ownerOf[shadowAccount] != owner) revert MappingMismatch();

        if (_withdrawable(shadowAccount) < amount) revert InsufficientAvailable();

        withdrawalProcessed[withdrawalId] = true;
        _balance[shadowAccount] -= amount;

        emit ShadowBurned(withdrawalId, shadowAccount, amount);
        // `userCommandHash` is bound to `withdrawalId` (== userCommandHash) by the
        // caller; carried for off-chain traceability.
        userCommandHash;
    }

    // ---------------------------------------------------------------------
    // Locking (market integration hook)
    // ---------------------------------------------------------------------

    /// @notice Set the locked (non-withdrawable) amount for a shadow account.
    /// @dev In production this is driven by the market/orderbook layer; exposed
    ///      to the coordinator so tests and the indexer can model open orders.
    function setLocked(bytes32 shadowAccount, uint256 newLocked) external onlyCoordinator {
        locked[shadowAccount] = newLocked;
        emit LockedUpdated(shadowAccount, newLocked);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function balanceOf(bytes32 shadowAccount) external view returns (uint256) {
        return _balance[shadowAccount];
    }

    /// @inheritdoc IShadowBridgeController
    function withdrawableBalance(bytes32 shadowAccount) external view returns (uint256) {
        return _withdrawable(shadowAccount);
    }

    function _withdrawable(bytes32 shadowAccount) internal view returns (uint256) {
        uint256 bal = _balance[shadowAccount];
        uint256 lk = locked[shadowAccount];
        return bal > lk ? bal - lk : 0;
    }
}
