// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GeometricBookDeployer, GeometricOpsDeployer} from "./FrontierDeployers.sol";

/// @notice Minimal production deploy factory for geometric Frontier books.
/// @dev This is the deploy-day factory. It intentionally omits the linear/demo
/// book deployer so the deploy script does not need to deploy oversized helper
/// contracts on EIP-170 chains. The broader FrontierBookFactory remains useful
/// for tests and experiments; deploy-facing agents should use this factory.
contract FrontierGeoBookFactory {
    event BookCreated(
        address indexed book,
        address indexed token0,
        address indexed token1,
        int24 tickSpacing,
        int24 startTick,
        address creator,
        address hooks,
        address feeRecipient,
        uint16 makerFeeBps,
        uint16 takerFeeBps
    );

    address[] public books;
    address public immutable permissionRegistry;
    GeometricBookDeployer public immutable geoBookDeployer;
    GeometricOpsDeployer public immutable geoOpsDeployer;

    /// canonical book per (token0, token1, spacing) for router path lookups
    mapping(address => mapping(address => mapping(int24 => address))) public getBook;
    /// first book created for a pair, any spacing — the v2-style default
    mapping(address => mapping(address => address)) public defaultBook;
    /// memoized geometric maker-ops companion per immutable config
    mapping(bytes32 => address) public makerOpsFor;

    constructor(
        address _permissionRegistry,
        GeometricBookDeployer _geoBookDeployer,
        GeometricOpsDeployer _geoOpsDeployer
    ) {
        permissionRegistry = _permissionRegistry;
        geoBookDeployer = _geoBookDeployer;
        geoOpsDeployer = _geoOpsDeployer;
    }

    function bookCount() external view returns (uint256) {
        return books.length;
    }

    function createGeoBook(address token0, address token1, int24 tickSpacing, int24 startTick)
        external
        returns (address book)
    {
        return createGeoBookWithHooksAndFees(token0, token1, tickSpacing, startTick, address(0), address(0), 0, 0);
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

    function createGeoBookWithHooks(address token0, address token1, int24 tickSpacing, int24 startTick, address hooks)
        external
        returns (address book)
    {
        return createGeoBookWithHooksAndFees(token0, token1, tickSpacing, startTick, hooks, address(0), 0, 0);
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
        require(token0 != token1 && token0 != address(0) && token1 != address(0), "bad tokens");
        require(tickSpacing > 0 && startTick % tickSpacing == 0, "bad ticks");
        require(makerFeeBps <= 1_000 && takerFeeBps <= 1_000, "fee too high");
        require(feeRecipient != address(0) || (makerFeeBps == 0 && takerFeeBps == 0), "fee recipient required");

        bytes32 opsKey = keccak256(abi.encode(token0, token1, tickSpacing, hooks, feeRecipient, makerFeeBps, takerFeeBps));
        address ops = makerOpsFor[opsKey];
        if (ops == address(0)) {
            ops = geoOpsDeployer.deploy(
                token0, token1, tickSpacing, hooks, permissionRegistry, feeRecipient, makerFeeBps, takerFeeBps
            );
            makerOpsFor[opsKey] = ops;
        }

        book = geoBookDeployer.deploy(
            token0, token1, tickSpacing, startTick, hooks, permissionRegistry, ops, feeRecipient, makerFeeBps, takerFeeBps
        );

        books.push(book);
        if (getBook[token0][token1][tickSpacing] == address(0)) {
            getBook[token0][token1][tickSpacing] = book;
        }
        if (defaultBook[token0][token1] == address(0)) {
            defaultBook[token0][token1] = book;
        }
        emit BookCreated(
            book, token0, token1, tickSpacing, startTick, msg.sender, hooks, feeRecipient, makerFeeBps, takerFeeBps
        );
    }
}
