# ChainFS

**ChainFS** is a decentralized file storage system. Your files are stored on a
blockchain — meaning no central server owns your data. File content lives in
on-chain transaction event logs; only small metadata is written to contract
storage. A simple command-line tool (`chaincli`) handles everything: wallet
setup, contract deployment, upload, and download.

> **Network:** SKALE Base Sepolia Testnet — transactions use the free native
> `CREDIT` token (obtain from the faucet at no cost).

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [First Run — ManagerBot](#first-run--managerbot)
5. [CLI Commands](#cli-commands)
6. [Deployment Flow](#deployment-flow)
7. [Project Structure](#project-structure)
8. [Running on a VPS / Background](#running-on-a-vps--background)
9. [Common Errors](#common-errors)
10. [Security Notes](#security-notes)
11. [Network Details](#network-details)

---

## How It Works

```
You → chaincli → ManagerBot (wallet + contract) → SKALE Testnet
                          ↓
              StorageBot  (compress → chunk → upload)
              DownloaderBot (fetch → verify → save)
                          ↓
              Local SQLite (index + cache)
```

1. **ManagerBot** creates or imports your wallet and deploys the smart contract
   once — automatically. You never touch Solidity or deployment scripts.
2. **StorageBot** compresses your file, splits it into chunks, and sends each
   chunk to the blockchain as an event log.
3. **DownloaderBot** reads those events back, reconstructs the file, verifies
   the checksum, and saves it locally.

---

## Prerequisites

| Tool | Minimum version | How to check |
|---|---|---|
| **Node.js** | **22.5.0** | `node --version` |
| **npm** | 10+ | `npm --version` |
| **Python** | **3.9** | `python3 --version` |
| **pip** | 23+ | `pip --version` |
| **Git** | any | `git --version` |

### Install Node.js 22 (if needed)

**Ubuntu / Debian**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**macOS (Homebrew)**
```bash
brew install node@22
```

**Windows**
Download the installer from https://nodejs.org and choose version 22 LTS.

---

## Installation

### 1 — Clone the repository

```bash
git clone https://github.com/vinayakkumar9000/CHAINFS.git
cd CHAINFS
```

### 2 — Install Node.js dependencies

```bash
npm install
```

### 3 — Install Python dependencies

```bash
pip install -r requirements.txt
```

### 4 — Compile the smart contract

```bash
npm run compile
```

This generates `artifacts/contracts/ChainFS.sol/ChainFS.json`, which
ManagerBot uses to deploy the contract. **You only need to do this once.**

---

## First Run — ManagerBot

> ManagerBot is the starting point. It sets up your wallet and deploys the
> ChainFS contract automatically. **You do not need to deploy anything manually.**

Run:

```bash
python chaincli manager
```

You will see:

```
=== ChainFS ManagerBot ===
Network: SKALE Base Sepolia Testnet
RPC: https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha

Select an option:
  1) Create new wallet
  2) Use existing private key
Enter choice (1 or 2):
```

---

### Option 1 — Create a new wallet

Type `1` and press Enter.

```
New wallet generated.
Address    : 0xYourWalletAddress
PRIVATE KEY: (write this down and keep it secure)
0xYourPrivateKeyHere

WARNING: Do not share this private key. It grants full access to funds.
Private key saved to config/wallet_private_key.txt (permissions restricted).

Fund this address using the faucet before continuing:
  https://base-sepolia-faucet.skale.space
Press ENTER after funding the address...
```

**Steps:**
1. Copy your wallet address.
2. Open the faucet: https://base-sepolia-faucet.skale.space
3. Paste your address and request test CREDIT tokens.
4. Press **Enter** in the terminal once the faucet transaction is confirmed.

---

### Option 2 — Import an existing private key

Type `2` and press Enter.

```
Enter your private key (0x...): 0xYourPrivateKey
Using wallet: 0xYourWalletAddress
```

If the wallet has no balance, you will be prompted to use the faucet (same as above).

---

### After funding — automatic contract deployment

Once your wallet has a balance, ManagerBot checks whether a contract is already
deployed for your wallet:

**Contract already deployed:**
```
ChainFS contract already deployed.
Contract address: 0xDeployedContractAddress
Wallet address : 0xYourWalletAddress
Wallet balance : 0.5 CREDIT
```

**No contract yet — deploy now:**
```
No contract deployed yet.
Do you want to deploy ChainFS contract now? (y/n): y

Deployment submitted. Tx hash: 0xTxHash...

ChainFS is ready to use.
Contract Address : 0xDeployedContractAddress
Transaction Hash : 0xTxHash
Wallet Address   : 0xYourWalletAddress
Wallet Balance   : 0.49 CREDIT
```

The contract address is saved to `config/contract.json` automatically.
All other `chaincli` commands read it from there — **no extra configuration needed**.

---

## CLI Commands

All commands use the same `chaincli` entry point. Run from the `CHAINFS` folder.

### Upload a file

```bash
python chaincli upload ./myfile.pdf
```

Output:
```
Uploading myfile.pdf...

Upload complete ✔
File ID: 0xabc123...
```

The File ID is your permanent reference to this file on the blockchain.

---

### Download a file

```bash
python chaincli download 0xabc123...
```

Output:
```
Downloading...

Download complete ✔
Saved to: downloads/myfile.pdf
```

Files are saved to the `downloads/` folder.

---

### List all files

```bash
python chaincli list
```

Output:
```
File ID               Name          Size
--------------------------------------------
0xabc123...           myfile.pdf    1.4 MB
0xdef456...           photo.jpg     320.5 KB
```

> If the list is empty, run `chaincli sync` first to index the chain.

---

### Sync local index with the blockchain

```bash
python chaincli sync
```

Output:
```
Syncing...

Sync complete ✔
```

This fetches new events from the chain and updates your local SQLite index.

---

### Show file details

```bash
python chaincli info 0xabc123...
```

Output:
```
File ID : 0xabc123...
Name    : myfile.pdf
Size    : 1.4 MB
Chunks  : 6
Owner   : 0xYourWalletAddress
Block   : 4820311
```

---

## Deployment Flow

Here is what happens end-to-end when you run `chaincli manager`:

```
1. ManagerBot connects to SKALE Base Sepolia RPC
2. You choose: create wallet OR import private key
3. Wallet address is displayed
4. ManagerBot checks your CREDIT balance
   ├─ Balance = 0 → prompts you to use the faucet, waits for you to confirm
   └─ Balance > 0 → continues
5. ManagerBot checks config/contract.json
   ├─ Contract found and valid → shows address, exits (nothing to do)
   └─ Contract not found → asks confirmation, then deploys
6. Contract deployed → address saved to config/contract.json
7. System is ready — chaincli upload/download/list/sync all work
```

You never need to run `hardhat deploy` or touch Solidity directly.

---

## Project Structure

```
CHAINFS/
├── contracts/
│   └── ChainFS.sol              Smart contract source
├── scripts/
│   └── deploy.js                Hardhat deployment helper (used internally)
├── src/
│   ├── manager_bot.py           Wallet setup + contract deployment
│   ├── storage_bot.py           Python upload pipeline
│   ├── downloader_bot.py        Python download pipeline
│   ├── storage-bot.js           Node.js upload pipeline
│   ├── downloader-bot.js        Node.js download pipeline
│   ├── sync-engine.js           On-chain event indexer
│   ├── cli.js                   Node.js CLI (sync command)
│   ├── db.js                    SQLite blob store (chunk cache)
│   └── db-manager.js            SQLite index DB (sync / list)
├── chaincli                     Python CLI entry point ← start here
├── config/                      Created by ManagerBot
│   ├── contract.json            Deployed contract address
│   └── wallet_private_key.txt   Your private key (mode 600)
├── artifacts/                   Generated by npm run compile
├── data/
│   └── chainfs.db               Local file index (SQLite)
├── downloads/                   Downloaded files saved here
├── test/
│   └── ChainFS.test.js          Contract + integration tests
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SETUP.md
│   └── USAGE.md
├── package.json
├── requirements.txt
└── .env.example
```

---

## Running on a VPS / Background

If you are running ChainFS on a remote server (VPS) and want it to keep running
after you close your SSH session, use `screen` or `tmux`.

### Using screen

```bash
# Install (Ubuntu)
sudo apt-get install screen

# Start a named session
screen -S chainfs

# Run your command inside screen
python chaincli sync

# Detach without stopping: press Ctrl+A then D

# Reattach later
screen -r chainfs
```

### Using tmux

```bash
# Install (Ubuntu)
sudo apt-get install tmux

# Start a session
tmux new -s chainfs

# Run your command
python chaincli sync

# Detach: press Ctrl+B then D

# Reattach later
tmux attach -t chainfs
```

---

## Common Errors

### `Insufficient funds` / Balance is still 0

Your wallet has no CREDIT tokens. Use the faucet:

```
https://base-sepolia-faucet.skale.space
```

Paste your wallet address, request tokens, wait ~30 seconds for confirmation,
then press Enter in the ManagerBot prompt.

---

### `Unable to connect to RPC`

The SKALE testnet RPC is unreachable. Check your internet connection. The RPC
endpoint is:

```
https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
```

Try opening it in a browser — if it returns a JSON response, it is up. If
the error persists, wait a few minutes and try again.

---

### `Invalid private key format`

The private key you entered is malformed. Make sure it is 64 hex characters,
optionally prefixed with `0x`. Example of a valid format:

```
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Do not include spaces, line breaks, or extra characters.

---

### `Contract artifact not found. Run npm run compile first.`

You skipped the compile step. Run:

```bash
npm run compile
```

---

### `No contract deployed. Run chaincli manager first.`

You are running `upload`, `download`, `list`, or `sync` without having run
ManagerBot first. Run:

```bash
python chaincli manager
```

---

### `File not found` (download)

The file ID you provided does not exist on the chain, or you have a typo.
Run `chaincli list` to see available file IDs, then run `chaincli sync` to make
sure your local index is up to date.

---

## Security Notes

| Rule | Details |
|---|---|
| **Private key stored locally only** | Saved to `config/wallet_private_key.txt` with restricted permissions (mode 600). It is never sent to any server. |
| **Never share your private key** | Anyone with your private key can spend your funds. |
| **Testnet only** | This system is configured for the SKALE Base Sepolia Testnet. Do not use real funds. |
| **`.env` not committed** | `.env` and `config/wallet_private_key.txt` are in `.gitignore` — they will not be accidentally pushed to GitHub. |

---

## Network Details

| Property | Value |
|---|---|
| Network Name | SKALE Base Sepolia |
| RPC URL | `https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha` |
| Explorer | https://base-sepolia-testnet-explorer.skalenodes.com/ |
| Native Token | CREDIT |
| Decimals | 18 |
| Chain ID | 324705682 |
| Chain ID (Hex) | 0x135A9D92 |
| Faucet | https://base-sepolia-faucet.skale.space |

---

## Smart Contract

ChainFS.sol is a minimal, event-based contract with no complex logic and no
reentrancy risks. Data is not stored in contract state — it lives in event logs.

| Function | Description |
|---|---|
| `createFile(fileId, name, size, chunkCount)` | Registers a new file. Emits `FileCreated`. |
| `uploadChunk(fileId, chunkIndex, data)` | Uploads one chunk (≤ 24 576 bytes). Emits `ChunkUploaded`. |
| `getFile(fileId)` | Returns metadata: name, size, chunkCount, owner. |

---

## Running Tests

```bash
npm test
```

Tests use an in-memory Hardhat EVM node — no funded wallet or external RPC needed.

---

## Advanced — Node.js CLI

The Node.js CLI (`node src/cli.js`) is an alternative interface for scripted usage.
It requires environment variables instead of the ManagerBot config:

```bash
export CHAINFS_RPC_URL=https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
export CHAINFS_CONTRACT=0x<deployed contract address>
export CHAINFS_PRIVATE_KEY=0x<your private key>

node src/cli.js upload ./myfile.pdf --verbose
node src/cli.js download 0x<fileId> ./output.pdf --verbose
node src/cli.js list
node src/cli.js sync --verbose
```

For most users, the Python `chaincli` interface is recommended.
