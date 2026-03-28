Implement StorageBot in Python.


IMPORTANT:




Follow ARCHITECTURE.md


Follow CONSTRAINTS.md


Must integrate with smart contract design




Responsibilities:




Read file from disk


Compute SHA256 hash


Compress file (gzip)


Split into chunks


Generate fileId (keccak256)


Call createFile()


Upload chunks using uploadChunk()




Advanced Requirements:




Retry logic (max 5 attempts)


Dynamic chunk size if gas fails


Progress tracking


Logging




Design Rules:






Modular functions:




read_file()


compress_data()


split_chunks()


upload_chunks()








Use web3.py






Handle errors gracefully






Connection:




Must match contract structure


Must produce data usable by DownloaderBot




Output:




Production-ready Python class


Clean structure



