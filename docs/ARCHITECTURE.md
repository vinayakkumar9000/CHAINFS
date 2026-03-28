# ChainFS Architecture

## Overview

ChainFS is a decentralized file storage system built on EVM-compatible blockchains.
File data is stored cheaply in transaction event logs; only minimal metadata lives
on-chain. An off-chain SQLite index and CLI tools make upload, download, listing, and
syncing straightforward from any machine.

---

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  User Interface                                                    │
│                                                                    │
│  ┌─────────────────────────┐   ┌───────────────────────────────┐  │
│  │  chaincli  (Python)     │   │  node src/cli.js  (Node.js)   │  │
│  │  manager / upload /     │   │  upload / download /           │  │
│  │  download / list /      │   │  list / sync                   │  │
│  │  sync / info            │   └───────────────────────────────┘  │
│  └────────────┬────────────┘                   │                  │
│               │                                │                  │
│  ┌────────────▼────────────┐   ┌───────────────▼───────────────┐  │
│  │  StorageBot (Python)    │   │  storage-bot.js (Node.js)     │  │
│  │  compress → chunk →     │   │  compress → chunk → upload    │  │
│  │  createFile → upload    │   └───────────────────────────────┘  │
│  └─────────────────────────┘                                      │
│  ┌─────────────────────────┐   ┌───────────────────────────────┐  │
│  │  DownloaderBot (Python) │   │  downloader-bot.js (Node.js)  │  │
│  │  fetch → reconstruct →  │   │  fetch logs → reconstruct →   │  │
│  │  verify → save          │   │  verify → write               │  │
│  └─────────────────────────┘   └───────────────────────────────┘  │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Local SQLite (two layers)                                   │  │
│  │  db.js         – chunk BLOBs  (upload / download cache)      │  │
│  │  db-manager.js – index only   (sync-engine / list / sync)    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                           │                                        │
│          JSON-RPC (ethers.js / web3.py)                            │
│                           ▼                                        │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  ChainFS.sol  (Solidity 0.8.26)                              │  │
│  │  createFile()    → FileCreated  event (metadata on-chain)    │  │
│  │  uploadChunk()   → ChunkUploaded event (data in log)         │  │
│  │  getFile()       → view (read metadata)                      │  │
│  └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Smart Contract — `contracts/ChainFS.sol`

The single on-chain component. Stores only a `FileMetadata` mapping (name, size,
chunkCount, owner). All file bytes are emitted in `ChunkUploaded` event logs and
never stored in contract storage, keeping gas costs low.

| Function | Description |
|---|---|
| `createFile(fileId, name, size, chunkCount)` | Registers a file; emits `FileCreated` |
| `uploadChunk(fileId, chunkIndex, data)` | Emits `ChunkUploaded` with raw chunk bytes |
| `getFile(fileId)` | Read-only metadata getter |

Validation enforced on-chain: duplicate fileIds, empty names, zero sizes/chunk
counts, out-of-range chunk indices, chunk data exceeding `MAX_CHUNK_SIZE` (24 576 B).

### 2. Storage Bot

Implements the **upload pipeline**: `read → SHA-256 → compress (gzip) → chunk → createFile() → uploadChunk() × N`

| Implementation | Path | Used by |
|---|---|---|
| Node.js | `src/storage-bot.js` | `src/cli.js` |
| Python  | `src/storage_bot.py` | `chaincli` |

Key properties:
- SHA-256 is computed on the **original, uncompressed** bytes — this becomes the `fileId`
- gzip compression covers the whole file before chunking
- `CHUNK_SIZE` ≤ 24 576 B (contract hard-limit)
- Python bot uses exponential back-off retries per chunk

### 3. Downloader Bot

Implements the **download pipeline**: `fetch ChunkUploaded logs → reconstruct → gunzip → verify SHA-256 → write`

| Implementation | Path | Used by |
|---|---|---|
| Node.js | `src/downloader-bot.js` | `src/cli.js` |
| Python  | `src/downloader_bot.py` | `chaincli` |

Key properties:
- `fileId == 0x + SHA-256(original_bytes)` — used to verify integrity after download
- Python bot uses parallel range queries (`ThreadPoolExecutor`)
- Both bots cache chunks in SQLite to avoid repeated RPC calls

### 4. Database Layer

ChainFS uses two SQLite layers:

| Module | Path | Role |
|---|---|---|
| `db.js` | `src/db.js` | **Blob store** – stores raw chunk BLOBs; used by Node.js upload/download |
| `DatabaseManager` | `src/db-manager.js` | **Index DB** – stores chunk hashes only; used by SyncEngine, `list`, `sync` |

Both use Node.js's built-in `node:sqlite` (`DatabaseSync`). The Python `chaincli` reads
the index DB directly via the standard `sqlite3` module.

**db.js schema:**

| Table | Purpose |
|---|---|
| `files` | One row per registered file (`tx_hash`, `block_number`) |
| `chunks` | One row per chunk — stores raw BLOB |
| `sync_state` | Key/value store for last synced block |

**db-manager.js schema:**

| Table | Purpose |
|---|---|
| `files` | Extended metadata (`mime_type`, `compressed_size`, `content_hash`) |
| `chunks` | Hash-only index (`chunk_hash`) — no BLOB |
| `sync_state` | Integer-valued key/value store |

### 5. Sync Engine — `src/sync-engine.js`

Incrementally indexes on-chain events into the `DatabaseManager` index DB.

Features:
- **Incremental** — resumes from `last_synced_block`
- **Batched** — fetches events in 2 000-block windows (configurable)
- **Concurrent** — up to 5 batch workers in parallel
- **Reorg-safe** — stays 5 blocks behind chain tip
- **Idempotent** — `INSERT OR IGNORE` makes re-runs safe
- **Resilient** — RPC failures trigger exponential back-off; a failed batch is skipped
  rather than aborting the entire sync

### 6. CLI

| CLI | Language | Entry point |
|---|---|---|
| `chaincli` | Python | `./chaincli` |
| Node.js CLI | Node.js | `src/cli.js` |

The Python `chaincli` delegates `sync` to the Node.js CLI via subprocess and reads
the resulting index DB with Python's `sqlite3` module.

---

## Upload Data Flow

```
local file
    │
    ▼  SHA-256(raw)  →  fileId
    │
    ▼  gzip compress
    │
    ▼  split into ≤24 576-byte chunks
    │
    ▼  createFile(fileId, name, size, N)  →  FileCreated log
    │
    ▼  uploadChunk(fileId, 0, chunk[0])   →  ChunkUploaded log
    ▼  uploadChunk(fileId, 1, chunk[1])   →  ChunkUploaded log
    ▼  …
```

## Download Data Flow

```
fileId
    │
    ▼  queryFilter(ChunkUploaded, fileId)  →  event logs from RPC
    │
    ▼  sort by chunkIndex, concatenate
    │
    ▼  gunzip
    │
    ▼  SHA-256(result) == fileId?  →  integrity verified
    │
    ▼  write to disk
```

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Event logs for data storage | ~1 000× cheaper than EVM storage slots |
| SHA-256 fileId | Deterministic; doubles as content hash for integrity verification |
| gzip before chunking | Single decompression step; better ratio than per-chunk compression |
| SQLite local index | Fast queries without hitting the RPC node after initial sync |
| Chunk size 24 576 B | Stays below EVM practical limit with headroom for gas overhead |
| Reorg-safe sync window | Avoids indexing blocks that may be reorganized away |
| Two DB layers | Blob store needed for download cache; index DB avoids storing large BLOBs during sync |
| Single contract | All files share one contract; no per-file deployment needed |

---

## Constraints

| Constraint | Approach |
|---|---|
| Event logs not queryable on-chain | Off-chain SQLite index built by replaying logs via `queryFilter` |
| EVM transaction size limit | Chunks capped at 24 576 bytes |
| Low storage cost | Data in event logs, not in contract storage |
| Integrity guarantee | SHA-256 of original bytes verified after every download |
| Compression required | gzip applied before chunking to reduce on-chain data volume |
| Retry logic required | Exponential back-off on all RPC and transaction calls |
