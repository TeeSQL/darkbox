// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermissionRegistry} from "./interfaces/IPermissionRegistry.sol";
import {EIP712} from "./utils/EIP712.sol";
import {ECDSA} from "./utils/ECDSA.sol";

/// @title PermissionRegistry
/// @notice Registry for permissions scoped to (user, operator, target) with a compact auth blob.
///
/// Storage encoding: bytes auth where
///   length 0 = not granted / revoked
///   bytes[0:4] = uint32 expiry (type(uint32).max = permanent)
///   length 4 = full target approval
///   length >4 = expiry followed by concatenated bytes4 selectors
contract PermissionRegistry is IPermissionRegistry, EIP712 {
    uint48 internal constant PERMANENT = type(uint48).max;
    uint32 internal constant STORED_PERMANENT = type(uint32).max;

    bytes32 public constant PERMISSION_PERMIT_TYPEHASH = keccak256(
        "PermissionPermit(address user,address operator,address target,bytes4 selector,uint48 expiry,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant FULL_AUTHORIZATION_PERMIT_TYPEHASH = keccak256(
        "FullAuthorizationPermit(address user,address operator,address target,uint48 expiry,uint256 nonce,uint256 deadline)"
    );

    mapping(address user => mapping(address operator => mapping(address target => bytes))) internal permissions;

    mapping(address user => uint256) public permissionNonce;

    constructor() EIP712("PermissionRegistry", "1") {}

    // -------------------------------------------------------------------------
    // Standing permission management
    // -------------------------------------------------------------------------

    function grant(address operator, address target, bytes4 selector) external {
        _grantSelector(msg.sender, operator, target, selector, STORED_PERMANENT);
    }

    function grantWithExpiry(address operator, address target, bytes4 selector, uint48 expiry) external {
        _grantSelector(msg.sender, operator, target, selector, _normalizeExpiryAllowPermanent(expiry));
    }

    function revoke(address operator, address target, bytes4 selector) external {
        _revokeSelector(msg.sender, operator, target, selector);
    }

    /// @notice Grant full target approval. Empty selector list encoded as expiry-only auth blob.
    function grantFull(address operator, address target) external {
        _setFull(msg.sender, operator, target, STORED_PERMANENT);
    }

    /// @notice Grant time-bounded full target approval.
    function grantFullWithExpiry(address operator, address target, uint48 expiry) external {
        _setFull(msg.sender, operator, target, _normalizeExpiryAllowPermanent(expiry));
    }

    /// @notice Revoke all approvals for operator on target.
    function revokeAll(address operator, address target) external {
        _revokeAll(msg.sender, operator, target);
    }

    /// @notice Set exactly the provided selector bundle for operator on target.
    function grantSelectorBundle(address operator, address target, bytes4[] calldata selectors, uint48 expiry)
        external
    {
        uint32 storedExpiry = expiry == PERMANENT ? STORED_PERMANENT : _normalizeExpiry(expiry);
        _setSelectorBundle(msg.sender, operator, target, selectors, storedExpiry);
    }

    function grantBatch(PermissionKey[] calldata keys) external {
        uint256 length = keys.length;
        for (uint256 i; i < length; ++i) {
            PermissionKey calldata key = keys[i];
            if (key.user != msg.sender) revert PermissionDenied(key.user, msg.sender, key.target, key.selector);
            _grantSelector(key.user, key.operator, key.target, key.selector, STORED_PERMANENT);
        }
    }

    function grantBatchWithExpiry(PermissionEntry[] calldata entries) external {
        uint256 length = entries.length;
        for (uint256 i; i < length; ++i) {
            PermissionEntry calldata entry = entries[i];
            PermissionKey calldata key = entry.key;
            if (key.user != msg.sender) revert PermissionDenied(key.user, msg.sender, key.target, key.selector);
            _grantSelector(
                key.user, key.operator, key.target, key.selector, _normalizeExpiryAllowPermanent(entry.expiry)
            );
        }
    }

    function revokeBatch(PermissionKey[] calldata keys) external {
        uint256 length = keys.length;
        for (uint256 i; i < length; ++i) {
            PermissionKey calldata key = keys[i];
            if (key.user != msg.sender) revert PermissionDenied(key.user, msg.sender, key.target, key.selector);
            _revokeSelector(key.user, key.operator, key.target, key.selector);
        }
    }

    // -------------------------------------------------------------------------
    // Signed permit
    // -------------------------------------------------------------------------

    function permitPermission(PermissionPermit calldata permit, bytes calldata signature) external {
        if (block.timestamp > permit.deadline) revert DeadlineExpired();
        if (permit.expiry != 0) _normalizeExpiryAllowPermanent(permit.expiry);

        uint256 nonce = permissionNonce[permit.user];
        if (permit.nonce != nonce) revert InvalidNonce(nonce, permit.nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                PERMISSION_PERMIT_TYPEHASH,
                permit.user,
                permit.operator,
                permit.target,
                permit.selector,
                permit.expiry,
                permit.nonce,
                permit.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedData(structHash), bytes(signature));
        if (signer != permit.user) revert InvalidSignature();

        permissionNonce[permit.user] = nonce + 1;
        if (permit.expiry == 0) {
            _revokeSelector(permit.user, permit.operator, permit.target, permit.selector);
        } else {
            _grantSelector(
                permit.user,
                permit.operator,
                permit.target,
                permit.selector,
                _normalizeExpiryAllowPermanent(permit.expiry)
            );
        }
    }

    function permitFullAuthorization(FullAuthorizationPermit calldata permit, bytes calldata signature) external {
        if (block.timestamp > permit.deadline) revert DeadlineExpired();
        if (permit.expiry != 0) _normalizeExpiryAllowPermanent(permit.expiry);

        uint256 nonce = permissionNonce[permit.user];
        if (permit.nonce != nonce) revert InvalidNonce(nonce, permit.nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                FULL_AUTHORIZATION_PERMIT_TYPEHASH,
                permit.user,
                permit.operator,
                permit.target,
                permit.expiry,
                permit.nonce,
                permit.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedData(structHash), bytes(signature));
        if (signer != permit.user) revert InvalidSignature();

        permissionNonce[permit.user] = nonce + 1;
        if (permit.expiry == 0) {
            _revokeAll(permit.user, permit.operator, permit.target);
        } else {
            _setFull(permit.user, permit.operator, permit.target, _normalizeExpiryAllowPermanent(permit.expiry));
        }
    }

    // -------------------------------------------------------------------------
    // Authorization queries
    // -------------------------------------------------------------------------

    function isAuthorizedCall(address user, address operator, address target, bytes4 selector)
        external
        view
        returns (bool)
    {
        (bool authorized, uint32 expiry,) = _decodeStorageAuthorization(permissions[user][operator][target], selector);
        return authorized && block.timestamp <= expiry;
    }

    function requireAuthorizedCall(address user, address operator, address target, bytes4 selector) external view {
        (bool authorized, uint32 expiry, bool selectorPresent) =
            _decodeStorageAuthorization(permissions[user][operator][target], selector);
        if (!selectorPresent) revert PermissionDenied(user, operator, target, selector);
        if (!authorized || block.timestamp > expiry) revert PermissionExpired(user, operator, target, selector);
    }

    function permissionExpiry(address user, address operator, address target, bytes4 selector)
        external
        view
        returns (uint48)
    {
        (bool selectorPresent, uint32 expiry,) =
            _decodeStorageAuthorization(permissions[user][operator][target], selector);
        if (!selectorPresent) return 0;
        return _externalExpiry(expiry);
    }

    function rawPermissionData(address user, address operator, address target) external view returns (bytes memory) {
        return permissions[user][operator][target];
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _setFull(address user, address operator, address target, uint32 expiry) internal {
        _validateBase(user, operator, target);
        permissions[user][operator][target] = abi.encodePacked(expiry);
        bytes4[] memory selectors = new bytes4[](0);
        emit PermissionSet(user, operator, target, bytes4(0), true, _externalExpiry(expiry));
        emit AuthorizationSet(user, operator, target, _externalExpiry(expiry), selectors);
    }

    function _revokeAll(address user, address operator, address target) internal {
        _validateBase(user, operator, target);
        delete permissions[user][operator][target];
        bytes4[] memory selectors = new bytes4[](0);
        emit PermissionSet(user, operator, target, bytes4(0), false, 0);
        emit AuthorizationSet(user, operator, target, 0, selectors);
    }

    function _setSelectorBundle(
        address user,
        address operator,
        address target,
        bytes4[] calldata selectors,
        uint32 expiry
    ) internal {
        _validateBase(user, operator, target);
        uint256 length = selectors.length;
        if (length == 0) {
            _setFull(user, operator, target, expiry);
            return;
        }

        bytes memory auth = new bytes(4 + length * 4);
        _writeExpiry(auth, expiry);
        bytes4 previous;
        for (uint256 i; i < length; ++i) {
            bytes4 selector = selectors[i];
            if (selector == bytes4(0) || selector <= previous) revert InvalidSelector();
            _writeSelector(auth, i, selector);
            previous = selector;
            emit PermissionSet(user, operator, target, selector, true, _externalExpiry(expiry));
        }
        permissions[user][operator][target] = auth;
        emit AuthorizationSet(user, operator, target, _externalExpiry(expiry), selectors);
    }

    function _grantSelector(address user, address operator, address target, bytes4 selector, uint32 expiry) internal {
        _validate(user, operator, target, selector);

        bytes memory auth = permissions[user][operator][target];
        if (auth.length == 4) {
            uint32 fullExpiry = _readExpiry(auth);
            if (fullExpiry != 0 && block.timestamp <= fullExpiry) {
                emit PermissionSet(user, operator, target, selector, true, _externalExpiry(fullExpiry));
                return;
            }
        }

        if (auth.length == 0 || auth.length == 4) {
            bytes memory fresh = new bytes(8);
            _writeExpiry(fresh, expiry);
            _writeSelector(fresh, 0, selector);
            permissions[user][operator][target] = fresh;
            emit PermissionSet(user, operator, target, selector, true, _externalExpiry(expiry));
            return;
        }

        uint256 selectorCount = (auth.length - 4) / 4;
        uint256 insertAt = selectorCount;
        bool found;
        for (uint256 i; i < selectorCount; ++i) {
            bytes4 current = _readSelector(auth, i);
            if (current == selector) {
                found = true;
                break;
            }
            if (selector < current) {
                insertAt = i;
                break;
            }
        }

        if (found) {
            _writeExpiry(auth, expiry);
            permissions[user][operator][target] = auth;
            emit PermissionSet(user, operator, target, selector, true, _externalExpiry(expiry));
            return;
        }

        bytes memory updated = new bytes(auth.length + 4);
        _writeExpiry(updated, expiry);
        for (uint256 i; i < selectorCount + 1; ++i) {
            bytes4 value;
            if (i < insertAt) value = _readSelector(auth, i);
            else if (i == insertAt) value = selector;
            else value = _readSelector(auth, i - 1);
            _writeSelector(updated, i, value);
        }
        permissions[user][operator][target] = updated;
        emit PermissionSet(user, operator, target, selector, true, _externalExpiry(expiry));
    }

    function _revokeSelector(address user, address operator, address target, bytes4 selector) internal {
        _validate(user, operator, target, selector);
        bytes memory auth = permissions[user][operator][target];
        if (auth.length == 0 || auth.length == 4) {
            emit PermissionSet(user, operator, target, selector, false, 0);
            return;
        }

        uint256 selectorCount = (auth.length - 4) / 4;
        uint256 removeAt = selectorCount;
        for (uint256 i; i < selectorCount; ++i) {
            if (_readSelector(auth, i) == selector) {
                removeAt = i;
                break;
            }
        }
        if (removeAt == selectorCount) {
            emit PermissionSet(user, operator, target, selector, false, 0);
            return;
        }
        if (selectorCount == 1) {
            delete permissions[user][operator][target];
            emit PermissionSet(user, operator, target, selector, false, 0);
            return;
        }

        bytes memory updated = new bytes(auth.length - 4);
        _writeExpiry(updated, _readExpiry(auth));
        for (uint256 i; i < selectorCount - 1; ++i) {
            bytes4 value = _readSelector(auth, i < removeAt ? i : i + 1);
            _writeSelector(updated, i, value);
        }
        permissions[user][operator][target] = updated;
        emit PermissionSet(user, operator, target, selector, false, 0);
    }

    function _decodeStorageAuthorization(bytes storage auth, bytes4 selector)
        internal
        view
        returns (bool selectorPresent, uint32 expiry, bool presentEvenIfExpired)
    {
        uint256 length = auth.length;
        if (length == 0) return (false, 0, false);
        if (length < 4 || (length - 4) % 4 != 0) return (false, 0, false);

        if (length <= 31) {
            bytes32 word;
            assembly {
                word := sload(auth.slot)
            }
            expiry = uint32(bytes4(word));
            if (expiry == 0) return (false, expiry, false);
            if (length == 4) return (true, expiry, true);

            uint256 selectorCount = (length - 4) / 4;
            for (uint256 i; i < selectorCount; ++i) {
                bytes4 current = bytes4(word << ((i + 1) * 32));
                if (current == selector) return (true, expiry, true);
                if (current > selector) break;
            }
            return (false, expiry, false);
        }

        bytes memory authMemory = auth;
        expiry = _readExpiry(authMemory);
        if (expiry == 0) return (false, expiry, false);

        uint256 selectorCount = (length - 4) / 4;
        for (uint256 i; i < selectorCount; ++i) {
            bytes4 current = _readSelector(authMemory, i);
            if (current == selector) return (true, expiry, true);
            if (current > selector) break;
        }
        return (false, expiry, false);
    }

    function _validate(address user, address operator, address target, bytes4 selector) internal pure {
        _validateBase(user, operator, target);
        if (selector == bytes4(0)) revert InvalidSelector();
    }

    function _validateBase(address user, address operator, address target) internal pure {
        if (user == address(0) || operator == address(0) || target == address(0)) revert InvalidAddress();
    }

    function _normalizeExpiry(uint48 expiry) internal view returns (uint32) {
        if (expiry == 0 || expiry <= uint48(block.timestamp) || expiry > uint48(STORED_PERMANENT - 1)) {
            revert InvalidExpiry();
        }
        return uint32(expiry);
    }

    function _normalizeExpiryAllowPermanent(uint48 expiry) internal view returns (uint32) {
        if (expiry == PERMANENT) return STORED_PERMANENT;
        return _normalizeExpiry(expiry);
    }

    function _externalExpiry(uint32 expiry) internal pure returns (uint48) {
        return expiry == STORED_PERMANENT ? PERMANENT : uint48(expiry);
    }

    function _readExpiry(bytes memory auth) internal pure returns (uint32 expiry) {
        assembly {
            expiry := shr(224, mload(add(auth, 32)))
        }
    }

    function _writeExpiry(bytes memory auth, uint32 expiry) internal pure {
        assembly {
            let word := mload(add(auth, 32))
            word := or(shl(224, expiry), and(word, 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff))
            mstore(add(auth, 32), word)
        }
    }

    function _readSelector(bytes memory auth, uint256 index) internal pure returns (bytes4 selector) {
        uint256 offset = 36 + index * 4;
        assembly {
            selector := mload(add(auth, offset))
        }
    }

    function _writeSelector(bytes memory auth, uint256 index, bytes4 selector) internal pure {
        uint256 offset = 36 + index * 4;
        assembly {
            let ptr := add(auth, offset)
            let word := mload(ptr)
            word := or(selector, and(word, 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff))
            mstore(ptr, word)
        }
    }
}
