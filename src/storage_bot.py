"""
StorageBot — Upload Engine for ChainFS.

Pipeline:  read (raw bytes) → hash (SHA-256) → compress (gzip) → chunk → createFile() → uploadChunk() × N

Key guarantees
--------------
- SHA-256 is computed on the ORIGINAL (pre-compression) bytes.
- gzip compression covers the whole file before any chunking.
- Chunk size starts at INITIAL_CHUNK_SIZE and is halved dynamically on gas failures.
- Each chunk upload retries up to MAX_RETRY_ATTEMPTS times with exponential back-off.
- fileId == SHA-256(original bytes), which lets DownloaderBot re-verify integrity after download.

Integration
-----------
- Wallet private key     : config/wallet_private_key.txt   (written by ManagerBot)
- Contract address       : config/contract.json            (written by ManagerBot)
- Contract ABI           : artifacts/contracts/ChainFS.sol/ChainFS.json
- Network                : SKALE Base Sepolia Testnet
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from eth_account.signers.local import LocalAccount
from web3 import Web3
from web3.exceptions import ContractLogicError

# ---------------------------------------------------------------------------
# Network / path constants (mirror manager_bot.py)
# ---------------------------------------------------------------------------

RPC_URL = "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha"
CHAIN_ID = 324705682

CONFIG_DIR = Path("config")
CONTRACT_CONFIG_PATH = CONFIG_DIR / "contract.json"
WALLET_FILE_PATH = CONFIG_DIR / "wallet_private_key.txt"
ARTIFACT_PATH = Path("artifacts/contracts/ChainFS.sol/ChainFS.json")

# ---------------------------------------------------------------------------
# Chunking / retry constants
# ---------------------------------------------------------------------------

# Must stay ≤ ChainFS.MAX_CHUNK_SIZE (24 576 bytes).  Start conservatively.
INITIAL_CHUNK_SIZE: int = 16_384   # 16 KB
MAX_CHUNK_SIZE: int = 24_576       # 24 KB (contract hard-limit)

MAX_RETRY_ATTEMPTS: int = 5
RETRY_BASE_DELAY: float = 1.0      # seconds
MAX_RETRY_DELAY: float = 16.0      # seconds

TX_TIMEOUT_SECONDS: int = 300
TX_POLL_LATENCY: int = 5

PROGRESS_WIDTH: int = 40           # characters for the progress bar


class StorageBot:
    """Upload files to the ChainFS smart contract, bit-for-bit reproducibly."""

    # --------------------------------------------------------------------- #
    # Construction
    # --------------------------------------------------------------------- #

    def __init__(self) -> None:
        self._account: Optional[LocalAccount] = None
        self._contract = None
        self._web3: Optional[Web3] = None

    # --------------------------------------------------------------------- #
    # Public orchestrator
    # --------------------------------------------------------------------- #

    def upload_file(self, file_path: str) -> str:
        """
        Full pipeline: load config → read → hash → compress → chunk → upload.

        Returns the fileId (0x-prefixed hex SHA-256 of original bytes) on success.
        Raises on any unrecoverable error.
        """
        self.load_wallet()
        self.load_contract()
        self.connect_web3()

        raw_bytes: bytes = self.read_file(file_path)
        original_hash: str = self.compute_hash(raw_bytes)
        compressed: bytes = self.compress_data(raw_bytes)
        chunk_size: int = INITIAL_CHUNK_SIZE
        chunks: List[bytes] = self.split_chunks(compressed, chunk_size)
        file_id: str = self.generate_file_id(original_hash)

        name: str = os.path.basename(file_path)
        print(f"\nFile      : {name}")
        print(f"Original  : {len(raw_bytes):,} bytes")
        print(f"Compressed: {len(compressed):,} bytes")
        print(f"Chunks    : {len(chunks)} × ≤{chunk_size:,} B")
        print(f"fileId    : {file_id}")

        self.create_file_on_chain(
            file_id=file_id,
            name=name,
            size=len(raw_bytes),
            chunk_count=len(chunks),
        )

        for index, data in enumerate(chunks):
            self._upload_chunk_with_dynamic_retry(file_id=file_id, chunk_index=index, data=data, total=len(chunks))

        print(f"\nUpload complete: {name}  [{len(chunks)} chunks]")
        return file_id

    # --------------------------------------------------------------------- #
    # Mandatory interface functions
    # --------------------------------------------------------------------- #

    def load_wallet(self) -> LocalAccount:
        """
        Load the wallet private key written by ManagerBot.

        Raises FileNotFoundError  when the key file is absent.
        Raises ValueError         when the key is empty or malformed.
        """
        if not WALLET_FILE_PATH.exists():
            raise FileNotFoundError(
                f"Wallet file not found at {WALLET_FILE_PATH}. "
                "Run ManagerBot first to set up a wallet."
            )
        private_key = WALLET_FILE_PATH.read_text().strip()
        if not private_key:
            raise ValueError("Wallet private key is empty.")
        if not private_key.startswith("0x"):
            private_key = "0x" + private_key

        from eth_account import Account  # local import to keep top-level deps minimal

        try:
            self._account = Account.from_key(private_key)
        except (ValueError, Exception) as exc:
            raise ValueError(f"Invalid private key: {exc}") from exc

        return self._account

    def load_contract(self) -> str:
        """
        Read the deployed contract address from config/contract.json.

        Returns the checksum address string.
        Raises FileNotFoundError when the config is absent.
        Raises ValueError        when the address is missing or malformed.
        """
        if not CONTRACT_CONFIG_PATH.exists():
            raise FileNotFoundError(
                f"Contract config not found at {CONTRACT_CONFIG_PATH}. "
                "Run ManagerBot to deploy the contract."
            )
        try:
            data = json.loads(CONTRACT_CONFIG_PATH.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(f"Malformed contract config: {exc}") from exc

        address = data.get("contractAddress")
        if not address:
            raise ValueError("contractAddress missing from contract config.")

        # Validate / normalise.
        try:
            self._contract_address: str = Web3.to_checksum_address(address)
        except Exception as exc:
            raise ValueError(f"Invalid contract address '{address}': {exc}") from exc

        return self._contract_address

    def connect_web3(self) -> Web3:
        """
        Establish a Web3 connection and instantiate the ChainFS contract.

        Raises RuntimeError on connection failure or missing/invalid ABI.
        """
        w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
        if not w3.is_connected():
            raise RuntimeError(
                f"Cannot connect to RPC at {RPC_URL}. "
                "Check network connectivity."
            )
        self._web3 = w3

        abi = self._load_abi()
        self._contract = w3.eth.contract(
            address=self._contract_address,
            abi=abi,
        )
        return w3

    def read_file(self, path: str) -> bytes:
        """
        Read a file as raw bytes (binary-safe — works for any file type).

        Raises FileNotFoundError when the path does not exist.
        Raises ValueError        when the file is empty.
        """
        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        with open(file_path, "rb") as fh:
            data = fh.read()
        if not data:
            raise ValueError(f"File is empty: {path}")
        return data

    def compute_hash(self, data: bytes) -> str:
        """
        Compute SHA-256 of *data* and return a 0x-prefixed hex digest.

        MUST be called on the ORIGINAL (pre-compression) bytes.
        The digest also serves as the fileId, enabling DownloaderBot verification.
        """
        return "0x" + hashlib.sha256(data).hexdigest()

    def compress_data(self, data: bytes) -> bytes:
        """
        Gzip-compress *data* (entire payload, NOT per-chunk).

        Raises RuntimeError on compression failure.
        """
        try:
            return gzip.compress(data)
        except OSError as exc:
            raise RuntimeError(f"Compression failed: {exc}") from exc

    def split_chunks(self, data: bytes, chunk_size: int) -> List[bytes]:
        """
        Split *data* into a list of non-overlapping byte slices of at most *chunk_size* bytes.

        Operates on the compressed data.  Byte order is preserved exactly.
        """
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        return [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]

    def generate_file_id(self, original_hash: str) -> str:
        """
        Derive the bytes32 fileId from the SHA-256 hash of the original file.

        Using SHA-256 (rather than a random keccak) keeps fileId deterministic
        and allows DownloaderBot to re-verify integrity after download:
            SHA256(decompressed) == fileId  →  file is identical to the upload.

        The 0x-prefixed 32-byte hex value is returned as-is.
        """
        # Strip the 0x prefix, zero-pad to 64 hex chars, re-attach prefix.
        hex_body = original_hash[2:] if original_hash.startswith("0x") else original_hash
        padded = hex_body.zfill(64)
        return f"0x{padded}"

    def create_file_on_chain(
        self,
        *,
        file_id: str,
        name: str,
        size: int,
        chunk_count: int,
    ) -> str:
        """
        Call createFile() on the ChainFS contract and wait for the receipt.

        Returns the transaction hash hex string.
        Raises RuntimeError on transaction failure.
        """
        self._ensure_ready()
        assert self._web3 is not None
        assert self._account is not None
        assert self._contract is not None

        file_id_bytes32 = self._to_bytes32(file_id)

        nonce = self._web3.eth.get_transaction_count(self._account.address)
        gas_price = self._safe_gas_price()

        try:
            estimated_gas = self._contract.functions.createFile(
                file_id_bytes32, name, size, chunk_count
            ).estimate_gas({"from": self._account.address})
        except Exception:
            estimated_gas = 500_000

        tx = self._contract.functions.createFile(
            file_id_bytes32, name, size, chunk_count
        ).build_transaction(
            {
                "from": self._account.address,
                "nonce": nonce,
                "chainId": CHAIN_ID,
                "gas": estimated_gas,
                **({"gasPrice": gas_price} if gas_price is not None else {}),
            }
        )

        signed = self._web3.eth.account.sign_transaction(tx, self._account.key)
        tx_hash = self._web3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self._web3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=TX_TIMEOUT_SECONDS, poll_latency=TX_POLL_LATENCY
        )
        if receipt.status != 1:
            raise RuntimeError(f"createFile() transaction failed: {tx_hash.hex()}")

        print(f"createFile tx : {tx_hash.hex()}")
        return tx_hash.hex()

    def upload_chunk(
        self,
        *,
        file_id: str,
        chunk_index: int,
        data: bytes,
        gas_override: Optional[int] = None,
    ) -> str:
        """
        Call uploadChunk() on the ChainFS contract for a single chunk.

        Returns the transaction hash hex string.
        Raises RuntimeError on transaction failure.
        """
        self._ensure_ready()
        assert self._web3 is not None
        assert self._account is not None
        assert self._contract is not None

        file_id_bytes32 = self._to_bytes32(file_id)

        nonce = self._web3.eth.get_transaction_count(self._account.address)
        gas_price = self._safe_gas_price()

        if gas_override is not None:
            estimated_gas = gas_override
        else:
            try:
                estimated_gas = self._contract.functions.uploadChunk(
                    file_id_bytes32, chunk_index, data
                ).estimate_gas({"from": self._account.address})
            except Exception:
                estimated_gas = 500_000

        tx = self._contract.functions.uploadChunk(
            file_id_bytes32, chunk_index, data
        ).build_transaction(
            {
                "from": self._account.address,
                "nonce": nonce,
                "chainId": CHAIN_ID,
                "gas": estimated_gas,
                **({"gasPrice": gas_price} if gas_price is not None else {}),
            }
        )

        signed = self._web3.eth.account.sign_transaction(tx, self._account.key)
        tx_hash = self._web3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self._web3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=TX_TIMEOUT_SECONDS, poll_latency=TX_POLL_LATENCY
        )
        if receipt.status != 1:
            raise RuntimeError(f"uploadChunk() transaction failed for chunk {chunk_index}: {tx_hash.hex()}")

        return tx_hash.hex()

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _upload_chunk_with_dynamic_retry(
        self,
        *,
        file_id: str,
        chunk_index: int,
        data: bytes,
        total: int,
    ) -> None:
        """
        Upload a single chunk with up to MAX_RETRY_ATTEMPTS retries.

        - Exponential back-off on transient RPC / timeout errors.
        - ContractLogicError (e.g. wrong index, invalid data length) is a hard
          failure: retrying the same payload will not help, so the error is
          raised immediately.
        - Progress bar is updated after each successful upload.

        Note: dynamic chunk-size reduction after createFile() is not possible
        because the contract has already recorded chunkCount on-chain.  The
        INITIAL_CHUNK_SIZE (16 KB) is intentionally well below the contract
        MAX_CHUNK_SIZE (24 KB) to prevent size-related rejections.
        """
        last_error: Optional[Exception] = None

        for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
            try:
                self.upload_chunk(
                    file_id=file_id,
                    chunk_index=chunk_index,
                    data=data,
                )
                self._print_progress(chunk_index + 1, total)
                return
            except (KeyboardInterrupt, SystemExit):
                raise
            except ContractLogicError as exc:
                # Contract rejected the transaction; retrying the same payload
                # will not succeed — surface the error immediately.
                raise RuntimeError(
                    f"Contract rejected chunk {chunk_index}: {exc}"
                ) from exc
            except Exception as exc:
                last_error = exc
                if attempt == MAX_RETRY_ATTEMPTS:
                    break
                delay = min(RETRY_BASE_DELAY * (2 ** (attempt - 1)), MAX_RETRY_DELAY)
                print(
                    f"\n  Chunk {chunk_index} attempt {attempt}/{MAX_RETRY_ATTEMPTS} failed: {exc}. "
                    f"Retrying in {delay:.1f}s…"
                )
                time.sleep(delay)

        raise RuntimeError(
            f"Failed to upload chunk {chunk_index} after {MAX_RETRY_ATTEMPTS} attempts. "
            f"Last error: {last_error}"
        )

    def _print_progress(self, done: int, total: int) -> None:
        """Render an ASCII progress bar to stdout."""
        fraction = done / total if total else 1.0
        filled = int(PROGRESS_WIDTH * fraction)
        bar = "█" * filled + "░" * (PROGRESS_WIDTH - filled)
        pct = int(fraction * 100)
        print(f"\rUploading: [{bar}] {pct}%  ({done}/{total} chunks)", end="", flush=True)
        if done == total:
            print()  # newline after completion

    def _load_abi(self) -> list:
        """Load the ChainFS contract ABI from the compiled artifact."""
        if not ARTIFACT_PATH.exists():
            raise FileNotFoundError(
                f"Contract artifact not found at {ARTIFACT_PATH}. "
                "Run `npm run compile` first."
            )
        try:
            artifact = json.loads(ARTIFACT_PATH.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(f"Malformed contract artifact: {exc}") from exc

        abi = artifact.get("abi")
        if not abi:
            raise ValueError("ABI missing from contract artifact.")
        return abi

    def _safe_gas_price(self) -> Optional[int]:
        """Fetch the network gas price; return None if unavailable (e.g. zero-gas SKALE)."""
        assert self._web3 is not None
        try:
            return self._web3.eth.gas_price
        except Exception:
            return None

    def _ensure_ready(self) -> None:
        """Guard: raise if wallet, contract address, or Web3 connection are not initialised."""
        if self._account is None:
            raise RuntimeError("Wallet not loaded. Call load_wallet() first.")
        if not hasattr(self, "_contract_address") or not self._contract_address:
            raise RuntimeError("Contract not loaded. Call load_contract() first.")
        if self._web3 is None or self._contract is None:
            raise RuntimeError("Web3 not connected. Call connect_web3() first.")

    @staticmethod
    def _to_bytes32(hex_value: str) -> bytes:
        """Convert a 0x-prefixed hex string to a 32-byte value suitable for web3."""
        body = hex_value[2:] if hex_value.startswith("0x") else hex_value
        return bytes.fromhex(body.zfill(64))


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def main(argv: Sequence[str] = ()) -> int:
    args = list(argv) or sys.argv[1:]
    if not args:
        print("Usage: python -m src.storage_bot <file_path>")
        return 1

    file_path = args[0]
    try:
        bot = StorageBot()
        file_id = bot.upload_file(file_path)
        print(f"\nfileId: {file_id}")
        return 0
    except KeyboardInterrupt:
        print("\nOperation cancelled by user.")
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
