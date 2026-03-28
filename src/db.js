"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

/**
 * Opens (or creates) the ChainFS SQLite database using the built-in
 * node:sqlite module (available in Node.js ≥ 22.5.0).
 *
 * @param {string} [dbPath] - Filesystem path for the SQLite file.
 *                            Pass ":memory:" for an in-memory database.
 *                            Defaults to ~/.chainfs/chainfs.db
 * @returns {DatabaseSync} An open DatabaseSync handle.
 */
function openDb(dbPath) {
  if (!dbPath) {
    const dir = path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".chainfs"
    );
    fs.mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, "chainfs.db");
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

/**
 * Creates tables if they do not yet exist.
 *
 * Schema
 * ------
 * files      – one row per registered file
 * chunks     – one row per uploaded chunk (data stored as BLOB)
 * sync_state – key/value store for indexer bookkeeping (e.g. last synced block)
 *
 * @param {DatabaseSync} db
 */
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_id      TEXT    NOT NULL PRIMARY KEY,
      name         TEXT    NOT NULL,
      size         INTEGER NOT NULL,
      chunk_count  INTEGER NOT NULL,
      owner        TEXT    NOT NULL,
      tx_hash      TEXT,
      block_number INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      file_id      TEXT    NOT NULL REFERENCES files(file_id),
      chunk_index  INTEGER NOT NULL,
      data         BLOB    NOT NULL,
      tx_hash      TEXT,
      block_number INTEGER,
      PRIMARY KEY (file_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ─── files ────────────────────────────────────────────────────────────────────

/**
 * Insert a file record. Safe to call multiple times (INSERT OR IGNORE).
 *
 * @param {DatabaseSync} db
 * @param {{ fileId: string, name: string, size: number,
 *           chunkCount: number, owner: string,
 *           txHash?: string, blockNumber?: number }} file
 */
function insertFile(db, file) {
  db.prepare(`
    INSERT OR IGNORE INTO files
      (file_id, name, size, chunk_count, owner, tx_hash, block_number)
    VALUES
      (@fileId, @name, @size, @chunkCount, @owner, @txHash, @blockNumber)
  `).run(file);
}

/**
 * Return all files, ordered by creation time.
 *
 * @param {DatabaseSync} db
 * @returns {object[]}
 */
function listFiles(db) {
  return db.prepare("SELECT * FROM files ORDER BY created_at DESC").all();
}

/**
 * Return a single file record, or undefined if not found.
 *
 * @param {DatabaseSync} db
 * @param {string} fileId
 * @returns {object|undefined}
 */
function getFile(db, fileId) {
  return db.prepare("SELECT * FROM files WHERE file_id = ?").get(fileId);
}

// ─── chunks ───────────────────────────────────────────────────────────────────

/**
 * Insert (or replace) a chunk record.
 *
 * @param {DatabaseSync} db
 * @param {{ fileId: string, chunkIndex: number, data: Buffer,
 *           txHash?: string, blockNumber?: number }} chunk
 */
function insertChunk(db, chunk) {
  db.prepare(`
    INSERT OR REPLACE INTO chunks
      (file_id, chunk_index, data, tx_hash, block_number)
    VALUES
      (@fileId, @chunkIndex, @data, @txHash, @blockNumber)
  `).run(chunk);
}

/**
 * Return all chunk records for a file, sorted by chunk_index.
 *
 * @param {DatabaseSync} db
 * @param {string} fileId
 * @returns {object[]}
 */
function getChunks(db, fileId) {
  return db
    .prepare("SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index")
    .all(fileId);
}

/**
 * Return the number of chunks already stored for a file.
 *
 * @param {DatabaseSync} db
 * @param {string} fileId
 * @returns {number}
 */
function countChunks(db, fileId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_id = ?")
    .get(fileId).n;
}

// ─── sync_state ───────────────────────────────────────────────────────────────

/**
 * Read a sync-state value by key.
 *
 * @param {DatabaseSync} db
 * @param {string} key
 * @returns {string|undefined}
 */
function getSyncState(db, key) {
  const row = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key);
  return row ? row.value : undefined;
}

/**
 * Upsert a sync-state key/value pair.
 *
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
function setSyncState(db, key, value) {
  db.prepare(`
    INSERT INTO sync_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

module.exports = {
  openDb,
  initSchema,
  insertFile,
  listFiles,
  getFile,
  insertChunk,
  getChunks,
  countChunks,
  getSyncState,
  setSyncState,
};
