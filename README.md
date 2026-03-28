# ChainFS

A decentralized file storage system built on EVM-compatible blockchains. File data is
stored cheaply in transaction event logs; only minimal metadata lives on-chain. A local
SQLite index and two CLI interfaces (Python `chaincli` and Node.js `node src/cli.js`)
make upload, download, listing, and syncing straightforward.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  chaincli (Python)  OR  node src/cli.js (Node.js)               │
│    ├─ StorageBot / storage-bot.js  compress → chunk → upload    │
│    └─ DownloaderBot / downloader-bot.js  fetch → verify → save  │
│                                                                  │
│  Local SQLite                                                    │
│    ├─ db.js         (chunk BLOBs — upload/download cache)        │
│    └─ db-manager.js (index only — sync / list)                   │
│                                                                  │
│  Smart Contract – ChainFS.sol                                    │
│    ├─ createFile()   → FileCreated  event                        │
│    └─ uploadChunk()  → ChunkUploaded event (data in log)         │
└─────────────────────────────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed breakdown.

---

## Repository Layout

```
contracts/
  ChainFS.sol          Solidity smart contract (single source of truth)
scripts/
  deploy.js            Hardhat deployment helper
src/
  db.js                SQLite blob store (node:sqlite)
  db-manager.js        SQLite index DB (hash-only, used by sync / list)
  storage-bot.js       Node.js upload pipeline
  downloader-bot.js    Node.js download pipeline
  sync-engine.js       Incremental on-chain event indexer
  cli.js               Node.js CLI entry point (Commander)
  storage_bot.py       Python upload pipeline
  downloader_bot.py    Python download pipeline
  manager_bot.py       Python wallet + deployment manager
chaincli               Python CLI entry point (argparse)
test/
  ChainFS.test.js      Contract + unit + integration tests
docs/
  ARCHITECTURE.md      Full architecture documentation
  SETUP.md             Environment and dependency setup guide
  USAGE.md             Detailed usage examples
hardhat.config.js
package.json
requirements.txt       Python dependencies
.env.example           Example environment variables
config.example.yaml    Example YAML configuration reference
```

---

## Quick Start

### Prerequisites

- **Node.js ≥ 22.5.0** (uses the built-in `node:sqlite` module — required)
- **Python ≥ 3.9** (for `chaincli` and Python bots)
- An EVM-compatible RPC endpoint (local Hardhat node or public testnet)

### 1 — Install dependencies

```bash
npm install
pip install -r requirements.txt
```

### 2 — Compile the contract

```bash
npm run compile
```

### 3 — Choose a setup path

**Option A — Python `chaincli` (recommended for interactive use)**

```bash
# Set up wallet and deploy contract interactively
chaincli manager
# Follow prompts to create/import wallet and deploy ChainFS
```

**Option B — Node.js CLI (for scripted / Hardhat local usage)**

```bash
# Start a local Hardhat node
npx hardhat node

# In another terminal, deploy
npm run deploy:local
# → ChainFS deployed to: 0x…

# Set environment variables
export CHAINFS_RPC_URL=http://127.0.0.1:8545
export CHAINFS_CONTRACT=0x<deployed address>
export CHAINFS_PRIVATE_KEY=0x<your private key>
```

See [docs/SETUP.md](docs/SETUP.md) for the complete setup guide.

---

## CLI Usage

### `chaincli` (Python — full workflow)

```bash
# Set up wallet and deploy contract
chaincli manager

# Upload a file
chaincli upload ./myfile.pdf

# Download a file
chaincli download 0x<fileId>

# List all indexed files
chaincli list

# Sync local index with the chain
chaincli sync

# Show file details
chaincli info 0x<fileId>
```

### `node src/cli.js` (Node.js)

Set environment variables first (see Option B above or copy `.env.example`).

```bash
# Upload a file
node src/cli.js upload ./myfile.pdf --verbose
# → Uploaded: fileId=0x… chunks=3

# Download a file
node src/cli.js download 0x<fileId> ./output.pdf --verbose
# → Downloaded: ./output.pdf

# List indexed files
node src/cli.js list
# → 0x…  myfile.pdf  142384B  chunks=6  owner=0x…

# Sync the local index
node src/cli.js sync --verbose
# → Sync complete.
```

See [docs/USAGE.md](docs/USAGE.md) for more examples.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CHAINFS_RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `CHAINFS_CONTRACT` | *(required)* | Deployed ChainFS contract address |
| `CHAINFS_PRIVATE_KEY` | *(required for upload)* | Signer private key |
| `CHAINFS_DB_PATH` | `~/.chainfs/chainfs.db` | SQLite blob-store path |
| `CHAINFS_INDEX_DB_PATH` | `./data/chainfs.db` | SQLite index DB path |

Copy `.env.example` to `.env` and fill in the values.

---

## Smart Contract API

### `createFile(bytes32 fileId, string name, uint256 size, uint256 chunkCount)`

Registers a new file on-chain. Emits `FileCreated`.

- `fileId` — `0x` + SHA-256 of the uncompressed file content (bytes32).
- `name` — Human-readable filename.
- `size` — Total uncompressed size in bytes.
- `chunkCount` — Number of chunks the file was split into.

### `uploadChunk(bytes32 fileId, uint256 chunkIndex, bytes data)`

Uploads one chunk of compressed file data. Emits `ChunkUploaded`.
`data` is limited to `MAX_CHUNK_SIZE` (24 576 bytes) per transaction.

### `getFile(bytes32 fileId) → (name, size, chunkCount, owner)`

Read-only convenience getter for on-chain metadata.

---

## Database Schema

### Blob store (`db.js`)

| Table | Key columns | Purpose |
|---|---|---|
| `files` | `file_id`, `name`, `size`, `chunk_count`, `owner` | Registered file metadata |
| `chunks` | `file_id`, `chunk_index`, `data` (BLOB) | Cached raw chunk bytes |
| `sync_state` | `key`, `value` | Indexer bookkeeping |

### Index DB (`db-manager.js`)

| Table | Key columns | Purpose |
|---|---|---|
| `files` | `file_id`, `original_size`, `total_chunks`, `content_hash` | File index (no BLOBs) |
| `chunks` | `file_id`, `chunk_index`, `chunk_hash` | Chunk hash index |
| `sync_state` | `key`, `value` (INTEGER) | Last synced block |

---

## Running Tests

```bash
npm test
```

Tests cover: smart contract validation, storage-bot unit tests, downloader-bot unit
tests, database module, and an end-to-end upload→download integration test.

---

## Design Principles

| Constraint | Approach |
|---|---|
| Event logs not queryable on-chain | Off-chain SQLite index built from `queryFilter` |
| EVM transaction data size limit | Chunks capped at 24 576 bytes |
| Low cost | Data in event logs, not contract storage |
| Integrity | SHA-256 fileId verified after every reconstruction |
| Compression | gzip applied before chunking |
| Reliability | Exponential back-off retries on all RPC calls |
