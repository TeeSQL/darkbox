// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Uniswap-v4-style hooks for frontier books: permissions are encoded
/// in the HOOK CONTRACT'S ADDRESS low bits, validated at book creation, so a
/// hook's capabilities are inspectable on-chain and immutable. Each callback
/// must return its own selector (v4 convention); reverting blocks the action.
/// The book skips callbacks for actions the hook itself initiates (the v4
/// noSelfCall lesson, learned on the fork test).
interface IFrontierHooks {
    function beforeDeposit(address maker, int24 lower, int24 upper, uint128 liquidity, int128 slope, bool isBid)
        external
        returns (bytes4);

    function afterDeposit(address maker, uint256 positionId, bool isBid) external returns (bytes4);

    function beforeSweep(address taker, int24 fromTick, int24 target) external returns (bytes4);

    function afterSweep(address taker, int24 fromTick, int24 reached, uint256 paid, uint256 received)
        external
        returns (bytes4);

    function afterClaim(address caller, uint256 positionId, uint256 proceeds) external returns (bytes4);

    function afterCancel(address caller, uint256 positionId, uint256 proceeds, uint256 principal)
        external
        returns (bytes4);
}

library FrontierHookFlags {
    uint160 internal constant BEFORE_DEPOSIT_FLAG = 1 << 0;
    uint160 internal constant AFTER_DEPOSIT_FLAG = 1 << 1;
    uint160 internal constant BEFORE_SWEEP_FLAG = 1 << 2;
    uint160 internal constant AFTER_SWEEP_FLAG = 1 << 3;
    uint160 internal constant AFTER_CLAIM_FLAG = 1 << 4;
    uint160 internal constant AFTER_CANCEL_FLAG = 1 << 5;

    uint160 internal constant ALL_FLAGS = (1 << 6) - 1;

    function hasFlag(address hooks, uint160 flag) internal pure returns (bool) {
        return uint160(hooks) & flag != 0;
    }
}
