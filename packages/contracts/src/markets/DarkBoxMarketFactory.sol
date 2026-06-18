// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DarkBoxBinaryMarket} from "./DarkBoxBinaryMarket.sol";
import {Outcome, MarketStatus, ResolverType, ResolverConfig, CreateMarketParams} from "./MarketTypes.sol";
import {IFrontierGeoBookFactory} from "../interfaces/IFrontier.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

/// @title DarkBoxMarketFactory
/// @notice Creates and tracks DarkBox binary prediction markets, enforces
///         creation rules, automatically registers Frontier books for the
///         YES/sUSDC and NO/sUSDC pairs, and drives lifecycle transitions under
///         role authorization (market spec §3.1).
/// @dev Market creation is admin/coordinator gated. Public/agent proposals are
///      approved off-chain first, then an admin/coordinator creates the on-chain
///      market and books in one transaction. PM contracts touch Frontier only
///      through `IFrontierGeoBookFactory`.
contract DarkBoxMarketFactory {
    struct MarketInfo {
        address market;
        address creator;
        bytes32 gameId;
        address yesBook;
        address noBook;
        bool booksRegistered;
    }

    // --- roles / config ---
    address public owner; // factory admin
    address public coordinator; // may register Frontier books
    address public immutable collateralToken; // synthetic USDC
    IFrontierGeoBookFactory public frontierFactory; // real Frontier geo factory
    address public feeRecipient; // Frontier fee recipient for new books
    address public treasury; // destination for slashed bonds

    // creation rules
    uint256 public minCreatorBond = 0; // deprecated/no bond gate; kept for ABI/admin config compatibility
    uint256 public maxMarketsPerCreator = 20;
    uint256 public maxQuestionLen = 256;
    uint64 public creationDeadline; // 0 = no deadline; else markets must be created before

    // Frontier book params applied at registration.
    // tickSpacing = 1 (finest geometric granularity, ~1bp/tick): prediction
    // prices live in a tight (0,1) band and Frontier rounds *partial* taker
    // fills inside a single wide interval down to zero, so fine spacing is
    // required for partial fills to execute. startTick = 0 (price ≈ 1.0
    // reference); makers quote bids below / asks above as price discovers.
    int24 public bookTickSpacing = 1;
    int24 public bookStartTick = 0;
    uint16 public bookMakerFeeBps = 0;
    uint16 public bookTakerFeeBps = 0;

    // --- storage ---
    mapping(bytes32 => MarketInfo) public markets; // marketId => info
    mapping(address => uint256) public marketCountOf; // creator => count
    mapping(bytes32 => bool) public questionHashUsed; // duplicate guard
    bytes32[] public marketIds;

    // --- events (market spec §9) ---
    event MarketCreated(
        bytes32 indexed gameId,
        bytes32 indexed marketId,
        address indexed creator,
        address market,
        string question,
        string metadataURI,
        uint64 closeTime,
        uint64 resolveBy,
        ResolverType resolverType
    );
    event BooksRegistered(
        bytes32 indexed marketId, address indexed yesBook, address indexed noBook, address yesToken, address noToken
    );

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event CoordinatorUpdated(address indexed previousCoordinator, address indexed newCoordinator);
    event FrontierFactoryUpdated(address indexed previousFactory, address indexed newFactory);
    event ConfigUpdated();

    // --- errors ---
    error NotOwner();
    error NotCoordinator();
    error NotResolver();
    error EmptyQuestion();
    error QuestionTooLong();
    error EmptyMetadata();
    error BadTimes();
    error CreationClosed();
    error UnsupportedResolver();
    error TooManyMarkets();
    error DuplicateQuestion();
    error UnknownMarket();
    error BooksAlreadyRegistered();
    error FrontierNotSet();
    error TransferFailed();
    error InvalidBook();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _owner,
        address _coordinator,
        address _collateralToken,
        address _frontierFactory,
        address _feeRecipient,
        address _treasury
    ) {
        require(_owner != address(0) && _collateralToken != address(0), "zero arg");
        owner = _owner;
        coordinator = _coordinator;
        collateralToken = _collateralToken;
        frontierFactory = IFrontierGeoBookFactory(_frontierFactory);
        feeRecipient = _feeRecipient == address(0) ? _owner : _feeRecipient;
        treasury = _treasury == address(0) ? _owner : _treasury;
    }

    // ---------------------------------------------------------------------
    // Market creation
    // ---------------------------------------------------------------------

    function createMarket(CreateMarketParams calldata params) external returns (bytes32 marketId, address market) {
        (marketId, market) = _createMarketShell(params);
        _createBooks(marketId);

        // Optional initial liquidity: pull, then split to the creator.
        if (params.initialLiquidity > 0) {
            _pull(msg.sender, params.initialLiquidity);
            if (!IERC20(collateralToken).approve(market, params.initialLiquidity)) revert TransferFailed();
            DarkBoxBinaryMarket(market).split(params.initialLiquidity, msg.sender);
        }
    }

    /// @notice Arc/testnet-friendly market creation path: deploy only the market
    ///         vault + outcome tokens. Call `createYesBook` and `createNoBook`
    ///         in separate transactions to stay under chains with 30M gas caps.
    function createMarketShell(CreateMarketParams calldata params) external returns (bytes32 marketId, address market) {
        return _createMarketShell(params);
    }

    function _createMarketShell(CreateMarketParams calldata params) internal returns (bytes32 marketId, address market) {
        if (msg.sender != owner && msg.sender != coordinator) revert NotCoordinator();
        _validate(params);
        if (address(frontierFactory) == address(0)) revert FrontierNotSet();

        bytes32 questionHash = computeQuestionHash(
            params.gameId, params.question, ResolverType.AdminManual, params.closeTime, params.metadataURI
        );
        if (questionHashUsed[questionHash]) revert DuplicateQuestion();
        questionHashUsed[questionHash] = true;

        marketId = keccak256(abi.encode(params.gameId, questionHash));
        require(markets[marketId].market == address(0), "marketId exists");

        // Deploy the market vault (which deploys YES + NO outcome tokens).
        // Resolution is deliberately admin-only for the MVP: whatever the caller
        // supplied, the market resolver is pinned to the current factory owner.
        string memory qSym = _shortSymbol(marketId);
        ResolverConfig memory resolver = ResolverConfig({
            resolverType: ResolverType.AdminManual,
            resolver: owner,
            sourceId: params.resolver.sourceId,
            data: params.resolver.data
        });
        DarkBoxBinaryMarket m = new DarkBoxBinaryMarket(
            marketId,
            collateralToken,
            resolver,
            params.closeTime,
            params.resolveBy,
            string.concat("DarkBox YES ", qSym),
            "YES",
            string.concat("DarkBox NO ", qSym),
            "NO"
        );
        market = address(m);

        markets[marketId] = MarketInfo({
            market: market,
            creator: msg.sender,
            gameId: params.gameId,
            yesBook: address(0),
            noBook: address(0),
            booksRegistered: false
        });
        marketIds.push(marketId);
        marketCountOf[msg.sender] += 1;

        emit MarketCreated(
            params.gameId,
            marketId,
            msg.sender,
            market,
            params.question,
            params.metadataURI,
            params.closeTime,
            params.resolveBy,
            ResolverType.AdminManual
        );
    }

    function _validate(CreateMarketParams calldata params) internal view {
        uint256 qlen = bytes(params.question).length;
        if (qlen == 0) revert EmptyQuestion();
        if (qlen > maxQuestionLen) revert QuestionTooLong();
        if (bytes(params.metadataURI).length == 0) revert EmptyMetadata();
        if (params.closeTime <= block.timestamp || params.resolveBy < params.closeTime) revert BadTimes();
        if (creationDeadline != 0 && block.timestamp > creationDeadline) revert CreationClosed();
        // MVP supports exactly one resolution mechanism: DarkBox admin manual resolution.
        if (params.resolver.resolverType != ResolverType.AdminManual) revert UnsupportedResolver();
        // creatorBond is intentionally ignored/deprecated: proposal approval is the gate.
        if (marketCountOf[msg.sender] >= maxMarketsPerCreator) revert TooManyMarkets();
    }

    /// @notice Canonical duplicate guard (market spec §5.2). Off-chain callers
    ///         must normalize casing/spacing of `question` before hashing.
    function computeQuestionHash(
        bytes32 gameId,
        string memory question,
        ResolverType resolverType,
        uint64 closeTime,
        string memory metadataURI
    ) public pure returns (bytes32) {
        // gameId is part of the hash so identical questions in different games do
        // not collide on the global duplicate guard (audit M-1: cross-game DoS).
        return keccak256(abi.encode(gameId, question, resolverType, closeTime, metadataURI));
    }

    // ---------------------------------------------------------------------
    // Frontier book registration (coordinator-gated; spec §7)
    // ---------------------------------------------------------------------

    /// @notice Legacy/recovery hook. Normal market creation calls this automatically.
    /// @dev On 30M-gas-cap chains prefer `createYesBook` then `createNoBook`.
    function createBooks(bytes32 marketId) external returns (address yesBook, address noBook) {
        if (msg.sender != coordinator && msg.sender != owner) revert NotCoordinator();
        return _createBooks(marketId);
    }

    function createYesBook(bytes32 marketId) external returns (address yesBook) {
        if (msg.sender != coordinator && msg.sender != owner) revert NotCoordinator();
        MarketInfo storage info = _bookInfo(marketId);
        if (info.yesBook != address(0)) revert BooksAlreadyRegistered();
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(info.market);
        yesBook = _createFrontierBook(m.yesToken());
        info.yesBook = yesBook;
        _finalizeBooksIfReady(marketId, info, m.yesToken(), m.noToken());
    }

    function createNoBook(bytes32 marketId) external returns (address noBook) {
        if (msg.sender != coordinator && msg.sender != owner) revert NotCoordinator();
        MarketInfo storage info = _bookInfo(marketId);
        if (info.noBook != address(0)) revert BooksAlreadyRegistered();
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(info.market);
        noBook = _createFrontierBook(m.noToken());
        info.noBook = noBook;
        _finalizeBooksIfReady(marketId, info, m.yesToken(), m.noToken());
    }

    function _createBooks(bytes32 marketId) internal returns (address yesBook, address noBook) {
        MarketInfo storage info = _bookInfo(marketId);
        if (info.booksRegistered) revert BooksAlreadyRegistered();
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(info.market);
        address yesTok = m.yesToken();
        address noTok = m.noToken();
        if (info.yesBook == address(0)) info.yesBook = _createFrontierBook(yesTok);
        if (info.noBook == address(0)) info.noBook = _createFrontierBook(noTok);
        _finalizeBooksIfReady(marketId, info, yesTok, noTok);
        return (info.yesBook, info.noBook);
    }

    function _bookInfo(bytes32 marketId) internal view returns (MarketInfo storage info) {
        info = markets[marketId];
        if (info.market == address(0)) revert UnknownMarket();
        if (address(frontierFactory) == address(0)) revert FrontierNotSet();
    }

    function _createFrontierBook(address token0) internal returns (address book) {
        book = frontierFactory.createGeoBookWithFees(
            token0, collateralToken, bookTickSpacing, bookStartTick, feeRecipient, bookMakerFeeBps, bookTakerFeeBps
        );
        if (book == address(0)) revert InvalidBook();
    }

    function _finalizeBooksIfReady(bytes32 marketId, MarketInfo storage info, address yesTok, address noTok) internal {
        if (info.yesBook == address(0) || info.noBook == address(0)) return;
        if (info.yesBook == info.noBook) revert InvalidBook();
        info.booksRegistered = true;
        emit BooksRegistered(marketId, info.yesBook, info.noBook, yesTok, noTok);
    }

    // ---------------------------------------------------------------------
    // Lifecycle (role-gated; market spec §8 "Authorization")
    // ---------------------------------------------------------------------

    function pauseMarket(bytes32 marketId, string calldata reason) external {
        DarkBoxBinaryMarket m = _adminOrResolver(marketId);
        m.pause(reason);
    }

    function resumeMarket(bytes32 marketId) external {
        DarkBoxBinaryMarket m = _adminOrResolver(marketId);
        m.resume();
    }

    function closeMarket(bytes32 marketId) external {
        DarkBoxBinaryMarket m = _adminOrResolver(marketId);
        m.close();
    }

    /// @notice Resolve to YES/NO. Only the market's configured resolver or the
    ///         factory owner may call. Returns the creator bond (clean resolve).
    function resolveMarket(bytes32 marketId, Outcome outcome, bytes32 resolutionHash) external {
        MarketInfo storage info = markets[marketId];
        if (info.market == address(0)) revert UnknownMarket();
        DarkBoxBinaryMarket m = DarkBoxBinaryMarket(info.market);
        if (msg.sender != owner && msg.sender != m.resolver()) revert NotResolver();

        m.resolve(outcome, resolutionHash);
    }

    /// @notice Void a market (admin only). Slashes the creator bond to treasury.
    function voidMarket(bytes32 marketId, string calldata reason, bytes32 evidenceHash) external onlyOwner {
        MarketInfo storage info = markets[marketId];
        if (info.market == address(0)) revert UnknownMarket();
        DarkBoxBinaryMarket(info.market).voidMarket(reason, evidenceHash);
    }

    function _adminOrResolver(bytes32 marketId) internal view returns (DarkBoxBinaryMarket m) {
        MarketInfo storage info = markets[marketId];
        if (info.market == address(0)) revert UnknownMarket();
        m = DarkBoxBinaryMarket(info.market);
        if (msg.sender != owner && msg.sender != m.resolver()) revert NotResolver();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getMarket(bytes32 marketId) external view returns (address market) {
        return markets[marketId].market;
    }

    function getBooks(bytes32 marketId) external view returns (address yesBook, address noBook) {
        MarketInfo storage info = markets[marketId];
        return (info.yesBook, info.noBook);
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    // ---------------------------------------------------------------------
    // Admin config
    // ---------------------------------------------------------------------

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    function setCoordinator(address newCoordinator) external onlyOwner {
        emit CoordinatorUpdated(coordinator, newCoordinator);
        coordinator = newCoordinator;
    }

    function setFrontierFactory(address newFactory) external onlyOwner {
        emit FrontierFactoryUpdated(address(frontierFactory), newFactory);
        frontierFactory = IFrontierGeoBookFactory(newFactory);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        feeRecipient = newRecipient;
        emit ConfigUpdated();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury=0");
        treasury = newTreasury;
        emit ConfigUpdated();
    }

    function setCreationRules(uint256 _minBond, uint256 _maxMarkets, uint256 _maxQuestionLen, uint64 _deadline)
        external
        onlyOwner
    {
        minCreatorBond = _minBond;
        maxMarketsPerCreator = _maxMarkets;
        maxQuestionLen = _maxQuestionLen;
        creationDeadline = _deadline;
        emit ConfigUpdated();
    }

    function setBookParams(int24 _tickSpacing, int24 _startTick, uint16 _makerFeeBps, uint16 _takerFeeBps)
        external
        onlyOwner
    {
        require(_tickSpacing > 0 && _startTick % _tickSpacing == 0, "bad ticks");
        require(_makerFeeBps <= 1000 && _takerFeeBps <= 1000, "fee too high");
        bookTickSpacing = _tickSpacing;
        bookStartTick = _startTick;
        bookMakerFeeBps = _makerFeeBps;
        bookTakerFeeBps = _takerFeeBps;
        emit ConfigUpdated();
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _pull(address from, uint256 amount) internal {
        if (!IERC20(collateralToken).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!IERC20(collateralToken).transfer(to, amount)) revert TransferFailed();
    }

    /// @dev First 4 bytes of the marketId, hex-encoded, for human-readable symbols.
    function _shortSymbol(bytes32 marketId) internal pure returns (string memory) {
        bytes16 hexChars = "0123456789abcdef";
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            uint8 b = uint8(marketId[i]);
            out[i * 2] = hexChars[b >> 4];
            out[i * 2 + 1] = hexChars[b & 0x0f];
        }
        return string(out);
    }
}
