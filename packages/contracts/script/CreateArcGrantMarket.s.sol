// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {DarkBoxMarketFactory} from "../src/markets/DarkBoxMarketFactory.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {CreateMarketParams, ResolverConfig, ResolverType} from "../src/markets/MarketTypes.sol";

/// @notice Create a new Arc Testnet market on the existing split-capable
///         DarkBoxMarketFactory, then deploy YES/NO books in separate txs.
contract CreateArcGrantMarket is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(pk);

        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/darkbox-arc-grant-market-5042002.json"));
        address marketFactory = vm.envAddress("MARKET_FACTORY");
        address syntheticUSDC = vm.envAddress("SUSDC");
        address frontierFactory = vm.envAddress("FRONTIER_FACTORY");
        address frontierRouter = vm.envAddress("FRONTIER_ROUTER");
        address frontierLens = vm.envAddress("FRONTIER_LENS");
        string memory question = vm.envOr("MARKET_QUESTION", string("Will DarkBox win a grant from Arc?"));
        string memory description = vm.envOr(
            "MARKET_DESCRIPTION",
            string("Arc Testnet stress-test market for DarkBox grant outcome.")
        );
        string memory metadataURI = vm.envOr("METADATA_URI", string("ipfs://darkbox/arc-grant-market.json"));
        bytes32 gameId = vm.envOr("GAME_ID", keccak256("darkbox-arc-grant-stress-1"));
        bytes32 sourceId = vm.envOr("SOURCE_ID", keccak256("arc-grants"));
        uint256 initialLiquidity = vm.envOr("INITIAL_LIQUIDITY", uint256(10_000e6));
        uint256 closeSeconds = vm.envOr("CLOSE_SECONDS", uint256(14 days));
        uint256 resolveBuffer = vm.envOr("RESOLVE_BUFFER_SECONDS", uint256(1 days));

        vm.startBroadcast(pk);

        SyntheticUSDC sUSDC = SyntheticUSDC(syntheticUSDC);
        sUSDC.mint(deployer, initialLiquidity);
        sUSDC.approve(marketFactory, type(uint256).max);

        CreateMarketParams memory params = CreateMarketParams({
            gameId: gameId,
            question: question,
            description: description,
            metadataURI: metadataURI,
            resolver: ResolverConfig({
                resolverType: ResolverType.AdminManual,
                resolver: deployer,
                sourceId: sourceId,
                data: ""
            }),
            closeTime: uint64(block.timestamp + closeSeconds),
            resolveBy: uint64(block.timestamp + closeSeconds + resolveBuffer),
            creatorBond: 10e6,
            initialLiquidity: 0
        });

        DarkBoxMarketFactory pmFactory = DarkBoxMarketFactory(marketFactory);
        (bytes32 marketId, address market) = pmFactory.createMarketShell(params);
        address yesBook = pmFactory.createYesBook(marketId);
        address noBook = pmFactory.createNoBook(marketId);

        sUSDC.approve(market, initialLiquidity);
        DarkBoxBinaryMarket(market).split(initialLiquidity, deployer);

        vm.stopBroadcast();

        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);

        string memory json = string.concat(
            "{\n",
            '  "chainId": ', vm.toString(block.chainid), ",\n",
            '  "deployer": "', vm.toString(deployer), '",\n',
            '  "frontier": {\n',
            '    "factory": "', vm.toString(frontierFactory), '",\n',
            '    "router": "', vm.toString(frontierRouter), '",\n',
            '    "lens": "', vm.toString(frontierLens), '"\n',
            "  },\n",
            '  "darkbox": {\n',
            '    "syntheticUSDC": "', vm.toString(syntheticUSDC), '",\n',
            '    "marketFactory": "', vm.toString(marketFactory), '"\n',
            "  },\n",
            '  "canonicalMarket": {\n',
            '    "marketId": "', vm.toString(marketId), '",\n',
            '    "market": "', vm.toString(market), '",\n',
            '    "question": "', question, '",\n',
            '    "yesToken": "', vm.toString(m.yesToken()), '",\n',
            '    "noToken": "', vm.toString(m.noToken()), '",\n',
            '    "yesBook": "', vm.toString(yesBook), '",\n',
            '    "noBook": "', vm.toString(noBook), '"\n',
            "  }\n",
            "}\n"
        );
        vm.writeFile(out, json);

        console2.log("Arc grant market written to", out);
        console2.log("question", question);
        console2.log("market", market);
        console2.log("yesBook", yesBook);
        console2.log("noBook", noBook);
    }
}
