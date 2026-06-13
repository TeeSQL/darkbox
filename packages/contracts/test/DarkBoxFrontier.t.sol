// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

// Real Frontier (vendored) stack.
import {FrontierGeoBookFactory} from "frontier/FrontierGeoBookFactory.sol";
import {GeometricBookDeployer, GeometricOpsDeployer} from "frontier/FrontierDeployers.sol";
import {FrontierLens} from "frontier/periphery/FrontierLens.sol";
import {FrontierRouter} from "frontier/periphery/FrontierRouter.sol";
import {PermissionRegistry} from "frontier/permissions/PermissionRegistry.sol";
import {RollingFrontierBook} from "frontier/RollingFrontierBook.sol";

// DarkBox PM stack.
import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {OutcomeToken} from "../src/markets/OutcomeToken.sol";
import {DarkBoxMarketFactory} from "../src/markets/DarkBoxMarketFactory.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {
    CreateMarketParams, ResolverConfig, ResolverType, Outcome, MarketStatus
} from "../src/markets/MarketTypes.sol";

/// @notice End-to-end integration of the DarkBox prediction-market layer on top
///         of the real Frontier orderbook: creation, split/join, book
///         registration, maker/taker fills, resolve/redeem, void, and the
///         authorization / lifecycle guards from the market spec.
contract DarkBoxFrontierTest is Test {
    // Frontier
    FrontierGeoBookFactory internal frontier;
    FrontierLens internal lens;
    FrontierRouter internal router;
    // DarkBox
    SyntheticUSDC internal sUSDC;
    DarkBoxMarketFactory internal pm;

    address internal admin = address(this); // owner + coordinator + minter
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal treasury = makeAddr("treasury");

    bytes32 internal constant GAME = keccak256("game-1");
    uint256 internal constant MINT = 1_000_000e6;

    // mirror of DarkBoxMarketFactory event for expectEmit
    event MarketCreated(
        bytes32 indexed gameId,
        bytes32 indexed marketId,
        address indexed creator,
        address market,
        string question,
        string metadataURI,
        uint64 closeTime,
        uint64 resolveBy,
        ResolverType resolverType
    );
    event Split(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount);

    function setUp() public {
        PermissionRegistry registry = new PermissionRegistry();
        frontier =
            new FrontierGeoBookFactory(address(registry), new GeometricBookDeployer(), new GeometricOpsDeployer());
        lens = new FrontierLens();
        router = new FrontierRouter(address(frontier), lens);

        sUSDC = new SyntheticUSDC(admin, admin);
        pm = new DarkBoxMarketFactory(admin, admin, address(sUSDC), address(frontier), admin, treasury);

        // fund actors
        sUSDC.mint(admin, MINT);
        sUSDC.mint(alice, MINT);
        sUSDC.mint(bob, MINT);
        sUSDC.mint(carol, MINT);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _params(string memory q, ResolverType rt, address resolver) internal view returns (CreateMarketParams memory) {
        return CreateMarketParams({
            gameId: GAME,
            question: q,
            description: "d",
            metadataURI: "ipfs://m",
            resolver: ResolverConfig({resolverType: rt, resolver: resolver, sourceId: keccak256("src"), data: ""}),
            closeTime: uint64(block.timestamp + 7 days),
            resolveBy: uint64(block.timestamp + 8 days),
            creatorBond: 10e6,
            initialLiquidity: 0
        });
    }

    function _createDerivative(address creator, string memory q) internal returns (bytes32 id, DarkBoxBinaryMarket m) {
        vm.startPrank(creator);
        sUSDC.approve(address(pm), type(uint256).max);
        (id, ) = pm.createMarket(_params(q, ResolverType.AdminManual, creator));
        vm.stopPrank();
        m = DarkBoxBinaryMarket(pm.getMarket(id));
    }

    function _split(DarkBoxBinaryMarket m, address who, uint256 amount) internal {
        vm.startPrank(who);
        sUSDC.approve(address(m), type(uint256).max);
        m.split(amount, who);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Market creation
    // ---------------------------------------------------------------------

    function test_CreateCanonicalMarketAndBooks() public {
        sUSDC.approve(address(pm), type(uint256).max);
        (bytes32 id, address market) = pm.createMarket(_params("Canonical?", ResolverType.CanonicalWinner, admin));
        assertTrue(market != address(0), "market deployed");

        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
        assertEq(uint8(m.status()), uint8(MarketStatus.Active), "active");
        assertEq(OutcomeToken(m.yesToken()).decimals(), 6, "yes 6 dec");

        (address yesBook, address noBook) = pm.createBooks(id);
        assertTrue(yesBook != address(0) && noBook != address(0) && yesBook != noBook, "two books");
        int24 sp = pm.bookTickSpacing();
        assertEq(frontier.getBook(m.yesToken(), address(sUSDC), sp), yesBook, "frontier knows yes book");
        assertEq(frontier.getBook(m.noToken(), address(sUSDC), sp), noBook, "frontier knows no book");
    }

    function test_CreateDerivativeLocksBond() public {
        uint256 balBefore = sUSDC.balanceOf(address(pm));
        (bytes32 id, ) = _createDerivative(alice, "Will X happen?");
        (, address creator, , uint256 bond, bool settled, , , bool booksReg) = pm.markets(id);
        assertEq(creator, alice, "creator");
        assertEq(bond, 10e6, "bond locked");
        assertFalse(settled, "bond not settled");
        assertFalse(booksReg, "books not yet registered");
        assertEq(sUSDC.balanceOf(address(pm)) - balBefore, 10e6, "factory holds bond");
    }

    function test_CreateEmitsMarketCreated() public {
        sUSDC.approve(address(pm), type(uint256).max);
        bytes32 qh = pm.computeQuestionHash(GAME, "E?", ResolverType.AdminManual, uint64(block.timestamp + 7 days), "ipfs://m");
        bytes32 expectedId = keccak256(abi.encode(GAME, qh));
        vm.expectEmit(true, true, true, false);
        emit MarketCreated(GAME, expectedId, admin, address(0), "E?", "ipfs://m", 0, 0, ResolverType.AdminManual);
        pm.createMarket(_params("E?", ResolverType.AdminManual, admin));
    }

    function test_RevertDuplicateQuestion() public {
        sUSDC.approve(address(pm), type(uint256).max);
        pm.createMarket(_params("dup", ResolverType.AdminManual, admin));
        vm.expectRevert(DarkBoxMarketFactory.DuplicateQuestion.selector);
        pm.createMarket(_params("dup", ResolverType.AdminManual, admin));
    }

    // Audit M-1 regression: an identical question in a DIFFERENT game must not
    // collide on the global duplicate guard (previously it did, enabling a
    // cross-game / front-run DoS that could brick the canonical market).
    function test_SameQuestionDifferentGamesDoNotCollide() public {
        sUSDC.approve(address(pm), type(uint256).max);
        CreateMarketParams memory p2 = _params("xgame", ResolverType.AdminManual, admin);
        p2.gameId = keccak256("game-2");
        (bytes32 id1, ) = pm.createMarket(_params("xgame", ResolverType.AdminManual, admin));
        (bytes32 id2, ) = pm.createMarket(p2);
        assertTrue(id1 != id2, "distinct ids across games");
        // Same (game, question) still reverts as a duplicate.
        vm.expectRevert(DarkBoxMarketFactory.DuplicateQuestion.selector);
        pm.createMarket(_params("xgame", ResolverType.AdminManual, admin));
    }

    function test_RevertEmptyQuestion() public {
        sUSDC.approve(address(pm), type(uint256).max);
        vm.expectRevert(DarkBoxMarketFactory.EmptyQuestion.selector);
        pm.createMarket(_params("", ResolverType.AdminManual, admin));
    }

    function test_RevertBadTimes() public {
        sUSDC.approve(address(pm), type(uint256).max);
        CreateMarketParams memory p = _params("bt", ResolverType.AdminManual, admin);
        p.closeTime = uint64(block.timestamp - 1);
        vm.expectRevert(DarkBoxMarketFactory.BadTimes.selector);
        pm.createMarket(p);
    }

    function test_RevertBondTooLow() public {
        sUSDC.approve(address(pm), type(uint256).max);
        CreateMarketParams memory p = _params("low", ResolverType.AdminManual, admin);
        p.creatorBond = 1e6;
        vm.expectRevert(DarkBoxMarketFactory.BondTooLow.selector);
        pm.createMarket(p);
    }

    function test_RevertUnsupportedResolver() public {
        sUSDC.approve(address(pm), type(uint256).max);
        vm.expectRevert(DarkBoxMarketFactory.UnsupportedResolver.selector);
        pm.createMarket(_params("u", ResolverType.ExternalAttested, admin));
    }

    function test_RevertCanonicalByNonAdmin() public {
        vm.startPrank(alice);
        sUSDC.approve(address(pm), type(uint256).max);
        vm.expectRevert(DarkBoxMarketFactory.CanonicalRestricted.selector);
        pm.createMarket(_params("canon", ResolverType.CanonicalWinner, alice));
        vm.stopPrank();
    }

    function test_InitialLiquidityMintsPairToCreator() public {
        sUSDC.approve(address(pm), type(uint256).max);
        CreateMarketParams memory p = _params("liq", ResolverType.AdminManual, admin);
        p.initialLiquidity = 500e6;
        (bytes32 id, address market) = pm.createMarket(p);
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
        assertEq(OutcomeToken(m.yesToken()).balanceOf(admin), 500e6, "yes minted");
        assertEq(OutcomeToken(m.noToken()).balanceOf(admin), 500e6, "no minted");
        assertEq(m.vaultCollateral(), 500e6, "collateral locked");
        id;
    }

    // ---------------------------------------------------------------------
    // Split / Join / invariants
    // ---------------------------------------------------------------------

    function test_SplitMintsPairAndLocksCollateral() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "sp");
        _split(m, alice, 100e6);
        assertEq(OutcomeToken(m.yesToken()).balanceOf(alice), 100e6);
        assertEq(OutcomeToken(m.noToken()).balanceOf(alice), 100e6);
        assertEq(m.vaultCollateral(), 100e6);
        // invariant: totalYes == totalNo == vaultCollateral
        assertEq(OutcomeToken(m.yesToken()).totalSupply(), OutcomeToken(m.noToken()).totalSupply());
        assertEq(OutcomeToken(m.yesToken()).totalSupply(), m.vaultCollateral());
    }

    function test_JoinBurnsPairReleasesCollateral() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "jn");
        _split(m, alice, 100e6);
        uint256 balBefore = sUSDC.balanceOf(alice);
        vm.prank(alice);
        m.join(40e6, alice);
        assertEq(OutcomeToken(m.yesToken()).balanceOf(alice), 60e6);
        assertEq(OutcomeToken(m.noToken()).balanceOf(alice), 60e6);
        assertEq(m.vaultCollateral(), 60e6);
        assertEq(sUSDC.balanceOf(alice) - balBefore, 40e6, "collateral returned");
    }

    function test_MergeAliasEqualsJoin() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "mg");
        _split(m, alice, 50e6);
        vm.prank(alice);
        m.merge(10e6, alice);
        assertEq(m.vaultCollateral(), 40e6);
    }

    function test_CannotSplitAfterClose() public {
        (bytes32 id, DarkBoxBinaryMarket m) = _createDerivative(alice, "cl");
        pm.closeMarket(id); // admin
        vm.startPrank(alice);
        sUSDC.approve(address(m), type(uint256).max);
        vm.expectRevert(DarkBoxBinaryMarket.BadStatus.selector);
        m.split(10e6, alice);
        vm.stopPrank();
    }

    function test_JoinAllowedAfterClose() public {
        (bytes32 id, DarkBoxBinaryMarket m) = _createDerivative(alice, "jc");
        _split(m, alice, 100e6);
        pm.closeMarket(id);
        vm.prank(alice);
        m.join(30e6, alice); // allowed while Closed-unresolved
        assertEq(m.vaultCollateral(), 70e6);
    }

    // ---------------------------------------------------------------------
    // Resolve / Redeem
    // ---------------------------------------------------------------------

    function test_ResolveYesRedeemYesOnly() public {
        (bytes32 id, DarkBoxBinaryMarket m) = _createDerivative(alice, "ry");
        _split(m, alice, 100e6);
        pm.resolveMarket(id, Outcome.Yes, keccak256("res")); // resolver = alice? no, AdminManual resolver=alice
        // resolver is alice (set in _params), but admin(owner) can also resolve
        assertEq(uint8(m.status()), uint8(MarketStatus.Resolved));
        uint256 bal = sUSDC.balanceOf(alice);
        vm.prank(alice);
        m.redeem(Outcome.Yes, 100e6, alice);
        assertEq(sUSDC.balanceOf(alice) - bal, 100e6, "yes redeems 1:1");
        // NO redeem must fail
        vm.prank(alice);
        vm.expectRevert(DarkBoxBinaryMarket.BadOutcome.selector);
        m.redeem(Outcome.No, 1e6, alice);
    }

    function test_ResolveNoRedeemNoOnly() public {
        (bytes32 id, DarkBoxBinaryMarket m) = _createDerivative(alice, "rn");
        _split(m, alice, 100e6);
        pm.resolveMarket(id, Outcome.No, keccak256("res"));
        vm.prank(alice);
        m.redeem(Outcome.No, 100e6, alice);
        assertEq(m.vaultCollateral(), 0, "drained");
    }

    function test_CannotResolveTwice() public {
        (bytes32 id, ) = _createDerivative(alice, "rt");
        pm.resolveMarket(id, Outcome.Yes, bytes32(0));
        vm.expectRevert(DarkBoxBinaryMarket.BadStatus.selector);
        pm.resolveMarket(id, Outcome.No, bytes32(0));
    }

    function test_CannotRedeemBeforeResolution() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "rb");
        _split(m, alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(DarkBoxBinaryMarket.BadStatus.selector);
        m.redeem(Outcome.Yes, 10e6, alice);
    }

    function test_BondReturnedOnResolve() public {
        (bytes32 id, ) = _createDerivative(alice, "bond");
        uint256 bal = sUSDC.balanceOf(alice);
        pm.resolveMarket(id, Outcome.Yes, bytes32(0));
        assertEq(sUSDC.balanceOf(alice) - bal, 10e6, "bond returned");
        (, , , , bool settled, , , ) = pm.markets(id);
        assertTrue(settled);
    }

    // ---------------------------------------------------------------------
    // Void
    // ---------------------------------------------------------------------

    function test_VoidRedeemsHalfEachAndSlashesBond() public {
        (bytes32 id, DarkBoxBinaryMarket m) = _createDerivative(alice, "void");
        _split(m, alice, 100e6);
        uint256 tBal = sUSDC.balanceOf(treasury);
        pm.voidMarket(id, "ambiguous", keccak256("ev"));
        assertEq(uint8(m.status()), uint8(MarketStatus.Voided));
        assertEq(sUSDC.balanceOf(treasury) - tBal, 10e6, "bond slashed to treasury");

        uint256 bal = sUSDC.balanceOf(alice);
        vm.startPrank(alice);
        m.redeem(Outcome.Yes, 100e6, alice); // 50
        m.redeem(Outcome.No, 100e6, alice); // 50
        vm.stopPrank();
        assertEq(sUSDC.balanceOf(alice) - bal, 100e6, "0.5 each = full back");
        assertEq(m.vaultCollateral(), 0, "drained");
    }

    // ---------------------------------------------------------------------
    // Authorization
    // ---------------------------------------------------------------------

    function test_UnauthorizedResolveReverts() public {
        (bytes32 id, ) = _createDerivative(alice, "auth1");
        vm.prank(bob);
        vm.expectRevert(DarkBoxMarketFactory.NotResolver.selector);
        pm.resolveMarket(id, Outcome.Yes, bytes32(0));
    }

    function test_UnauthorizedVoidReverts() public {
        (bytes32 id, ) = _createDerivative(alice, "auth2");
        vm.prank(bob);
        vm.expectRevert(DarkBoxMarketFactory.NotOwner.selector);
        pm.voidMarket(id, "x", bytes32(0));
    }

    function test_UnauthorizedCreateBooksReverts() public {
        (bytes32 id, ) = _createDerivative(alice, "auth3");
        vm.prank(bob);
        vm.expectRevert(DarkBoxMarketFactory.NotCoordinator.selector);
        pm.createBooks(id);
    }

    function test_DirectMarketLifecycleCallReverts() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "auth4");
        vm.prank(bob);
        vm.expectRevert(DarkBoxBinaryMarket.NotFactory.selector);
        m.resolve(Outcome.Yes, bytes32(0));
    }

    function test_OutcomeTokenMintRestricted() public {
        (, DarkBoxBinaryMarket m) = _createDerivative(alice, "auth5");
        OutcomeToken yes = OutcomeToken(m.yesToken());
        vm.prank(bob);
        vm.expectRevert(OutcomeToken.NotMarket.selector);
        yes.mint(bob, 1e6);
    }

    // ---------------------------------------------------------------------
    // Frontier trading: maker deposit, taker fill, cancel
    // ---------------------------------------------------------------------

    function test_FrontierMakerDepositTakerFill() public {
        // canonical market with books
        sUSDC.approve(address(pm), type(uint256).max);
        (bytes32 id, address market) = pm.createMarket(_params("trade", ResolverType.CanonicalWinner, admin));
        (address yesBookAddr, ) = pm.createBooks(id);
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
        RollingFrontierBook yesBook = RollingFrontierBook(yesBookAddr);

        // alice becomes a maker: split to get YES inventory, sell YES (ask) above tick 0
        _split(m, alice, 1_000e6);
        vm.startPrank(alice);
        OutcomeToken(m.yesToken()).approve(yesBookAddr, type(uint256).max);
        // 100 unit-wide ask intervals above the current tick (spacing=1)
        uint256 posId = yesBook.deposit(1, 101, uint128(1e6));
        vm.stopPrank();
        assertGt(OutcomeToken(m.yesToken()).balanceOf(yesBookAddr), 0, "book escrowed YES");

        // bob takes: buy YES paying sUSDC through the router
        uint256 amountIn = 50e6;
        (uint256 q0,,) = lens.quoteBuy(yesBook, amountIn);
        assertGt(q0, 0, "quote fills");

        uint256 bobYesBefore = OutcomeToken(m.yesToken()).balanceOf(bob);
        vm.startPrank(bob);
        sUSDC.approve(address(router), type(uint256).max);
        (uint256 paid, uint256 received) = router.buyExactIn(yesBook, amountIn, q0, bob, block.timestamp);
        vm.stopPrank();
        assertEq(received, q0, "received == quote");
        assertGt(paid, 0, "paid sUSDC");
        assertEq(OutcomeToken(m.yesToken()).balanceOf(bob) - bobYesBefore, received, "bob got YES");

        // alice claims her sUSDC proceeds from the filled ask
        vm.prank(alice);
        uint256 proceeds = yesBook.claim(posId);
        assertGt(proceeds, 0, "maker claimed sUSDC proceeds");
    }

    function test_FrontierCancelReturnsPrincipal() public {
        sUSDC.approve(address(pm), type(uint256).max);
        (bytes32 id, address market) = pm.createMarket(_params("cancel", ResolverType.CanonicalWinner, admin));
        (address yesBookAddr, ) = pm.createBooks(id);
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
        RollingFrontierBook yesBook = RollingFrontierBook(yesBookAddr);

        _split(m, alice, 1_000e6);
        vm.startPrank(alice);
        OutcomeToken(m.yesToken()).approve(yesBookAddr, type(uint256).max);
        uint256 yesBefore = OutcomeToken(m.yesToken()).balanceOf(alice);
        uint256 posId = yesBook.deposit(1, 101, uint128(1e6));
        assertLt(OutcomeToken(m.yesToken()).balanceOf(alice), yesBefore, "YES escrowed");
        (, uint256 principal0) = yesBook.cancel(posId);
        vm.stopPrank();
        assertGt(principal0, 0, "principal returned on cancel");
        assertEq(OutcomeToken(m.yesToken()).balanceOf(alice), yesBefore, "YES fully returned");
    }

    function test_FrontierTakerFeeAccrues() public {
        // configure a taker fee, recipient = admin (feeRecipient)
        pm.setBookParams(1, 0, 0, 100); // 100 bps taker fee
        sUSDC.approve(address(pm), type(uint256).max);
        (bytes32 id, address market) = pm.createMarket(_params("fee", ResolverType.CanonicalWinner, admin));
        (address yesBookAddr, ) = pm.createBooks(id);
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
        RollingFrontierBook yesBook = RollingFrontierBook(yesBookAddr);

        _split(m, alice, 1_000e6);
        vm.startPrank(alice);
        OutcomeToken(m.yesToken()).approve(yesBookAddr, type(uint256).max);
        yesBook.deposit(1, 101, uint128(1e6));
        vm.stopPrank();

        uint256 feeRecvBefore = sUSDC.balanceOf(admin);
        vm.startPrank(bob);
        sUSDC.approve(address(router), type(uint256).max);
        router.buyExactIn(yesBook, 50e6, 0, bob, block.timestamp);
        vm.stopPrank();
        assertGt(sUSDC.balanceOf(admin) - feeRecvBefore, 0, "taker fee accrued to recipient");
    }
}
