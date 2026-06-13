// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DarkBoxBridge} from "../src/DarkBoxBridge.sol";
import {ShadowBridgeController} from "../src/ShadowBridgeController.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Deploys the public bridge (+ optional mintable mock USDC) to the
///         public chain. Run against the public testnet RPC.
///
/// Env:
///   PRIVATE_KEY        deployer key (also funds gas)
///   ADMIN_ADDRESS      multisig/admin role (defaults to deployer)
///   SIGNER_ADDRESS     signing-service authorization key
///   DEPLOY_MOCK_USDC   "true" to deploy a mintable MockERC20 as test USDC
contract DeployPublic is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address signer = vm.envAddress("SIGNER_ADDRESS");
        bool deployMock = vm.envOr("DEPLOY_MOCK_USDC", false);

        vm.startBroadcast(pk);

        DarkBoxBridge bridge = new DarkBoxBridge(admin, signer);
        console2.log("DarkBoxBridge:", address(bridge));
        console2.log("  admin:", admin);
        console2.log("  signer:", signer);

        if (deployMock) {
            MockERC20 usdc = new MockERC20("DarkBox Test USDC", "tUSDC", 6);
            usdc.mint(deployer, 1_000_000e6);
            console2.log("MockUSDC:", address(usdc));
            console2.log("  minted 1,000,000 tUSDC to:", deployer);
        }

        vm.stopBroadcast();
    }
}

/// @notice Deploys the shadow bridge controller to the shadow chain (a local
///         anvil for the MVP smoke test).
///
/// Env:
///   PRIVATE_KEY          deployer key
///   COORDINATOR_ADDRESS  bridge coordinator key (defaults to deployer)
contract DeployShadow is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address coordinator = vm.envOr("COORDINATOR_ADDRESS", deployer);

        vm.startBroadcast(pk);
        ShadowBridgeController ctrl = new ShadowBridgeController(coordinator);
        console2.log("ShadowBridgeController:", address(ctrl));
        console2.log("  coordinator:", coordinator);
        vm.stopBroadcast();
    }
}
