"""
ManagerBot — CLI-based wallet and deployment manager for ChainFS.

Responsibilities:
  - Wallet creation and loading from private key
  - Funding verification against SKALE Base Sepolia Testnet
  - Contract deployment (ChainFS) and local config persistence

Network config (mandatory):
  RPC: https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
  Chain ID: 324705682
  Native token: CREDIT (18 decimals)
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import Web3
from web3.exceptions import ContractLogicError


RPC_URL = "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha"
CHAIN_ID = 324705682
CONFIG_DIR = Path("config")
CONTRACT_CONFIG_PATH = CONFIG_DIR / "contract.json"
WALLET_FILE_PATH = CONFIG_DIR / "wallet_private_key.txt"
ARTIFACT_PATH = Path("artifacts/contracts/ChainFS.sol/ChainFS.json")
DEPLOY_GAS_FALLBACK = 6_000_000
TX_TIMEOUT_SECONDS = 300
TX_POLL_LATENCY = 5


@dataclass
class WalletInfo:
    account: LocalAccount
    balance_wei: int

    @property
    def address(self) -> str:
        return self.account.address

    @property
    def balance_credit(self) -> str:
        return f"{Web3.from_wei(self.balance_wei, 'ether')} CREDIT"


class ManagerBot:
    def __init__(self) -> None:
        self.web3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
        if not self.web3.is_connected():
            raise SystemExit(
                f"Unable to connect to RPC at {RPC_URL}. "
                "Check network connectivity and verify the RPC endpoint is reachable."
            )

    # ------------------------------------------------------------------ #
    # Wallet helpers
    # ------------------------------------------------------------------ #

    def generate_wallet(self) -> LocalAccount:
        Account.enable_unaudited_hdwallet_features()
        return Account.create()

    def load_wallet_from_private_key(self, private_key: str) -> LocalAccount:
        pk = private_key.strip()
        if not pk:
            raise ValueError("Private key is empty.")
        if not pk.startswith("0x"):
            pk = "0x" + pk
        try:
            return Account.from_key(pk)
        except ValueError as exc:
            raise ValueError("Invalid private key format.") from exc

    def check_balance(self, address: str) -> int:
        try:
            return self.web3.eth.get_balance(address)
        except Exception as exc:  # broad: network issues, invalid address
            raise RuntimeError(f"Failed to fetch balance for {address}: {exc}") from exc

    def wait_for_funding(self, address: str) -> int:
        while True:
            input("Press ENTER after funding the address... ")
            balance = self.check_balance(address)
            if balance > 0:
                return balance
            print("Balance is still 0. Please fund using the faucet and try again.")

    # ------------------------------------------------------------------ #
    # Config helpers
    # ------------------------------------------------------------------ #

    def load_contract_config(self) -> Optional[str]:
        if not CONTRACT_CONFIG_PATH.exists():
            return None
        try:
            data = json.loads(CONTRACT_CONFIG_PATH.read_text())
            return data.get("contractAddress")
        except Exception:
            return None

    def save_contract_config(self, contract_address: str) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONTRACT_CONFIG_PATH.write_text(json.dumps({"contractAddress": contract_address}, indent=2))

    def _persist_private_key(self, private_key: str) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        WALLET_FILE_PATH.write_text(private_key)
        try:
            os.chmod(WALLET_FILE_PATH, 0o600)
        except PermissionError:
            pass  # best effort

    # ------------------------------------------------------------------ #
    # Contract helpers
    # ------------------------------------------------------------------ #

    def _load_artifact(self) -> Tuple[list, str]:
        if not ARTIFACT_PATH.exists():
            raise FileNotFoundError(
                f"Contract artifact not found at {ARTIFACT_PATH}. Run `npm run compile` first."
            )
        artifact = json.loads(ARTIFACT_PATH.read_text())
        abi = artifact.get("abi")
        bytecode = artifact.get("bytecode")
        if not abi or not bytecode:
            raise ValueError("Invalid contract artifact: missing ABI or bytecode.")
        return abi, bytecode

    def verify_contract_exists(self, address: str) -> bool:
        try:
            code = self.web3.eth.get_code(address)
            return code is not None and len(code) > 0
        except Exception:
            return False

    def deploy_contract(self, wallet: LocalAccount) -> Tuple[str, str]:
        abi, bytecode = self._load_artifact()
        contract = self.web3.eth.contract(abi=abi, bytecode=bytecode)
        nonce = self.web3.eth.get_transaction_count(wallet.address)
        try:
            gas_price = self.web3.eth.gas_price
        except Exception:
            gas_price = None

        try:
            estimated_gas = contract.constructor().estimate_gas({"from": wallet.address})
        except Exception:
            estimated_gas = DEPLOY_GAS_FALLBACK

        tx = contract.constructor().build_transaction(
            {
                "from": wallet.address,
                "nonce": nonce,
                "chainId": CHAIN_ID,
                "gas": estimated_gas,
                **({"gasPrice": gas_price} if gas_price else {}),
            }
        )
        signed = self.web3.eth.account.sign_transaction(tx, wallet.key)
        tx_hash = self.web3.eth.send_raw_transaction(signed.raw_transaction)
        print(f"Deployment submitted. Tx hash: {tx_hash.hex()}")

        try:
            receipt = self.web3.eth.wait_for_transaction_receipt(
                tx_hash, timeout=TX_TIMEOUT_SECONDS, poll_latency=TX_POLL_LATENCY
            )
        except ContractLogicError as exc:
            raise RuntimeError(f"Deployment failed: {exc}") from exc
        if receipt.status != 1:
            raise RuntimeError("Deployment transaction failed.")
        return receipt.contractAddress, tx_hash.hex()

    # ------------------------------------------------------------------ #
    # CLI flow
    # ------------------------------------------------------------------ #

    def interactive(self) -> None:
        print("=== ChainFS ManagerBot ===")
        print("Network: SKALE Base Sepolia Testnet")
        print(f"RPC: {RPC_URL}")
        print("")

        wallet = self._select_wallet()
        balance = self.check_balance(wallet.address)
        if balance == 0:
            print("Wallet has no funds. Please fund using the faucet:")
            print("  https://base-sepolia-faucet.skale.space")
            balance = self.wait_for_funding(wallet.address)
        print(f"Wallet balance: {Web3.from_wei(balance, 'ether')} CREDIT")

        existing_contract = self.load_contract_config()
        if existing_contract and self.verify_contract_exists(existing_contract):
            print("\nChainFS contract already deployed.")
            print(f"Contract address: {existing_contract}")
            print(f"Wallet address : {wallet.address}")
            print(f"Wallet balance : {Web3.from_wei(balance, 'ether')} CREDIT")
            return

        print("\nNo contract deployed yet.")
        choice = input("Do you want to deploy ChainFS contract now? (y/n): ").strip().lower()
        if choice not in {"y", "yes"}:
            print("Aborting without deployment.")
            return

        contract_address, tx_hash = self.deploy_contract(wallet)
        self.save_contract_config(contract_address)
        post_balance = self.check_balance(wallet.address)

        print("\nChainFS is ready to use.")
        print(f"Contract Address : {contract_address}")
        print(f"Transaction Hash : {tx_hash}")
        print(f"Wallet Address   : {wallet.address}")
        print(f"Wallet Balance   : {Web3.from_wei(post_balance, 'ether')} CREDIT")

    def _select_wallet(self) -> LocalAccount:
        while True:
            print("Select an option:")
            print("  1) Create new wallet")
            print("  2) Use existing private key")
            choice = input("Enter choice (1 or 2): ").strip()
            if choice == "1":
                return self._handle_new_wallet()
            if choice == "2":
                return self._handle_existing_wallet()
            print("Invalid choice. Please enter 1 or 2.")

    def _handle_new_wallet(self) -> LocalAccount:
        wallet = self.generate_wallet()
        print("\nNew wallet generated.")
        print(f"Address    : {wallet.address}")
        print("PRIVATE KEY: (write this down and keep it secure)")
        print(wallet.key.hex())
        print("\nWARNING: Do not share this private key. It grants full access to funds.")

        self._persist_private_key(wallet.key.hex())
        print(f"Private key saved to {WALLET_FILE_PATH} (permissions restricted where possible).")
        print("\nFund this address using the faucet before continuing:")
        print("  https://base-sepolia-faucet.skale.space")
        self.wait_for_funding(wallet.address)
        return wallet

    def _handle_existing_wallet(self) -> LocalAccount:
        pk = input("Enter your private key (0x...): ").strip()
        wallet = self.load_wallet_from_private_key(pk)
        print(f"Using wallet: {wallet.address}")
        return wallet


def main() -> int:
    try:
        bot = ManagerBot()
        bot.interactive()
        return 0
    except KeyboardInterrupt:
        print("\nOperation cancelled by user.")
        return 1
    except Exception as exc:
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
