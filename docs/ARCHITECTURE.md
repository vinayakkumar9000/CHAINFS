# ChainFS Architecture

## Overview
ChainFS is a decentralized file storage system built on EVM.

## Core Design
- File data stored in event logs (cheap)
- Metadata stored minimally in contract
- Local SQLite DB for indexing
- CLI bots for interaction

## Components

### Smart Contract
- createFile()
- uploadChunk()

### Storage Bot
- compress → chunk → upload

### Downloader Bot
- fetch logs → reconstruct → verify

### Database
- files
- chunks
- sync_state

### CLI
- upload
- download
- list
- sync

## Constraints
- event logs not queryable on-chain
- must use off-chain indexing

## Goals
- low cost
- scalable
- reliable
