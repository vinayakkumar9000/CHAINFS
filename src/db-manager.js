"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

/**
 * Default database path: ./data/chainfs.db (relative to cwd).
 * Can be overridden by passing an explicit path to the constructor,
 * or set to ":memory:" for testing.
 */
const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "chainfs.db");

/**
 * DatabaseManager
 *
 * Manages the ChainFS index database.  All tables use INSERT OR IGNORE so
 * duplicate inserts are silently discarded (idempotent).
 *
 * Schema
 * ──────
 *   files      – one row per registered file (indexed by owner / timestamp)
 *   chunks     – one row per chunk (hash only – no raw data)
 *   sync_state – key/INTEGER-value store used by SyncEngine
 *
 * Performance
 * ───────────
 *   WAL mode       → concurrent reads while a write is in progress
 *   Foreign keys   → ON  (data integrity)
 *   4 indexes      → sub-millisecond lookups even with millions of rows
 */
class DatabaseManager {
  /**
   * @param {string} [dbPath] - Filesystem path for the SQLite file.
   *                            Defaults to ./data/chainfs.db.
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Open the database, apply PRAGMAs, and create tables/indexes if missing.
   * Must be called before any other method.
   *
   * @returns {DatabaseManager} this (for chaining)
   */
  initialize() {
    if (this.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this._initSchema();
    return this;
  }

  // ─── Schema ─────────────────────────────────────────────────────────────────

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_id         TEXT    PRIMARY KEY,
        owner           TEXT,
        name            TEXT,
        mime_type       TEXT,
        original_size   INTEGER,
        compressed_size INTEGER,
        content_hash    TEXT,
        total_chunks    INTEGER,
        timestamp       INTEGER,
        block_number    INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunks (
        file_id      TEXT,
        chunk_index  INTEGER,
        chunk_hash   TEXT,
        tx_hash      TEXT,
        block_number INTEGER,
        log_index    INTEGER,
        PRIMARY KEY (file_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT    PRIMARY KEY,
        value INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_files_owner     ON files(owner);
      CREATE INDEX IF NOT EXISTS idx_files_timestamp ON files(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chunks_file     ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_tx       ON chunks(tx_hash);
    `);
  }

  // ─── files ───────────────────────────────────────────────────────────────────

  /**
   * Insert a file record.  Safe to call multiple times (INSERT OR IGNORE).
   *
   * @param {object} file
   * @param {string}  file.fileId
   * @param {string}  file.owner
   * @param {string}  file.name
   * @param {string}  [file.mimeType]
   * @param {number}  file.originalSize
   * @param {number}  [file.compressedSize]
   * @param {string}  file.contentHash      - hex bytes32 (= fileId for ChainFS)
   * @param {number}  file.totalChunks
   * @param {number}  [file.timestamp]      - Unix seconds (0 if unknown)
   * @param {number}  file.blockNumber
   */
  insertFile({
    fileId,
    owner,
    name,
    mimeType = null,
    originalSize,
    compressedSize = null,
    contentHash,
    totalChunks,
    timestamp = 0,
    blockNumber,
  }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO files
           (file_id, owner, name, mime_type, original_size, compressed_size,
            content_hash, total_chunks, timestamp, block_number)
         VALUES
           (@fileId, @owner, @name, @mimeType, @originalSize, @compressedSize,
            @contentHash, @totalChunks, @timestamp, @blockNumber)`
      )
      .run({
        fileId,
        owner,
        name,
        mimeType,
        originalSize,
        compressedSize,
        contentHash,
        totalChunks,
        timestamp,
        blockNumber,
      });
  }

  /**
   * Query all files belonging to an owner, newest-first.
   *
   * @param {string} owner
   * @returns {object[]}
   */
  getFilesByOwner(owner) {
    return this.db
      .prepare(
        "SELECT * FROM files WHERE owner = ? ORDER BY timestamp DESC, block_number DESC"
      )
      .all(owner);
  }

  /**
   * Return a single file record, or undefined if not found.
   *
   * @param {string} fileId
   * @returns {object|undefined}
   */
  getFileById(fileId) {
    return this.db
      .prepare("SELECT * FROM files WHERE file_id = ?")
      .get(fileId);
  }

  /**
   * List all indexed files, newest-first.
   *
   * @returns {object[]}
   */
  listFiles() {
    return this.db
      .prepare(
        "SELECT * FROM files ORDER BY timestamp DESC, block_number DESC"
      )
      .all();
  }

  // ─── chunks ──────────────────────────────────────────────────────────────────

  /**
   * Insert a chunk record.  Safe to call multiple times (INSERT OR IGNORE).
   *
   * @param {object} chunk
   * @param {string}  chunk.fileId
   * @param {number}  chunk.chunkIndex
   * @param {string}  chunk.chunkHash    - hex SHA-256 of the raw chunk bytes
   * @param {string}  chunk.txHash
   * @param {number}  chunk.blockNumber
   * @param {number}  chunk.logIndex
   */
  insertChunk({ fileId, chunkIndex, chunkHash, txHash, blockNumber, logIndex }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO chunks
           (file_id, chunk_index, chunk_hash, tx_hash, block_number, log_index)
         VALUES
           (@fileId, @chunkIndex, @chunkHash, @txHash, @blockNumber, @logIndex)`
      )
      .run({ fileId, chunkIndex, chunkHash, txHash, blockNumber, logIndex });
  }

  /**
   * Return all chunk records for a file, ordered by chunk_index.
   *
   * @param {string} fileId
   * @returns {object[]}
   */
  getChunks(fileId) {
    return this.db
      .prepare(
        "SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index"
      )
      .all(fileId);
  }

  // ─── sync_state ───────────────────────────────────────────────────────────────

  /**
   * Return the last block number that was fully synced (0 if never synced).
   *
   * @returns {number}
   */
  getLastSyncedBlock() {
    const row = this.db
      .prepare("SELECT value FROM sync_state WHERE key = 'last_synced_block'")
      .get();
    return row ? row.value : 0;
  }

  /**
   * Persist the last fully-synced block number.
   *
   * @param {number} blockNumber
   */
  setLastSyncedBlock(blockNumber) {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES ('last_synced_block', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(blockNumber);
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Close the underlying database handle.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { DatabaseManager, DEFAULT_DB_PATH };
