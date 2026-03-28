Implement DownloaderBot in Python.


IMPORTANT:




Follow ARCHITECTURE.md


Follow CONSTRAINTS.md


Must be compatible with StorageBot output




Responsibilities:




Accept fileId or transaction hash


Fetch ChunkStored events


Extract chunk data


Reconstruct file in correct order


Decompress file


Verify SHA256 hash




Performance:




Use parallel chunk fetching


Minimize RPC calls




Error Handling:




Missing chunks


Corrupted data


Retry failed fetch




Design Rules:




Modular:



fetch_chunks()


reconstruct_file()


decompress()


verify_hash()








Connection:




Must use same chunk structure as StorageBot


Must validate against original file hash




Output:




Clean, production-ready Python class



