// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {DarkBoxMarketFactory} from "../src/markets/DarkBoxMarketFactory.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {CreateMarketParams, ResolverConfig, ResolverType} from "../src/markets/MarketTypes.sol";

/// @notice Arc-friendly continuation deploy. Reuses an already-deployed
///         Frontier factory/router/lens + sUSDC, deploys a split-book-capable
///         DarkBoxMarketFactory, then creates the canonical market shell and
///         YES/NO books in separate transactions to stay under Arc's 30M gas cap.
contract DeployArcMarketSplit is Script {
    uint256 internal constant DEFAULT_MAKER_FEE_BPS = 0;
    uint256 internal constant DEFAULT_TAKER_FEE_BPS = 100;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(pk);
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/darkbox-arc-testnet-5042002.json"));

        address frontierFactory = vm.envAddress("FRONTIER_FACTORY");
        address frontierRouter = vm.envAddress("FRONTIER_ROUTER");
        address frontierLens = vm.envAddress("FRONTIER_LENS");
        address syntheticUSDC = vm.envAddress("SUSDC");
        uint16 makerFeeBps = uint16(vm.envOr("MAKER_FEE_BPS", DEFAULT_MAKER_FEE_BPS));
        uint16 takerFeeBps = uint16(vm.envOr("TAKER_FEE_BPS", DEFAULT_TAKER_FEE_BPS));

        vm.startBroadcast(pk);

        DarkBoxMarketFactory pmFactory = new DarkBoxMarketFactory(
            deployer, // owner/admin
            deployer, // coordinator
            syntheticUSDC,
            frontierFactory,
            deployer, // feeRecipient
            deployer // treasury
        );
        pmFactory.setBookParams(1, 0, makerFeeBps, takerFeeBps);

        SyntheticUSDC sUSDC = SyntheticUSDC(syntheticUSDC);
        sUSDC.mint(deployer, 1_000_000e6);
        sUSDC.approve(address(pmFactory), type(uint256).max);

        CreateMarketParams memory params = CreateMarketParams({
            gameId: keccak256("darkbox-game-1"),
            question: "Will the canonical project win the hackathon?",
            description: "Canonical DarkBox hackathon-winner market.",
            metadataURI: "ipfs://darkbox/canonical-market.json",
            resolver: ResolverConfig({
                resolverType: ResolverType.AdminManual,
                resolver: deployer,
                sourceId: keccak256("hackathon-judges"),
                data: ""
            }),
            closeTime: uint64(block.timestamp + 7 days),
            resolveBy: uint64(block.timestamp + 8 days),
            creatorBond: 10e6,
            initialLiquidity: 0
        });

        (bytes32 marketId, address market) = pmFactory.createMarketShell(params);
        address yesBook = pmFactory.createYesBook(marketId);
        address noBook = pmFactory.createNoBook(marketId);

        // Split initial liquidity after books are deployed. The deployer receives
        // the initial YES/NO inventory for seeding the books.
        uint256 initialLiquidity = 1_000e6;
        sUSDC.approve(market, initialLiquidity);
        DarkBoxBinaryMarket(market).split(initialLiquidity, deployer);

        vm.stopBroadcast();

        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);

        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "deployer": "',
            vm.toString(deployer),
            '",\n',
            '  "frontier": {\n',
            '    "factory": "',
            vm.toString(frontierFactory),
            '",\n',
            '    "router": "',
            vm.toString(frontierRouter),
            '",\n',
            '    "lens": "',
            vm.toString(frontierLens),
            '"\n',
            "  },\n",
            '  "feeConfig": {\n',
            '    "makerFeeBps": ',
            vm.toString(makerFeeBps),
            ",\n",
            '    "takerFeeBps": ',
            vm.toString(takerFeeBps),
            "\n",
            "  },\n",
            '  "darkbox": {\n',
            '    "syntheticUSDC": "',
            vm.toString(syntheticUSDC),
            '",\n',
            '    "marketFactory": "',
            vm.toString(address(pmFactory)),
            '"\n',
            "  },\n",
            '  "canonicalMarket": {\n',
            '    "marketId": "',
            vm.toString(marketId),
            '",\n',
            '    "market": "',
            vm.toString(market),
            '",\n',
            '    "yesToken": "',
            vm.toString(m.yesToken()),
            '",\n',
            '    "noToken": "',
            vm.toString(m.noToken()),
            '",\n',
            '    "yesBook": "',
            vm.toString(yesBook),
            '",\n',
            '    "noBook": "',
            vm.toString(noBook),
            '"\n',
            "  }\n",
            "}\n"
        );
        vm.writeFile(out, json);

        console2.log("Arc DarkBox deployment written to", out);
        console2.log("frontier.factory", frontierFactory);
        console2.log("frontier.router", frontierRouter);
        console2.log("frontier.lens", frontierLens);
        console2.log("syntheticUSDC", syntheticUSDC);
        console2.log("marketFactory", address(pmFactory));
        console2.log("canonical.market", market);
        console2.log("canonical.yesBook", yesBook);
        console2.log("canonical.noBook", noBook);
    }
}
