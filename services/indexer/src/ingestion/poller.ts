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
      transport: http(config.hiddenRpcUrl, {
        // Bound each request so a dropped/half-open geth socket REJECTS (and we
        // retry from the cursor) instead of hanging the await forever.
        timeout: config.rpcTimeoutMs,
        // The scan loop owns retry/backoff/reconnect, so disable viem's own
        // per-call retry to keep failure handling in one place.
        retryCount: 0,
      }),
    });
  }
  return client;
}

/**
 * Drop the cached viem client so the next getClient() rebuilds the transport.
 * Called after a network/socket error so a dead keep-alive socket is replaced by
 * a fresh connection rather than reused.
 */
function resetClient(): void {
  client = null;
}

/**
 * Collaborators the scan loop depends on. Defaults wire to the real viem client
 * and DB-backed cursor/log processing; tests inject fakes to exercise the
 * RPC-error resilience path without a live geth or Postgres.
 */
export interface ScanIo {
  getClient: () => PublicClient;
  resetClient: () => void;
  getCursor: (
    adapter: AdapterName,
    chainId: number,
    address: `0x${string}`,
  ) => Promise<bigint>;
  processLogs: (watched: WatchedContract, logs: Log[]) => Promise<void>;
}

const realIo: ScanIo = {
  getClient,
  resetClient,
  getCursor,
  processLogs,
};

async function fetchBlockTimestamp(blockNumber: bigint): Promise<bigint> {
  try {
    const block = await getClient().getBlock({ blockNumber });
    return block.timestamp;
  } catch {
    return 0n;
  }
}

async function fetchTransactionSender(
  txHash: `0x${string}`,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = txHash.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const tx = await getClient().getTransaction({ hash: txHash });
    const from = tx.from?.toLowerCase() ?? null;
    cache.set(key, from);
    return from;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function processLogs(
  watchedContract: WatchedContract,
  logs: Log[],
): Promise<void> {
  if (logs.length === 0) return;

  const txFromCache = new Map<string, string | null>();
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
      const txFrom = await fetchTransactionSender(log.transactionHash as `0x${string}`, txFromCache);

      const event: NormalizedEvent = {
        chainId: watchedContract.chainId,
        blockNumber: log.blockNumber,
        blockTimestamp: blockTs,
        txHash: log.transactionHash as `0x${string}`,
        txFrom: txFrom ?? undefined,
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

/**
 * Polls a single watched contract for new logs and advances its cursor.
 *
 * RESILIENCE: every RPC call (getBlockNumber / getLogs) is wrapped. On a
 * network/socket/RPC error we log a structured warning, refresh the viem client
 * (so a dropped keep-alive socket reconnects), and STOP this contract's scan
 * WITHOUT advancing past the failed range — the cursor only moves when a batch is
 * persisted, so the next cycle resumes from exactly the same block. We never let
 * an RPC error escape this function (it must not kill the scan loop) and never
 * skip unscanned blocks.
 *
 * Returns true if the scan completed cleanly, false if an RPC error was caught
 * (so the caller can back off before the next cycle).
 */
export async function pollContract(
  watched: WatchedContract,
  io: ScanIo = realIo,
): Promise<boolean> {
  const fromBlock =
    (await io.getCursor(watched.adapter, watched.chainId, watched.address)) + 1n;
  let toBlock: bigint;
  try {
    toBlock = await io.getClient().getBlockNumber();
  } catch (err) {
    console.warn(
      `[indexer] scan rpc error (getBlockNumber) adapter=${watched.adapter} address=${watched.address} cursor=${fromBlock - 1n} — backing off, will resume`,
      describeError(err),
    );
    io.resetClient();
    return false;
  }

  if (fromBlock > toBlock) return true;

  const batchSize = BigInt(config.pollBatchSize);
  let current = fromBlock;
  while (current <= toBlock) {
    const end = current + batchSize - 1n < toBlock ? current + batchSize - 1n : toBlock;
    try {
      const logs = await io.getClient().getLogs({
        address: watched.address,
        fromBlock: current,
        toBlock: end,
      });
      await io.processLogs(watched, logs);
    } catch (err) {
      // Network/socket/RPC drop (e.g. geth restarting): log, refresh the client,
      // and STOP advancing. The cursor stays put, so the next cycle retries this
      // exact range — we must never jump past blocks we failed to scan.
      console.warn(
        `[indexer] scan rpc error (getLogs) adapter=${watched.adapter} address=${watched.address} from=${current} to=${end} — backing off, will resume from cursor`,
        describeError(err),
      );
      io.resetClient();
      return false;
    }
    current = end + 1n;
  }
  return true;
}

/** Compact, log-safe description of an error (avoids dumping raw Socket objects). */
function describeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

/** Only real 20-byte hex addresses are pollable; anything else (e.g. seeded
 * placeholder ids like "v0:book:..." or "0xseed") would make getLogs reject the
 * whole scan cycle with InvalidParams, so we drop them defensively. */
function isHexAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function registerDynamicFrontierBook(address: string): void {
  if (!isHexAddress(address)) return;
  frontierBookAddresses.add(address.toLowerCase());
}

export function registerDynamicPmMarket(address: string): void {
  if (!isHexAddress(address)) return;
  pmMarketAddresses.add(address.toLowerCase());
}

/**
 * One full scan cycle across all watched contracts. Each contract contains its
 * own RPC errors (see {@link pollContract}), so one geth blip never aborts the
 * cycle or kills the loop. Returns false if any contract hit an RPC error this
 * cycle, so the supervisor can apply backoff before the next pass.
 */
export async function runPollCycle(): Promise<boolean> {
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

  let allOk = true;
  for (const watched of [...staticContracts, ...dynamicContracts]) {
    const ok = await pollContract(watched);
    if (!ok) allOk = false;
  }
  return allOk;
}

export async function loadDynamicContractsFromDb(): Promise<void> {
  const { query: dbQuery } = await import("../db.js");
  const books = await dbQuery<{ yes_book: string; no_book: string }>(
    "SELECT yes_book, no_book FROM markets WHERE yes_book IS NOT NULL AND no_book IS NOT NULL",
  );
  for (const row of books.rows) {
    if (row.yes_book) registerDynamicFrontierBook(row.yes_book);
    if (row.no_book) registerDynamicFrontierBook(row.no_book);
  }

  const markets = await dbQuery<{ market_address: string }>(
    "SELECT market_address FROM markets",
  );
  for (const row of markets.rows) {
    if (row.market_address) registerDynamicPmMarket(row.market_address);
  }
}
