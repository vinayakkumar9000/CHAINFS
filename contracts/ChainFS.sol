// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ChainFS
/// @notice Decentralized file storage: metadata on-chain, file data in event logs.
contract ChainFS {
    struct FileMetadata {
        string name;
        uint256 size;
        uint256 chunkCount;
        address owner;
        bool exists;
    }

    /// @notice Mapping from fileId to its metadata.
    mapping(bytes32 => FileMetadata) public files;

    /// @notice Emitted when a new file entry is registered.
    event FileCreated(
        bytes32 indexed fileId,
        string  name,
        uint256 size,
        uint256 chunkCount,
        address indexed owner
    );

    /// @notice Emitted when a chunk of file data is uploaded.
    ///         The raw chunk bytes are stored cheaply in the log.
    event ChunkUploaded(
        bytes32 indexed fileId,
        uint256 indexed chunkIndex,
        bytes   data
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error FileAlreadyExists(bytes32 fileId);
    error FileNotFound(bytes32 fileId);
    error NotFileOwner(bytes32 fileId, address caller);
    error InvalidChunkIndex(bytes32 fileId, uint256 chunkIndex, uint256 chunkCount);
    error InvalidChunkSize();
    error EmptyFileName();
    error ZeroSize();
    error ZeroChunkCount();

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Maximum chunk size (24 KB — leaves room under the 24-KB tx limit).
    uint256 public constant MAX_CHUNK_SIZE = 24_576;

    // -------------------------------------------------------------------------
    // Functions
    // -------------------------------------------------------------------------

    /// @notice Register a new file and store its metadata on-chain.
    /// @param fileId      Unique identifier (e.g. keccak256 of file content).
    /// @param name        Human-readable filename.
    /// @param size        Total file size in bytes (before chunking).
    /// @param chunkCount  Number of chunks the file is split into.
    function createFile(
        bytes32 fileId,
        string  calldata name,
        uint256 size,
        uint256 chunkCount
    ) external {
        if (files[fileId].exists) revert FileAlreadyExists(fileId);
        if (bytes(name).length == 0) revert EmptyFileName();
        if (size == 0) revert ZeroSize();
        if (chunkCount == 0) revert ZeroChunkCount();

        files[fileId] = FileMetadata({
            name:       name,
            size:       size,
            chunkCount: chunkCount,
            owner:      msg.sender,
            exists:     true
        });

        emit FileCreated(fileId, name, size, chunkCount, msg.sender);
    }

    /// @notice Upload a single chunk of file data.
    ///         The chunk bytes are emitted in an event log (cheap storage).
    /// @param fileId      The file this chunk belongs to.
    /// @param chunkIndex  Zero-based index of this chunk.
    /// @param data        Raw (compressed) chunk bytes.
    function uploadChunk(
        bytes32      fileId,
        uint256      chunkIndex,
        bytes calldata data
    ) external {
        if (!files[fileId].exists) revert FileNotFound(fileId);
        if (files[fileId].owner != msg.sender) revert NotFileOwner(fileId, msg.sender);
        if (chunkIndex >= files[fileId].chunkCount)
            revert InvalidChunkIndex(fileId, chunkIndex, files[fileId].chunkCount);
        if (data.length == 0 || data.length > MAX_CHUNK_SIZE) revert InvalidChunkSize();

        emit ChunkUploaded(fileId, chunkIndex, data);
    }

    /// @notice Convenience view — returns the on-chain metadata for a file.
    function getFile(bytes32 fileId)
        external
        view
        returns (
            string memory name,
            uint256 size,
            uint256 chunkCount,
            address owner
        )
    {
        if (!files[fileId].exists) revert FileNotFound(fileId);
        FileMetadata storage f = files[fileId];
        return (f.name, f.size, f.chunkCount, f.owner);
    }
}
