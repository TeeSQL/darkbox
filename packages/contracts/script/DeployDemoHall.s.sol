// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

// Real Frontier (vendored) deploy-day stack.
import {FrontierGeoBookFactory} from "frontier/FrontierGeoBookFactory.sol";
import {GeometricBookDeployer, GeometricOpsDeployer} from "frontier/FrontierDeployers.sol";
import {FrontierLens} from "frontier/periphery/FrontierLens.sol";
import {FrontierRouter} from "frontier/periphery/FrontierRouter.sol";
import {RollingFrontierBook} from "frontier/RollingFrontierBook.sol";
import {PermissionRegistry} from "frontier/permissions/PermissionRegistry.sol";

// DarkBox PM stack.
import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {DarkBoxMarketFactory} from "../src/markets/DarkBoxMarketFactory.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {CreateMarketParams, ResolverConfig, ResolverType} from "../src/markets/MarketTypes.sol";

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IBook {
    function deposit(int24, int24, uint128) external returns (uint256);
}

/// @notice Deploys the full DarkBox stack on the running hidden-chain Anvil and
///         seeds a *lively* demo hall: several curated hackathon-prediction
///         markets, maker-ask ladders provided by the house (deployer), and a
///         bootstrap round of taker buys from 9 daemon wallets. Each daemon buy
///         is broadcast from that daemon's key so the indexer attributes the
///         fill (via tx.from) to the right agent. Buys walk the ladder upward,
///         so earlier daemons enter cheaper and the leaderboard shows varied PnL
///         immediately; the continuous trade loop keeps prices moving after.
///
/// Env: DEPLOY_OUT (json path). Uses anvil deterministic keys.
contract DeployDemoHall is Script {
    // anvil deterministic keys: acct0 = house/deployer; acct1..9 = daemons.
    uint256 internal constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function daemonKeys() internal pure returns (uint256[9] memory k) {
        // canonical anvil deterministic keys acct1..acct9
        k[0] = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        k[1] = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
        k[2] = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
        k[3] = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
        k[4] = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
        k[5] = 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e;
        k[6] = 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356;
        k[7] = 0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97;
        k[8] = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;
    }

    string[7] internal QUESTIONS = [
        "Will DaemonHall be a finalist?",
        "Will a solo hacker take first place?",
        "Will an AI-agent project win the grand prize?",
        "Will the winning team ship fully on-chain?",
        "Will a prediction-market project place top 3?",
        "Will DaemonHall win Best Use of AI?",
        "Will an infra / devtools project win?"
    ];

    function run() external {
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/darkbox-demohall.json"));
        address deployer = vm.addr(K0);

        // --- Deploy Frontier + DarkBox under the house key ---
        vm.startBroadcast(K0);
        PermissionRegistry registry = new PermissionRegistry();
        FrontierGeoBookFactory frontier =
            new FrontierGeoBookFactory(address(registry), new GeometricBookDeployer(), new GeometricOpsDeployer());
        FrontierLens lens = new FrontierLens();
        FrontierRouter router = new FrontierRouter(address(frontier), lens);

        SyntheticUSDC sUSDC = new SyntheticUSDC(deployer, deployer);
        DarkBoxMarketFactory pmFactory =
            new DarkBoxMarketFactory(deployer, deployer, address(sUSDC), address(frontier), deployer, deployer);
        pmFactory.setBookParams(1, 0, 0, 100); // tickSpacing=1, makerFee=0, takerFee=100bps

        // House needs collateral to seed every market's initial liquidity.
        sUSDC.mint(deployer, 100_000_000e6);
        sUSDC.approve(address(pmFactory), type(uint256).max);

        // Fund the 9 daemon wallets generously (bootstrap + continuous loop).
        uint256[9] memory dk = daemonKeys();
        for (uint256 i = 0; i < 9; i++) {
            sUSDC.mint(vm.addr(dk[i]), 100_000e6);
        }
        vm.stopBroadcast();

        // --- Create markets + house maker ladders ---
        bytes32[7] memory marketIds;
        address[7] memory markets;
        address[7] memory yesBooks;
        address[7] memory noBooks;

        for (uint256 q = 0; q < QUESTIONS.length; q++) {
            vm.startBroadcast(K0);
            CreateMarketParams memory params = CreateMarketParams({
                gameId: keccak256("darkbox-game-1"),
                question: QUESTIONS[q],
                description: "DarkBox demo hall market.",
                metadataURI: "ipfs://darkbox/demo.json",
                resolver: ResolverConfig({
                    resolverType: ResolverType.AdminManual,
                    resolver: deployer,
                    sourceId: keccak256("hackathon-judges"),
                    data: ""
                }),
                closeTime: uint64(block.timestamp + 7 days),
                resolveBy: uint64(block.timestamp + 8 days),
                creatorBond: 10e6,
                initialLiquidity: 2_000e6
            });
            (bytes32 marketId, address market) = pmFactory.createMarket(params);
            (address yesBook, address noBook) = pmFactory.getBooks(marketId);
            marketIds[q] = marketId;
            markets[q] = market;
            yesBooks[q] = yesBook;
            noBooks[q] = noBook;

            DarkBoxBinaryMarket m = DarkBoxBinaryMarket(market);
            // House holds the initial-liquidity YES + NO; lay ask ladders so
            // takers can buy across rising price levels.
            IERC20Like(m.yesToken()).approve(yesBook, type(uint256).max);
            IERC20Like(m.noToken()).approve(noBook, type(uint256).max);
            _ladder(yesBook);
            _ladder(noBook);
            vm.stopBroadcast();
        }

        // --- Bootstrap taker buys: each daemon trades a varied subset ---
        uint256 deadline = block.timestamp + 1 days;
        for (uint256 i = 0; i < 9; i++) {
            vm.startBroadcast(dk[i]);
            IERC20Like(address(sUSDC)).approve(address(router), type(uint256).max);
            // Each daemon touches 3 markets (offset by index) and alternates
            // YES/NO so positions differ. Amounts vary by daemon for spread.
            for (uint256 j = 0; j < 3; j++) {
                uint256 mi = (i + j) % QUESTIONS.length;
                bool yes = ((i + j) % 2) == 0;
                address book = yes ? yesBooks[mi] : noBooks[mi];
                uint256 amountIn = (1e6) + (uint256(i) * 250_000) + (uint256(j) * 400_000);
                try router.buyExactIn(RollingFrontierBook(book), amountIn, 0, vm.addr(dk[i]), deadline) {
                    // ok
                } catch {
                    // book thin / slippage — skip, keep the hall populating
                }
            }
            vm.stopBroadcast();
        }

        // --- Write addresses + market list ---
        string memory mjson = "[";
        for (uint256 q = 0; q < QUESTIONS.length; q++) {
            mjson = string.concat(
                mjson,
                q == 0 ? "" : ",",
                '{"marketId":"',
                vm.toString(marketIds[q]),
                '","market":"',
                vm.toString(markets[q]),
                '","yesBook":"',
                vm.toString(yesBooks[q]),
                '","noBook":"',
                vm.toString(noBooks[q]),
                '","question":"',
                QUESTIONS[q],
                '"}'
            );
        }
        mjson = string.concat(mjson, "]");

        string memory json = string.concat(
            "{\n",
            '  "chainId": ', vm.toString(block.chainid), ",\n",
            '  "deployer": "', vm.toString(deployer), '",\n',
            '  "syntheticUSDC": "', vm.toString(address(sUSDC)), '",\n',
            '  "marketFactory": "', vm.toString(address(pmFactory)), '",\n',
            '  "frontier": { "factory": "', vm.toString(address(frontier)),
            '", "router": "', vm.toString(address(router)),
            '", "lens": "', vm.toString(address(lens)), '" },\n',
            '  "markets": ', mjson, "\n",
            "}\n"
        );
        vm.writeFile(out, json);

        console2.log("DemoHall deployment written to", out);
        console2.log("marketFactory", address(pmFactory));
        console2.log("syntheticUSDC", address(sUSDC));
        console2.log("router", address(router));
    }

    /// Lay a multi-band ask ladder so buyExactIn can walk rising price levels.
    function _ladder(address book) internal {
        for (uint256 b = 0; b < 6; b++) {
            int24 lower = int24(uint24(1 + b * 100));
            int24 upper = int24(uint24(101 + b * 100));
            try IBook(book).deposit(lower, upper, 1_000_000) {} catch {}
        }
    }
}
