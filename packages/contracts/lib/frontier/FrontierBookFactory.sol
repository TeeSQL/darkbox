// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    RollingBookDeployer,
    MakerOpsDeployer,
    GeometricBookDeployer,
    GeometricOpsDeployer
} from "./FrontierDeployers.sol";

/// @notice Spins up independent rolling-frontier books. Markets are meant to
/// be cheap and ephemeral: anyone can launch one for any (token0, token1)
/// pair with whatever tick spacing fits their use case, run several in
/// parallel (e.g. a fine-grained book and a coarse one for the same pair),
/// and simply abandon a book once its orders are claimed/cancelled — books
/// hold no protocol-wide state and need no cleanup.
///
/// Two curves are deployable: Linear (the demo identity curve) and Geometric
/// (the production 1.0001^tick curve). A book's curve is fixed at creation;
/// its maker-ops companion must price spans with the SAME curve, so the
/// companion memo is keyed per curve too.
///
/// EIP-170 layout: each book is a core contract plus a maker-ops companion
/// it delegatecalls for requotes/cancels/transfers. The companion only
/// depends on (token0, token1, spacing, hooks) + the shared registry, so the
/// factory memoizes ONE companion per such config (and curve) and reuses it
/// for every book that matches. Actual deployment happens in four thin
/// deployer contracts (one embedded initcode each) so the factory itself
/// stays under the code-size limit.
contract FrontierBookFactory {
    enum Curve {
        Linear,
        Geometric
    }

    event BookCreated(
        address indexed book,
        address indexed token0,
        address indexed token1,
        int24 tickSpacing,
        int24 startTick,
        address creator,
        address hooks,
        Curve curve,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    );

    address[] public books;
    /// shared delegatable-permission registry for all books (0 = owner-only)
    address public immutable permissionRegistry;
    RollingBookDeployer public immutable bookDeployer;
    MakerOpsDeployer public immutable makerOpsDeployer;
    GeometricBookDeployer public immutable geoBookDeployer;
    GeometricOpsDeployer public immutable geoOpsDeployer;
    /// canonical book per (token0, token1, spacing) for router path lookups
    mapping(address => mapping(address => mapping(int24 => address))) public getBook;
    /// first book created for a pair, any spacing — the v2-style default
    mapping(address => mapping(address => address)) public defaultBook;
    /// memoized maker-ops companion per (token0, token1, spacing, hooks, curve)
    mapping(bytes32 => address) public makerOpsFor;

    constructor(
        address _permissionRegistry,
        RollingBookDeployer _bookDeployer,
        MakerOpsDeployer _makerOpsDeployer,
        GeometricBookDeployer _geoBookDeployer,
        GeometricOpsDeployer _geoOpsDeployer
    ) {
        permissionRegistry = _permissionRegistry;
        bookDeployer = _bookDeployer;
        makerOpsDeployer = _makerOpsDeployer;
        geoBookDeployer = _geoBookDeployer;
        geoOpsDeployer = _geoOpsDeployer;
    }

    function bookCount() external view returns (uint256) {
        return books.length;
    }

    function createBook(address token0, address token1, int24 tickSpacing, int24 startTick)
        external
        returns (address book)
    {
        return createBookWithHooksAndFees(token0, token1, tickSpacing, startTick, address(0), address(0), 0, 0);
    }

    function createGeoBook(address token0, address token1, int24 tickSpacing, int24 startTick)
        external
        returns (address book)
    {
        return createGeoBookWithHooksAndFees(token0, token1, tickSpacing, startTick, address(0), address(0), 0, 0);
    }

    /// @notice v4-style: the hooks contract's address encodes its permission
    /// flags in the low bits; books bind it immutably.
    function createBookWithHooks(address token0, address token1, int24 tickSpacing, int24 startTick, address hooks)
        public
        returns (address book)
    {
        return createBookWithHooksAndFees(token0, token1, tickSpacing, startTick, hooks, address(0), 0, 0);
    }

    function createGeoBookWithHooks(address token0, address token1, int24 tickSpacing, int24 startTick, address hooks)
        public
        returns (address book)
    {
        return createGeoBookWithHooksAndFees(token0, token1, tickSpacing, startTick, hooks, address(0), 0, 0);
    }

    function createBookWithFees(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address book) {
        return createBookWithHooksAndFees(
            token0, token1, tickSpacing, startTick, address(0), feeRecipient, makerFeeBps, takerFeeBps
        );
    }

    function createGeoBookWithFees(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) external returns (address book) {
        return createGeoBookWithHooksAndFees(
            token0, token1, tickSpacing, startTick, address(0), feeRecipient, makerFeeBps, takerFeeBps
        );
    }

    function createBookWithHooksAndFees(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address hooks,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) public returns (address book) {
        return _create(
            Curve.Linear, token0, token1, tickSpacing, startTick, hooks, feeRecipient, makerFeeBps, takerFeeBps
        );
    }

    function createGeoBookWithHooksAndFees(
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address hooks,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) public returns (address book) {
        return _create(
            Curve.Geometric, token0, token1, tickSpacing, startTick, hooks, feeRecipient, makerFeeBps, takerFeeBps
        );
    }

    function _create(
        Curve curve,
        address token0,
        address token1,
        int24 tickSpacing,
        int24 startTick,
        address hooks,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    ) internal returns (address book) {
        require(token0 != token1 && token0 != address(0) && token1 != address(0), "bad tokens");
        bytes32 opsKey =
            keccak256(abi.encode(token0, token1, tickSpacing, hooks, curve, feeRecipient, makerFeeBps, takerFeeBps));
        address ops = makerOpsFor[opsKey];
        if (ops == address(0)) {
            ops = curve == Curve.Geometric
                ? geoOpsDeployer.deploy(
                    token0, token1, tickSpacing, hooks, permissionRegistry, feeRecipient, makerFeeBps, takerFeeBps
                )
                : makerOpsDeployer.deploy(
                    token0, token1, tickSpacing, hooks, permissionRegistry, feeRecipient, makerFeeBps, takerFeeBps
                );
            makerOpsFor[opsKey] = ops;
        }
        book = curve == Curve.Geometric
            ? geoBookDeployer.deploy(
                token0,
                token1,
                tickSpacing,
                startTick,
                hooks,
                permissionRegistry,
                ops,
                feeRecipient,
                makerFeeBps,
                takerFeeBps
            )
            : bookDeployer.deploy(
                token0,
                token1,
                tickSpacing,
                startTick,
                hooks,
                permissionRegistry,
                ops,
                feeRecipient,
                makerFeeBps,
                takerFeeBps
            );
        books.push(book);
        if (getBook[token0][token1][tickSpacing] == address(0)) {
            getBook[token0][token1][tickSpacing] = book;
        }
        if (defaultBook[token0][token1] == address(0)) {
            defaultBook[token0][token1] = book;
        }
        emit BookCreated(
            book,
            token0,
            token1,
            tickSpacing,
            startTick,
            msg.sender,
            hooks,
            curve,
            feeRecipient,
            makerFeeBps,
            takerFeeBps
        );
    }
}
