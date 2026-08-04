#!/usr/bin/env python3
# MIT License — Copyright (c) 2026 HQV Software
"""
make_icns.py — build a macOS .icns icon from a PNG, without macOS tooling.

    python make_icns.py branding/hMail-transparent.png branding/hmail.icns

The ICNS container is a simple big-endian TOC: a 'icns' magic, the total
length, then a sequence of (4-byte type, 4-byte length-including-header,
payload) chunks. Modern macOS reads PNG payloads directly, so each size is
stored as a PNG. Retina variants use the same types at 2x pixel dimensions.
"""
import io
import struct
import sys

from PIL import Image

# (OSType, pixel size) — the set Finder, Dock and the About window use.
ENTRIES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"icp6", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),  # 512@2x
    (b"ic11", 32),    # 16@2x
    (b"ic12", 64),    # 32@2x
    (b"ic13", 256),   # 128@2x
    (b"ic14", 512),   # 256@2x
]


def render(src: Image.Image, size: int) -> bytes:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(src.resize((size, size), Image.LANCZOS), (0, 0))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: make_icns.py <source.png> <output.icns>")
    src_path, out_path = sys.argv[1], sys.argv[2]
    src = Image.open(src_path).convert("RGBA")

    chunks = b""
    for ostype, size in ENTRIES:
        payload = render(src, size)
        chunks += ostype + struct.pack(">I", len(payload) + 8) + payload

    with open(out_path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)

    print(f"{out_path}: {len(chunks) + 8} bytes, {len(ENTRIES)} representations")


if __name__ == "__main__":
    main()
