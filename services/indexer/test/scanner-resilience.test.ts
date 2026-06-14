import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Log, PublicClient } from "viem";
import { pollContract, type ScanIo } from "../src/ingestion/poller.js";
import type { AdapterName } from "../src/adapters/types.js";

const WATCHED = {
  adapter: "pm_factory" as AdapterName,
  chainId: 1337,
  address: "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
  abi: [],
};

/** A socket-drop error of the shape geth produces when its RPC connection dies. */
function socketDropError(): Error {
  const err = new Error("socket hang up");
  err.name = "SocketError";
  return err;
}

function makeLog(blockNumber: bigint): Log {
  return {
    blockNumber,
    transactionHash: "0xabc",
    logIndex: 0,
    address: WATCHED.address,
    data: "0x",
    topics: [],
  } as unknown as Log;
}

/**
 * Builds a ScanIo backed by an in-memory cursor that advances exactly like the
 * real processLogs (cursor → max block seen). Lets us assert resume behavior
 * without a live geth or Postgres.
 */
function makeIo(
  cursor: { value: bigint },
  client: PublicClient,
  counters: { resetClient: number },
): ScanIo {
  return {
    getClient: () => client,
    resetClient: () => {
      counters.resetClient += 1;
    },
    getCursor: async () => cursor.value,
    processLogs: async (_watched, logs) => {
      for (const log of logs) {
        if (log.blockNumber && log.blockNumber > cursor.value) {
          cursor.value = log.blockNumber;
        }
      }
    },
  };
}

describe("scanner resilience — survives geth RPC drops", () => {
  it("catches a socket error mid-scan, does not throw, refreshes the client, and resumes from the SAME cursor on retry", async () => {
    const cursor = { value: 35n }; // mirrors the live incident: cursor stuck at 35
    const counters = { resetClient: 0 };
    let getLogsCalls = 0;

    const client = {
      getBlockNumber: async () => 40n,
      getLogs: async () => {
        getLogsCalls += 1;
        if (getLogsCalls === 1) throw socketDropError(); // geth RPC drops mid-scan
        return [makeLog(40n)]; // RPC back: scan blocks up to head
      },
    } as unknown as PublicClient;

    const io = makeIo(cursor, client, counters);

    // First cycle: RPC drops. Must NOT throw, must NOT advance the cursor.
    let firstOk: boolean | undefined;
    await assert.doesNotReject(async () => {
      firstOk = await pollContract(WATCHED, io);
    });
    assert.equal(firstOk, false, "cycle reports the RPC failure");
    assert.equal(cursor.value, 35n, "cursor must NOT advance past unscanned blocks");
    assert.ok(counters.resetClient >= 1, "client is refreshed so the dead socket reconnects");

    // Second cycle: RPC back. Resumes from cursor 35 and advances to head.
    const secondOk = await pollContract(WATCHED, io);
    assert.equal(secondOk, true, "cycle succeeds once RPC recovers");
    assert.equal(cursor.value, 40n, "cursor advances to chain head on retry");
  });

  it("stops at the failed batch instead of skipping unscanned blocks", async () => {
    // Head far ahead with the default batch size (100) → batches 1-100, 101-200, 201-250.
    const cursor = { value: 0n };
    const counters = { resetClient: 0 };
    const seenRanges: bigint[] = [];

    const client = {
      getBlockNumber: async () => 250n,
      getLogs: async (args: { toBlock: bigint }) => {
        seenRanges.push(args.toBlock);
        if (args.toBlock === 200n) throw socketDropError(); // second batch fails
        return [makeLog(args.toBlock)]; // advance cursor to end of batch
      },
    } as unknown as PublicClient;

    const io = makeIo(cursor, client, counters);

    const ok = await pollContract(WATCHED, io);

    assert.equal(ok, false, "reports failure");
    assert.deepEqual(seenRanges, [100n, 200n], "stops after the failing batch — does NOT scan 201-250");
    assert.equal(cursor.value, 100n, "cursor stays at the last fully-scanned block; never skips 101-200");
  });
});
