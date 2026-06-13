// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShadowBridgeController} from "../src/ShadowBridgeController.sol";
import {IShadowBridgeController} from "../src/interfaces/IShadowBridgeController.sol";

contract ShadowBridgeControllerTest is Test {
    ShadowBridgeController internal ctrl;

    address internal coordinator = makeAddr("coordinator");
    address internal owner = makeAddr("owner");
    address internal asset = makeAddr("shadowUSDC");

    bytes32 internal constant GAME_ID = keccak256("game-1");
    bytes32 internal shadowAccount;

    function setUp() public {
        ctrl = new ShadowBridgeController(coordinator);
        shadowAccount = keccak256(abi.encode(GAME_ID, owner));
    }

    function _depositOpId(string memory tag) internal pure returns (bytes32) {
        return keccak256(bytes(tag));
    }

    // --- Mapping ---

    function test_MapShadowAccountCoordinatorOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ShadowBridgeController.NotCoordinator.selector);
        ctrl.mapShadowAccount(owner, shadowAccount);

        vm.prank(coordinator);
        vm.expectEmit(true, true, false, false);
        emit IShadowBridgeController.ShadowAccountMapped(owner, shadowAccount);
        ctrl.mapShadowAccount(owner, shadowAccount);

        assertEq(ctrl.shadowOf(owner), shadowAccount);
        assertEq(ctrl.ownerOf(shadowAccount), owner);
    }

    function test_MappingImmutableOnceSet() public {
        vm.startPrank(coordinator);
        ctrl.mapShadowAccount(owner, shadowAccount);
        // identical remap is idempotent (no revert)
        ctrl.mapShadowAccount(owner, shadowAccount);
        // conflicting remap reverts
        vm.expectRevert(ShadowBridgeController.MappingMismatch.selector);
        ctrl.mapShadowAccount(owner, keccak256("other"));
        vm.stopPrank();
    }

    // --- Mint ---

    function test_MintShadowAutoMapsAndCredits() public {
        bytes32 opId = _depositOpId("op-1");
        vm.prank(coordinator);
        vm.expectEmit(true, true, true, true);
        emit IShadowBridgeController.ShadowMinted(opId, shadowAccount, asset, 100e6);
        ctrl.mintShadow(opId, owner, shadowAccount, asset, 100e6);

        assertEq(ctrl.balanceOf(shadowAccount, asset), 100e6);
        assertEq(ctrl.shadowOf(owner), shadowAccount); // auto-mapped
    }

    function test_MintIdempotentPerDepositOpId() public {
        bytes32 opId = _depositOpId("op-1");
        vm.startPrank(coordinator);
        ctrl.mintShadow(opId, owner, shadowAccount, asset, 100e6);
        vm.expectRevert(ShadowBridgeController.AlreadyMinted.selector);
        ctrl.mintShadow(opId, owner, shadowAccount, asset, 100e6);
        vm.stopPrank();
        assertEq(ctrl.balanceOf(shadowAccount, asset), 100e6); // only once
    }

    function test_MintCoordinatorOnly() public {
        vm.prank(owner);
        vm.expectRevert(ShadowBridgeController.NotCoordinator.selector);
        ctrl.mintShadow(_depositOpId("op-1"), owner, shadowAccount, asset, 1e6);
    }

    function test_MintRejectsMappingMismatch() public {
        vm.startPrank(coordinator);
        ctrl.mintShadow(_depositOpId("op-1"), owner, shadowAccount, asset, 1e6);
        // same owner, different shadow account -> mismatch
        vm.expectRevert(ShadowBridgeController.MappingMismatch.selector);
        ctrl.mintShadow(_depositOpId("op-2"), owner, keccak256("other-shadow"), asset, 1e6);
        vm.stopPrank();
    }

    // --- Burn ---

    function _seed(uint256 amount) internal {
        vm.prank(coordinator);
        ctrl.mintShadow(_depositOpId("seed"), owner, shadowAccount, asset, amount);
    }

    function test_BurnForWithdrawalHappyPath() public {
        _seed(100e6);
        bytes32 withdrawalId = keccak256("wd-1");
        vm.prank(coordinator);
        vm.expectEmit(true, true, true, true);
        emit IShadowBridgeController.ShadowBurned(withdrawalId, shadowAccount, asset, 40e6);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 40e6, withdrawalId);

        assertEq(ctrl.balanceOf(shadowAccount, asset), 60e6);
        assertTrue(ctrl.withdrawalProcessed(withdrawalId));
    }

    function test_BurnRevertsOnInsufficientAvailable() public {
        _seed(100e6);
        bytes32 withdrawalId = keccak256("wd-1");
        vm.prank(coordinator);
        vm.expectRevert(ShadowBridgeController.InsufficientAvailable.selector);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 101e6, withdrawalId);
    }

    function test_BurnExcludesLockedFromWithdrawable() public {
        _seed(100e6);
        // 70 locked in open orders -> only 30 withdrawable
        vm.prank(coordinator);
        ctrl.setLocked(shadowAccount, asset, 70e6);
        assertEq(ctrl.withdrawableBalance(shadowAccount, asset), 30e6);

        bytes32 withdrawalId = keccak256("wd-1");
        vm.prank(coordinator);
        vm.expectRevert(ShadowBridgeController.InsufficientAvailable.selector);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 31e6, withdrawalId);

        // 30 is fine
        vm.prank(coordinator);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 30e6, withdrawalId);
        assertEq(ctrl.balanceOf(shadowAccount, asset), 70e6);
    }

    function test_BurnRevertsOnReusedWithdrawalId() public {
        _seed(100e6);
        bytes32 withdrawalId = keccak256("wd-1");
        vm.startPrank(coordinator);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 10e6, withdrawalId);
        vm.expectRevert(ShadowBridgeController.AlreadyWithdrawn.selector);
        ctrl.burnForWithdrawal(withdrawalId, owner, shadowAccount, asset, 10e6, withdrawalId);
        vm.stopPrank();
    }

    function test_BurnCoordinatorOnly() public {
        _seed(100e6);
        vm.prank(owner);
        vm.expectRevert(ShadowBridgeController.NotCoordinator.selector);
        ctrl.burnForWithdrawal(keccak256("wd-1"), owner, shadowAccount, asset, 10e6, keccak256("wd-1"));
    }

    function test_BurnRevertsOnMappingMismatch() public {
        _seed(100e6);
        vm.prank(coordinator);
        vm.expectRevert(ShadowBridgeController.MappingMismatch.selector);
        ctrl.burnForWithdrawal(keccak256("wd-1"), owner, keccak256("wrong-shadow"), asset, 10e6, keccak256("wd-1"));
    }

    function test_WithdrawableBalanceView() public {
        _seed(100e6);
        assertEq(ctrl.withdrawableBalance(shadowAccount, asset), 100e6);
        vm.prank(coordinator);
        ctrl.setLocked(shadowAccount, asset, 100e6);
        assertEq(ctrl.withdrawableBalance(shadowAccount, asset), 0);
    }
}
