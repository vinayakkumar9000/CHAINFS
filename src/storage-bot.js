"use strict";

/**
 * storage-bot.js
 *
 * Reads a local file, compresses it, splits it into chunks sized to fit inside
 * a single Ethereum transaction, then uploads each chunk to the ChainFS
 * smart contract via uploadChunk().
 *
 * Pipeline:  compress → chunk → upload
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { ethers } = require("ethers");

const db = require("./db");

// Maximum bytes per chunk (must stay ≤ ChainFS.MAX_CHUNK_SIZE = 24 576).
const CHUNK_SIZE = 24_576;

/**
 * Compress a Buffer with gzip (sync, for simplicity).
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function compress(buf) {
  return zlib.gzipSync(buf);
}

/**
 * Split a Buffer into an array of chunks of at most `size` bytes each.
 *
 * @param {Buffer} buf
 * @param {number} size
 * @returns {Buffer[]}
 */
function chunk(buf, size) {
  const chunks = [];
  for (let offset = 0; offset < buf.length; offset += size) {
    chunks.push(buf.subarray(offset, offset + size));
  }
  return chunks;
}

/**
 * Derive a stable bytes32 file ID from the original (uncompressed) file
 * content so that the same file always gets the same ID.
 *
 * @param {Buffer} rawContent
 * @returns {string}  0x-prefixed hex string
 */
function deriveFileId(rawContent) {
  return "0x" + crypto.createHash("sha256").update(rawContent).digest("hex");
}

/**
 * Upload a single chunk to the contract and persist it in the local DB.
 *
 * @param {object} opts
 * @param {import('ethers').Contract}      opts.contract
 * @param {import('node:sqlite').DatabaseSync} opts.database
 * @param {string}  opts.fileId
 * @param {number}  opts.chunkIndex
 * @param {Buffer}  opts.data
 * @param {boolean} [opts.verbose]
 */
async function uploadChunk({ contract, database, fileId, chunkIndex, data, verbose }) {
  const tx = await contract.uploadChunk(fileId, chunkIndex, data);
  const receipt = await tx.wait();

  db.insertChunk(database, {
    fileId,
    chunkIndex,
    data,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });

  if (verbose) {
    console.log(
      `  chunk ${chunkIndex} → tx ${receipt.hash} (block ${receipt.blockNumber})`
    );
  }
}

/**
 * Full storage pipeline: compress → chunk → register file → upload chunks.
 *
 * @param {object} opts
 * @param {string}  opts.filePath        Local path to the file to upload.
 * @param {import('ethers').Contract}      opts.contract  Connected ChainFS contract.
 * @param {import('node:sqlite').DatabaseSync} opts.database  Open SQLite handle.
 * @param {boolean} [opts.verbose]       Print progress.
 * @returns {Promise<{ fileId: string, chunkCount: number }>}
 */
async function upload({ filePath, contract, database, verbose }) {
  const rawContent = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const fileId = deriveFileId(rawContent);

  if (verbose) {
    console.log(`Uploading: ${name}`);
    console.log(`  fileId : ${fileId}`);
    console.log(`  raw size: ${rawContent.length} bytes`);
  }

  // ── 1. Compress ────────────────────────────────────────────────────────────
  const compressed = compress(rawContent);

  if (verbose) {
    console.log(`  compressed: ${compressed.length} bytes`);
  }

  // ── 2. Chunk ───────────────────────────────────────────────────────────────
  const chunks = chunk(compressed, CHUNK_SIZE);

  if (verbose) {
    console.log(`  chunks: ${chunks.length}`);
  }

  // ── 3. Register file on-chain ──────────────────────────────────────────────
  const tx = await contract.createFile(
    fileId,
    name,
    rawContent.length,
    chunks.length
  );
  const receipt = await tx.wait();

  db.insertFile(database, {
    fileId,
    name,
    size: rawContent.length,
    chunkCount: chunks.length,
    owner: await contract.runner.getAddress(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  });

  if (verbose) {
    console.log(`  createFile tx: ${receipt.hash}`);
  }

  // ── 4. Upload chunks ───────────────────────────────────────────────────────
  for (let i = 0; i < chunks.length; i++) {
    await uploadChunk({
      contract,
      database,
      fileId,
      chunkIndex: i,
      data: chunks[i],
      verbose,
    });
  }

  if (verbose) {
    console.log(`Done uploading ${name}.`);
  }

  return { fileId, chunkCount: chunks.length };
}

module.exports = { compress, chunk, deriveFileId, upload, CHUNK_SIZE };
