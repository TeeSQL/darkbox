// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RollingFrontierBook} from "../RollingFrontierBook.sol";
import {IERC20Minimal} from "../RangeTakeProfitBook.sol";

interface IERC20Aux {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @title FrontierPositionNFT — ERC-721 wrapper over book positions
///
/// The book's positions are already transferable handles; this contract
/// turns them into standard NFTs so they plug into wallets, marketplaces,
/// and vault tooling. Two ways in:
///
///   - mintAsk/mintBid: the wrapper is the depositor (pulls funds, deposits,
///     mints) — no prior setup needed.
///   - wrap: adopt an EXISTING position. The owner grants this contract
///     `transferPosition` on the book via the permission registry once,
///     then wrap() atomically pulls the position in and mints. (The
///     ownership check happens before the pull, so nobody can claim a
///     position that isn't theirs.)
///
/// Claims/cancels/requotes forward to the book with proceeds routed to the
/// CURRENT NFT holder. unwrap() hands the raw position back and burns.
contract FrontierPositionNFT {
    string public constant name = "Frontier Positions";
    string public constant symbol = "FRONT-POS";

    RollingFrontierBook public immutable book;

    uint256 public nextTokenId = 1;
    mapping(uint256 => uint256) public bookPositionOf; // tokenId => book position id
    mapping(uint256 => uint256) public tokenOf; // book position id => tokenId

    // ----- minimal ERC-721 state -----
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(RollingFrontierBook _book) {
        book = _book;
        // the wrapper deposits with its own balance; max-approve once
        _approveMax(address(_book.token0()), address(_book));
        _approveMax(address(_book.token1()), address(_book));
    }

    // ------------------------------------------------------------------
    // Ways in
    // ------------------------------------------------------------------

    function mintAsk(int24 lower, int24 upper, uint128 liquidity, int128 slope)
        external
        returns (uint256 tokenId)
    {
        uint24 n = uint24(upper - lower) / uint24(book.tickSpacing());
        int256 principal = int256(uint256(liquidity)) * int256(uint256(uint24(n)))
            + (int256(slope) * int256(uint256(uint24(n))) * (int256(uint256(uint24(n))) - 1)) / 2;
        require(principal >= 0, "bad shape");
        require(book.token0().transferFrom(msg.sender, address(this), uint256(principal)), "pull0 failed");
        uint256 positionId =
            slope == 0 ? book.deposit(lower, upper, liquidity) : book.depositShaped(lower, upper, liquidity, slope);
        tokenId = _mintFor(positionId, msg.sender);
    }

    function mintBid(int24 lower, int24 upper, uint128 liquidity) external returns (uint256 tokenId) {
        uint256 before = IERC20Aux(address(book.token1())).balanceOf(address(this));
        // the bid principal is curve-dependent; pull a ceiling then refund
        uint256 estimate = _bidPrincipal(lower, upper, liquidity);
        require(book.token1().transferFrom(msg.sender, address(this), estimate), "pull1 failed");
        uint256 positionId = book.depositBid(lower, upper, liquidity);
        uint256 spent = before + estimate - IERC20Aux(address(book.token1())).balanceOf(address(this));
        if (estimate > spent) {
            require(book.token1().transfer(msg.sender, estimate - spent), "refund failed");
        }
        tokenId = _mintFor(positionId, msg.sender);
    }

    /// @notice Adopt an existing position. Requires a registry grant of
    /// `transferPosition` (this contract, the book) from the owner.
    function wrap(uint256 positionId) external returns (uint256 tokenId) {
        (address owner,,,,,,, bool live,) = book.positions(positionId);
        require(live, "not live");
        require(owner == msg.sender, "not position owner");
        book.transferPosition(positionId, address(this));
        tokenId = _mintFor(positionId, msg.sender);
    }

    /// @notice Hand the raw book position to the NFT holder and burn.
    function unwrap(uint256 tokenId) external {
        address owner = _authHolder(tokenId);
        uint256 positionId = bookPositionOf[tokenId];
        _burn(tokenId, owner);
        book.transferPosition(positionId, owner);
    }

    // ------------------------------------------------------------------
    // Forwarded management — proceeds go to the CURRENT holder
    // ------------------------------------------------------------------

    function claim(uint256 tokenId) external returns (uint256 proceeds1) {
        address owner = _authHolder(tokenId);
        proceeds1 = book.claim(bookPositionOf[tokenId]);
        if (proceeds1 > 0) require(book.token1().transfer(owner, proceeds1), "payout failed");
    }

    function claimBid(uint256 tokenId) external returns (uint256 proceeds0) {
        address owner = _authHolder(tokenId);
        proceeds0 = book.claimBid(bookPositionOf[tokenId]);
        if (proceeds0 > 0) require(book.token0().transfer(owner, proceeds0), "payout failed");
    }

    function cancel(uint256 tokenId) external returns (uint256 proceeds1, uint256 refund0) {
        address owner = _authHolder(tokenId);
        uint256 positionId = bookPositionOf[tokenId];
        _burn(tokenId, owner);
        (proceeds1, refund0) = book.cancel(positionId);
        if (proceeds1 > 0) require(book.token1().transfer(owner, proceeds1), "payout failed");
        if (refund0 > 0) require(book.token0().transfer(owner, refund0), "refund failed");
    }

    function cancelBid(uint256 tokenId) external returns (uint256 proceeds0, uint256 refund1) {
        address owner = _authHolder(tokenId);
        uint256 positionId = bookPositionOf[tokenId];
        _burn(tokenId, owner);
        (proceeds0, refund1) = book.cancelBid(positionId);
        if (proceeds0 > 0) require(book.token0().transfer(owner, proceeds0), "payout failed");
        if (refund1 > 0) require(book.token1().transfer(owner, refund1), "refund failed");
    }

    function _authHolder(uint256 tokenId) internal view returns (address owner) {
        owner = _ownerOf[tokenId];
        require(
            msg.sender == owner || msg.sender == getApproved[tokenId] || isApprovedForAll[owner][msg.sender],
            "not authorized"
        );
    }

    // ------------------------------------------------------------------
    // Minimal ERC-721
    // ------------------------------------------------------------------

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        require(owner != address(0), "no token");
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _ownerOf[tokenId];
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "not authorized");
        getApproved[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_ownerOf[tokenId] == from, "wrong from");
        require(to != address(0), "zero to");
        require(
            msg.sender == from || msg.sender == getApproved[tokenId] || isApprovedForAll[from][msg.sender],
            "not authorized"
        );
        delete getApproved[tokenId];
        unchecked {
            balanceOf[from]--;
            balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data)
                    == IERC721Receiver.onERC721Received.selector,
                "unsafe recipient"
            );
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd; // ERC-721
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    function _mintFor(uint256 positionId, address to) internal returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        bookPositionOf[tokenId] = positionId;
        tokenOf[positionId] = tokenId;
        unchecked {
            balanceOf[to]++;
        }
        _ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId, address owner) internal {
        delete getApproved[tokenId];
        unchecked {
            balanceOf[owner]--;
        }
        delete _ownerOf[tokenId];
        delete tokenOf[bookPositionOf[tokenId]];
        delete bookPositionOf[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function _bidPrincipal(int24 lower, int24 upper, uint128 liquidity) internal view returns (uint256 cost) {
        int24 s = book.tickSpacing();
        for (int24 t = lower; t < upper; t += s) {
            // mirrors the book's per-level ceil at the linear curve; for
            // geometric books the pull-then-refund in mintBid absorbs the gap
            cost += (uint256(liquidity) * book.rateAt(t) + 1e18 - 1) / 1e18;
        }
    }

    function _approveMax(address token, address spender) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Aux.approve.selector, spender, type(uint256).max));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve failed");
    }
}
