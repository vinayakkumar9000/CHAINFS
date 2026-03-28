"use strict";

/**
 * downloader-bot.js
 *
 * Fetches ChunkUploaded event logs from the chain, reconstructs the original
 * file, verifies its SHA-256 hash, and writes it to disk.
 *
 * Pipeline:  fetch logs → reconstruct → verify
 */

const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const { ethers } = require("ethers");

const db = require("./db");
const { deriveFileId } = require("./storage-bot");

/**
 * Decompress a gzip-compressed Buffer.
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function decompress(buf) {
  return zlib.gunzipSync(buf);
}

/**
 * Verify that the SHA-256 hash of `content` matches `expectedFileId`.
 *
 * @param {Buffer} content     Decompressed file content.
 * @param {string} expectedFileId  0x-prefixed hex string.
 * @returns {boolean}
 */
function verify(content, expectedFileId) {
  const actual = deriveFileId(content);
  return actual.toLowerCase() === expectedFileId.toLowerCase();
}

/**
 * Fetch all ChunkUploaded logs for a given fileId from the chain,
 * store any missing chunks in the local DB, then return the ordered list.
 *
 * @param {object} opts
 * @param {import('ethers').Contract}         opts.contract
 * @param {import('node:sqlite').DatabaseSync} opts.database
 * @param {string}  opts.fileId
 * @param {number}  [opts.fromBlock]  Start of log range (default 0).
 * @param {boolean} [opts.verbose]
 * @returns {Promise<Buffer[]>} Chunk buffers ordered by chunkIndex.
 */
async function fetchChunks({ contract, database, fileId, fromBlock = 0, verbose }) {
  if (verbose) {
    console.log(`Fetching logs for fileId ${fileId} from block ${fromBlock}…`);
  }

  const filter = contract.filters.ChunkUploaded(fileId);
  const logs = await contract.queryFilter(filter, fromBlock);

  if (verbose) {
    console.log(`  found ${logs.length} log(s)`);
  }

  for (const log of logs) {
    const { chunkIndex, data } = log.args;
    const chunkData = Buffer.from(
      ethers.getBytes(data)
    );

    db.insertChunk(database, {
      fileId,
      chunkIndex: Number(chunkIndex),
      data: chunkData,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  // Return chunks from DB (covers both freshly fetched and already-cached).
  const rows = db.getChunks(database, fileId);
  return rows.map((r) => Buffer.from(r.data));
}

/**
 * Full download pipeline: fetch logs → reconstruct → verify → write to disk.
 *
 * @param {object} opts
 * @param {string}  opts.fileId        bytes32 hex string.
 * @param {string}  opts.outputPath    Where to write the reconstructed file.
 * @param {import('ethers').Contract}         opts.contract
 * @param {import('node:sqlite').DatabaseSync} opts.database
 * @param {number}  [opts.fromBlock]
 * @param {boolean} [opts.verbose]
 * @returns {Promise<void>}
 */
async function download({ fileId, outputPath, contract, database, fromBlock = 0, verbose }) {
  // ── 1. Fetch logs ─────────────────────────────────────────────────────────
  const chunkBuffers = await fetchChunks({
    contract,
    database,
    fileId,
    fromBlock,
    verbose,
  });

  if (chunkBuffers.length === 0) {
    throw new Error(`No chunks found for fileId ${fileId}`);
  }

  // ── 2. Reconstruct ────────────────────────────────────────────────────────
  const compressed = Buffer.concat(chunkBuffers);

  if (verbose) {
    console.log(`  compressed size: ${compressed.length} bytes`);
  }

  const content = decompress(compressed);

  if (verbose) {
    console.log(`  decompressed size: ${content.length} bytes`);
  }

  // ── 3. Verify ─────────────────────────────────────────────────────────────
  if (!verify(content, fileId)) {
    throw new Error(
      `Integrity check failed for fileId ${fileId}. ` +
        "The reconstructed file does not match the expected hash."
    );
  }

  if (verbose) {
    console.log("  integrity check: OK");
  }

  // ── 4. Write to disk ──────────────────────────────────────────────────────
  fs.writeFileSync(outputPath, content);

  if (verbose) {
    console.log(`  written to ${outputPath}`);
  }
}

/**
 * Sync all files known to the local DB from the chain.
 * Updates sync_state with the latest block number processed.
 *
 * @param {object} opts
 * @param {import('ethers').Contract}         opts.contract
 * @param {import('node:sqlite').DatabaseSync} opts.database
 * @param {boolean} [opts.verbose]
 */
async function sync({ contract, database, verbose }) {
  const lastSyncedBlock = Number(
    db.getSyncState(database, "last_synced_block") || "0"
  );

  if (verbose) {
    console.log(`Syncing from block ${lastSyncedBlock}…`);
  }

  // Fetch all FileCreated events.
  const fileFilter = contract.filters.FileCreated();
  const fileLogs = await contract.queryFilter(fileFilter, lastSyncedBlock);

  if (verbose) {
    console.log(`  found ${fileLogs.length} FileCreated event(s)`);
  }

  for (const log of fileLogs) {
    const { fileId, name, size, chunkCount, owner } = log.args;
    db.insertFile(database, {
      fileId,
      name,
      size: Number(size),
      chunkCount: Number(chunkCount),
      owner,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  // Fetch all ChunkUploaded events.
  const chunkFilter = contract.filters.ChunkUploaded();
  const chunkLogs = await contract.queryFilter(chunkFilter, lastSyncedBlock);

  if (verbose) {
    console.log(`  found ${chunkLogs.length} ChunkUploaded event(s)`);
  }

  for (const log of chunkLogs) {
    const { fileId, chunkIndex, data } = log.args;
    db.insertChunk(database, {
      fileId,
      chunkIndex: Number(chunkIndex),
      data: Buffer.from(ethers.getBytes(data)),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    });
  }

  // Persist latest synced block.
  const latestBlock = await contract.runner.provider.getBlockNumber();
  db.setSyncState(database, "last_synced_block", String(latestBlock));

  if (verbose) {
    console.log(`Sync complete. Latest block: ${latestBlock}`);
  }
}

module.exports = { decompress, verify, fetchChunks, download, sync };
