// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDarkBoxBridge, IERC20Minimal} from "./interfaces/IDarkBoxBridge.sol";
import {ECDSA} from "./lib/ECDSA.sol";

/// @title DarkBoxBridge
/// @notice Public escrow that custodies real USDC/ETH, records deposits, and
///         releases funds only against a signing-service `WithdrawalAuthorization`
///         (which is itself only issued after a confirmed shadow-EVM burn).
/// @dev Self-contained EIP-712; native asset sentinel is `address(0)`.
contract DarkBoxBridge is IDarkBoxBridge {
    /// @notice Native ETH sentinel for the `asset` field.
    address public constant NATIVE = address(0);

    // --- EIP-712 domain ---
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // WithdrawalAuthorization(bytes32 gameId,address owner,bytes32 shadowAccount,address asset,uint256 amount,address recipient,bytes32 userCommandHash,bytes32 shadowBurnRef,uint256 nonce,uint256 deadline)
    bytes32 public constant WITHDRAWAL_AUTHORIZATION_TYPEHASH = keccak256(
        "WithdrawalAuthorization(bytes32 gameId,address owner,bytes32 shadowAccount,address asset,uint256 amount,address recipient,bytes32 userCommandHash,bytes32 shadowBurnRef,uint256 nonce,uint256 deadline)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // --- Roles / config ---
    address public admin; // multisig/admin
    address public signer; // signing-service authorization key

    bool public depositsPaused;
    bool public withdrawalsPaused;

    /// @notice Used withdrawal nonces, per owner (spec section 9).
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    /// @notice Escrow accounting per (owner, asset).
    mapping(address => mapping(address => uint256)) public totalDeposited;
    mapping(address => mapping(address => uint256)) public totalWithdrawn;

    // --- Errors ---
    error NotAdmin();
    error DepositsPaused();
    error WithdrawalsPaused();
    error NonceAlreadyUsed();
    error AuthorizationExpired();
    error BadSigner();
    error WrongMsgValue();
    error ZeroAmount();
    error NativeTransferFailed();

    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);
    event DepositsPausedSet(bool paused);
    event WithdrawalsPausedSet(bool paused);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin, address _signer) {
        require(_admin != address(0), "admin=0");
        admin = _admin;
        signer = _signer;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("DarkBoxBridge")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Direct ETH send path (spec 6.1.1). Beneficiary defaults to sender.
    /// @dev gameId/depositRef are unknown for a raw send; the offchain watcher
    ///      resolves them from config. Emitted as zero here.
    receive() external payable {
        if (depositsPaused) revert DepositsPaused();
        emit DepositReceived(bytes32(0), msg.sender, NATIVE, msg.value, msg.sender, bytes32(0));
    }

    /// @inheritdoc IDarkBoxBridge
    function deposit(bytes32 gameId, address asset, uint256 amount, address beneficiary, bytes32 depositRef)
        external
        payable
    {
        if (depositsPaused) revert DepositsPaused();
        if (amount == 0) revert ZeroAmount();
        address bene = beneficiary == address(0) ? msg.sender : beneficiary;

        if (asset == NATIVE) {
            if (msg.value != amount) revert WrongMsgValue();
        } else {
            if (msg.value != 0) revert WrongMsgValue();
            // pull tokens from caller (requires prior approve)
            _safeTransferFrom(asset, msg.sender, address(this), amount);
        }

        totalDeposited[bene][asset] += amount;
        emit DepositReceived(gameId, msg.sender, asset, amount, bene, depositRef);
    }

    /// @notice Register an agent commitment (spec section 8). Emits canonical event only.
    function registerAgent(
        bytes32 gameId,
        bytes32 agentId,
        bytes32 shadowAccount,
        string calldata ensName,
        bytes32 instructionHash,
        bytes32 runtimeHash,
        bytes32 revealSaltHash
    ) external {
        emit AgentRegistered(
            gameId, agentId, msg.sender, shadowAccount, ensName, instructionHash, runtimeHash, revealSaltHash
        );
    }

    // ---------------------------------------------------------------------
    // Withdrawals
    // ---------------------------------------------------------------------

    /// @inheritdoc IDarkBoxBridge
    /// @dev Permissionless submission (spec 1.1): anyone with a valid service
    ///      signature may submit; funds always go to the bound `recipient`.
    function withdraw(
        bytes32 gameId,
        address owner,
        bytes32 shadowAccount,
        address asset,
        uint256 amount,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        bytes32 userCommandHash,
        bytes32 shadowBurnRef,
        bytes calldata serviceSignature
    ) external {
        if (withdrawalsPaused) revert WithdrawalsPaused();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (usedNonces[owner][nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_AUTHORIZATION_TYPEHASH,
                gameId,
                owner,
                shadowAccount,
                asset,
                amount,
                recipient,
                userCommandHash,
                shadowBurnRef,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ECDSA.recover(digest, serviceSignature);
        if (recovered != signer) revert BadSigner();

        usedNonces[owner][nonce] = true;
        totalWithdrawn[owner][asset] += amount;

        _payout(asset, recipient, amount);

        emit WithdrawalExecuted(gameId, owner, asset, amount, recipient, nonce, userCommandHash, shadowBurnRef);
    }

    // ---------------------------------------------------------------------
    // Emergency
    // ---------------------------------------------------------------------

    /// @inheritdoc IDarkBoxBridge
    function emergencyWithdraw(
        bytes32 gameId,
        address owner,
        address asset,
        uint256 amount,
        address recipient,
        bytes32 reason
    ) external onlyAdmin {
        totalWithdrawn[owner][asset] += amount;
        _payout(asset, recipient, amount);
        emit EmergencyWithdrawal(gameId, owner, asset, amount, recipient, reason);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setSigner(address newSigner) external onlyAdmin {
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "admin=0");
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    function setDepositsPaused(bool paused) external onlyAdmin {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setWithdrawalsPaused(bool paused) external onlyAdmin {
        withdrawalsPaused = paused;
        emit WithdrawalsPausedSet(paused);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _payout(address asset, address to, uint256 amount) internal {
        if (asset == NATIVE) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            _safeTransfer(asset, to, amount);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }
}
