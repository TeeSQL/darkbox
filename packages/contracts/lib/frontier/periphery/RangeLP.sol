// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "../RollingFrontierBook.sol";
import {IERC20Minimal} from "../RangeTakeProfitBook.sol";

/// @title RangeLP — Uniswap-style passive liquidity ON the orderbook.
///
/// A personal LP vault for one book: holds both tokens and quotes symmetric
/// ladders around the current price (asks above, bids below), like a
/// discretized x*y=k position. Fills convert inventory from one token to the
/// other exactly as an AMM position would; `rebalance()` re-centers the
/// ladders around the new price (the keeper-driven analogue of continuous
/// AMM rebalancing — see EXPERIMENTS.md for what this does and doesn't
/// replicate). Coexists with ordinary limit orders on the same book.
contract RangeLP {
    RollingFrontierBook public immutable book;
    address public immutable owner;
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;

    uint128 public sizePerLevel; // token0 units per level, both sides
    uint24 public levelsPerSide;
    int24 public gap; // half-spread in ticks (aligned)

    uint256 public askId;
    uint256 public bidId;

    event Opened(int24 mid, uint256 askId, uint256 bidId);
    event Rebalanced(int24 newMid, uint256 askId, uint256 bidId);
    event Closed(uint256 returned0, uint256 returned1);

    modifier onlyOwner() {
        // delegatable: the owner may grant bots requote/rebalance rights on
        // THIS vault via the shared permission registry
        if (msg.sender != owner) {
            require(address(book.permissions()) != address(0), "owner only");
            book.permissions().requireAuthorizedCall(owner, msg.sender, address(this), msg.sig);
        }
        _;
    }

    constructor(RollingFrontierBook _book, address _owner) {
        book = _book;
        owner = _owner;
        token0 = _book.token0();
        token1 = _book.token1();
        (bool ok0,) = address(token0).call(
            abi.encodeWithSignature("approve(address,uint256)", address(_book), type(uint256).max)
        );
        (bool ok1,) = address(token1).call(
            abi.encodeWithSignature("approve(address,uint256)", address(_book), type(uint256).max)
        );
        require(ok0 && ok1, "approve failed");
    }

    function open(uint128 _sizePerLevel, uint24 _levelsPerSide, int24 _gap) external onlyOwner {
        require(askId == 0 && bidId == 0, "already open");
        sizePerLevel = _sizePerLevel;
        levelsPerSide = _levelsPerSide;
        gap = _gap;
        _post();
        emit Opened(book.currentTick(), askId, bidId);
    }

    /// @notice Re-center both ladders around the current price. Claims fills,
    /// pulls back unfilled inventory, reposts as much of each side as the
    /// vault's current inventory affords (fills shift inventory between the
    /// tokens exactly like an AMM position changing composition).
    function rebalance() external onlyOwner {
        _teardown();
        _post();
        emit Rebalanced(book.currentTick(), askId, bidId);
    }

    function close() external onlyOwner {
        _teardown();
        uint256 b0 = token0Balance();
        uint256 b1 = token1Balance();
        if (b0 > 0) require(token0.transfer(owner, b0), "t0 out failed");
        if (b1 > 0) require(token1.transfer(owner, b1), "t1 out failed");
        emit Closed(b0, b1);
    }

    function token0Balance() public view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(token0).staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok ? abi.decode(ret, (uint256)) : 0;
    }

    function token1Balance() public view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(token1).staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok ? abi.decode(ret, (uint256)) : 0;
    }

    // ------------------------------------------------------------------

    function _teardown() internal {
        if (askId != 0) {
            book.cancel(askId); // claims fills + returns principal to this vault
            askId = 0;
        }
        if (bidId != 0) {
            book.cancelBid(bidId);
            bidId = 0;
        }
    }

    function _post() internal {
        int24 s = book.tickSpacing();
        int24 mid = book.currentTick();
        int24 g = gap < s ? s : (gap / s) * s;

        // ask side: as many levels as token0 inventory affords
        {
            int24 lower = _alignUp(mid + g, s);
            if (lower <= mid) lower += s;
            uint24 n = uint24(_min(levelsPerSide, token0Balance() / sizePerLevel));
            if (n > 0) {
                askId = book.deposit(lower, lower + int24(n) * s, sizePerLevel);
            }
        }
        // bid side: as many levels as token1 inventory affords (walk costs)
        {
            int24 upper = _alignDown(mid - g, s);
            if (upper > mid) upper = _alignDown(mid, s);
            uint256 budget = token1Balance();
            uint24 n;
            uint256 cost;
            while (n < levelsPerSide) {
                int24 lvl = upper - int24(n + 1) * s;
                uint256 levelCost = (uint256(sizePerLevel) * _rate(lvl) + 1e18 - 1) / 1e18;
                if (cost + levelCost > budget) break;
                cost += levelCost;
                n++;
            }
            if (n > 0) {
                bidId = book.depositBid(upper - int24(n) * s, upper, sizePerLevel);
            }
        }
    }

    function _rate(int24 t) internal pure returns (uint256) {
        int256 r = int256(1e18) + int256(t) * 1e15;
        require(r > 0, "rate underflow");
        return uint256(r);
    }

    function _alignUp(int24 x, int24 s) internal pure returns (int24) {
        int24 q = x / s;
        if (x > 0 && x % s != 0) q += 1;
        return q * s;
    }

    function _alignDown(int24 x, int24 s) internal pure returns (int24) {
        int24 q = x / s;
        if (x < 0 && x % s != 0) q -= 1;
        return q * s;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/// @notice Factory so the UI/bots can open personal LP vaults in one call.
contract RangeLPFactory {
    event VaultCreated(address indexed vault, address indexed owner, address indexed book);

    mapping(address => address[]) public vaultsOf;

    function createVault(RollingFrontierBook book) external returns (address vault) {
        vault = address(new RangeLP(book, msg.sender));
        vaultsOf[msg.sender].push(vault);
        emit VaultCreated(vault, msg.sender, address(book));
    }
}
