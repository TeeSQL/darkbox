// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFrontierHooks} from "../IFrontierHooks.sol";

/// @notice Example hook: maker allowlist (beforeDeposit gate) + running
/// volume counter (afterSweep). Deploy at an address with
/// BEFORE_DEPOSIT_FLAG | AFTER_SWEEP_FLAG bits set (tests use deployCodeTo,
/// production uses CREATE2 mining — same as Uniswap v4).
contract GatedVolumeHook is IFrontierHooks {
    address public immutable admin;
    mapping(address => bool) public allowed;
    uint256 public totalSweeps;
    uint256 public totalToken0Volume;

    constructor(address _admin) {
        admin = _admin;
    }

    function setAllowed(address maker, bool ok) external {
        require(msg.sender == admin, "admin only");
        allowed[maker] = ok;
    }

    function beforeDeposit(address maker, int24, int24, uint128, int128, bool) external view returns (bytes4) {
        require(allowed[maker], "maker not allowed");
        return IFrontierHooks.beforeDeposit.selector;
    }

    function afterDeposit(address, uint256, bool) external pure returns (bytes4) {
        return IFrontierHooks.afterDeposit.selector;
    }

    function beforeSweep(address, int24, int24) external pure returns (bytes4) {
        return IFrontierHooks.beforeSweep.selector;
    }

    function afterSweep(address, int24 fromTick, int24 reached, uint256 paid, uint256 received)
        external
        returns (bytes4)
    {
        totalSweeps++;
        totalToken0Volume += reached > fromTick ? received : paid;
        return IFrontierHooks.afterSweep.selector;
    }

    function afterClaim(address, uint256, uint256) external pure returns (bytes4) {
        return IFrontierHooks.afterClaim.selector;
    }

    function afterCancel(address, uint256, uint256, uint256) external pure returns (bytes4) {
        return IFrontierHooks.afterCancel.selector;
    }
}
