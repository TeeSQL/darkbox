// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DarkBoxBridge} from "../src/DarkBoxBridge.sol";

/// @notice Shared EIP-712 signing helpers for bridge tests.
abstract contract BridgeEIP712Helper is Test {
    bytes32 internal constant WITHDRAWAL_AUTHORIZATION_TYPEHASH = keccak256(
        "WithdrawalAuthorization(bytes32 gameId,address owner,bytes32 shadowAccount,address asset,uint256 amount,address recipient,bytes32 userCommandHash,bytes32 shadowBurnRef,uint256 nonce,uint256 deadline)"
    );

    struct Authorization {
        bytes32 gameId;
        address owner;
        bytes32 shadowAccount;
        address asset;
        uint256 amount;
        address recipient;
        bytes32 userCommandHash;
        bytes32 shadowBurnRef;
        uint256 nonce;
        uint256 deadline;
    }

    function _authDigest(DarkBoxBridge bridge, Authorization memory a) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_AUTHORIZATION_TYPEHASH,
                a.gameId,
                a.owner,
                a.shadowAccount,
                a.asset,
                a.amount,
                a.recipient,
                a.userCommandHash,
                a.shadowBurnRef,
                a.nonce,
                a.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", bridge.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
