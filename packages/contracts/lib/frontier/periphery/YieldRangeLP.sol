// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "../RollingFrontierBook.sol";
import {IERC20Minimal} from "../RangeTakeProfitBook.sol";

interface IYieldVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title YieldRangeLP — NOTES-yield.md Level 1: vault-native quoting capital
///
/// A personal market-making vault whose IDLE inventory earns lending yield.
/// Whatever the two-sided ladder doesn't currently need is parked in
/// 4626-style yield vaults (Aave static wrappers, Morpho, ...) and pulled
/// back just-in-time on every rebalance. One owner means all yield
/// questions vanish — it's their money the whole time; no distribution
/// accounting, no book changes.
///
/// Posted principal lives in the BOOK while quoted (the book pulls at
/// deposit). Yield on the posted float is Level 0 (quote a share-denominated
/// pair) or the Level 2 buffered adapter — see NOTES-yield.md.
///
/// Liveness: close() exits IN KIND if a vault redeem fails — the owner
/// receives the yield shares themselves rather than being trapped behind a
/// frozen lending market.
contract YieldRangeLP {
    RollingFrontierBook public immutable book;
    address public immutable owner;
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;
    IYieldVault public immutable vault0;
    IYieldVault public immutable vault1;

    uint128 public sizePerLevel;
    uint24 public levelsPerSide;
    int24 public gap;

    uint256 public askId;
    uint256 public bidId;

    event Opened(int24 mid, uint256 askId, uint256 bidId);
    event Rebalanced(int24 newMid, uint256 askId, uint256 bidId);
    event Parked(uint256 assets0, uint256 assets1);
    event Closed(uint256 returned0, uint256 returned1, uint256 shares0InKind, uint256 shares1InKind);

    modifier onlyOwner() {
        if (msg.sender != owner) {
            require(address(book.permissions()) != address(0), "owner only");
            book.permissions().requireAuthorizedCall(owner, msg.sender, address(this), msg.sig);
        }
        _;
    }

    constructor(RollingFrontierBook _book, address _owner, IYieldVault _vault0, IYieldVault _vault1) {
        book = _book;
        owner = _owner;
        token0 = _book.token0();
        token1 = _book.token1();
        vault0 = _vault0;
        vault1 = _vault1;
        _approveMax(address(token0), address(_book));
        _approveMax(address(token1), address(_book));
        _approveMax(address(token0), address(_vault0));
        _approveMax(address(token1), address(_vault1));
    }

    function open(uint128 _sizePerLevel, uint24 _levelsPerSide, int24 _gap) external onlyOwner {
        require(askId == 0 && bidId == 0, "already open");
        sizePerLevel = _sizePerLevel;
        levelsPerSide = _levelsPerSide;
        gap = _gap;
        _post();
        _park();
        emit Opened(book.currentTick(), askId, bidId);
    }

    /// @notice Re-center: cancel both ladders (claims fills), pull idle
    /// capital back from the yield vaults, repost around the new mid, park
    /// the new idle remainder.
    function rebalance() external onlyOwner {
        _teardown();
        _unparkAll();
        _post();
        _park();
        emit Rebalanced(book.currentTick(), askId, bidId);
    }

    function close() external onlyOwner {
        _teardown();
        // best-effort unwind; fall back to in-kind shares if a vault is stuck
        uint256 inKind0 = _tryUnparkAll(vault0);
        uint256 inKind1 = _tryUnparkAll(vault1);
        if (inKind0 > 0) require(vault0.transfer(owner, inKind0), "shares0 out failed");
        if (inKind1 > 0) require(vault1.transfer(owner, inKind1), "shares1 out failed");
        uint256 b0 = _bal(address(token0));
        uint256 b1 = _bal(address(token1));
        if (b0 > 0) require(token0.transfer(owner, b0), "t0 out failed");
        if (b1 > 0) require(token1.transfer(owner, b1), "t1 out failed");
        emit Closed(b0, b1, inKind0, inKind1);
    }

    /// @notice Total vault value, hot + parked (assets, not shares).
    function totalValue() external view returns (uint256 v0, uint256 v1) {
        v0 = _bal(address(token0)) + vault0.convertToAssets(vault0.balanceOf(address(this)));
        v1 = _bal(address(token1)) + vault1.convertToAssets(vault1.balanceOf(address(this)));
    }

    // ------------------------------------------------------------------

    function _teardown() internal {
        if (askId != 0) {
            book.cancel(askId);
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

        {
            int24 lower = _alignUp(mid + g, s);
            if (lower <= mid) lower += s;
            uint24 n = uint24(_min(levelsPerSide, _bal(address(token0)) / sizePerLevel));
            if (n > 0) {
                askId = book.deposit(lower, lower + int24(n) * s, sizePerLevel);
            }
        }
        {
            int24 upper = _alignDown(mid - g, s);
            if (upper > mid) upper = _alignDown(mid, s);
            uint256 budget = _bal(address(token1));
            uint24 n;
            uint256 cost;
            while (n < levelsPerSide) {
                int24 lvl = upper - int24(n + 1) * s;
                uint256 levelCost = (uint256(sizePerLevel) * book.rateAt(lvl) + 1e18 - 1) / 1e18;
                if (cost + levelCost > budget) break;
                cost += levelCost;
                n++;
            }
            if (n > 0) {
                bidId = book.depositBid(upper - int24(n) * s, upper, sizePerLevel);
            }
        }
    }

    /// @dev Everything not consumed by _post is idle — put it to work.
    function _park() internal {
        uint256 b0 = _bal(address(token0));
        uint256 b1 = _bal(address(token1));
        if (b0 > 0) vault0.deposit(b0, address(this));
        if (b1 > 0) vault1.deposit(b1, address(this));
        if (b0 > 0 || b1 > 0) emit Parked(b0, b1);
    }

    function _unparkAll() internal {
        uint256 s0 = vault0.balanceOf(address(this));
        uint256 s1 = vault1.balanceOf(address(this));
        if (s0 > 0) vault0.redeem(s0, address(this), address(this));
        if (s1 > 0) vault1.redeem(s1, address(this), address(this));
    }

    /// @dev Returns the share balance LEFT BEHIND if redeem fails (in-kind).
    function _tryUnparkAll(IYieldVault v) internal returns (uint256 sharesLeft) {
        uint256 s = v.balanceOf(address(this));
        if (s == 0) return 0;
        try v.redeem(s, address(this), address(this)) {
            return 0;
        } catch {
            return s;
        }
    }

    function _bal(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok ? abi.decode(ret, (uint256)) : 0;
    }

    function _approveMax(address token, address spender) internal {
        (bool ok,) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve failed");
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

/// @notice Factory so the UI/bots can open yield-bearing LP vaults in one call.
contract YieldRangeLPFactory {
    event VaultCreated(address indexed vault, address indexed owner, address indexed book);

    mapping(address => address[]) public vaultsOf;

    function createVault(RollingFrontierBook book, IYieldVault vault0, IYieldVault vault1)
        external
        returns (address vault)
    {
        vault = address(new YieldRangeLP(book, msg.sender, vault0, vault1));
        vaultsOf[msg.sender].push(vault);
        emit VaultCreated(vault, msg.sender, address(book));
    }
}
