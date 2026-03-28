# CHAINFS

A decentralized file storage system built on EVM. File data is stored cheaply in event logs; only minimal metadata lives on-chain. A local SQLite index and off-chain CLI bots make upload, download, listing and syncing straightforward.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI  (upload / download / list / sync)                  │
│    ├─ storage-bot   compress → chunk → upload            │
│    └─ downloader-bot fetch logs → reconstruct → verify   │
│                                                          │
│  SQLite DB  (files · chunks · sync_state)                │
│                                                          │
│  Smart Contract – ChainFS.sol                            │
│    ├─ createFile()   → FileCreated  event                │
│    └─ uploadChunk()  → ChunkUploaded event               │
└─────────────────────────────────────────────────────────┘
```

### Why event logs?

Storing data in EVM event logs is far cheaper than contract storage. Events are not accessible on-chain (i.e. you cannot read them in Solidity), so ChainFS maintains an off-chain SQLite index built by replaying logs from the RPC node.

---

## Repository Layout

```
contracts/
  ChainFS.sol          Solidity smart contract
scripts/
  deploy.js            Deployment helper
src/
  db.js                SQLite database helpers (node:sqlite)
  storage-bot.js       compress → chunk → upload pipeline
  downloader-bot.js    fetch logs → reconstruct → verify pipeline
  cli.js               Commander-based CLI entry point
test/
  ChainFS.test.js      Contract + unit + integration tests
hardhat.config.js
package.json
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 22.5.0 (uses the built-in `node:sqlite` module)
- An EVM-compatible RPC endpoint (local Hardhat node or public testnet)

### Install

```bash
npm install
```

### Compile the contract

```bash
npm run compile
```

### Run tests

```bash
npm test
```

### Deploy

```bash
# Start a local Hardhat node in one terminal
npx hardhat node

# Deploy in another terminal
npm run deploy:local
# → prints: ChainFS deployed to: 0x…
```

---

## CLI Usage

Set the required environment variables:

```bash
export CHAINFS_RPC_URL=http://127.0.0.1:8545   # default
export CHAINFS_CONTRACT=0x<deployed address>
export CHAINFS_PRIVATE_KEY=0x<your private key>  # required for upload
export CHAINFS_DB_PATH=/path/to/chainfs.db        # optional
```

### Upload a file

```bash
node src/cli.js upload ./myfile.pdf --verbose
# Uploaded: fileId=0x… chunks=3
```

### Download a file

```bash
node src/cli.js download 0x<fileId> ./output.pdf --verbose
# Downloaded: ./output.pdf
```

### List indexed files

```bash
node src/cli.js list
# 0x…  myfile.pdf  142384B  chunks=6  owner=0x…
```

### Sync the local index

```bash
node src/cli.js sync --verbose
# Syncing from block 0…
# Sync complete.
```

---

## Smart Contract API

### `createFile(bytes32 fileId, string name, uint256 size, uint256 chunkCount)`

Registers a new file on-chain. Emits `FileCreated`.

- `fileId` — `keccak256` / `sha256` of the uncompressed file content (bytes32).
- `name` — Human-readable filename.
- `size` — Total uncompressed size in bytes.
- `chunkCount` — Number of chunks the file was split into.

### `uploadChunk(bytes32 fileId, uint256 chunkIndex, bytes data)`

Uploads one chunk of compressed file data. Emits `ChunkUploaded`. The `data` field is limited to `MAX_CHUNK_SIZE` (24 576 bytes) per transaction.

### `getFile(bytes32 fileId) → (name, size, chunkCount, owner)`

Read-only convenience getter for on-chain metadata.

---

## Database Schema

| Table        | Key columns                                      | Purpose                       |
|--------------|--------------------------------------------------|-------------------------------|
| `files`      | `file_id`, `name`, `size`, `chunk_count`, `owner` | Indexed file metadata         |
| `chunks`     | `file_id`, `chunk_index`, `data`                 | Cached chunk blobs            |
| `sync_state` | `key`, `value`                                   | Indexer bookkeeping (e.g. last synced block) |

---

## Design Constraints

| Constraint | Approach |
|---|---|
| Event logs not queryable on-chain | Off-chain SQLite index built from `queryFilter` |
| Transaction data size limit | Chunks capped at 24 576 bytes |
| Low cost | Data in logs, not storage |
| Integrity | SHA-256 fileId verified after reconstruction |
