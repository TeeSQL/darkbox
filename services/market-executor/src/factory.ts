import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { booksRegisteredEvent, marketCreatedEvent, marketFactoryAbi } from "./abis.js";

/** Parameters for one on-chain market creation (mirrors CreateMarketParams). */
export interface CreateMarketInput {
  gameId: Hex;
  question: string;
  description: string;
  metadataURI: string;
  resolver: {
    resolverType: number; // 0 = AdminManual
    resolver: Address;
    sourceId: Hex;
    data: Hex;
  };
  closeTime: bigint;
  resolveBy: bigint;
  creatorBond: bigint;
  initialLiquidity: bigint;
}

/** Result of a (newly created OR recovered) market. */
export interface CreatedMarket {
  /** Present only when we actually sent a createMarket tx; null on pure recovery. */
  txHash: Hex | null;
  marketId: Hex;
  marketAddress: Address;
  yesBook: Address;
  noBook: Address;
  yesToken: Address;
  noToken: Address;
}

/**
 * The factory operations the executor depends on. Implemented by the viem-backed
 * `ViemMarketFactoryClient` against the real hidden-chain contract, and by a fake
 * in tests.
 */
export interface FactoryClient {
  /** simulate → write → wait → parse logs (falls back to getBooks on missing BooksRegistered). */
  createMarket(input: CreateMarketInput): Promise<CreatedMarket>;
  /**
   * Crash-recovery lookup: scan MarketCreated logs for `gameId` and match on the
   * exact `question`, returning the prior market (with books) if it exists.
   */
  findExistingMarketByQuestion(gameId: Hex, question: string): Promise<CreatedMarket | null>;
}

export interface ViemFactoryConfig {
  rpcUrl: string;
  chainId: number;
  factoryAddress: Address;
  coordinatorPrivateKey: Hex;
  /** Earliest block to scan for recovery lookups (default 0). */
  fromBlock?: bigint;
}

function chainFor(id: number, rpc: string) {
  return defineChain({
    id,
    name: `hidden-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export class ViemMarketFactoryClient implements FactoryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly factory: Address;
  private readonly fromBlock: bigint;

  /** Coordinator address derived from the key — safe to expose/log (NOT the key). */
  readonly coordinatorAddress: Address;

  constructor(cfg: ViemFactoryConfig) {
    const account = privateKeyToAccount(cfg.coordinatorPrivateKey);
    this.coordinatorAddress = account.address;
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    this.factory = cfg.factoryAddress;
    this.fromBlock = cfg.fromBlock ?? 0n;
  }

  async createMarket(input: CreateMarketInput): Promise<CreatedMarket> {
    const account = this.walletClient.account!;
    const params = {
      gameId: input.gameId,
      question: input.question,
      description: input.description,
      metadataURI: input.metadataURI,
      resolver: {
        resolverType: input.resolver.resolverType,
        resolver: input.resolver.resolver,
        sourceId: input.resolver.sourceId,
        data: input.resolver.data,
      },
      closeTime: input.closeTime,
      resolveBy: input.resolveBy,
      creatorBond: input.creatorBond,
      initialLiquidity: input.initialLiquidity,
    } as const;

    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.factory,
      abi: marketFactoryAbi,
      functionName: "createMarket",
      args: [params],
    });
    const txHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    const created = parseEventLogs({
      abi: marketFactoryAbi,
      eventName: "MarketCreated",
      logs: receipt.logs,
    })[0];
    if (!created) {
      throw new Error(`createMarket: MarketCreated not found in receipt ${txHash}`);
    }
    const marketId = created.args.marketId;
    const marketAddress = created.args.market;

    const books = parseEventLogs({
      abi: marketFactoryAbi,
      eventName: "BooksRegistered",
      logs: receipt.logs,
    }).find((l) => l.args.marketId === marketId);

    let yesBook: Address;
    let noBook: Address;
    let yesToken: Address;
    let noToken: Address;
    if (books) {
      yesBook = books.args.yesBook;
      noBook = books.args.noBook;
      yesToken = books.args.yesToken;
      noToken = books.args.noToken;
    } else {
      // Fallback: BooksRegistered missing from this receipt — read getBooks.
      // Tokens aren't exposed by getBooks, so leave them zeroed.
      [yesBook, noBook] = await this.readBooks(marketId);
      yesToken = zeroAddress;
      noToken = zeroAddress;
    }

    return { txHash, marketId, marketAddress, yesBook, noBook, yesToken, noToken };
  }

  async findExistingMarketByQuestion(
    gameId: Hex,
    question: string,
  ): Promise<CreatedMarket | null> {
    const createdLogs = await this.publicClient.getLogs({
      address: this.factory,
      event: marketCreatedEvent,
      args: { gameId },
      fromBlock: this.fromBlock,
      toBlock: "latest",
    });
    const match = createdLogs.find((l) => l.args.question === question);
    if (!match || !match.args.marketId || !match.args.market) return null;

    const marketId = match.args.marketId;
    const marketAddress = match.args.market;

    // Recover the books for this market: prefer the BooksRegistered log, fall
    // back to the on-chain getBooks view.
    const bookLogs = await this.publicClient.getLogs({
      address: this.factory,
      event: booksRegisteredEvent,
      args: { marketId },
      fromBlock: this.fromBlock,
      toBlock: "latest",
    });
    const bookLog = bookLogs[0];
    let yesBook: Address;
    let noBook: Address;
    let yesToken: Address = zeroAddress;
    let noToken: Address = zeroAddress;
    if (bookLog) {
      yesBook = bookLog.args.yesBook!;
      noBook = bookLog.args.noBook!;
      yesToken = bookLog.args.yesToken!;
      noToken = bookLog.args.noToken!;
    } else {
      [yesBook, noBook] = await this.readBooks(marketId);
    }

    return { txHash: null, marketId, marketAddress, yesBook, noBook, yesToken, noToken };
  }

  private async readBooks(marketId: Hex): Promise<[Address, Address]> {
    const [yesBook, noBook] = await this.publicClient.readContract({
      address: this.factory,
      abi: marketFactoryAbi,
      functionName: "getBooks",
      args: [marketId],
    });
    return [yesBook, noBook];
  }
}
