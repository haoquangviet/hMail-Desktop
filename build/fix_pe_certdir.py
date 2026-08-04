#!/usr/bin/env python3
# MIT License — Copyright (c) 2026 HQV Software
"""
fix_pe_certdir.py — clear a stale Authenticode certificate-table pointer.

rcedit rewrites a PE's resources and drops the signature blob at the end of
the file, but leaves data directory entry 4 (the certificate table) pointing
at the old offset. The entry then addresses bytes past EOF, and every signing
tool rejects the file with 0x800700C1 ("is not a valid Win32 application").

This zeroes that entry when it no longer fits inside the file, which is
exactly what the file looks like after its signature has been removed.

    python fix_pe_certdir.py <file.exe> [more.exe ...]
"""
import struct
import sys

CERT_DIR_INDEX = 4


def clear_stale_cert_dir(path: str) -> bool:
    """Returns True if the file was modified."""
    with open(path, "r+b") as f:
        data = f.read()
        if data[:2] != b"MZ":
            raise ValueError(f"{path}: not a PE file")
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        if data[pe:pe + 4] != b"PE\0\0":
            raise ValueError(f"{path}: bad PE signature")

        coff = pe + 4
        opt_size = struct.unpack_from("<H", data, coff + 16)[0]
        opt = coff + 20
        magic = struct.unpack_from("<H", data, opt)[0]
        if magic not in (0x10B, 0x20B):
            raise ValueError(f"{path}: unknown optional header magic 0x{magic:x}")

        # NumberOfRvaAndSizes sits at the end of the optional header's
        # windows-specific fields: 92 bytes in for PE32, 108 for PE32+.
        nrva_off = opt + (108 if magic == 0x20B else 92)
        nrva = struct.unpack_from("<I", data, nrva_off)[0]
        if nrva <= CERT_DIR_INDEX:
            return False

        entry = nrva_off + 4 + CERT_DIR_INDEX * 8
        offset, size = struct.unpack_from("<II", data, entry)
        if offset == 0 and size == 0:
            return False
        if offset + size <= len(data):
            return False  # signature is intact, leave it alone

        f.seek(entry)
        f.write(struct.pack("<II", 0, 0))
        print(f"{path}: cleared stale cert table (offset={offset} size={size}, "
              f"file is {len(data)} bytes)")
        return True


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for path in sys.argv[1:]:
        if not clear_stale_cert_dir(path):
            print(f"{path}: certificate table OK, nothing to do")


if __name__ == "__main__":
    main()
