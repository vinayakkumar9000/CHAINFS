# ChainFS Usage Guide

ChainFS provides two CLI interfaces:

| CLI | Language | Entry point | Best for |
|---|---|---|---|
| `chaincli` | Python | `./chaincli` | Interactive use, testnet, full workflow |
| Node.js CLI | Node.js | `node src/cli.js` | Scripted use, local dev, CI |

---

## `chaincli` — Python CLI

### Prerequisites

- `chaincli manager` run at least once (creates wallet + deploys contract)
- `npm run compile` completed (Python bots load the ABI from the artifact)

### `chaincli manager`

Set up a wallet and deploy the ChainFS contract interactively.

```bash
chaincli manager
```

Example session:

```
=== ChainFS ManagerBot ===
Network: SKALE Base Sepolia Testnet
RPC: https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha

Select an option:
  1) Create new wallet
  2) Use existing private key
Enter choice (1 or 2): 1

New wallet generated.
Address    : 0xAbCd…
PRIVATE KEY: (write this down and keep it secure)
0xdeadbeef…

Fund this address using the faucet:
  https://base-sepolia-faucet.skale.space
Press ENTER after funding the address...

Wallet balance: 1.0 CREDIT

No contract deployed yet.
Do you want to deploy ChainFS contract now? (y/n): y

Deployment submitted. Tx hash: 0x…
ChainFS is ready to use.
Contract Address : 0x1234…
Wallet Address   : 0xAbCd…
Wallet Balance   : 0.98 CREDIT
```

After this step, `config/contract.json` and `config/wallet_private_key.txt` are
created and all subsequent `chaincli` commands use them automatically.

---

### `chaincli upload <file>`

Upload a file to ChainFS.

```bash
chaincli upload report.pdf
```

```
Uploading report.pdf...

File      : report.pdf
Original  : 245,678 bytes
Compressed: 198,432 bytes
Chunks    : 13 × ≤16,384 B
fileId    : 0xabc123…

createFile tx : 0x…
Uploading: [████████████████████████████████████████] 100%  (13/13 chunks)

Upload complete: report.pdf  [13 chunks]

Upload complete ✔
File ID: 0xabc123…
```

The returned `File ID` is the 0x-prefixed SHA-256 hash of the original file bytes.
Store it — you need it to download the file later.

---

### `chaincli download <file_id>`

Download a file from ChainFS. The file is saved to the `downloads/` directory under
its original filename.

```bash
chaincli download 0xabc123…
```

```
Downloading...

Download complete ✔
Saved to: downloads/report.pdf
```

After download, ChainFS verifies the SHA-256 hash of the reconstructed file against
the `fileId`. If they do not match, an error is raised and the file is not saved.

---

### `chaincli list`

List all files indexed in the local SQLite database.

```bash
chaincli list
```

```
File ID               Name           Size
────────────────────  ─────────────  ──────────
0xabc123...           report.pdf     240.0 KB
0xdef456...           photo.jpg        1.2 MB
0x789abc...           notes.txt       12.3 KB
```

> Run `chaincli sync` first if the list is empty.

---

### `chaincli sync`

Sync the local index database with on-chain events.

```bash
chaincli sync
```

```
Syncing...
Syncing blocks 1–847 (chain tip: 852, safe window: 5)
  1 batch(es) × up to 2000 blocks
    FileCreated=2  ChunkUploaded=15
Sync complete. Last synced block: 847.

Sync complete ✔
```

Subsequent syncs only scan new blocks (incremental).

---

### `chaincli info <file_id>`

Show detailed information about a specific file.

```bash
chaincli info 0xabc123…
```

```
File ID : 0xabc123…
Name    : report.pdf
Size    : 240.0 KB
Chunks  : 13
Owner   : 0xAbCd…
Block   : 42
```

You can also use a fileId prefix (as long as it is unambiguous):

```bash
chaincli info 0xabc12
```

---

## `node src/cli.js` — Node.js CLI

### Environment variables

```bash
export CHAINFS_RPC_URL=http://127.0.0.1:8545   # default
export CHAINFS_CONTRACT=0x<deployed address>    # required
export CHAINFS_PRIVATE_KEY=0x<private key>      # required for upload
export CHAINFS_DB_PATH=/path/to/chainfs.db      # optional blob store
export CHAINFS_INDEX_DB_PATH=./data/chainfs.db  # optional index DB
```

Or load from `.env`:

```bash
# Using a .env loader such as dotenv-cli:
npx dotenv -e .env -- node src/cli.js upload myfile.txt
```

---

### `node src/cli.js upload <filePath>`

```bash
node src/cli.js upload ./report.pdf
# Uploaded: fileId=0xabc123… chunks=13

node src/cli.js upload ./report.pdf --verbose
# Uploading: report.pdf
#   fileId : 0xabc123…
#   raw size: 245678 bytes
#   compressed: 198432 bytes
#   chunks: 13
#   createFile tx: 0x…
#   chunk 0 → tx 0x… (block 12)
#   chunk 1 → tx 0x… (block 13)
#   …
#   Done uploading report.pdf.
# Uploaded: fileId=0xabc123… chunks=13
```

---

### `node src/cli.js download <fileId> <outputPath>`

```bash
node src/cli.js download 0xabc123… ./output.pdf
# Downloaded: ./output.pdf

node src/cli.js download 0xabc123… ./output.pdf --verbose
#   compressed size: 198432 bytes
#   decompressed size: 245678 bytes
#   integrity check: OK
#   written to ./output.pdf
# Downloaded: ./output.pdf

# Start log query from a specific block (speeds up large chain queries)
node src/cli.js download 0xabc123… ./output.pdf --from-block 100
```

---

### `node src/cli.js list`

```bash
node src/cli.js list
# 0xabc123…  report.pdf  245678B  chunks=13  owner=0x…
# 0xdef456…  photo.jpg   1258291B chunks=52  owner=0x…
```

> Requires a prior `node src/cli.js sync` or upload to populate the index DB.

---

### `node src/cli.js sync`

```bash
node src/cli.js sync
# Sync complete.

node src/cli.js sync --verbose
# Syncing blocks 1–852 (chain tip: 857, safe window: 5)
#   1 batch(es) × up to 2000 blocks
#     FileCreated=2  ChunkUploaded=15
# Sync complete. Last synced block: 852.
# Sync complete.
```

---

## End-to-end test flow

The following steps exercise the full upload → sync → download pipeline using a local
Hardhat node.

```bash
# 1. Start local node
npx hardhat node

# 2. Deploy contract (new terminal)
npm run deploy:local
# Note the printed contract address

# 3. Set environment
export CHAINFS_RPC_URL=http://127.0.0.1:8545
export CHAINFS_CONTRACT=0x<printed address>
export CHAINFS_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 4. Upload a file
echo "Hello, ChainFS!" > /tmp/test.txt
node src/cli.js upload /tmp/test.txt --verbose
# Note the printed fileId

# 5. Sync the index
node src/cli.js sync --verbose

# 6. List files
node src/cli.js list

# 7. Download and verify
node src/cli.js download 0x<fileId> /tmp/output.txt --verbose
diff /tmp/test.txt /tmp/output.txt && echo "Files match ✔"

# 8. Verify SHA-256 manually
sha256sum /tmp/test.txt
# Compare first 64 hex chars with the fileId (strip 0x prefix)
```
