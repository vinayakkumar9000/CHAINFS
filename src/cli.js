#!/usr/bin/env node
"use strict";

/**
 * cli.js — ChainFS command-line interface
 *
 * Commands:
 *   upload   <filePath>            Upload a file to ChainFS.
 *   download <fileId> <outputPath> Download a file from ChainFS.
 *   list                           List all files in the local index.
 *   sync                           Sync the local index with the chain.
 *
 * Configuration (environment variables or --option flags):
 *   CHAINFS_RPC_URL     JSON-RPC endpoint (default: http://127.0.0.1:8545)
 *   CHAINFS_CONTRACT    Deployed ChainFS contract address
 *   CHAINFS_PRIVATE_KEY Signer private key (for upload)
 *   CHAINFS_DB_PATH     SQLite database path (default: ~/.chainfs/chainfs.db)
 */

const path = require("path");
const { Command } = require("commander");
const { ethers } = require("ethers");

const db = require("./db");
const storageBotModule = require("./storage-bot");
const downloaderBotModule = require("./downloader-bot");

// ─── ABI (only the events and functions we need) ──────────────────────────────

const CHAINFS_ABI = [
  "function createFile(bytes32 fileId, string name, uint256 size, uint256 chunkCount) external",
  "function uploadChunk(bytes32 fileId, uint256 chunkIndex, bytes data) external",
  "function getFile(bytes32 fileId) external view returns (string name, uint256 size, uint256 chunkCount, address owner)",
  "event FileCreated(bytes32 indexed fileId, string name, uint256 size, uint256 chunkCount, address indexed owner)",
  "event ChunkUploaded(bytes32 indexed fileId, uint256 indexed chunkIndex, bytes data)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getEnv(key, fallback) {
  return process.env[key] || fallback;
}

function requireEnv(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`Error: environment variable ${key} is required.`);
    process.exit(1);
  }
  return val;
}

/**
 * Build an ethers Contract instance.
 *
 * @param {boolean} needsSigner - true for write operations (upload).
 * @returns {{ contract: import('ethers').Contract, provider: import('ethers').JsonRpcProvider }}
 */
function buildContract(needsSigner = false) {
  const rpcUrl = getEnv("CHAINFS_RPC_URL", "http://127.0.0.1:8545");
  const contractAddress = requireEnv("CHAINFS_CONTRACT");
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  let runner;
  if (needsSigner) {
    const privateKey = requireEnv("CHAINFS_PRIVATE_KEY");
    runner = new ethers.Wallet(privateKey, provider);
  } else {
    runner = provider;
  }

  const contract = new ethers.Contract(contractAddress, CHAINFS_ABI, runner);
  return { contract, provider };
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("chainfs")
  .description("Decentralized file storage on EVM")
  .version("1.0.0");

// ── upload ────────────────────────────────────────────────────────────────────

program
  .command("upload <filePath>")
  .description("Compress, chunk, and upload a file to ChainFS")
  .option("-v, --verbose", "print progress")
  .action(async (filePath, opts) => {
    const database = db.openDb(getEnv("CHAINFS_DB_PATH"));
    const { contract } = buildContract(true);

    try {
      const { fileId, chunkCount } = await storageBotModule.upload({
        filePath: path.resolve(filePath),
        contract,
        database,
        verbose: opts.verbose,
      });
      console.log(`Uploaded: fileId=${fileId} chunks=${chunkCount}`);
    } catch (err) {
      console.error("Upload failed:", err.message);
      process.exit(1);
    }
  });

// ── download ──────────────────────────────────────────────────────────────────

program
  .command("download <fileId> <outputPath>")
  .description("Fetch a file from ChainFS and write it to disk")
  .option("--from-block <number>", "start block for log query", "0")
  .option("-v, --verbose", "print progress")
  .action(async (fileId, outputPath, opts) => {
    const database = db.openDb(getEnv("CHAINFS_DB_PATH"));
    const { contract } = buildContract(false);

    try {
      await downloaderBotModule.download({
        fileId,
        outputPath: path.resolve(outputPath),
        contract,
        database,
        fromBlock: Number(opts.fromBlock),
        verbose: opts.verbose,
      });
      console.log(`Downloaded: ${outputPath}`);
    } catch (err) {
      console.error("Download failed:", err.message);
      process.exit(1);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all files in the local index")
  .action(() => {
    const database = db.openDb(getEnv("CHAINFS_DB_PATH"));
    const files = db.listFiles(database);

    if (files.length === 0) {
      console.log("No files found. Run `chainfs sync` to index the chain.");
      return;
    }

    for (const f of files) {
      console.log(
        `${f.file_id}  ${f.name}  ${f.size}B  chunks=${f.chunk_count}  owner=${f.owner}`
      );
    }
  });

// ── sync ──────────────────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync the local index with on-chain events")
  .option("-v, --verbose", "print progress")
  .action(async (opts) => {
    const database = db.openDb(getEnv("CHAINFS_DB_PATH"));
    const { contract } = buildContract(false);

    try {
      await downloaderBotModule.sync({ contract, database, verbose: opts.verbose });
      console.log("Sync complete.");
    } catch (err) {
      console.error("Sync failed:", err.message);
      process.exit(1);
    }
  });

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
