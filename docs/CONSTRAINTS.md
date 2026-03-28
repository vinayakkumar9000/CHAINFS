# ChainFS Design Constraints

| Constraint | Enforcement |
|---|---|
| Event logs are primary storage | All file bytes emitted via `ChunkUploaded`; nothing stored in contract storage |
| Contract storage must be minimal | Only `FileMetadata` (name, size, chunkCount, owner) lives on-chain |
| Cannot query events on-chain | Off-chain SQLite index built by replaying logs via `queryFilter` |
| Must use off-chain indexing | `SyncEngine` (Node.js) + `DatabaseManager` maintain the local index |
| Must support chunking | Files split into ≤ 24 576-byte chunks before upload |
| Must support retry logic | Exponential back-off applied to all RPC and transaction calls |
| Must verify data integrity | SHA-256(decompressed) compared against `fileId` after every download |
| Must use compression before upload | gzip applied to the entire file before chunking |
