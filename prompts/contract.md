Implement the ChainFS smart contract.


IMPORTANT:




Follow ARCHITECTURE.md


Follow CONSTRAINTS.md


Do NOT redesign architecture




Requirements:






Solidity version ^0.8.20






Storage:








mapping(address => bytes32[]) userFiles


mapping(bytes32 => FileLookup)


mapping(bytes32 => address) fileOwner


mapping(bytes32 => mapping(uint256 => bool)) chunkUploaded






Struct:
FileLookup:






totalChunks


exists






Functions:






createFile()


uploadChunk()






Events:






FileCreated


ChunkStored






Rules:






Only owner can upload chunks


Prevent duplicate chunk uploads


Validate chunk index


Use calldata for efficiency






Comments:






Explain why event logs are used


Explain why minimal storage is used




Output:




Clean, production-ready contract


No unnecessary features




This contract must align with Storage Bot and Downloader Bot logic.

