"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const zlib = require("zlib");
const path = require("path");
const fs = require("fs");
const os = require("os");

const db = require("../src/db");
const storageBotModule = require("../src/storage-bot");
const downloaderBotModule = require("../src/downloader-bot");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create an in-memory SQLite database pre-populated with the schema. */
function makeDb() {
  return db.openDb(":memory:");
}

/** Return a bytes32 hex string derived from content. */
function fileId(content) {
  return "0x" + crypto.createHash("sha256").update(content).digest("hex");
}

// ─── Smart Contract Tests ─────────────────────────────────────────────────────

describe("ChainFS contract", function () {
  let chainfs;
  let owner;
  let other;

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const ChainFS = await ethers.getContractFactory("ChainFS");
    chainfs = await ChainFS.deploy();
    await chainfs.waitForDeployment();
  });

  // ── createFile ──────────────────────────────────────────────────────────────

  describe("createFile", function () {
    it("registers a file and emits FileCreated", async function () {
      const id = fileId(Buffer.from("hello"));
      await expect(chainfs.createFile(id, "hello.txt", 5, 1))
        .to.emit(chainfs, "FileCreated")
        .withArgs(id, "hello.txt", 5, 1, owner.address);

      const [name, size, chunkCount, addr] = await chainfs.getFile(id);
      expect(name).to.equal("hello.txt");
      expect(size).to.equal(5n);
      expect(chunkCount).to.equal(1n);
      expect(addr).to.equal(owner.address);
    });

    it("reverts when the same fileId is registered twice", async function () {
      const id = fileId(Buffer.from("dupe"));
      await chainfs.createFile(id, "dupe.txt", 4, 1);
      await expect(
        chainfs.createFile(id, "dupe.txt", 4, 1)
      ).to.be.revertedWithCustomError(chainfs, "FileAlreadyExists");
    });

    it("reverts on empty name", async function () {
      const id = fileId(Buffer.from("x"));
      await expect(
        chainfs.createFile(id, "", 1, 1)
      ).to.be.revertedWithCustomError(chainfs, "EmptyFileName");
    });

    it("reverts on zero size", async function () {
      const id = fileId(Buffer.from("x"));
      await expect(
        chainfs.createFile(id, "x.txt", 0, 1)
      ).to.be.revertedWithCustomError(chainfs, "ZeroSize");
    });

    it("reverts on zero chunkCount", async function () {
      const id = fileId(Buffer.from("x"));
      await expect(
        chainfs.createFile(id, "x.txt", 1, 0)
      ).to.be.revertedWithCustomError(chainfs, "ZeroChunkCount");
    });
  });

  // ── uploadChunk ─────────────────────────────────────────────────────────────

  describe("uploadChunk", function () {
    let id;
    const content = Buffer.from("chunk data");

    beforeEach(async function () {
      id = fileId(content);
      await chainfs.createFile(id, "file.txt", content.length, 1);
    });

    it("emits ChunkUploaded", async function () {
      await expect(chainfs.uploadChunk(id, 0, content))
        .to.emit(chainfs, "ChunkUploaded")
        .withArgs(id, 0, ethers.hexlify(content));
    });

    it("reverts for unknown fileId", async function () {
      const unknownId = "0x" + "aa".repeat(32);
      await expect(
        chainfs.uploadChunk(unknownId, 0, content)
      ).to.be.revertedWithCustomError(chainfs, "FileNotFound");
    });

    it("reverts when caller is not the owner", async function () {
      await expect(
        chainfs.connect(other).uploadChunk(id, 0, content)
      ).to.be.revertedWithCustomError(chainfs, "NotFileOwner");
    });

    it("reverts for out-of-range chunkIndex", async function () {
      await expect(
        chainfs.uploadChunk(id, 1, content) // chunkCount is 1, so index 1 is invalid
      ).to.be.revertedWithCustomError(chainfs, "InvalidChunkIndex");
    });

    it("reverts for empty data", async function () {
      await expect(
        chainfs.uploadChunk(id, 0, "0x")
      ).to.be.revertedWithCustomError(chainfs, "InvalidChunkSize");
    });

    it("reverts for data exceeding MAX_CHUNK_SIZE", async function () {
      const big = Buffer.alloc(24_577, 0xff);
      await expect(
        chainfs.uploadChunk(id, 0, big)
      ).to.be.revertedWithCustomError(chainfs, "InvalidChunkSize");
    });
  });

  // ── getFile ─────────────────────────────────────────────────────────────────

  describe("getFile", function () {
    it("reverts for unknown fileId", async function () {
      await expect(
        chainfs.getFile("0x" + "bb".repeat(32))
      ).to.be.revertedWithCustomError(chainfs, "FileNotFound");
    });
  });
});

// ─── Storage Bot Tests ────────────────────────────────────────────────────────

describe("storage-bot (unit)", function () {
  const { compress, chunk, deriveFileId, CHUNK_SIZE } = storageBotModule;

  describe("compress / decompress round-trip", function () {
    it("gzip output decompresses back to the original", function () {
      const original = Buffer.from("hello chainfs world");
      const compressed = compress(original);
      const decompressed = zlib.gunzipSync(compressed);
      expect(decompressed).to.deep.equal(original);
    });
  });

  describe("chunk", function () {
    it("splits a buffer into equal-size pieces", function () {
      const buf = Buffer.alloc(100, 0xab);
      const chunks = chunk(buf, 30);
      expect(chunks).to.have.length(4);
      expect(chunks[0]).to.have.length(30);
      expect(chunks[3]).to.have.length(10);
    });

    it("returns a single chunk when data fits in one piece", function () {
      const buf = Buffer.alloc(10, 0x01);
      expect(chunk(buf, 100)).to.have.length(1);
    });

    it("respects the CHUNK_SIZE constant (≤ 24 576)", function () {
      expect(CHUNK_SIZE).to.be.at.most(24_576);
    });
  });

  describe("deriveFileId", function () {
    it("returns a 0x-prefixed 64-char hex string (bytes32)", function () {
      const id = deriveFileId(Buffer.from("test"));
      expect(id).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("is deterministic", function () {
      const buf = Buffer.from("deterministic");
      expect(deriveFileId(buf)).to.equal(deriveFileId(buf));
    });

    it("differs for different inputs", function () {
      expect(deriveFileId(Buffer.from("a"))).to.not.equal(
        deriveFileId(Buffer.from("b"))
      );
    });
  });
});

// ─── Downloader Bot Tests ─────────────────────────────────────────────────────

describe("downloader-bot (unit)", function () {
  const { decompress, verify } = downloaderBotModule;

  describe("decompress", function () {
    it("round-trips with zlib.gzipSync", function () {
      const original = Buffer.from("roundtrip test");
      const compressed = zlib.gzipSync(original);
      expect(decompress(compressed)).to.deep.equal(original);
    });
  });

  describe("verify", function () {
    it("returns true when content matches fileId", function () {
      const content = Buffer.from("verify me");
      const id = storageBotModule.deriveFileId(content);
      expect(verify(content, id)).to.be.true;
    });

    it("returns false when content does not match fileId", function () {
      const content = Buffer.from("verify me");
      const otherId = storageBotModule.deriveFileId(Buffer.from("different"));
      expect(verify(content, otherId)).to.be.false;
    });

    it("is case-insensitive in the hex comparison", function () {
      const content = Buffer.from("case");
      const id = storageBotModule.deriveFileId(content);
      expect(verify(content, id.toUpperCase())).to.be.true;
    });
  });
});

// ─── Database Tests ───────────────────────────────────────────────────────────

describe("db module", function () {
  let database;

  beforeEach(function () {
    database = makeDb();
  });

  afterEach(function () {
    database.close();
  });

  describe("files", function () {
    const sampleFile = {
      fileId: "0x" + "01".repeat(32),
      name: "sample.txt",
      size: 100,
      chunkCount: 2,
      owner: "0xabc",
      txHash: "0xtx1",
      blockNumber: 42,
    };

    it("inserts and retrieves a file", function () {
      db.insertFile(database, sampleFile);
      const row = db.getFile(database, sampleFile.fileId);
      expect(row).to.not.be.undefined;
      expect(row.name).to.equal("sample.txt");
      expect(row.size).to.equal(100);
      expect(row.chunk_count).to.equal(2);
    });

    it("listFiles returns inserted files", function () {
      db.insertFile(database, sampleFile);
      const files = db.listFiles(database);
      expect(files).to.have.length(1);
    });

    it("INSERT OR IGNORE prevents duplicates", function () {
      db.insertFile(database, sampleFile);
      db.insertFile(database, sampleFile); // duplicate — should not throw
      expect(db.listFiles(database)).to.have.length(1);
    });
  });

  describe("chunks", function () {
    const fid = "0x" + "02".repeat(32);

    beforeEach(function () {
      db.insertFile(database, {
        fileId: fid,
        name: "f.txt",
        size: 5,
        chunkCount: 2,
        owner: "0xdef",
        txHash: null,
        blockNumber: null,
      });
    });

    it("inserts and retrieves chunks", function () {
      db.insertChunk(database, {
        fileId: fid,
        chunkIndex: 0,
        data: Buffer.from("hello"),
        txHash: null,
        blockNumber: null,
      });
      const chunks = db.getChunks(database, fid);
      expect(chunks).to.have.length(1);
      expect(Buffer.from(chunks[0].data)).to.deep.equal(Buffer.from("hello"));
    });

    it("countChunks returns the correct count", function () {
      db.insertChunk(database, { fileId: fid, chunkIndex: 0, data: Buffer.from("a"), txHash: null, blockNumber: null });
      db.insertChunk(database, { fileId: fid, chunkIndex: 1, data: Buffer.from("b"), txHash: null, blockNumber: null });
      expect(db.countChunks(database, fid)).to.equal(2);
    });

    it("INSERT OR REPLACE updates existing chunk", function () {
      db.insertChunk(database, { fileId: fid, chunkIndex: 0, data: Buffer.from("old"), txHash: null, blockNumber: null });
      db.insertChunk(database, { fileId: fid, chunkIndex: 0, data: Buffer.from("new"), txHash: null, blockNumber: null });
      const chunks = db.getChunks(database, fid);
      expect(chunks).to.have.length(1);
      expect(Buffer.from(chunks[0].data)).to.deep.equal(Buffer.from("new"));
    });
  });

  describe("sync_state", function () {
    it("returns undefined for an unknown key", function () {
      expect(db.getSyncState(database, "no_such_key")).to.be.undefined;
    });

    it("set and get round-trips", function () {
      db.setSyncState(database, "last_synced_block", "999");
      expect(db.getSyncState(database, "last_synced_block")).to.equal("999");
    });

    it("updates an existing key", function () {
      db.setSyncState(database, "k", "v1");
      db.setSyncState(database, "k", "v2");
      expect(db.getSyncState(database, "k")).to.equal("v2");
    });
  });
});

// ─── Integration Test (contract + bots + db) ──────────────────────────────────

describe("integration: upload then download", function () {
  let chainfs;
  let owner;
  let tmpDir;

  before(async function () {
    [owner] = await ethers.getSigners();
    const ChainFS = await ethers.getContractFactory("ChainFS");
    chainfs = await ChainFS.deploy();
    await chainfs.waitForDeployment();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chainfs-test-"));
  });

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads a file and downloads it back intact", async function () {
    const database = makeDb();

    // Create a temporary file to upload.
    const original = Buffer.from("Hello, ChainFS! This is an integration test.");
    const inputPath = path.join(tmpDir, "input.txt");
    fs.writeFileSync(inputPath, original);

    // Upload.
    const { fileId: fid } = await storageBotModule.upload({
      filePath: inputPath,
      contract: chainfs,
      database,
      verbose: false,
    });

    // Download.
    const outputPath = path.join(tmpDir, "output.txt");
    await downloaderBotModule.download({
      fileId: fid,
      outputPath,
      contract: chainfs,
      database,
      fromBlock: 0,
      verbose: false,
    });

    // Verify.
    const result = fs.readFileSync(outputPath);
    expect(result).to.deep.equal(original);

    database.close();
  });

  it("sync indexes FileCreated and ChunkUploaded events", async function () {
    const database = makeDb();

    const content = Buffer.from("sync test content");
    const inputPath = path.join(tmpDir, "sync-input.txt");
    fs.writeFileSync(inputPath, content);

    // Upload using a fresh DB so there are events on-chain.
    const freshDb = makeDb();
    await storageBotModule.upload({
      filePath: inputPath,
      contract: chainfs,
      database: freshDb,
      verbose: false,
    });
    freshDb.close();

    // Sync into a different DB.
    await downloaderBotModule.sync({ contract: chainfs, database, verbose: false });

    const files = db.listFiles(database);
    expect(files.length).to.be.at.least(1);

    const lastBlock = db.getSyncState(database, "last_synced_block");
    expect(Number(lastBlock)).to.be.greaterThan(0);

    database.close();
  });
});
