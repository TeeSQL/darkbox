// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPermissionRegistry {
    // -------------------------------------------------------------------------
    // Data structures
    // -------------------------------------------------------------------------

    struct PermissionKey {
        address user;
        address operator;
        address target;
        bytes4 selector;
    }

    /// @notice Used by grantBatchWithExpiry to bundle a selector key with its expiry.
    struct PermissionEntry {
        PermissionKey key;
        uint48 expiry;
    }

    /// @notice Signed permit for gasless off-chain selector grants/revokes.
    /// @dev expiry semantics: 0 = revoke, type(uint48).max = permanent, else = expiry timestamp.
    ///      Validated: if expiry != 0, expiry must be in the future and storage-representable.
    struct PermissionPermit {
        address user;
        address operator;
        address target;
        bytes4 selector;
        uint48 expiry;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Signed permit for gasless full-target grants/revokes.
    /// @dev expiry semantics: 0 = revoke all, type(uint48).max = permanent, else = expiry timestamp.
    ///      Full-target authorization is intentionally a separate typed-data shape so wallets can
    ///      render stronger warnings than they would for selector-scoped permissions.
    struct FullAuthorizationPermit {
        address user;
        address operator;
        address target;
        uint48 expiry;
        uint256 nonce;
        uint256 deadline;
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error PermissionDenied(address user, address operator, address target, bytes4 selector);
    /// @notice Thrown by requireAuthorizedCall when a permission existed but has passed its expiry.
    error PermissionExpired(address user, address operator, address target, bytes4 selector);
    error InvalidAddress();
    error InvalidSelector();
    /// @notice Thrown when a granted expiry is zero or already in the past.
    error InvalidExpiry();
    error InvalidSignature();
    error DeadlineExpired();
    error InvalidNonce(uint256 expected, uint256 actual);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted on every permission change.
    /// @param expiry type(uint48).max = permanent; 0 = revoked; else = expiry timestamp.
    event PermissionSet(
        address indexed user,
        address indexed operator,
        address indexed target,
        bytes4 selector,
        bool approved,
        uint48 expiry
    );

    /// @notice Emitted when the whole authorization blob for (user, operator, target) is replaced.
    /// @dev Empty selectors with nonzero expiry means full-target authorization. Empty selectors with
    ///      zero expiry means no authorization. This decoded event is indexer/wallet friendly; the
    ///      packed storage bytes remain an implementation detail.
    event AuthorizationSet(
        address indexed user, address indexed operator, address indexed target, uint48 expiry, bytes4[] selectors
    );

    // -------------------------------------------------------------------------
    // Standing permission management
    // -------------------------------------------------------------------------

    /// @notice Grant a permanent selector-scoped standing permission.
    function grant(address operator, address target, bytes4 selector) external;

    /// @notice Grant a time-bounded selector-scoped standing permission. expiry must be strictly in the future.
    function grantWithExpiry(address operator, address target, bytes4 selector, uint48 expiry) external;

    function revoke(address operator, address target, bytes4 selector) external;

    /// @notice Grant permanent full-target approval. Authorizes every selector on target.
    function grantFull(address operator, address target) external;

    /// @notice Grant time-bounded full-target approval. Authorizes every selector on target until expiry.
    function grantFullWithExpiry(address operator, address target, uint48 expiry) external;

    /// @notice Revoke the entire auth blob for operator on target.
    function revokeAll(address operator, address target) external;

    /// @notice Replace the selector bundle for operator on target. Selectors must be sorted and unique.
    function grantSelectorBundle(address operator, address target, bytes4[] calldata selectors, uint48 expiry) external;

    /// @notice Batch-grant permanent selector-scoped permissions. All keys must have user == msg.sender.
    function grantBatch(PermissionKey[] calldata keys) external;

    /// @notice Batch-grant time-bounded selector-scoped permissions. All keys must have user == msg.sender.
    function grantBatchWithExpiry(PermissionEntry[] calldata entries) external;

    function revokeBatch(PermissionKey[] calldata keys) external;

    // -------------------------------------------------------------------------
    // Signed permit
    // -------------------------------------------------------------------------

    /// @notice Gasless selector permission grant/revoke: user signs off-chain, anyone submits on-chain.
    function permitPermission(PermissionPermit calldata permit, bytes calldata signature) external;

    /// @notice Gasless full-target authorization grant/revoke: user signs off-chain, anyone submits on-chain.
    function permitFullAuthorization(FullAuthorizationPermit calldata permit, bytes calldata signature) external;

    // -------------------------------------------------------------------------
    // Authorization queries
    // -------------------------------------------------------------------------

    function isAuthorizedCall(address user, address operator, address target, bytes4 selector)
        external
        view
        returns (bool);

    function requireAuthorizedCall(address user, address operator, address target, bytes4 selector) external view;

    /// @notice Returns the effective expiry for selector: 0 = not granted, type(uint48).max = permanent.
    function permissionExpiry(address user, address operator, address target, bytes4 selector)
        external
        view
        returns (uint48);

    /// @notice Returns raw auth bytes for wallet/indexer inspection.
    function rawPermissionData(address user, address operator, address target) external view returns (bytes memory);

    // -------------------------------------------------------------------------
    // Nonce
    // -------------------------------------------------------------------------

    function permissionNonce(address user) external view returns (uint256);
}
