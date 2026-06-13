// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "./RollingFrontierBook.sol";
import {FrontierMakerOps} from "./FrontierMakerOps.sol";
import {GeometricFrontierBook, GeometricMakerOps} from "./GeometricFrontierBook.sol";

/// @notice EIP-170 plumbing for the factory: a contract that does `new X()`
/// embeds X's full creation code in its own runtime, so a factory deploying
/// the ~23KB book AND its ~20KB maker-ops companion directly would bust the
/// code-size limit itself. Each deployer below embeds exactly ONE initcode
/// and stays under the limit; the factory holds only their addresses.
/// Both are permissionless and stateless — deploying contracts for someone
/// else grants no power over them.
contract RollingBookDeployer {
    function deploy(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address hooks,
        address permissions,
        address makerOps,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address) {
        return address(
            new RollingFrontierBook(
                token0,
                token1,
                tickSpacing,
                startTick,
                hooks,
                permissions,
                makerOps,
                feeRecipient,
                makerFeeBps,
                takerFeeBps
            )
        );
    }
}

contract MakerOpsDeployer {
    function deploy(
        address token0,
        address token1,
        int24 tickSpacing,
        address hooks,
        address permissions,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address) {
        return address(
            new FrontierMakerOps(
                token0, token1, tickSpacing, hooks, permissions, feeRecipient, makerFeeBps, takerFeeBps
            )
        );
    }
}

/// @notice GeometricFrontierBook's INITCODE (~24.9KB) is itself over the
/// EIP-170 runtime limit, so the embed-one-initcode trick above cannot work
/// here — a `new`-style deployer would carry the whole blob in its runtime.
/// Instead the CONSTRUCTOR (initcode may be ~49KB per EIP-3860) splits the
/// creation code across two SSTORE2-style data contracts; deploy() stitches
/// them back together with the abi-encoded constructor args and CREATEs.
contract GeometricBookDeployer {
    address public immutable chunk0;
    address public immutable chunk1;

    constructor() {
        bytes memory code = type(GeometricFrontierBook).creationCode;
        uint256 half = code.length / 2;
        chunk0 = _store(code, 0, half);
        chunk1 = _store(code, half, code.length - half);
    }

    function deploy(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address hooks,
        address permissions,
        address makerOps,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address book) {
        bytes memory init = bytes.concat(
            _read(chunk0),
            _read(chunk1),
            abi.encode(
                token0,
                token1,
                tickSpacing,
                startTick,
                hooks,
                permissions,
                makerOps,
                feeRecipient,
                makerFeeBps,
                takerFeeBps
            )
        );
        assembly ("memory-safe") {
            book := create(0, add(init, 0x20), mload(init))
        }
        require(book != address(0), "geo book deploy failed");
    }

    /// @dev data contract whose runtime is a STOP guard byte + the slice
    /// (the guard keeps the blob from ever being executable as a contract).
    function _store(bytes memory code, uint256 offset, uint256 size) private returns (address ptr) {
        bytes memory data = new bytes(size);
        assembly ("memory-safe") {
            mcopy(add(data, 0x20), add(add(code, 0x20), offset), size)
        }
        // PUSH4 len; DUP1; PUSH1 14; PUSH1 0; CODECOPY; PUSH1 0; RETURN
        bytes memory init = abi.encodePacked(hex"63", uint32(size + 1), hex"80600e6000396000f3", hex"00", data);
        assembly ("memory-safe") {
            ptr := create(0, add(init, 0x20), mload(init))
        }
        require(ptr != address(0), "chunk store failed");
    }

    function _read(address ptr) private view returns (bytes memory data) {
        uint256 size;
        assembly ("memory-safe") {
            size := extcodesize(ptr)
        }
        data = new bytes(size - 1); // drop the STOP guard
        assembly ("memory-safe") {
            extcodecopy(ptr, add(data, 0x20), 1, sub(size, 1))
        }
    }
}

contract GeometricOpsDeployer {
    function deploy(
        address token0,
        address token1,
        int24 tickSpacing,
        address hooks,
        address permissions,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address) {
        return address(
            new GeometricMakerOps(
                token0, token1, tickSpacing, hooks, permissions, feeRecipient, makerFeeBps, takerFeeBps
            )
        );
    }
}
