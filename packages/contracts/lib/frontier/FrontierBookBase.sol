// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./RangeTakeProfitBook.sol";
import {IFrontierHooks, FrontierHookFlags} from "./hooks/IFrontierHooks.sol";
import {IPermissionRegistry} from "./permissions/interfaces/IPermissionRegistry.sol";

/// @title FrontierBookBase — storage layout + shared machinery of the book
///
/// EIP-170 split: the deployable book is two contracts sharing this exact
/// storage layout and immutable set. `RollingFrontierBook` (the address
/// users hold) keeps the hot path — deposits, sweeps, claims, views — and
/// forwards the cold maker-management surface (requotes, cancels,
/// transfers) to a `FrontierMakerOps` companion via delegatecall. Because
/// delegatecalled code reads its OWN immutables, the companion is
/// constructed with the same (token0, token1, spacing, hooks, permissions)
/// and can be shared by every book with that config.
///
/// Everything either side touches lives here; neither deployable contract
/// declares state of its own (the core's `makerOps` is immutable, i.e.
/// code, not storage), so the delegatecall can never desynchronize layouts.
abstract contract FrontierBookBase {
    using FrontierHookFlags for address;

    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;
    int24 public immutable tickSpacing;
    /// v4-style hooks contract (flags in its address low bits); 0 = none
    IFrontierHooks public immutable hooks;
    /// delegatable permissions (ERC Approval Registry); 0 = owner-only
    IPermissionRegistry public immutable permissions;
    /// fee recipient for this experimental branch; zero only when both fees are zero
    address public immutable feeRecipient;
    /// maker fee charged from claim proceeds, in basis points
    uint16 public immutable makerFeeBps;
    /// taker fee charged on sweep input, in basis points
    uint16 public immutable takerFeeBps;

    int24 internal _currentTick;
    uint64 public fillClock;
    uint64 internal _nextPositionId = 1;

    function nextPositionId() public view returns (uint256) {
        return _nextPositionId;
    }

    // signed: +L at live frontiers, -L at order uppers; rolls self-cancel
    mapping(int24 => int256) public frontierDelta;
    // SECOND-ORDER deltas for shaped (linear-ladder) orders: the aggregate
    // per-level size increment in effect from each boundary. Rolls forward
    // with the value accumulator: A(t+s) = A(t) + S(t+s). Uniform orders
    // never touch it. Levels covered by any order always have size >= 1
    // (enforced at deposit), so the value bitmap alone drives sweeps and the
    // slope accumulator piggybacks on the roll chain.
    mapping(int24 => int256) public frontierSlope;
    // one bit per tick-spacing interval with nonzero frontierDelta, so sweeps
    // skip empty price regions in O(1) per 256 intervals instead of one SLOAD
    // per interval (which would brick sweeps across wide gaps)
    mapping(int16 => uint256) public tickBitmap;

    // ASK-side fill records: ONE entry per liquidity-moving up-sweep instead
    // of a clock stamp per level ("endpoint sweeps"). Entries keep clocks
    // strictly increasing and highs strictly decreasing (dominated entries
    // are popped), so "highest boundary covered since clock c" is the first
    // entry with clock > c — O(log sweeps). Soundness: a sweep that reached
    // boundary H crossed every boundary <= H after that clock, and it cannot
    // cover a live position's levels without consuming them (bits force
    // absorption); prefix-contiguity turns that into per-position proof.
    struct HighWater {
        uint64 clock;
        int24 high;
    }

    HighWater[] internal _highWaters;

    // ----- BID side (buy token0 with token1, resting BELOW the price) -----
    // Exact mirror of the ask machinery: sizes are token0-denominated
    // (per-level amount of token0 the maker wants to buy, so claims and
    // span sums stay closed-form), the frontier rolls DOWNWARD, and fill
    // clocks are keyed by the interval's LOWER boundary. Uniform sizes only
    // (shapes mirror mechanically; kept ask-side for now).
    mapping(int24 => int256) public bidDelta; // +B at bid frontiers (interval lower), -B at lower-s
    mapping(int16 => uint256) public bidBitmap;

    // Mirror of the high-water stack for DOWN-sweeps: one record per
    // liquidity-moving down-sweep instead of a clock stamp per boundary.
    // Entries: clocks ascending, lows strictly ascending, so the first
    // entry past a deposit clock carries the minimum boundary reached.
    struct LowWater {
        uint64 clock;
        int24 low;
    }

    LowWater[] internal _lowWaters;

    // lowest/highest boundaries ever used; only for the O(width) view scans
    int24 internal _minBoundary = type(int24).max;
    int24 internal _maxBoundary = type(int24).min;

    struct Position {
        address owner;
        int24 lower;
        int24 upper;
        // asks: proceeds paid for [lower, cursor); bids: paid for [cursor, upper)
        int24 claimedUpper;
        bool live;
        bool isBid;
        uint128 liquidity; // size at `lower` (L0)
        uint64 depositClock;
    }

    mapping(uint256 => Position) internal _positions;
    // Ask-only per-level size increment; bids and flat asks leave this slot
    // unset, saving one fresh position SSTORE on the hot flat paths.
    mapping(uint256 => int128) internal _positionSlope;

    function positions(uint256 positionId)
        public
        view
        returns (
            address owner,
            int24 lower,
            int24 upper,
            uint128 liquidity,
            int128 slope,
            uint64 depositClock,
            int24 claimedUpper,
            bool live,
            bool isBid
        )
    {
        Position storage p = _positions[positionId];
        return (
            p.owner,
            p.lower,
            p.upper,
            p.liquidity,
            _positionSlope[positionId],
            p.depositClock,
            p.claimedUpper,
            p.live,
            p.isBid
        );
    }

    function _storePosition(
        uint256 positionId,
        address owner,
        int24 lower,
        int24 upper,
        uint128 liquidity,
        uint64 depositClock,
        int24 claimedUpper,
        bool isBid
    ) internal {
        uint256 word0 = uint256(uint160(owner)) | (uint256(uint24(lower)) << 160) | (uint256(uint24(upper)) << 184)
            | (uint256(uint24(claimedUpper)) << 208) | (uint256(1) << 232) | (isBid ? (uint256(1) << 240) : 0);
        uint256 word1 = uint256(liquidity) | (uint256(depositClock) << 128);
        assembly ("memory-safe") {
            mstore(0, positionId)
            mstore(32, _positions.slot)
            let slot := keccak256(0, 64)
            sstore(slot, word0)
            sstore(add(slot, 1), word1)
        }
    }

    // Internal balance ledger: proceeds/refunds can be credited here instead
    // of transferred out, and every deposit path spends credit FIRST, pulling
    // only the shortfall via transferFrom. This is what lets earned balances
    // recycle into new orders with zero token transfers.
    mapping(address => uint256) public internalBalance0;
    mapping(address => uint256) public internalBalance1;

    event Deposit(uint256 indexed positionId, address indexed owner, int24 lower, int24 upper, uint128 liquidity);
    event IntervalFilled(int24 indexed lowerTick, uint128 liquidity, uint256 proceeds1, uint64 clock);
    event RunFilled(int24 indexed fromLevel, int24 toBoundary, uint256 startSize, int256 slopePerLevel, uint64 clock);
    event Claim(uint256 indexed positionId, uint256 proceeds1);
    event Cancel(uint256 indexed positionId, uint256 proceeds1, uint256 principal0);
    event Requote(uint256 indexed positionId, int24 lower, int24 upper, uint128 liquidity);
    event PositionTransferred(uint256 indexed positionId, address indexed from, address indexed to);
    event InternalCredit(address indexed user, uint256 amount0, uint256 amount1);
    event InternalWithdraw(address indexed user, uint256 amount0, uint256 amount1);
    event MakerFee(
        uint256 indexed positionId,
        address indexed token,
        uint256 grossProceeds,
        uint256 fee,
        uint256 netProceeds,
        address recipient
    );
    event TakerFee(
        address indexed payer,
        address indexed token,
        uint256 grossInput,
        uint256 fee,
        uint256 totalPaid,
        address recipient
    );

    uint256 internal constant PRICE_SCALE = 1e18;
    uint256 public constant FEE_BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;

    constructor(
        address _token0,
        address _token1,
        int24 _tickSpacing,
        int24 _initialTick,
        address _hooks,
        address _permissions,
        address _feeRecipient,
        uint16 _makerFeeBps,
        uint16 _takerFeeBps
    ) {
        require(_tickSpacing > 0, "bad spacing");
        require(_makerFeeBps <= MAX_FEE_BPS && _takerFeeBps <= MAX_FEE_BPS, "fee too high");
        require(_feeRecipient != address(0) || (_makerFeeBps == 0 && _takerFeeBps == 0), "fee recipient required");
        token0 = IERC20Minimal(_token0);
        token1 = IERC20Minimal(_token1);
        tickSpacing = _tickSpacing;
        _currentTick = _initialTick;
        hooks = IFrontierHooks(_hooks);
        permissions = IPermissionRegistry(_permissions);
        feeRecipient = _feeRecipient;
        makerFeeBps = _makerFeeBps;
        takerFeeBps = _takerFeeBps;
    }

    // ------------------------------------------------------------------
    // Delegatable authorization (ERC Approval Registry integration):
    // the owner can always act; anyone else needs a selector-scoped grant
    // for THIS book in the registry. Payouts always go to the position
    // owner regardless of who triggers — operators manage, never receive.
    // ------------------------------------------------------------------

    function _authOwner(address owner) internal view {
        if (msg.sender != owner) {
            require(address(permissions) != address(0), "not owner");
            permissions.requireAuthorizedCall(owner, msg.sender, address(this), msg.sig);
        }
    }

    // ------------------------------------------------------------------
    // Batching: settle a whole portfolio in one transaction. Delegatecall
    // to self preserves msg.sender AND msg.sig (per inner call), so
    // authorization is byte-identical to separate transactions; the
    // savings are one 21k intrinsic + cold account/token access per
    // extra call. No function here is payable, so msg.value reuse — the
    // classic multicall hazard — does not apply.
    // ------------------------------------------------------------------

    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }

    // ------------------------------------------------------------------
    // Hook dispatch (skipped when the hook itself is the caller)
    // ------------------------------------------------------------------

    function _callHook(uint160 flag, bytes memory data, bytes4 expected) internal {
        address h = address(hooks);
        if (h == address(0) || !h.hasFlag(flag) || msg.sender == h) return;
        (bool ok, bytes memory ret) = h.call(data);
        require(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == expected, "hook rejected");
    }

    function _callBeforeDepositHook(
        address owner,
        int24 lower,
        int24 upper,
        uint128 liquidity,
        int128 slope,
        bool isBid
    ) internal {
        address h = address(hooks);
        if (h == address(0) || !h.hasFlag(FrontierHookFlags.BEFORE_DEPOSIT_FLAG) || msg.sender == h) return;
        (bool ok, bytes memory ret) =
            h.call(abi.encodeCall(IFrontierHooks.beforeDeposit, (owner, lower, upper, liquidity, slope, isBid)));
        require(
            ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IFrontierHooks.beforeDeposit.selector,
            "hook rejected"
        );
    }

    function _callAfterDepositHook(address owner, uint256 positionId, bool isBid) internal {
        address h = address(hooks);
        if (h == address(0) || !h.hasFlag(FrontierHookFlags.AFTER_DEPOSIT_FLAG) || msg.sender == h) return;
        (bool ok, bytes memory ret) = h.call(abi.encodeCall(IFrontierHooks.afterDeposit, (owner, positionId, isBid)));
        require(
            ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IFrontierHooks.afterDeposit.selector, "hook rejected"
        );
    }

    // ------------------------------------------------------------------
    // Shared internals
    // ------------------------------------------------------------------

    function _checkRange(int24 lower, int24 upper) internal view {
        require(lower < upper, "empty range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "unaligned");
        require(lower > _currentTick, "range not above price");
    }

    function _levels(int24 lower, int24 upper) internal view returns (uint24) {
        return uint24(upper - lower) / uint24(tickSpacing);
    }

    function _levelOf(Position storage p, int24 t) internal view returns (uint24) {
        return uint24(t - p.lower) / uint24(tickSpacing);
    }

    /// @dev size at level j of a shaped order
    function _sizeAt(uint128 l0, int128 m, uint24 j) internal pure returns (int256) {
        return int256(uint256(l0)) + int256(m) * int256(uint256(j));
    }

    function _checkShape(int24 lower, int24 upper, uint128 l0, int128 m) internal view virtual {
        uint24 n = _levels(lower, upper);
        // linear => extrema at the endpoints; every covered level must hold
        // at least 1 unit so the sweep bitmap sees it
        require(_sizeAt(l0, m, 0) >= 1 && _sizeAt(l0, m, n - 1) >= 1, "level size < 1");
    }

    function _addOrder(int24 lower, int24 upper, uint128 liquidity, int128 slope) internal {
        _writeDelta(lower, frontierDelta[lower] + int256(uint256(liquidity)));
        uint24 n = _levels(lower, upper);
        int256 lastSize = _sizeAt(liquidity, slope, n - 1);
        _writeDelta(upper, frontierDelta[upper] - lastSize);
        if (slope != 0) {
            // slope takes effect from the SECOND level; ends at upper.
            // (single-level orders: the two writes hit the same slot, net 0)
            _writeSlope(lower + tickSpacing, frontierSlope[lower + tickSpacing] + int256(slope));
            _writeSlope(upper, frontierSlope[upper] - int256(slope));
        }
        if (lower < _minBoundary) _minBoundary = lower;
    }

    /// @dev Remove an order's remaining tail [frontier, upper). At an
    /// untouched frontier (== lower) the order's slot contribution is its L0
    /// jump and its slope entry rests at lower+s. At a rolled-into frontier,
    /// the value slot holds the order's PREVIOUS level's base (the slope
    /// advance is applied at consumption), and its slope lives in the
    /// frontier's absorbed slope slot.
    function _removeOrderAt(int24 frontier, int24 lower, int24 upper, uint128 liquidity, int128 slope) internal {
        uint24 jF = uint24(frontier - lower) / uint24(tickSpacing);
        uint24 n = _levels(lower, upper);
        if (frontier == lower) {
            _writeDelta(frontier, frontierDelta[frontier] - _sizeAt(liquidity, slope, 0));
            if (slope != 0) _writeSlope(lower + tickSpacing, frontierSlope[lower + tickSpacing] - int256(slope));
        } else {
            _writeDelta(frontier, frontierDelta[frontier] - _sizeAt(liquidity, slope, jF - 1));
            if (slope != 0) _writeSlope(frontier, frontierSlope[frontier] - int256(slope));
        }
        _writeDelta(upper, frontierDelta[upper] + _sizeAt(liquidity, slope, n - 1));
        if (slope != 0) _writeSlope(upper, frontierSlope[upper] + int256(slope));
    }

    function _addBid(int24 lower, int24 upper, uint128 liquidity) internal {
        int24 upperT = upper - tickSpacing;
        int24 lowerT = lower - tickSpacing;
        int256 liq = int256(uint256(liquidity));
        int256 oldUpper = bidDelta[upperT];
        int256 newUpper = oldUpper + liq;
        int256 oldLower = bidDelta[lowerT];
        int256 newLower = oldLower - liq;
        bidDelta[upperT] = newUpper;
        bidDelta[lowerT] = newLower;
        if (oldUpper == 0 && oldLower == 0) {
            int24 cUpper = upperT / tickSpacing;
            int24 cLower = lowerT / tickSpacing;
            int16 wordUpper = int16(cUpper >> 8);
            uint256 maskUpper = uint256(1) << uint8(uint24(cUpper));
            uint256 maskLower = uint256(1) << uint8(uint24(cLower));
            int16 wordLower = int16(cLower >> 8);
            if (wordUpper == wordLower) {
                bidBitmap[wordUpper] |= maskUpper | maskLower;
            } else {
                bidBitmap[wordUpper] |= maskUpper;
                bidBitmap[wordLower] |= maskLower;
            }
            return;
        }
        _syncBidBitsAfterTwo(upperT, oldUpper, newUpper, lowerT, oldLower, newLower);
    }

    function _syncBidBitsAfterTwo(int24 a, int256 oldA, int256 newA, int24 b, int256 oldB, int256 newB) internal {
        bool touchA = oldA == 0 || newA == 0;
        bool touchB = oldB == 0 || newB == 0;
        if (!touchA && !touchB) return;

        int24 cA = a / tickSpacing;
        int16 wordA = int16(cA >> 8);
        uint256 maskA = uint256(1) << uint8(uint24(cA));
        if (touchB) {
            int24 cB = b / tickSpacing;
            int16 wordB = int16(cB >> 8);
            uint256 maskB = uint256(1) << uint8(uint24(cB));
            if (wordA == wordB) {
                uint256 word = bidBitmap[wordA];
                if (touchA) word = newA != 0 ? word | maskA : word & ~maskA;
                word = newB != 0 ? word | maskB : word & ~maskB;
                bidBitmap[wordA] = word;
                return;
            }
            if (touchA) _syncBidBit(wordA, maskA, newA != 0);
            _syncBidBit(wordB, maskB, newB != 0);
            return;
        }
        _syncBidBit(wordA, maskA, newA != 0);
    }

    function _syncBidBit(int16 wordPos, uint256 mask, bool set) internal {
        uint256 word = bidBitmap[wordPos];
        if (set) {
            if (word & mask == 0) bidBitmap[wordPos] = word | mask;
        } else {
            if (word & mask != 0) bidBitmap[wordPos] = word & ~mask;
        }
    }

    /// @dev Bid mirror of _writeDelta, maintaining the bid bitmap.
    function _writeBidDelta(int24 t, int256 newVal) internal {
        int256 old = bidDelta[t];
        if (old == newVal) return;
        bidDelta[t] = newVal;
        if (old == 0 || newVal == 0) {
            int24 c = t / tickSpacing;
            int16 wordPos = int16(c >> 8);
            uint8 bitPos = uint8(uint24(c));
            if (newVal != 0) bidBitmap[wordPos] |= (uint256(1) << bitPos);
            else bidBitmap[wordPos] &= ~(uint256(1) << bitPos);
        }
    }

    /// @dev Largest spacing-aligned t in [minT, fromT] with nonzero bidDelta,
    /// scanning whole bitmap words downward.
    function _prevActive(int24 fromT, int24 minT) internal view returns (int24, bool) {
        if (fromT < minT) return (0, false);
        int24 c = fromT / tickSpacing;
        int24 cMin = minT / tickSpacing;
        while (c >= cMin) {
            int16 wordPos = int16(c >> 8);
            uint8 bitPos = uint8(uint24(c));
            // keep bits at and below bitPos
            uint256 word = bidBitmap[wordPos] << (255 - bitPos);
            if (word != 0) {
                int24 cFound = c - int24(uint24(255 - _msb(word)));
                if (cFound < cMin) return (0, false);
                return (cFound * tickSpacing, true);
            }
            c = (int24(wordPos) * 256) - 1;
        }
        return (0, false);
    }

    function _msb(uint256 x) private pure returns (uint8 r) {
        // precondition: x != 0
        if (x >> 128 != 0) {
            r += 128;
            x >>= 128;
        }
        if (x >> 64 != 0) {
            r += 64;
            x >>= 64;
        }
        if (x >> 32 != 0) {
            r += 32;
            x >>= 32;
        }
        if (x >> 16 != 0) {
            r += 16;
            x >>= 16;
        }
        if (x >> 8 != 0) {
            r += 8;
            x >>= 8;
        }
        if (x >> 4 != 0) {
            r += 4;
            x >>= 4;
        }
        if (x >> 2 != 0) {
            r += 2;
            x >>= 2;
        }
        if (x >> 1 != 0) {
            r += 1;
        }
    }

    /// @dev Mirror of _frontier: lowest boundary covered by any down-sweep
    /// since the bid's deposit, clamped to its range (prefix-from-the-top
    /// contiguity makes the clamp exact). O(log sweep-records).
    function _bidFrontier(Position storage p) internal view returns (int24 hi) {
        hi = p.claimedUpper;
        int24 lw = _lowSince(p.depositClock);
        if (lw < hi) hi = lw < p.lower ? p.lower : lw;
    }

    function _floorAligned(int24 x) internal view returns (int24) {
        int24 q = x / tickSpacing;
        if (x < 0 && x % tickSpacing != 0) q -= 1;
        return q * tickSpacing;
    }

    /// @dev token1 value of `size` token0-units per level over [a, b) at the
    /// linear rate curve; ceil = book-favorable (bid deposits), floor = payouts.
    function _uniformSpanValue(int24 a, int24 b, uint128 size, bool roundUp) internal view virtual returns (uint256) {
        unchecked {
            int256 sp = int256(tickSpacing);
            int256 n = (int256(b) - int256(a)) / sp;
            int256 tickSum = n * int256(a) + (sp * n * (n - 1)) / 2;
            int256 rateSum = n * int256(PRICE_SCALE) + tickSum * 1e15;
            require(rateSum > 0, "rate underflow");
            uint256 v = uint256(size) * uint256(rateSum);
            return roundUp ? (v + PRICE_SCALE - 1) / PRICE_SCALE : v / PRICE_SCALE;
        }
    }

    function _rate(int24 t) internal pure virtual returns (uint256) {
        int256 r = int256(PRICE_SCALE) + int256(t) * 1e15;
        require(r > 0, "rate underflow");
        return uint256(r);
    }

    /// @dev token0 sold and token1 collected (ceil, contract-favorable) for
    /// an affine run of `n` levels starting at level `e` with start size
    /// `a0` and per-level slope `slope`. Closed form: size linear in k,
    /// rate linear in tick => quadratic series.
    function _runAmounts(int24 e, int256 a0, int256 slope, uint256 n)
        internal
        view
        virtual
        returns (uint256 out0, uint256 cost1)
    {
        int256 ni = int256(n);
        int256 sumK = (ni * (ni - 1)) / 2;
        int256 sumK2 = ((ni - 1) * ni * (2 * ni - 1)) / 6;
        int256 tot0 = a0 * ni + slope * sumK;
        int256 c0 = int256(PRICE_SCALE) + int256(e) * 1e15;
        int256 c1 = int256(tickSpacing) * 1e15;
        int256 val = a0 * c0 * ni + (a0 * c1 + slope * c0) * sumK + slope * c1 * sumK2;
        require(tot0 >= 0 && val >= 0, "negative run");
        out0 = uint256(tot0);
        cost1 = (uint256(val) + PRICE_SCALE - 1) / PRICE_SCALE;
    }

    /// @dev token0 collected and token1 paid out (floor, contract-favorable)
    /// for a uniform descending run of `n` levels starting at level `e` with
    /// per-level size `a0`. Rate linear in tick => arithmetic series.
    function _bidRunAmounts(int24 e, int256 a0, uint256 n) internal view virtual returns (uint256 in0, uint256 out1) {
        int256 ni = int256(n);
        int256 sumK = (ni * (ni - 1)) / 2;
        int256 tot0 = a0 * ni;
        int256 c0 = int256(PRICE_SCALE) + int256(e) * 1e15;
        int256 c1 = int256(tickSpacing) * 1e15;
        int256 val = a0 * c0 * ni - a0 * c1 * sumK; // levels descend from e
        require(tot0 >= 0 && val >= 0, "negative run");
        in0 = uint256(tot0);
        out1 = uint256(val) / PRICE_SCALE;
    }

    /// @dev Spend the payer's internal token0 credit first; transferFrom
    /// only the shortfall.
    function _pull0(address payer, uint256 amount) internal {
        uint256 credit = internalBalance0[payer];
        if (credit >= amount) {
            internalBalance0[payer] = credit - amount;
            return;
        }
        if (credit > 0) internalBalance0[payer] = 0;
        _transferInExact(token0, payer, amount - credit, "non-exact token0 transfer");
    }

    /// @dev Mirror for token1.
    function _pull1(address payer, uint256 amount) internal {
        uint256 credit = internalBalance1[payer];
        if (credit >= amount) {
            internalBalance1[payer] = credit - amount;
            return;
        }
        if (credit > 0) internalBalance1[payer] = 0;
        _transferInExact(token1, payer, amount - credit, "non-exact token1 transfer");
    }

    function _transferInExact(IERC20Minimal token, address payer, uint256 amount, string memory err) internal {
        if (amount == 0) return;
        uint256 beforeBal = token.balanceOf(address(this));
        require(token.transferFrom(payer, address(this), amount), "transfer in failed");
        require(token.balanceOf(address(this)) - beforeBal == amount, err);
    }

    function _feeAmount(uint256 amount, uint16 feeBps) internal pure returns (uint256) {
        return (amount * feeBps) / FEE_BPS_DENOMINATOR;
    }

    function _maxGrossForTotal(uint256 maxTotal, uint16 feeBps) internal pure returns (uint256) {
        if (feeBps == 0 || maxTotal == type(uint256).max) return maxTotal;
        uint256 denominator = FEE_BPS_DENOMINATOR + uint256(feeBps);
        return
            (maxTotal / denominator) * FEE_BPS_DENOMINATOR + ((maxTotal % denominator) * FEE_BPS_DENOMINATOR)
                / denominator;
    }

    function _chargeMakerFee(IERC20Minimal token, uint256 positionId, uint256 grossProceeds)
        internal
        returns (uint256 netProceeds, uint256 fee)
    {
        fee = _feeAmount(grossProceeds, makerFeeBps);
        netProceeds = grossProceeds - fee;
        if (fee > 0) require(token.transfer(feeRecipient, fee), "fee transfer failed");
        if (makerFeeBps > 0) emit MakerFee(positionId, address(token), grossProceeds, fee, netProceeds, feeRecipient);
    }

    function _takerTotal(uint256 grossInput) internal view returns (uint256 totalPaid, uint256 fee) {
        fee = _feeAmount(grossInput, takerFeeBps);
        totalPaid = grossInput + fee;
    }

    function _payTakerFee(IERC20Minimal token, address payer, uint256 grossInput, uint256 fee, uint256 totalPaid)
        internal
    {
        if (fee > 0) require(token.transfer(feeRecipient, fee), "fee transfer failed");
        if (takerFeeBps > 0) emit TakerFee(payer, address(token), grossInput, fee, totalPaid, feeRecipient);
    }

    /// @dev Single write paths for the ask ledgers, keeping the bitmap in
    /// sync. Bit set <=> frontierDelta != 0 OR frontierSlope != 0 — runs
    /// telescope between set bits, so a slope-only endpoint MUST be visible
    /// or a run would sail over a shape change.
    function _writeDelta(int24 t, int256 newVal) internal {
        int256 old = frontierDelta[t];
        if (old == newVal) return;
        frontierDelta[t] = newVal;
        if (old == 0 || newVal == 0) _syncAskBit(t);
    }

    function _writeSlope(int24 t, int256 newVal) internal {
        int256 old = frontierSlope[t];
        if (old == newVal) return;
        frontierSlope[t] = newVal;
        if (old == 0 || newVal == 0) _syncAskBit(t);
    }

    function _syncAskBit(int24 t) internal {
        bool set = frontierDelta[t] != 0 || frontierSlope[t] != 0;
        int24 c = t / tickSpacing; // exact: t is always spacing-aligned
        int16 wordPos = int16(c >> 8);
        uint8 bitPos = uint8(uint24(c)); // low 8 bits, two's complement safe
        uint256 word = tickBitmap[wordPos];
        uint256 mask = uint256(1) << bitPos;
        if (set) {
            if (word & mask == 0) tickBitmap[wordPos] = word | mask;
        } else {
            if (word & mask != 0) tickBitmap[wordPos] = word & ~mask;
        }
    }

    /// @dev Smallest spacing-aligned t in [fromT, maxT] with nonzero delta,
    /// scanning whole bitmap words.
    function _nextActive(int24 fromT, int24 maxT) internal view returns (int24, bool) {
        if (fromT > maxT) return (0, false);
        int24 c = fromT / tickSpacing;
        int24 cMax = maxT / tickSpacing;
        while (c <= cMax) {
            int16 wordPos = int16(c >> 8);
            uint8 bitPos = uint8(uint24(c));
            uint256 word = tickBitmap[wordPos] >> bitPos;
            if (word != 0) {
                int24 cFound = c + int24(uint24(_lsb(word)));
                if (cFound > cMax) return (0, false);
                return (cFound * tickSpacing, true);
            }
            c = (int24(wordPos) + 1) * 256;
        }
        return (0, false);
    }

    function _lsb(uint256 x) private pure returns (uint8 r) {
        // precondition: x != 0
        if (x & type(uint128).max == 0) {
            r += 128;
            x >>= 128;
        }
        if (x & type(uint64).max == 0) {
            r += 64;
            x >>= 64;
        }
        if (x & type(uint32).max == 0) {
            r += 32;
            x >>= 32;
        }
        if (x & type(uint16).max == 0) {
            r += 16;
            x >>= 16;
        }
        if (x & type(uint8).max == 0) {
            r += 8;
            x >>= 8;
        }
        if (x & 0xF == 0) {
            r += 4;
            x >>= 4;
        }
        if (x & 0x3 == 0) {
            r += 2;
            x >>= 2;
        }
        if (x & 0x1 == 0) {
            r += 1;
        }
    }

    /// @dev Frontier = highest boundary covered by any up-sweep since the
    /// position's deposit, clamped to its range (prefix-contiguity makes the
    /// clamp exact). O(log sweep-records).
    function _frontier(Position storage p) internal view returns (int24 lo) {
        lo = p.claimedUpper;
        int24 hw = _highSince(p.depositClock);
        if (hw > lo) lo = hw > p.upper ? p.upper : hw;
    }

    /// @dev Highest boundary covered by a liquidity-moving up-sweep with
    /// clock > c. Entries: clocks ascending, highs strictly descending, so
    /// the first entry past c carries the maximum.
    function _highSince(uint64 c) internal view returns (int24) {
        uint256 n = _highWaters.length;
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_highWaters[mid].clock > c) hi = mid;
            else lo = mid + 1;
        }
        if (lo == n) return type(int24).min;
        return _highWaters[lo].high;
    }

    function _pushHighWater(uint64 clock, int24 high) internal {
        uint256 n = _highWaters.length;
        while (n > 0 && _highWaters[n - 1].high <= high) {
            _highWaters.pop();
            n--;
        }
        _highWaters.push(HighWater({clock: clock, high: high}));
    }

    /// @dev Lowest boundary covered by a liquidity-moving down-sweep with
    /// clock > c. Entries: clocks ascending, lows strictly ascending, so
    /// the first entry past c carries the minimum.
    function _lowSince(uint64 c) internal view returns (int24) {
        uint256 n = _lowWaters.length;
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_lowWaters[mid].clock > c) hi = mid;
            else lo = mid + 1;
        }
        if (lo == n) return type(int24).max;
        return _lowWaters[lo].low;
    }

    function _pushLowWater(uint64 clock, int24 low) internal {
        uint256 n = _lowWaters.length;
        while (n > 0 && _lowWaters[n - 1].low >= low) {
            _lowWaters.pop();
            n--;
        }
        _lowWaters.push(LowWater({clock: clock, low: low}));
    }

    /// @dev Proceeds for the position's levels in [a, b): closed-form sum of
    /// size(j) * rate(tick(j)) — size linear in j, rate linear in tick, so
    /// the sum is a quadratic series, floored ONCE over the whole span (the
    /// single rounding is what makes O(1) payouts possible).
    /// rate(t) = 1e18 + t*1e15, same linear curve as RangeTakeProfitBook.
    function _spanAmt1(Position storage p, int128 slope, int24 a, int24 b) internal view virtual returns (uint256) {
        int256 sp = int256(tickSpacing);
        int256 ja = (int256(a) - int256(p.lower)) / sp;
        int256 n = (int256(b) - int256(a)) / sp;
        int256 jb = ja + n; // exclusive
        // sums over j in [ja, jb)
        int256 s1 = n;
        int256 sj = ((ja + jb - 1) * n) / 2;
        int256 sj2 = ((jb - 1) * jb * (2 * jb - 1) - (ja - 1) * ja * (2 * ja - 1)) / 6;
        // size(j) = L0 + m*j ; rate(j) = C0 + C1*j, with C0 = 1e18 + lower*1e15, C1 = s*1e15
        int256 l0 = int256(uint256(p.liquidity));
        int256 m = int256(slope);
        int256 c0 = int256(PRICE_SCALE) + int256(p.lower) * 1e15;
        int256 c1 = sp * 1e15;
        int256 total = l0 * c0 * s1 + (l0 * c1 + m * c0) * sj + m * c1 * sj2;
        require(total >= 0, "rate underflow");
        return uint256(total) / PRICE_SCALE;
    }

    /// @dev Sum of level sizes for levels j in [jStart, jEnd).
    function _principalSpan(uint128 l0, int128 m, uint24 jStart, uint24 jEnd) internal pure returns (uint256) {
        int256 n = int256(uint256(jEnd)) - int256(uint256(jStart));
        if (n <= 0) return 0;
        int256 sj = ((int256(uint256(jStart)) + int256(uint256(jEnd)) - 1) * n) / 2;
        int256 total = int256(uint256(l0)) * n + int256(m) * sj;
        require(total >= 0, "negative principal");
        return uint256(total);
    }

    function _nextBoundaryAbove(int24 tick) internal view returns (int24) {
        int24 b = (tick / tickSpacing) * tickSpacing;
        if (b <= tick) b += tickSpacing;
        return b;
    }
}
