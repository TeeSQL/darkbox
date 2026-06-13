// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

// Real Frontier (vendored) deploy-day stack.
import {FrontierGeoBookFactory} from "frontier/FrontierGeoBookFactory.sol";
import {GeometricBookDeployer, GeometricOpsDeployer} from "frontier/FrontierDeployers.sol";
import {FrontierLens} from "frontier/periphery/FrontierLens.sol";
import {FrontierRouter} from "frontier/periphery/FrontierRouter.sol";
import {PermissionRegistry} from "frontier/permissions/PermissionRegistry.sol";

// DarkBox PM stack.
import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {DarkBoxMarketFactory} from "../src/markets/DarkBoxMarketFactory.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {
    CreateMarketParams, ResolverConfig, ResolverType, Outcome
} from "../src/markets/MarketTypes.sol";

/// @notice Deploys the full DarkBox stack on top of the real Frontier orderbook:
///         Frontier (registry/deployers/factory/lens/router), synthetic USDC,
///         the DarkBox market factory, then seeds the canonical hackathon-winner
///         market and registers its YES/sUSDC + NO/sUSDC books.
///
/// Env (all optional — defaults target a local anvil/private chain):
/// - DEPLOYER_KEY : private key (defaults to anvil account[0])
/// - DEPLOY_OUT   : output JSON path (defaults to deployments/darkbox-latest.json)
/// - TAKER_FEE_BPS / MAKER_FEE_BPS : Frontier fees for the seeded books
contract DeployDarkBox is Script {
    // anvil account[0]
    uint256 internal constant DEFAULT_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_KEY", DEFAULT_KEY);
        address deployer = vm.addr(pk);
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/darkbox-latest.json"));
        uint16 makerFeeBps = uint16(vm.envOr("MAKER_FEE_BPS", uint256(0)));
        uint16 takerFeeBps = uint16(vm.envOr("TAKER_FEE_BPS", uint256(30)));

        vm.startBroadcast(pk);

        // --- Frontier ---
        PermissionRegistry registry = new PermissionRegistry();
        FrontierGeoBookFactory frontier =
            new FrontierGeoBookFactory(address(registry), new GeometricBookDeployer(), new GeometricOpsDeployer());
        FrontierLens lens = new FrontierLens();
        FrontierRouter router = new FrontierRouter(address(frontier), lens);

        // --- DarkBox collateral + factory ---
        // deployer is admin + minter + coordinator for the local MVP deploy.
        SyntheticUSDC sUSDC = new SyntheticUSDC(deployer, deployer);
        DarkBoxMarketFactory pmFactory = new DarkBoxMarketFactory(
            deployer, // owner/admin
            deployer, // coordinator
            address(sUSDC),
            address(frontier),
            deployer, // feeRecipient
            deployer // treasury
        );
        pmFactory.setBookParams(1, 0, makerFeeBps, takerFeeBps);

        // --- Seed canonical hackathon-winner market ---
        sUSDC.mint(deployer, 1_000_000e6);
        sUSDC.approve(address(pmFactory), type(uint256).max);

        CreateMarketParams memory params = CreateMarketParams({
            gameId: keccak256("darkbox-game-1"),
            question: "Will the canonical project win the hackathon?",
            description: "Canonical DarkBox hackathon-winner market.",
            metadataURI: "ipfs://darkbox/canonical-market.json",
            resolver: ResolverConfig({
                resolverType: ResolverType.CanonicalWinner,
                resolver: deployer,
                sourceId: keccak256("hackathon-judges"),
                data: ""
            }),
            closeTime: uint64(block.timestamp + 7 days),
            resolveBy: uint64(block.timestamp + 8 days),
            creatorBond: 10e6,
            initialLiquidity: 1_000e6
        });

        (bytes32 marketId, address market) = pmFactory.createMarket(params);
        (address yesBook, address noBook) = pmFactory.createBooks(marketId);

        vm.stopBroadcast();

        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);

        string memory json = string.concat(
            "{\n",
            '  "chainId": ', vm.toString(block.chainid), ",\n",
            '  "deployer": "', vm.toString(deployer), '",\n',
            '  "frontier": {\n',
            '    "registry": "', vm.toString(address(registry)), '",\n',
            '    "factory": "', vm.toString(address(frontier)), '",\n',
            '    "lens": "', vm.toString(address(lens)), '",\n',
            '    "router": "', vm.toString(address(router)), '"\n',
            "  },\n",
            '  "darkbox": {\n',
            '    "syntheticUSDC": "', vm.toString(address(sUSDC)), '",\n',
            '    "marketFactory": "', vm.toString(address(pmFactory)), '"\n',
            "  },\n",
            '  "canonicalMarket": {\n',
            '    "marketId": "', vm.toString(marketId), '",\n',
            '    "market": "', vm.toString(market), '",\n',
            '    "yesToken": "', vm.toString(m.yesToken()), '",\n',
            '    "noToken": "', vm.toString(m.noToken()), '",\n',
            '    "yesBook": "', vm.toString(yesBook), '",\n',
            '    "noBook": "', vm.toString(noBook), '"\n',
            "  }\n",
            "}\n"
        );
        vm.writeFile(out, json);

        console2.log("DarkBox deployment written to", out);
        console2.log("frontier.factory", address(frontier));
        console2.log("frontier.router", address(router));
        console2.log("frontier.lens", address(lens));
        console2.log("syntheticUSDC", address(sUSDC));
        console2.log("marketFactory", address(pmFactory));
        console2.log("canonical.market", market);
        console2.log("canonical.yesBook", yesBook);
        console2.log("canonical.noBook", noBook);
    }
}
