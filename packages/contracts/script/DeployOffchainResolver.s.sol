// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OffchainResolver} from "../src/ens/OffchainResolver.sol";

/// @notice Deploys the DarkBox ERC-3668 OffchainResolver for `darkbox.eth`.
///
/// After deploying, set this contract as the resolver for `darkbox.eth` (via the
/// ENS app or registry `setResolver`) so all `*.darkbox.eth` lookups route to the
/// `darkbox-ens` gateway.
///
/// Env:
/// - DEPLOYER_KEY      : private key that deploys + owns the resolver (required on live nets)
/// - ENS_GATEWAY_URL   : gateway template, e.g. https://ens.darkbox.example/r/{sender}/{data}.json
/// - ENS_GATEWAY_SIGNER: trusted gateway signer address (the `/ens/gateway` signer)
contract DeployOffchainResolver is Script {
    function run() external returns (OffchainResolver resolver) {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        string memory url = vm.envString("ENS_GATEWAY_URL");
        address signer = vm.envAddress("ENS_GATEWAY_SIGNER");

        address[] memory signers = new address[](1);
        signers[0] = signer;

        vm.startBroadcast(key);
        resolver = new OffchainResolver(url, signers);
        vm.stopBroadcast();

        console2.log("OffchainResolver:", address(resolver));
        console2.log("gateway url:", url);
        console2.log("trusted signer:", signer);
        console2.log("Next: set this address as the resolver for darkbox.eth");
    }
}
