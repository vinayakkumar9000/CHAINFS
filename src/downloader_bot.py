"""
DownloaderBot – reconstructs files from ChainFS ChunkUploaded events.

Design constraints:
- Handle everything as bytes (binary-safe).
- Fetch only relevant logs (filtered by fileId) with retries.
- Use parallel log fetching to reduce latency.
- Verify integrity via SHA-256 (matches StorageBot fileId derivation).
- Compatible with ChainFS StorageBot gzip compression.
"""

from __future__ import annotations

import gzip
import hashlib
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, TypeVar

T = TypeVar("T")

from web3 import Web3
from web3._utils.events import get_event_data


class DownloaderBot:
    def __init__(
        self,
        web3: Web3,
        contract_address: str,
        contract_abi: Sequence[Dict[str, Any]],
        db_path: Optional[str] = None,
        *,
        max_workers: int = 4,
        log_batch_size: int = 1_000,
        retry_attempts: int = 3,
        retry_backoff_seconds: float = 0.5,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be a positive integer")
        if log_batch_size <= 0:
            raise ValueError("log_batch_size must be a positive integer")

        self.web3 = web3
        self.contract = web3.eth.contract(
            address=Web3.to_checksum_address(contract_address), abi=contract_abi
        )
        self.max_workers = max_workers
        self.log_batch_size = log_batch_size
        # Enforce minimum retries to satisfy the "at least 3" requirement.
        self.retry_attempts = max(3, retry_attempts)
        self.retry_backoff_seconds = retry_backoff_seconds

        self.logger = logging.getLogger(__name__)
        self.conn: Optional[sqlite3.Connection] = None
        if db_path:
            db_dir = os.path.dirname(db_path)
            if db_dir:
                os.makedirs(db_dir, exist_ok=True)
            self.conn = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self._db_lock = threading.Lock()
            self._init_schema()

        # Cache ABIs/topics for decoding and filtering.
        self._chunk_event_abi = self.contract.events.ChunkUploaded().abi
        self._file_created_event_abi = self.contract.events.FileCreated().abi
        self._chunk_event_topic = Web3.keccak(text="ChunkUploaded(bytes32,uint256,bytes)").hex()
        self._file_created_event_topic = Web3.keccak(
            text="FileCreated(bytes32,string,uint256,uint256,address)"
        ).hex()

    # --------------------------------------------------------------------- #
    # Public API (pipeline primitives)
    # --------------------------------------------------------------------- #

    def resolve_file_id(self, tx_hash: str) -> str:
        """
        Derive fileId from a transaction hash by decoding FileCreated/ChunkUploaded logs.
        """
        receipt = self._call_with_retries(lambda: self.web3.eth.get_transaction_receipt(tx_hash))
        for log in receipt.get("logs", []):
            if log.get("address", "").lower() != self.contract.address.lower():
                continue
            topic0 = self._hex(log["topics"][0])
            if topic0 == self._file_created_event_topic:
                decoded = get_event_data(self.web3.codec, self._file_created_event_abi, log)
                return self._normalize_file_id(decoded["args"]["fileId"])
            if topic0 == self._chunk_event_topic:
                decoded = get_event_data(self.web3.codec, self._chunk_event_abi, log)
                return self._normalize_file_id(decoded["args"]["fileId"])
        raise ValueError("Unable to resolve fileId from transaction receipt")

    def get_file_metadata(self, file_id: str) -> Dict[str, Any]:
        """
        Fetch on-chain metadata for a fileId and persist it locally if a DB is configured.
        """
        fid = self._normalize_file_id(file_id)
        name, size, chunk_count, owner = self._call_with_retries(
            lambda: self.contract.functions.getFile(fid).call()
        )
        metadata = {
            "fileId": fid,
            "name": name,
            "size": int(size),
            "totalChunks": int(chunk_count),
            "owner": owner,
            # StorageBot derives fileId as SHA-256 of original data, so contentHash == fileId.
            "contentHash": fid,
        }
        if self.conn:
            self._upsert_file(metadata)
        return metadata

    def fetch_chunk_events(
        self,
        file_id: str,
        *,
        from_block: Optional[int] = None,
        to_block: Optional[int] = None,
        total_chunks: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Fetch ChunkUploaded events for file_id using parallel range queries.
        Includes cached chunks from SQLite (if present) to avoid repeated RPCs.
        """
        fid = self._normalize_file_id(file_id)
        events: List[Dict[str, Any]] = []

        # Use cached chunks first to reduce RPC load.
        cached = self._load_cached_chunks(fid) if self.conn else []
        events.extend(cached)
        if total_chunks is not None and len(cached) >= total_chunks:
            return events

        latest_block = self._call_with_retries(lambda: self.web3.eth.block_number)
        start_block = 0 if from_block is None else from_block
        end_block = latest_block if to_block is None else to_block
        if start_block > end_block:
            raise ValueError("from_block cannot be greater than to_block")

        ranges = self._build_block_ranges(start_block, end_block, self.log_batch_size)
        if not ranges:
            return events

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = [
                executor.submit(self._get_chunk_logs_for_range, fid, r_start, r_end) for r_start, r_end in ranges
            ]
            for future in as_completed(futures):
                decoded_logs = future.result()
                for log in decoded_logs:
                    events.append(log)
                    if self.conn:
                        self._persist_chunk_from_event(fid, log)

        return events

    def extract_chunks(self, events: Iterable[Dict[str, Any]], file_id: Optional[str] = None) -> List[Tuple[int, bytes]]:
        """
        Convert decoded events (or cached rows) into a deduplicated list of (chunkIndex, bytes).
        Duplicate indices are overwritten by the last occurrence.
        """
        chunk_map: Dict[int, bytes] = {}
        for evt in events:
            if "args" in evt:
                idx = int(evt["args"]["chunkIndex"])
                data = bytes(evt["args"]["data"])
            else:
                idx = int(evt["chunkIndex"])
                data = bytes(evt["data"])
            if idx in chunk_map:
                self.logger.warning(
                    "Duplicate chunk index %s encountered for file %s; overwriting previous data",
                    idx,
                    file_id or "unknown",
                )
            chunk_map[idx] = data  # overwrites duplicates safely
        return [(idx, chunk_map[idx]) for idx in sorted(chunk_map)]

    def validate_chunks(self, chunks: Sequence[Tuple[int, bytes]], total_chunks: int) -> None:
        """
        Ensure we have exactly total_chunks chunks; raise if missing.
        """
        unique_indices = {idx for idx, _ in chunks}
        if len(unique_indices) != total_chunks:
            missing = set(range(total_chunks)) - unique_indices
            raise ValueError(f"Missing chunks: {sorted(missing)}")

    def reconstruct_data(self, chunks: Sequence[Tuple[int, bytes]]) -> bytes:
        """
        Sort by chunkIndex and concatenate raw bytes.
        """
        ordered = [data for _, data in sorted(chunks, key=lambda pair: pair[0])]
        return b"".join(ordered)

    def decompress_data(self, data: bytes) -> bytes:
        """
        Decompress gzip-compressed bytes. Raises on corruption.
        """
        try:
            return gzip.decompress(data)
        except OSError as exc:
            raise ValueError(f"Decompression failed (gzip data may be corrupted): {exc}") from exc

    def verify_hash(self, data: bytes, expected_hash: str) -> bool:
        """
        Compare SHA-256 digest (0x-prefixed hex) to expected_hash.
        """
        digest = self._hash_bytes(data)
        normalized_expected = self._normalize_hash(expected_hash)
        return digest.lower() == normalized_expected.lower()

    def save_file(self, file_path: str, data: bytes) -> None:
        """
        Write bytes to disk (binary-safe).
        """
        dir_name = os.path.dirname(file_path)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)
        with open(file_path, "wb") as handle:
            handle.write(data)

    # --------------------------------------------------------------------- #
    # Orchestrator
    # --------------------------------------------------------------------- #

    def download(
        self,
        *,
        file_id: Optional[str] = None,
        tx_hash: Optional[str] = None,
        output_path: str,
        from_block: Optional[int] = None,
        to_block: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Full pipeline: resolve → metadata → fetch → reconstruct → decompress → verify → save.
        """
        if not file_id:
            if not tx_hash:
                raise ValueError("Either file_id or tx_hash must be provided")
            file_id = self.resolve_file_id(tx_hash)

        metadata = self.get_file_metadata(file_id)
        events = self.fetch_chunk_events(
            metadata["fileId"],
            from_block=from_block,
            to_block=to_block,
            total_chunks=metadata["totalChunks"],
        )
        chunks = self.extract_chunks(events, file_id=metadata["fileId"])
        self.validate_chunks(chunks, metadata["totalChunks"])
        compressed = self.reconstruct_data(chunks)
        decompressed = self.decompress_data(compressed)
        computed_hash = self._hash_bytes(decompressed)
        if not self.verify_hash(decompressed, metadata["contentHash"]):
            raise ValueError(
                f"Content integrity verification failed: computed SHA256 {computed_hash} does not match expected {metadata['contentHash']}"
            )
        self.save_file(output_path, decompressed)
        return metadata

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _init_schema(self) -> None:
        assert self.conn is not None
        self.conn.execute(
            """
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
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
              file_id      TEXT    NOT NULL,
              chunk_index  INTEGER NOT NULL,
              data         BLOB    NOT NULL,
              tx_hash      TEXT,
              block_number INTEGER,
              PRIMARY KEY (file_id, chunk_index)
            );
            """
        )
        self.conn.commit()

    def _upsert_file(self, metadata: Dict[str, Any]) -> None:
        assert self.conn is not None
        with self._db_lock:
            self.conn.execute(
                """
                INSERT INTO files (file_id, name, size, chunk_count, owner, tx_hash, block_number)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_id) DO UPDATE SET
                  name=excluded.name,
                  size=excluded.size,
                  chunk_count=excluded.chunk_count,
                  owner=excluded.owner
                """,
                (
                    metadata["fileId"],
                    metadata["name"],
                    metadata["size"],
                    metadata["totalChunks"],
                    metadata["owner"],
                    None,
                    None,
                ),
            )
            self.conn.commit()

    def _load_cached_chunks(self, file_id: str) -> List[Dict[str, Any]]:
        assert self.conn is not None
        with self._db_lock:
            rows = self.conn.execute(
                "SELECT chunk_index, data, tx_hash, block_number FROM chunks WHERE file_id = ?",
                (file_id,),
            ).fetchall()
        events: List[Dict[str, Any]] = []
        for row in rows:
            events.append(
                {
                    "chunkIndex": int(row["chunk_index"]),
                    "data": bytes(row["data"]),
                    "txHash": row["tx_hash"],
                    "blockNumber": row["block_number"],
                    "source": "cache",
                }
            )
        return events

    def _persist_chunk_from_event(self, file_id: str, event: Dict[str, Any]) -> None:
        assert self.conn is not None
        chunk_index = int(event["args"]["chunkIndex"])
        data = bytes(event["args"]["data"])
        with self._db_lock:
            self.conn.execute(
                """
                INSERT OR REPLACE INTO chunks (file_id, chunk_index, data, tx_hash, block_number)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    file_id,
                    chunk_index,
                    sqlite3.Binary(data),
                    event.get("transactionHash"),
                    event.get("blockNumber"),
                ),
            )
            self.conn.commit()

    def _get_chunk_logs_for_range(self, file_id: str, start_block: int, end_block: int) -> List[Dict[str, Any]]:
        filter_params = {
            "fromBlock": start_block,
            "toBlock": end_block,
            "address": self.contract.address,
            "topics": [self._chunk_event_topic, file_id],
        }
        raw_logs = self._call_with_retries(lambda: self.web3.eth.get_logs(filter_params))
        return [
            get_event_data(self.web3.codec, self._chunk_event_abi, log) for log in raw_logs
        ]

    def _build_block_ranges(self, start: int, end: int, size: int) -> List[Tuple[int, int]]:
        ranges: List[Tuple[int, int]] = []
        cursor = start
        while cursor <= end:
            upper = min(end, cursor + size - 1)
            ranges.append((cursor, upper))
            cursor = upper + 1
        return ranges

    @staticmethod
    def _hash_bytes(data: bytes) -> str:
        return "0x" + hashlib.sha256(data).hexdigest()

    def _call_with_retries(self, fn: Callable[[], T]) -> T:
        last_error: Optional[Exception] = None
        for attempt in range(1, self.retry_attempts + 1):
            try:
                return fn()
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as exc:
                last_error = exc
                if attempt == self.retry_attempts:
                    break
                time.sleep(self.retry_backoff_seconds * (2 ** (attempt - 1)))
        assert last_error is not None
        raise last_error

    @staticmethod
    def _hex(topic: Any) -> str:
        return topic.hex() if hasattr(topic, "hex") else Web3.to_hex(topic)

    @staticmethod
    def _normalize_file_id(file_id: Any) -> str:
        if isinstance(file_id, (bytes, bytearray)):
            fid = Web3.to_hex(file_id)
        elif isinstance(file_id, str):
            fid = file_id if file_id.startswith("0x") else f"0x{file_id}"
        else:
            fid = Web3.to_hex(file_id)

        hex_body = fid[2:] if fid.startswith("0x") else fid
        padded = hex_body.zfill(64)
        return f"0x{padded}"

    @staticmethod
    def _normalize_hash(value: Any) -> str:
        if isinstance(value, (bytes, bytearray)):
            return Web3.to_hex(value)
        text = str(value)
        return text if text.startswith("0x") else f"0x{text}"
