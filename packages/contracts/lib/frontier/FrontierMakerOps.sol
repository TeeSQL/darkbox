// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FrontierBookBase} from "./FrontierBookBase.sol";
import {FrontierHookFlags, IFrontierHooks} from "./hooks/IFrontierHooks.sol";

/// @title FrontierMakerOps — the book's cold maker-management surface
///
/// EIP-170 companion to RollingFrontierBook: requotes, cancels, and
/// position transfers execute here via delegatecall from the book, against
/// the book's storage. Deployed with the same (token0, token1, spacing,
/// hooks, permissions) immutables as the book(s) it serves — delegatecalled
/// code reads its OWN immutables, so matching them is what makes this
/// module shareable by every book with the same config (the factory
/// memoizes one per config; the initial tick is irrelevant here).
///
/// Called directly (not via a book), every entrypoint hits empty storage
/// and reverts on the `live` check — the module holds no funds and has no
/// deposit surface, so it is inert standalone.
contract FrontierMakerOps is FrontierBookBase {
    constructor(
        address _token0,
        address _token1,
        int24 _tickSpacing,
        address _hooks,
        address _permissions,
        address _feeRecipient,
        uint16 _makerFeeBps,
        uint16 _takerFeeBps
    )
        FrontierBookBase(
            _token0, _token1, _tickSpacing, 0, _hooks, _permissions, _feeRecipient, _makerFeeBps, _takerFeeBps
        )
    {}

    /// @notice Transfer position ownership (claims/refunds follow the new
    /// owner). Makes positions composable assets: periphery contracts can
    /// build positions and hand them to users; wrappers can tokenize them.
    function transferPosition(uint256 positionId, address to) external {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        _authOwner(p.owner);
        require(to != address(0), "zero owner");
        p.owner = to;
        emit PositionTransferred(positionId, msg.sender, to);
    }

    /// @notice O(1) re-price for quoters: move a completely UNFILLED order to
    /// a new range (and optionally new size) in place — four endpoint-delta
    /// writes, no token transfers when the principal is unchanged. The
    /// position's clock refreshes, so it joins the new levels' current
    /// lifecycles exactly as a fresh deposit would. Reverts if any interval
    /// has filled (settle via claim/cancel first).
    function requote(uint256 positionId, int24 newLower, int24 newUpper, uint128 newLiquidity) external {
        requoteShaped(positionId, newLower, newUpper, newLiquidity, 0);
    }

    /// @notice O(1) re-price (and optionally re-shape/re-size) of a
    /// completely unfilled order; tokens settle difference-only.
    function requoteShaped(uint256 positionId, int24 newLower, int24 newUpper, uint128 newLiquidity, int128 newSlope)
        public
    {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(!p.isBid, "use bid methods");
        _authOwner(p.owner);
        // completely unfilled <=> first interval not filled since deposit
        // (prefix-contiguity: nothing above it can have filled either)
        require(_highSince(p.depositClock) < p.lower + tickSpacing, "partially filled");
        _checkRange(newLower, newUpper);
        _checkShape(newLower, newUpper, newLiquidity, newSlope);
        int128 oldSlope = _positionSlope[positionId];

        // remove old endpoint entries (order unfilled: frontier == lower),
        // place new ones
        _removeOrderAt(p.lower, p.lower, p.upper, p.liquidity, oldSlope);
        _addOrder(newLower, newUpper, newLiquidity, newSlope);

        uint256 oldAmount0 = _principalSpan(p.liquidity, oldSlope, 0, _levels(p.lower, p.upper));
        uint256 newAmount0 = _principalSpan(newLiquidity, newSlope, 0, _levels(newLower, newUpper));

        p.lower = newLower;
        p.upper = newUpper;
        p.liquidity = newLiquidity;
        p.depositClock = fillClock;
        p.claimedUpper = newLower;
        if (newSlope == 0) delete _positionSlope[positionId];
        else _positionSlope[positionId] = newSlope;

        if (newAmount0 > oldAmount0) {
            _pull0(msg.sender, newAmount0 - oldAmount0);
        } else if (oldAmount0 > newAmount0) {
            require(token0.transfer(msg.sender, oldAmount0 - newAmount0), "transfer out failed");
        }
        emit Requote(positionId, newLower, newUpper, newLiquidity);
    }

    /// @notice O(1) re-price of a completely unfilled bid; token1 settles
    /// difference-only; clock refresh preserves freshness.
    function requoteBid(uint256 positionId, int24 newLower, int24 newUpper, uint128 newLiquidity) external {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(p.isBid, "not a bid");
        _authOwner(p.owner);
        require(newLiquidity > 0, "zero liquidity");
        // completely unfilled <=> topmost level not filled since deposit
        require(_lowSince(p.depositClock) > p.upper - tickSpacing, "partially filled");
        require(newLower < newUpper, "empty range");
        require(newLower % tickSpacing == 0 && newUpper % tickSpacing == 0, "unaligned");
        require(newUpper <= _currentTick, "range not below price");

        _writeBidDelta(p.upper - tickSpacing, bidDelta[p.upper - tickSpacing] - int256(uint256(p.liquidity)));
        _writeBidDelta(p.lower - tickSpacing, bidDelta[p.lower - tickSpacing] + int256(uint256(p.liquidity)));
        _addBid(newLower, newUpper, newLiquidity);

        uint256 oldAmount1 = _uniformSpanValue(p.lower, p.upper, p.liquidity, true);
        uint256 newAmount1 = _uniformSpanValue(newLower, newUpper, newLiquidity, true);

        p.lower = newLower;
        p.upper = newUpper;
        p.liquidity = newLiquidity;
        p.depositClock = fillClock;
        p.claimedUpper = newUpper;

        if (newAmount1 > oldAmount1) {
            _pull1(msg.sender, newAmount1 - oldAmount1);
        } else if (oldAmount1 > newAmount1) {
            require(token1.transfer(msg.sender, oldAmount1 - newAmount1), "transfer out failed");
        }
        emit Requote(positionId, newLower, newUpper, newLiquidity);
    }

    /// @notice O(1) cancel against a maximal-frontier witness: pays unclaimed
    /// filled proceeds, returns the unfilled suffix principal, removes the
    /// order's endpoint deltas, retires the position.
    function cancelWithWitness(uint256 positionId, int24 frontier)
        public
        returns (uint256 proceeds1, uint256 principal0)
    {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(!p.isBid, "use bid methods");
        _authOwner(p.owner);
        require(frontier >= p.lower && frontier <= p.upper, "frontier out of range");
        require((frontier - p.lower) % tickSpacing == 0, "unaligned frontier");
        // proves frontier is filled-up-to...
        int24 hw = _highSince(p.depositClock);
        if (frontier > p.lower) require(hw >= frontier, "frontier not filled");
        // ...and maximal (next interval NOT filled since deposit)
        if (frontier < p.upper) {
            require(hw < frontier + tickSpacing, "frontier not maximal");
        }

        if (frontier > p.claimedUpper) {
            (proceeds1,) =
                _chargeMakerFee(token1, positionId, _spanAmt1(p, _positionSlope[positionId], p.claimedUpper, frontier));
            p.claimedUpper = frontier;
        }
        if (frontier < p.upper) {
            int128 slope = _positionSlope[positionId];
            _removeOrderAt(frontier, p.lower, p.upper, p.liquidity, slope);
            principal0 = _principalSpan(p.liquidity, slope, _levelOf(p, frontier), _levels(p.lower, p.upper));
        }
        // if frontier == upper the order fully consumed: its +L already rolled
        // into upper and self-cancelled against its -L; nothing to remove.
        p.live = false;
        delete _positionSlope[positionId];

        if (proceeds1 > 0) require(token1.transfer(p.owner, proceeds1), "transfer out failed");
        if (principal0 > 0) require(token0.transfer(p.owner, principal0), "transfer out failed");
        emit Cancel(positionId, proceeds1, principal0);
        _callHook(
            FrontierHookFlags.AFTER_CANCEL_FLAG,
            abi.encodeCall(IFrontierHooks.afterCancel, (msg.sender, positionId, proceeds1, principal0)),
            IFrontierHooks.afterCancel.selector
        );
    }

    /// @notice Convenience variant: finds the frontier itself in O(log width).
    function cancel(uint256 positionId) external returns (uint256 proceeds1, uint256 principal0) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(!p.isBid, "use bid methods");
        _authOwner(p.owner);
        return cancelWithWitness(positionId, _frontier(p));
    }

    /// @notice O(1) bid cancel against a maximal-frontier witness: pays
    /// unclaimed token0, refunds unfilled token1 (floor), retires the bid.
    function cancelBidWithWitness(uint256 positionId, int24 frontier)
        public
        returns (uint256 proceeds0, uint256 refund1)
    {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(p.isBid, "not a bid");
        _authOwner(p.owner);
        require(frontier >= p.lower && frontier <= p.upper, "frontier out of range");
        require((frontier - p.lower) % tickSpacing == 0, "unaligned frontier");
        int24 lw = _lowSince(p.depositClock);
        if (frontier < p.upper) require(lw <= frontier, "frontier not filled");
        if (frontier > p.lower) {
            require(lw > frontier - tickSpacing, "frontier not maximal");
        }

        if (frontier < p.claimedUpper) {
            (proceeds0,) = _chargeMakerFee(
                token0,
                positionId,
                uint256(p.liquidity) * (uint256(uint24(p.claimedUpper - frontier)) / uint256(uint24(tickSpacing)))
            );
            p.claimedUpper = frontier;
        }
        if (frontier > p.lower) {
            _writeBidDelta(frontier - tickSpacing, bidDelta[frontier - tickSpacing] - int256(uint256(p.liquidity)));
            _writeBidDelta(p.lower - tickSpacing, bidDelta[p.lower - tickSpacing] + int256(uint256(p.liquidity)));
            refund1 = _uniformSpanValue(p.lower, frontier, p.liquidity, false);
        }
        p.live = false;

        if (proceeds0 > 0) require(token0.transfer(p.owner, proceeds0), "transfer out failed");
        if (refund1 > 0) require(token1.transfer(p.owner, refund1), "transfer out failed");
        emit Cancel(positionId, proceeds0, refund1);
        _callHook(
            FrontierHookFlags.AFTER_CANCEL_FLAG,
            abi.encodeCall(IFrontierHooks.afterCancel, (msg.sender, positionId, proceeds0, refund1)),
            IFrontierHooks.afterCancel.selector
        );
    }

    /// @notice Convenience variant: finds the bid frontier in O(log width).
    function cancelBid(uint256 positionId) external returns (uint256 proceeds0, uint256 refund1) {
        Position storage p = _positions[positionId];
        require(p.live, "not live");
        require(p.isBid, "not a bid");
        _authOwner(p.owner);
        return cancelBidWithWitness(positionId, _bidFrontier(p));
    }
}
