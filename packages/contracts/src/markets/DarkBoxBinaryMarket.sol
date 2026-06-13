// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../lib/ERC20.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {Outcome, MarketStatus, ResolverConfig, ResolverType} from "./MarketTypes.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title DarkBoxBinaryMarket
/// @notice Per-market collateral vault + split/join/redeem controller for one
///         binary YES/NO prediction market (market spec §3.2/§6). Deploys its
///         own YES and NO `OutcomeToken`s. Lifecycle transitions are driven by
///         the `DarkBoxMarketFactory` (which enforces role checks); users call
///         `split`/`join`/`redeem` directly.
/// @dev Collateral is hidden-chain synthetic USDC (6 decimals). Outcome tokens
///      mirror collateral decimals so all conversions are exactly 1:1.
contract DarkBoxBinaryMarket {
    // --- identity / wiring ---
    address public immutable factory;
    bytes32 public immutable marketId;
    address public immutable collateralToken;
    OutcomeToken public immutable yes;
    OutcomeToken public immutable no;

    // --- resolver config (immutable after construction; market spec §8 lifecycle) ---
    ResolverType public immutable resolverType;
    address public immutable resolver;
    bytes32 public immutable resolverSourceId;

    // --- lifecycle state ---
    MarketStatus public status;
    Outcome public resolvedOutcome;
    bytes32 public resolutionHash;
    uint64 public immutable closeTime;
    uint64 public immutable resolveBy;

    // --- events (market spec §9) ---
    event MarketActivated(bytes32 indexed marketId);
    event MarketPaused(bytes32 indexed marketId, string reason);
    event MarketResumed(bytes32 indexed marketId);
    event MarketClosed(bytes32 indexed marketId);
    event MarketResolved(bytes32 indexed marketId, Outcome outcome, bytes32 resolutionHash);
    event MarketVoided(bytes32 indexed marketId, string reason, bytes32 evidenceHash);

    event Split(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount);
    event Joined(bytes32 indexed marketId, address indexed caller, address indexed receiver, uint256 amount);
    event Redeemed(
        bytes32 indexed marketId, address indexed caller, address indexed receiver, Outcome outcome, uint256 amount
    );

    error NotFactory();
    error BadStatus();
    error ZeroAmount();
    error ZeroReceiver();
    error BadOutcome();
    error TransferFailed();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(
        bytes32 _marketId,
        address _collateralToken,
        ResolverConfig memory _resolver,
        uint64 _closeTime,
        uint64 _resolveBy,
        string memory yesName,
        string memory yesSymbol,
        string memory noName,
        string memory noSymbol
    ) {
        factory = msg.sender;
        marketId = _marketId;
        collateralToken = _collateralToken;
        resolverType = _resolver.resolverType;
        resolver = _resolver.resolver;
        resolverSourceId = _resolver.sourceId;
        closeTime = _closeTime;
        resolveBy = _resolveBy;

        uint8 dec = IERC20Min(_collateralToken).decimals();
        yes = new OutcomeToken(yesName, yesSymbol, dec, _marketId);
        no = new OutcomeToken(noName, noSymbol, dec, _marketId);

        status = MarketStatus.Active; // Draft collapsed into Active (spec §4)
        resolvedOutcome = Outcome.Unset;
        emit MarketActivated(_marketId);
    }

    // ---------------------------------------------------------------------
    // Views required by IDarkBoxBinaryMarket
    // ---------------------------------------------------------------------

    function yesToken() external view returns (address) {
        return address(yes);
    }

    function noToken() external view returns (address) {
        return address(no);
    }

    /// @notice Collateral currently custodied by this vault.
    function vaultCollateral() public view returns (uint256) {
        return IERC20Min(collateralToken).balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Split / Join / Redeem (market spec §6)
    // ---------------------------------------------------------------------

    /// @notice Lock `amount` collateral, mint `amount` YES + `amount` NO to `receiver`.
    function split(uint256 amount, address receiver) external returns (uint256 yesAmount, uint256 noAmount) {
        if (status != MarketStatus.Active) revert BadStatus();
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();

        _pull(msg.sender, amount);
        yes.mint(receiver, amount);
        no.mint(receiver, amount);

        emit Split(marketId, msg.sender, receiver, amount);
        return (amount, amount);
    }

    /// @notice Burn `amount` YES + `amount` NO from caller, release `amount` collateral.
    /// @dev Allowed while Active or Closed-but-unresolved (spec §6.2).
    function join(uint256 amount, address receiver) external returns (uint256 collateralReturned) {
        return _join(msg.sender, amount, receiver);
    }

    function _join(address caller, uint256 amount, address receiver) internal returns (uint256) {
        if (status != MarketStatus.Active && status != MarketStatus.Closed) revert BadStatus();
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();

        yes.burn(caller, amount);
        no.burn(caller, amount);
        _push(receiver, amount);

        emit Joined(marketId, caller, receiver, amount);
        return amount;
    }

    /// @notice After resolution burn winning tokens 1:1; after void burn either
    ///         side at 0.5 collateral per token (spec §6.3/§6.4 "cleaner MVP").
    function redeem(Outcome outcome, uint256 amount, address receiver)
        external
        returns (uint256 collateralReturned)
    {
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (outcome != Outcome.Yes && outcome != Outcome.No) revert BadOutcome();

        if (status == MarketStatus.Resolved) {
            if (outcome != resolvedOutcome) revert BadOutcome();
            _burnOutcome(outcome, msg.sender, amount);
            collateralReturned = amount;
        } else if (status == MarketStatus.Voided) {
            _burnOutcome(outcome, msg.sender, amount);
            collateralReturned = amount / 2; // each full token worth 0.5 (Invalid)
        } else {
            revert BadStatus();
        }

        if (collateralReturned > 0) _push(receiver, collateralReturned);
        emit Redeemed(marketId, msg.sender, receiver, outcome, amount);
    }

    /// @notice `merge` alias for `join` (spec §2 terminology note).
    function merge(uint256 amount, address receiver) external returns (uint256) {
        return _join(msg.sender, amount, receiver);
    }

    // ---------------------------------------------------------------------
    // Lifecycle (factory-gated; factory enforces role authorization)
    // ---------------------------------------------------------------------

    function pause(string calldata reason) external onlyFactory {
        if (status != MarketStatus.Active) revert BadStatus();
        status = MarketStatus.Paused;
        emit MarketPaused(marketId, reason);
    }

    function resume() external onlyFactory {
        if (status != MarketStatus.Paused) revert BadStatus();
        status = MarketStatus.Active;
        emit MarketResumed(marketId);
    }

    function close() external onlyFactory {
        if (status != MarketStatus.Active && status != MarketStatus.Paused) revert BadStatus();
        status = MarketStatus.Closed;
        emit MarketClosed(marketId);
    }

    function resolve(Outcome outcome, bytes32 _resolutionHash) external onlyFactory {
        if (status == MarketStatus.Resolved || status == MarketStatus.Voided) revert BadStatus();
        if (outcome != Outcome.Yes && outcome != Outcome.No) revert BadOutcome();
        status = MarketStatus.Resolved;
        resolvedOutcome = outcome;
        resolutionHash = _resolutionHash;
        emit MarketResolved(marketId, outcome, _resolutionHash);
    }

    function voidMarket(string calldata reason, bytes32 evidenceHash) external onlyFactory {
        if (status == MarketStatus.Resolved || status == MarketStatus.Voided) revert BadStatus();
        status = MarketStatus.Voided;
        resolvedOutcome = Outcome.Invalid;
        emit MarketVoided(marketId, reason, evidenceHash);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _burnOutcome(Outcome outcome, address from, uint256 amount) internal {
        if (outcome == Outcome.Yes) {
            yes.burn(from, amount);
        } else {
            no.burn(from, amount);
        }
    }

    function _pull(address from, uint256 amount) internal {
        bool ok = IERC20Min(collateralToken).transferFrom(from, address(this), amount);
        if (!ok) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        bool ok = IERC20Min(collateralToken).transfer(to, amount);
        if (!ok) revert TransferFailed();
    }
}
