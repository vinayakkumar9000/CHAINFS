"use strict";

const crypto = require("crypto");
const { ethers } = require("ethers");

/**
 * Default configuration constants.
 */
const BATCH_SIZE = 2_000;   // blocks per RPC batch
const SAFE_WINDOW = 5;      // don't sync the latest N blocks (reorg protection)
const MAX_CONCURRENT = 5;   // maximum parallel batch workers
const MAX_RETRIES = 3;      // RPC retry attempts per batch
const RETRY_BASE_MS = 1_000; // base delay for exponential backoff (ms)

/**
 * SyncEngine
 *
 * Incrementally indexes ChainFS on-chain events into a local DatabaseManager.
 *
 * Design goals
 * ────────────
 * • Incremental  – tracks last_synced_block; never scans from block 0 again.
 * • Batched      – fetches events in BATCH_SIZE-block windows to cap RPC load.
 * • Concurrent   – up to MAX_CONCURRENT batch workers run in parallel.
 * • Reorg-safe   – stays SAFE_WINDOW blocks behind the chain tip.
 * • Idempotent   – INSERT OR IGNORE means re-running a batch is harmless.
 * • Resilient    – RPC failures trigger exponential-backoff retries; a single
 *                  failed batch is logged and skipped rather than aborting sync.
 *
 * Note: the `timestamp` field in `files` is stored as 0 to avoid an extra
 * `getBlock()` RPC call per file event.  Applications that require exact
 * timestamps can fetch them separately using `block_number`.
 *
 * ──────────────
 * FileCreated(fileId, name, size, chunkCount, owner)
 *   → inserted into the `files` table
 *
 * ChunkUploaded(fileId, chunkIndex, data)
 *   → SHA-256(data) computed locally, metadata inserted into `chunks` table
 *   (raw chunk bytes are NOT stored – this DB is for indexing, not retrieval)
 */
class SyncEngine {
  /**
   * @param {object} opts
   * @param {import('ethers').Contract}         opts.contract      - Connected ChainFS contract.
   * @param {import('./db-manager').DatabaseManager} opts.dbManager - Initialised DatabaseManager.
   * @param {number}  [opts.batchSize=2000]     - Blocks per RPC batch.
   * @param {number}  [opts.safeWindow=5]       - Blocks behind chain tip to stay.
   * @param {number}  [opts.maxConcurrent=5]    - Max parallel batch workers.
   */
  constructor({
    contract,
    dbManager,
    batchSize = BATCH_SIZE,
    safeWindow = SAFE_WINDOW,
    maxConcurrent = MAX_CONCURRENT,
  }) {
    this.contract = contract;
    // In ethers v6 a Contract connected with a Wallet has runner.provider;
    // when connected with a Provider directly, runner IS the provider.
    this.provider = contract.runner.provider ?? contract.runner;
    this.dbManager = dbManager;
    this.batchSize = batchSize;
    this.safeWindow = safeWindow;
    this.maxConcurrent = maxConcurrent;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Run an incremental sync up to (chainTip - safeWindow).
   *
   * @param {boolean} [verbose=false]
   * @returns {Promise<void>}
   */
  async sync(verbose = false) {
    const latestBlock = await this.provider.getBlockNumber();
    const safeBlock = Math.max(0, latestBlock - this.safeWindow);

    // Resume from one block after the last successfully synced block.
    const fromBlock = this.dbManager.getLastSyncedBlock() + 1;

    if (fromBlock > safeBlock) {
      if (verbose) {
        console.log(
          `Already up-to-date (safe tip: ${safeBlock}, last synced: ${fromBlock - 1}).`
        );
      }
      return;
    }

    if (verbose) {
      console.log(
        `Syncing blocks ${fromBlock}–${safeBlock} ` +
          `(chain tip: ${latestBlock}, safe window: ${this.safeWindow})`
      );
    }

    // ── Build batch ranges ────────────────────────────────────────────────────
    const batches = [];
    for (let start = fromBlock; start <= safeBlock; start += this.batchSize) {
      batches.push({ start, end: Math.min(start + this.batchSize - 1, safeBlock) });
    }

    if (verbose) {
      console.log(
        `  ${batches.length} batch(es) × up to ${this.batchSize} blocks`
      );
    }

    // ── Process batches with bounded concurrency ──────────────────────────────
    await this._processConcurrently(batches, verbose);

    // ── Commit progress ───────────────────────────────────────────────────────
    this.dbManager.setLastSyncedBlock(safeBlock);

    if (verbose) {
      console.log(`Sync complete. Last synced block: ${safeBlock}.`);
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  /**
   * Process all batches with at most `this.maxConcurrent` workers running at
   * once.  Uses a shared index counter; because JS is single-threaded the
   * `nextIdx++` read-modify-write is atomic between async suspensions.
   *
   * @param {{ start: number, end: number }[]} batches
   * @param {boolean} verbose
   * @returns {Promise<void>}
   */
  async _processConcurrently(batches, verbose) {
    let nextIdx = 0;
    const self = this;

    async function worker() {
      while (nextIdx < batches.length) {
        const batch = batches[nextIdx++];
        await self._processBatch(batch, verbose);
      }
    }

    const workerCount = Math.min(this.maxConcurrent, batches.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  /**
   * Fetch and process all ChainFS events in [start, end].
   *
   * Both event types are fetched in a single parallel RPC round-trip.
   * On RPC failure the batch is retried with exponential backoff; if all
   * retries are exhausted the batch is skipped (logged) so other batches
   * can still proceed.
   *
   * @param {{ start: number, end: number }} batch
   * @param {boolean} verbose
   * @returns {Promise<void>}
   */
  async _processBatch({ start, end }, verbose) {
    if (verbose) {
      console.log(`  batch ${start}–${end}`);
    }

    let fileLogs, chunkLogs;

    try {
      [fileLogs, chunkLogs] = await this._withRetry(() =>
        Promise.all([
          this.contract.queryFilter(
            this.contract.filters.FileCreated(),
            start,
            end
          ),
          this.contract.queryFilter(
            this.contract.filters.ChunkUploaded(),
            start,
            end
          ),
        ])
      );
    } catch (err) {
      console.error(
        `  [SyncEngine] batch ${start}–${end} failed after ${MAX_RETRIES} retries: ${err.message}`
      );
      return; // skip – other batches will still run
    }

    if (verbose && (fileLogs.length || chunkLogs.length)) {
      console.log(
        `    FileCreated=${fileLogs.length}  ChunkUploaded=${chunkLogs.length}`
      );
    }

    for (const log of fileLogs) {
      try {
        this._processFileCreated(log);
      } catch (err) {
        console.error(
          `  [SyncEngine] skipping malformed FileCreated log ` +
            `(tx ${log.transactionHash}): ${err.message}`
        );
      }
    }

    for (const log of chunkLogs) {
      try {
        this._processChunkUploaded(log);
      } catch (err) {
        console.error(
          `  [SyncEngine] skipping malformed ChunkUploaded log ` +
            `(tx ${log.transactionHash}): ${err.message}`
        );
      }
    }
  }

  /**
   * Decode a FileCreated log and insert the metadata into the `files` table.
   *
   * In ChainFS fileId = 0x + SHA-256(original bytes), so it doubles as the
   * content_hash field.
   *
   * @param {import('ethers').EventLog} log
   */
  _processFileCreated(log) {
    const { fileId, name, size, chunkCount, owner } = log.args;

    this.dbManager.insertFile({
      fileId,
      owner,
      name,
      mimeType: null,
      originalSize: Number(size),
      compressedSize: null,      // not available from the event
      contentHash: fileId,       // fileId IS the SHA-256 content hash
      totalChunks: Number(chunkCount),
      timestamp: 0,              // avoids an extra getBlock() RPC call
      blockNumber: log.blockNumber,
    });
  }

  /**
   * Decode a ChunkUploaded log, compute SHA-256(data), and insert chunk
   * metadata into the `chunks` table.
   *
   * Raw bytes are NOT stored – only the hash for integrity verification.
   *
   * @param {import('ethers').EventLog} log
   */
  _processChunkUploaded(log) {
    const { fileId, chunkIndex, data } = log.args;
    const rawData = Buffer.from(ethers.getBytes(data));
    const chunkHash = crypto
      .createHash("sha256")
      .update(rawData)
      .digest("hex");

    this.dbManager.insertChunk({
      fileId,
      chunkIndex: Number(chunkIndex),
      chunkHash,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index,
    });
  }

  /**
   * Call `fn` up to `maxRetries` times with exponential back-off.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {number} [maxRetries]
   * @param {number} [baseDelayMs]
   * @returns {Promise<T>}
   */
  async _withRetry(fn, maxRetries = MAX_RETRIES, baseDelayMs = RETRY_BASE_MS) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          // Exponential back-off: 1 s, 2 s, 4 s, …
          await new Promise((r) =>
            setTimeout(r, baseDelayMs * 2 ** (attempt - 1))
          );
        }
      }
    }
    throw lastErr;
  }
}

module.exports = {
  SyncEngine,
  BATCH_SIZE,
  SAFE_WINDOW,
  MAX_CONCURRENT,
};
