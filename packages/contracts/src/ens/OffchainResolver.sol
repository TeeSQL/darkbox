// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ENSIP-10 wildcard resolver interface.
interface IExtendedResolver {
    function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}

/// @notice The shape the offchain CCIP gateway answers with.
interface IResolverService {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result, uint64 expires, bytes memory sig);
}

/// @dev Self-contained signature check (no external deps) matching the gateway's
/// `0x1900`-prefixed digest: keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak256(request) ‖ keccak256(result)).
library SignatureVerifier {
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    function verify(bytes calldata request, bytes calldata response)
        internal
        view
        returns (address signer, bytes memory result)
    {
        uint64 expires;
        bytes memory sig;
        (result, expires, sig) = abi.decode(response, (bytes, uint64, bytes));
        require(expires >= block.timestamp, "SignatureVerifier: signature expired");
        signer = recover(makeSignatureHash(address(this), expires, request, result), sig);
    }

    function recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "SignatureVerifier: bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "SignatureVerifier: bad v");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "SignatureVerifier: invalid signer");
        return signer;
    }
}

/// @title OffchainResolver
/// @notice ERC-3668 (CCIP-Read) resolver for `darkbox.eth`. Set this contract as
/// the resolver for `darkbox.eth`; all `*.darkbox.eth` lookups are answered by the
/// `darkbox-ens` gateway and verified here against the trusted signer set. Records
/// live entirely offchain, so issuing `<agent>.darkbox.eth` costs zero gas.
contract OffchainResolver is IExtendedResolver {
    string public url;
    address public owner;
    mapping(address => bool) public signers;

    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);

    event NewOwner(address indexed owner);
    event NewUrl(string url);
    event SignerChanged(address indexed signer, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "OffchainResolver: not owner");
        _;
    }

    /// @param _url Gateway template, e.g. `https://ens.darkbox.example/r/{sender}/{data}.json`.
    /// @param _signers Initial trusted gateway signer addresses.
    constructor(string memory _url, address[] memory _signers) {
        owner = msg.sender;
        url = _url;
        emit NewOwner(msg.sender);
        emit NewUrl(_url);
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
            emit SignerChanged(_signers[i], true);
        }
    }

    function setUrl(string calldata _url) external onlyOwner {
        url = _url;
        emit NewUrl(_url);
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        emit SignerChanged(signer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit NewOwner(newOwner);
    }

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(IResolverService.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, this.resolveWithProof.selector, callData);
    }

    /// @notice CCIP-Read callback: verify the gateway's signed answer and return the result.
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (address signer, bytes memory result) = SignatureVerifier.verify(extraData, response);
        require(signers[signer], "OffchainResolver: invalid signer");
        return result;
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return interfaceID == type(IExtendedResolver).interfaceId || interfaceID == 0x01ffc9a7;
    }
}
