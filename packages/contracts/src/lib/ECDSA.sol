// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal, self-contained ECDSA recovery (no external deps).
library ECDSA {
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignature();

    /// @dev Recovers the signer of `digest` from a 65-byte `signature`.
    function recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        // Reject malleable signatures (upper-half of the curve order).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignatureS();
        }
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
