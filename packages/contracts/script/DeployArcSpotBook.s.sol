// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "../lib/frontier/MockERC20.sol";

interface IFrontierGeoBookFactory {
    function createGeoBook(address token0, address token1, int24 tickSpacing, int24 startTick) external returns (address book);
}

contract DeployArcSpotBook is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(deployerKey);
        address frontierFactory = vm.envAddress("FRONTIER_FACTORY");
        address router = vm.envAddress("FRONTIER_ROUTER");
        address lens = vm.envAddress("FRONTIER_LENS");
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/frontier-arc-spot-5042002.json"));
        int24 startTick = int24(vm.envOr("START_TICK", int256(82_947)));

        vm.startBroadcast(deployerKey);
        MockERC20 weth = new MockERC20("Wrapped Ether (Arc demo)", "WETH");
        MockERC20 usdc = new MockERC20("USD Coin (Arc demo)", "USDC");
        address book = IFrontierGeoBookFactory(frontierFactory).createGeoBook(address(weth), address(usdc), 1, startTick);

        // Seed demo balances for the deployer plus the maker/taker keys if present.
        weth.mint(deployer, 1_000 ether);
        usdc.mint(deployer, 10_000_000 ether);
        address maker = vm.envOr("MAKER_ADDRESS", address(0));
        address taker = vm.envOr("TAKER_ADDRESS", address(0));
        if (maker != address(0)) {
            weth.mint(maker, 1_000 ether);
            usdc.mint(maker, 10_000_000 ether);
        }
        if (taker != address(0)) {
            weth.mint(taker, 1_000 ether);
            usdc.mint(taker, 10_000_000 ether);
        }
        vm.stopBroadcast();

        string memory json = string.concat(
            '{\n',
            '  "network": "arc-testnet",\n',
            '  "chainId": 5042002,\n',
            '  "name": "Frontier Arc Testnet - WETH/USDC",\n',
            '  "frontier": {\n',
            '    "factory": "', vm.toString(frontierFactory), '",\n',
            '    "router": "', vm.toString(router), '",\n',
            '    "lens": "', vm.toString(lens), '"\n',
            '  },\n',
            '  "spot": {\n',
            '    "weth": "', vm.toString(address(weth)), '",\n',
            '    "usdc": "', vm.toString(address(usdc)), '",\n',
            '    "book": "', vm.toString(book), '",\n',
            '    "tickSpacing": 1,\n',
            '    "startTick": ", vm.toString(startTick), "\n',
            '  }\n',
            '}\n'
        );
        vm.writeFile(out, json);
        console2.log("spot deployment written", out);
        console2.log("weth", address(weth));
        console2.log("usdc", address(usdc));
        console2.log("book", book);
    }
}
