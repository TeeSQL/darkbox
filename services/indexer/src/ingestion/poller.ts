import {
  createPublicClient,
  http,
  decodeEventLog,
  type Log,
  type PublicClient,
  type Abi,
} from "viem";
import { config } from "../config.js";
import { withTransaction } from "../db.js";
import { storeEvent, updateCursor, getCursor } from "./processor.js";
import {
  bridgeAbi,
  shadowBridgeAbi,
  frontierBookAbi,
  pmFactoryAbi,
  pmMarketAbi,
} from "../adapters/abis.js";
import type { AdapterName, NormalizedEvent } from "../adapters/types.js";
import {
  applyBridgeEvent,
  applyShadowBridgeEvent,
} from "../reducers/bridge.js";
import {
  applyFrontierEvent,
  registerFrontierBook,
} from "../reducers/frontier.js";
import { applyPmFactoryEvent, applyPmMarketEvent } from "../reducers/pm.js";

interface WatchedContract {
  adapter: AdapterName;
  chainId: number;
  address: `0x${string}`;
  abi: Abi;
}

let client: PublicClient | null = null;
let frontierBookAddresses: Set<string> = new Set();
let pmMarketAddresses: Set<string> = new Set();

function getClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      transport: http(config.hiddenRpcUrl),
    });
  }
  return client;
}

async function fetchBlockTimestamp(blockNumber: bigint): Promise<bigint> {
  try {
    const block = await getClient().getBlock({ blockNumber });
    return block.timestamp;
  } catch {
    return 0n;
  }
}

async function processLogs(
  watchedContract: WatchedContract,
  logs: Log[],
): Promise<void> {
  if (logs.length === 0) return;

  await withTransaction(async (txClient) => {
    for (const log of logs) {
      if (!log.blockNumber || !log.transactionHash || log.logIndex == null) continue;

      let decoded: Record<string, unknown>;
      let eventName: string;
      try {
        const result = decodeEventLog({
          abi: watchedContract.abi,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        eventName = result.eventName as unknown as string;
        decoded = result.args as unknown as Record<string, unknown>;
      } catch {
        continue;
      }

      const blockTs = await fetchBlockTimestamp(log.blockNumber);

      const event: NormalizedEvent = {
        chainId: watchedContract.chainId,
        blockNumber: log.blockNumber,
        blockTimestamp: blockTs,
        txHash: log.transactionHash as `0x${string}`,
        logIndex: log.logIndex,
        contractAddress: log.address as `0x${string}`,
        adapter: watchedContract.adapter,
        eventName,
        decoded,
      };

      const rowId = await storeEvent(txClient, event);
      if (rowId === null) continue; // already processed

      switch (watchedContract.adapter) {
        case "bridge":
          await applyBridgeEvent(txClient, event as NormalizedEvent<Record<string, unknown>>);
          break;
        case "shadow_bridge":
          await applyShadowBridgeEvent(txClient, event as NormalizedEvent<Record<string, unknown>>);
          break;
        case "frontier":
          await applyFrontierEvent(txClient, event as NormalizedEvent<Record<string, unknown>>);
          break;
        case "pm_factory":
          await applyPmFactoryEvent(txClient, event as NormalizedEvent<Record<string, unknown>>);
          break;
        case "pm_market":
          await applyPmMarketEvent(txClient, event as NormalizedEvent<Record<string, unknown>>);
          break;
      }
    }

    if (logs.length > 0) {
      const lastBlock = logs.reduce(
        (max, l) => (l.blockNumber && l.blockNumber > max ? l.blockNumber : max),
        0n,
      );
      if (lastBlock > 0n) {
        await updateCursor(
          txClient,
          watchedContract.adapter,
          watchedContract.chainId,
          watchedContract.address,
          lastBlock,
        );
      }
    }
  });
}

async function pollContract(watched: WatchedContract): Promise<void> {
  const rpcClient = getClient();
  const fromBlock = (await getCursor(watched.adapter, watched.chainId, watched.address)) + 1n;
  let toBlock: bigint;
  try {
    toBlock = await rpcClient.getBlockNumber();
  } catch {
    return; // node not yet available
  }

  if (fromBlock > toBlock) return;

  const batchSize = BigInt(config.pollBatchSize);
  let current = fromBlock;
  while (current <= toBlock) {
    const end = current + batchSize - 1n < toBlock ? current + batchSize - 1n : toBlock;
    try {
      const logs = await rpcClient.getLogs({
        address: watched.address,
        fromBlock: current,
        toBlock: end,
      });
      await processLogs(watched, logs);
    } catch (err) {
      console.error(`[indexer] poll failed adapter=${watched.adapter} address=${watched.address} from=${current} to=${end}`, err);
    }
    current = end + 1n;
  }
}

export function registerDynamicFrontierBook(address: string): void {
  frontierBookAddresses.add(address.toLowerCase());
}

export function registerDynamicPmMarket(address: string): void {
  pmMarketAddresses.add(address.toLowerCase());
}

export async function runPollCycle(): Promise<void> {
  const staticContracts: WatchedContract[] = [
    {
      adapter: "bridge",
      chainId: config.publicChainId,
      address: config.bridgeAddress,
      abi: bridgeAbi as Abi,
    },
    {
      adapter: "shadow_bridge",
      chainId: config.hiddenChainId,
      address: config.shadowBridgeControllerAddress,
      abi: shadowBridgeAbi as Abi,
    },
    {
      adapter: "pm_factory",
      chainId: config.hiddenChainId,
      address: config.marketFactoryAddress,
      abi: pmFactoryAbi as Abi,
    },
  ];

  const dynamicContracts: WatchedContract[] = [
    ...[...frontierBookAddresses].map(
      (addr) =>
        ({
          adapter: "frontier" as AdapterName,
          chainId: config.hiddenChainId,
          address: addr as `0x${string}`,
          abi: frontierBookAbi as Abi,
        }) satisfies WatchedContract,
    ),
    ...[...pmMarketAddresses].map(
      (addr) =>
        ({
          adapter: "pm_market" as AdapterName,
          chainId: config.hiddenChainId,
          address: addr as `0x${string}`,
          abi: pmMarketAbi as Abi,
        }) satisfies WatchedContract,
    ),
  ];

  for (const watched of [...staticContracts, ...dynamicContracts]) {
    await pollContract(watched);
  }
}

export async function loadDynamicContractsFromDb(): Promise<void> {
  const { query: dbQuery } = await import("../db.js");
  const books = await dbQuery<{ yes_book: string; no_book: string }>(
    "SELECT yes_book, no_book FROM markets WHERE yes_book IS NOT NULL AND no_book IS NOT NULL",
  );
  for (const row of books.rows) {
    if (row.yes_book) frontierBookAddresses.add(row.yes_book.toLowerCase());
    if (row.no_book) frontierBookAddresses.add(row.no_book.toLowerCase());
  }

  const markets = await dbQuery<{ market_address: string }>(
    "SELECT market_address FROM markets",
  );
  for (const row of markets.rows) {
    if (row.market_address) pmMarketAddresses.add(row.market_address.toLowerCase());
  }
}
