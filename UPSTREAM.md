# Upstream Thunderbird — pinned version

hMail Desktop is built from this exact official Mozilla Thunderbird release.
The build script (`build/build.ps1`) downloads this artifact and verifies its
SHA-256 checksum before applying any modification.

| Field | Value |
|---|---|
| Product | Mozilla Thunderbird (vi locale) |
| Version | **140.13.0esr** |
| Channel | ESR 140 |
| Windows installer | <https://archive.mozilla.org/pub/thunderbird/releases/140.13.0esr/win64/vi/Thunderbird%20Setup%20140.13.0esr.exe> |
| Windows SHA-256 | `dd1e2ffb1b72e74a1337c2e53fc0ccef75810da80d299ca032e8f05164bb8ade` |
| macOS disk image | <https://archive.mozilla.org/pub/thunderbird/releases/140.13.0esr/mac/vi/Thunderbird%20140.13.0esr.dmg> |
| macOS SHA-256 | `fb189b96852417a773e22abca5208a05d762e6beb72861075a61a5e91df8dbd7` |
| Upstream SHA256SUMS | <https://archive.mozilla.org/pub/thunderbird/releases/140.13.0esr/SHA256SUMS> |
| Source code (comm-esr140) | <https://hg-edge.mozilla.org/releases/comm-esr140/> |
| Source tarball | <https://archive.mozilla.org/pub/thunderbird/releases/140.13.0esr/source/> |

Every modified file relative to this release lives in [`omni-patches/`](omni-patches/)
(files replaced inside `omni.ja`) and [`overlay/`](overlay/) (files added next to the
application). Anything not present in those folders is bit-identical to the official
release.
