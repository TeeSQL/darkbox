// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

abstract contract EIP712 {
    bytes32 private immutable _domainSeparator;

    constructor(string memory name, string memory version) {
        _domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }
}
