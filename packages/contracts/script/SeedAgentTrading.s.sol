// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {SyntheticUSDC} from "../src/SyntheticUSDC.sol";
import {OutcomeToken} from "../src/markets/OutcomeToken.sol";
import {DarkBoxBinaryMarket} from "../src/markets/DarkBoxBinaryMarket.sol";
import {FrontierLens} from "frontier/periphery/FrontierLens.sol";
import {FrontierRouter} from "frontier/periphery/FrontierRouter.sol";
import {RollingFrontierBook} from "frontier/RollingFrontierBook.sol";

/// @notice Seed REAL on-chain agent trading on the LIVE mesh market so the indexer
///         ingests actual fills/pricing/volume — "agents making noise."
///
/// Coordinator-funded demo liquidity (Ocean's framing): the deployer key, which is
/// the explicit sUSDC minter + coordinator + gas funder, funds per-daemon accounts
/// with sUSDC + a little gas. Each daemon splits collateral into YES/NO inventory,
/// then places maker asks on the YES book and takes them via the FrontierRouter.
/// Mirrors the passing test_FrontierMakerDepositTakerFill exactly (deposit -> router
/// buyExactIn -> claim), so it generates confirmed fills, not just intents.
///
/// Per-daemon keys are derived from a sealed DAEMON_SEED (env, generated inside core)
/// — only public addresses ever leave this process. Run via the deployer image on the
/// mesh against the hidden chain (88813), DEPLOYER_KEY = the coordinator/minter key.
///
/// Tunables (env): DAEMON_SEED, SEED_DAEMONS (default 4), SEED_ROUNDS (default 6),
/// SEED_FUND_USDC (default 2000e6), SEED_SPLIT (default 1000e6), SEED_BUY_IN (default 40e6).
contract SeedAgentTrading is Script {
    // Final fully-mined addresses on chain 88813 (deployed-addresses-88813.json).
    SyntheticUSDC constant SUSDC = SyntheticUSDC(0x4d61006FDEaC7aaE14B373e7084b9968d42479e6);
    DarkBoxBinaryMarket constant MARKET = DarkBoxBinaryMarket(0x8d331eFbA13d204885Bf9B9D56bD5eff995f86f9);
    RollingFrontierBook constant YESBOOK = RollingFrontierBook(0x324d7fE2d849c2e3b4B1607BD8c1569FAD435fC8);
    FrontierRouter constant ROUTER = FrontierRouter(0x671703218c0e53Dd0708639Fe3d1a49A0A5817C7);
    FrontierLens constant LENS = FrontierLens(0x7534299de8c190793B82246d6EF1471F6d4a7253);

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_KEY"); // minter + coordinator + gas funder
        // DAEMON_SEED is REQUIRED (sealed env, generated inside core) — NO fallback.
        // A hardcoded default would derive KNOWN private keys and fund/trade from them,
        // so envBytes32 reverts hard if it's missing/misnamed (Ocean's review).
        bytes32 seed = vm.envBytes32("DAEMON_SEED");
        uint256 n = vm.envOr("SEED_DAEMONS", uint256(4));
        uint256 rounds = vm.envOr("SEED_ROUNDS", uint256(6));
        uint256 fundUsdc = vm.envOr("SEED_FUND_USDC", uint256(2_000e6));
        uint256 splitAmt = vm.envOr("SEED_SPLIT", uint256(1_000e6));
        uint256 buyIn = vm.envOr("SEED_BUY_IN", uint256(40e6));

        // Bound every param BEFORE any mint/broadcast so an env typo can't fund/trade
        // absurd amounts, and require >=2 daemons so nobody self-trades (Ocean's review).
        require(n >= 2 && n <= 16, "SEED_DAEMONS out of range (need 2..16)");
        require(rounds >= 1 && rounds <= 50, "SEED_ROUNDS out of range (1..50)");
        require(fundUsdc > 0 && fundUsdc <= 100_000e6, "SEED_FUND_USDC out of range (<=100k)");
        require(splitAmt > 0 && splitAmt <= fundUsdc, "SEED_SPLIT out of range (<=fund)");
        require(buyIn > 0 && buyIn <= fundUsdc, "SEED_BUY_IN out of range (<=fund)");
        console2.log("seed params -- daemons:", n, "rounds:", rounds);
        console2.log("seed params -- fundUsdc:", fundUsdc, "splitAmt:", splitAmt);
        console2.log("seed params -- buyIn (per take):", buyIn);

        uint256[] memory pk = new uint256[](n);
        address[] memory dae = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            // valid secp256k1 key: < 2^255 (so < curve order n) and non-zero.
            pk[i] = (uint256(keccak256(abi.encodePacked(seed, i))) >> 1) | 1;
            dae[i] = vm.addr(pk[i]);
        }

        OutcomeToken yes = OutcomeToken(MARKET.yesToken());

        // 1) Coordinator funds each daemon (gas + sUSDC), then daemon splits + approves.
        for (uint256 i = 0; i < n; i++) {
            vm.startBroadcast(deployerPk);
            if (dae[i].balance < 0.02 ether) payable(dae[i]).transfer(0.05 ether);
            SUSDC.mint(dae[i], fundUsdc);
            vm.stopBroadcast();

            vm.startBroadcast(pk[i]);
            SUSDC.approve(address(MARKET), type(uint256).max);
            MARKET.split(splitAmt, dae[i]); // splitAmt YES + splitAmt NO
            yes.approve(address(YESBOOK), type(uint256).max);
            SUSDC.approve(address(ROUTER), type(uint256).max);
            vm.stopBroadcast();
            console2.log("daemon funded+prepped:", i, dae[i]);
        }

        // 2) Trading rounds: a rotating maker posts a YES ask ladder rung, the next
        //    daemon takes it via the router. Real fills -> volume -> pricing.
        uint256 fills;
        for (uint256 r = 0; r < rounds; r++) {
            uint256 mi = r % n;
            uint256 ti = (r + 1) % n;

            // ask ladder rung above tick 0 (mirrors the passing test deposit(1,101,..));
            // each round climbs +120 ticks so successive buys keep finding fresh asks.
            int24 lo = int24(uint24(1 + r * 120));
            int24 hi = lo + 100;
            vm.startBroadcast(pk[mi]);
            uint256 posId = YESBOOK.deposit(lo, hi, uint128(3e6));
            vm.stopBroadcast();

            (uint256 q0,,) = LENS.quoteBuy(YESBOOK, buyIn);
            if (q0 == 0) {
                console2.log("round no-fill (q0=0), skip:", r);
                continue;
            }
            vm.startBroadcast(pk[ti]);
            ROUTER.buyExactIn(YESBOOK, buyIn, (q0 * 95) / 100, dae[ti], block.timestamp + 600);
            vm.stopBroadcast();

            vm.startBroadcast(pk[mi]);
            YESBOOK.claim(posId);
            vm.stopBroadcast();

            fills++;
            console2.log("round filled:", r);
        }
        console2.log("=== SEED TRADING COMPLETE, fills: ===", fills);
    }
}
