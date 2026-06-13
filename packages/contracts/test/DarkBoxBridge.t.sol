// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DarkBoxBridge} from "../src/DarkBoxBridge.sol";
import {IDarkBoxBridge} from "../src/interfaces/IDarkBoxBridge.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {BridgeEIP712Helper} from "./Helpers.sol";

contract DarkBoxBridgeTest is BridgeEIP712Helper {
    DarkBoxBridge internal bridge;
    MockERC20 internal usdc;

    address internal admin = makeAddr("admin");
    uint256 internal signerPk = 0xA11CE;
    address internal signer;

    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");

    bytes32 internal constant GAME_ID = keccak256("game-1");
    bytes32 internal constant SHADOW_ACCOUNT = keccak256("shadow-1");

    function setUp() public {
        signer = vm.addr(signerPk);
        bridge = new DarkBoxBridge(admin, signer);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(user, 1_000_000e6);
    }

    // --- Deposits ---

    function test_DepositERC20EmitsEvent() public {
        uint256 amount = 100e6;
        bytes32 ref = keccak256("ref-1");
        vm.startPrank(user);
        usdc.approve(address(bridge), amount);
        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.DepositReceived(GAME_ID, user, address(usdc), amount, user, ref);
        bridge.deposit(GAME_ID, address(usdc), amount, address(0), ref);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(bridge)), amount);
        assertEq(bridge.totalDeposited(user, address(usdc)), amount);
    }

    function test_DepositERC20WithExplicitBeneficiary() public {
        uint256 amount = 50e6;
        address bene = makeAddr("bene");
        vm.startPrank(user);
        usdc.approve(address(bridge), amount);
        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.DepositReceived(GAME_ID, user, address(usdc), amount, bene, bytes32(0));
        bridge.deposit(GAME_ID, address(usdc), amount, bene, bytes32(0));
        vm.stopPrank();
        assertEq(bridge.totalDeposited(bene, address(usdc)), amount);
    }

    function test_DirectEthReceiveEmitsNativeDeposit() public {
        vm.deal(user, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.DepositReceived(bytes32(0), user, address(0), 1 ether, user, bytes32(0));
        vm.prank(user);
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(bridge).balance, 1 ether);
    }

    function test_DepositNativeViaFunction() public {
        vm.deal(user, 2 ether);
        vm.prank(user);
        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.DepositReceived(GAME_ID, user, address(0), 2 ether, user, bytes32(0));
        bridge.deposit{value: 2 ether}(GAME_ID, address(0), 2 ether, address(0), bytes32(0));
        assertEq(address(bridge).balance, 2 ether);
    }

    function test_DepositNativeWrongMsgValueReverts() public {
        vm.deal(user, 2 ether);
        vm.prank(user);
        vm.expectRevert(DarkBoxBridge.WrongMsgValue.selector);
        bridge.deposit{value: 1 ether}(GAME_ID, address(0), 2 ether, address(0), bytes32(0));
    }

    function test_DepositRevertsWhenPaused() public {
        vm.prank(admin);
        bridge.setDepositsPaused(true);
        vm.startPrank(user);
        usdc.approve(address(bridge), 1e6);
        vm.expectRevert(DarkBoxBridge.DepositsPaused.selector);
        bridge.deposit(GAME_ID, address(usdc), 1e6, address(0), bytes32(0));
        vm.stopPrank();
    }

    // --- Withdrawals ---

    function _fundBridgeUSDC(uint256 amount) internal {
        usdc.mint(address(bridge), amount);
    }

    function _auth(uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (Authorization memory)
    {
        return Authorization({
            gameId: GAME_ID,
            owner: user,
            shadowAccount: SHADOW_ACCOUNT,
            asset: address(usdc),
            amount: amount,
            recipient: recipient,
            userCommandHash: keccak256("cmd-1"),
            shadowBurnRef: keccak256("burn-1"),
            nonce: nonce,
            deadline: deadline
        });
    }

    function _submit(Authorization memory a, bytes memory sig) internal {
        bridge.withdraw(
            a.gameId,
            a.owner,
            a.shadowAccount,
            a.asset,
            a.amount,
            a.recipient,
            a.nonce,
            a.deadline,
            a.userCommandHash,
            a.shadowBurnRef,
            sig
        );
    }

    function test_WithdrawHappyPath() public {
        uint256 amount = 100e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));

        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.WithdrawalExecuted(
            GAME_ID, user, address(usdc), amount, recipient, 1, a.userCommandHash, a.shadowBurnRef
        );
        _submit(a, sig);

        assertEq(usdc.balanceOf(recipient), amount);
        assertTrue(bridge.usedNonces(user, 1));
    }

    function test_WithdrawPermissionlessSubmission() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 7, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        // a random submitter, not the owner
        vm.prank(makeAddr("relayer"));
        _submit(a, sig);
        assertEq(usdc.balanceOf(recipient), amount);
    }

    function test_WithdrawRevertsOnReusedNonce() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount * 2);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        _submit(a, sig);
        vm.expectRevert(DarkBoxBridge.NonceAlreadyUsed.selector);
        _submit(a, sig);
    }

    function test_WithdrawRevertsOnWrongSigner() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(0xBEEF, _authDigest(bridge, a)); // not the signer
        vm.expectRevert(DarkBoxBridge.BadSigner.selector);
        _submit(a, sig);
    }

    function test_WithdrawRevertsOnExpiredDeadline() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(DarkBoxBridge.AuthorizationExpired.selector);
        _submit(a, sig);
    }

    function test_WithdrawRevertsOnTamperedAmount() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount * 2);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        a.amount = amount * 2; // tamper after signing
        vm.expectRevert(DarkBoxBridge.BadSigner.selector);
        _submit(a, sig);
    }

    function test_WithdrawRevertsOnTamperedRecipient() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        a.recipient = makeAddr("attacker");
        vm.expectRevert(DarkBoxBridge.BadSigner.selector);
        _submit(a, sig);
    }

    function test_WithdrawRevertsWhenPaused() public {
        uint256 amount = 10e6;
        _fundBridgeUSDC(amount);
        vm.prank(admin);
        bridge.setWithdrawalsPaused(true);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        vm.expectRevert(DarkBoxBridge.WithdrawalsPaused.selector);
        _submit(a, sig);
    }

    function test_WithdrawNative() public {
        uint256 amount = 1 ether;
        vm.deal(address(bridge), amount);
        Authorization memory a = _auth(amount, 1, block.timestamp + 1 hours);
        a.asset = address(0);
        bytes memory sig = _sign(signerPk, _authDigest(bridge, a));
        _submit(a, sig);
        assertEq(recipient.balance, amount);
    }

    // --- Emergency ---

    function test_EmergencyWithdrawAdminOnly() public {
        uint256 amount = 100e6;
        _fundBridgeUSDC(amount);
        bytes32 reason = keccak256("outage");

        vm.expectEmit(true, true, true, true);
        emit IDarkBoxBridge.EmergencyWithdrawal(GAME_ID, user, address(usdc), amount, recipient, reason);
        vm.prank(admin);
        bridge.emergencyWithdraw(GAME_ID, user, address(usdc), amount, recipient, reason);
        assertEq(usdc.balanceOf(recipient), amount);
    }

    function test_EmergencyWithdrawRevertsForNonAdmin() public {
        _fundBridgeUSDC(100e6);
        vm.prank(user);
        vm.expectRevert(DarkBoxBridge.NotAdmin.selector);
        bridge.emergencyWithdraw(GAME_ID, user, address(usdc), 100e6, recipient, bytes32(0));
    }

    // --- Admin gating ---

    function test_SetSignerAdminOnly() public {
        vm.prank(admin);
        bridge.setSigner(makeAddr("newSigner"));
        assertEq(bridge.signer(), makeAddr("newSigner"));

        vm.prank(user);
        vm.expectRevert(DarkBoxBridge.NotAdmin.selector);
        bridge.setSigner(user);
    }

    function test_PauseSettersAdminOnly() public {
        vm.prank(user);
        vm.expectRevert(DarkBoxBridge.NotAdmin.selector);
        bridge.setDepositsPaused(true);

        vm.prank(user);
        vm.expectRevert(DarkBoxBridge.NotAdmin.selector);
        bridge.setWithdrawalsPaused(true);
    }

    function test_RotatedSignerAcceptedAfterSet() public {
        uint256 newPk = 0xC0FFEE;
        vm.prank(admin);
        bridge.setSigner(vm.addr(newPk));

        uint256 amount = 5e6;
        _fundBridgeUSDC(amount);
        Authorization memory a = _auth(amount, 9, block.timestamp + 1 hours);
        bytes memory sig = _sign(newPk, _authDigest(bridge, a));
        _submit(a, sig);
        assertEq(usdc.balanceOf(recipient), amount);
    }
}
