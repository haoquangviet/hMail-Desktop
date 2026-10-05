# Upstream Thunderbird — pinned version

hMail Desktop is built from this exact official Mozilla Thunderbird release.
The build script (`build/build.ps1`) downloads this artifact and verifies its
SHA-256 checksum before applying any modification.

| Field | Value |
|---|---|
| Product | Mozilla Thunderbird (vi locale) |
| Version | **140.17.0esr** |
| Channel | ESR 140 |
| Windows installer | <https://archive.mozilla.org/pub/thunderbird/releases/140.17.0esr/win64/vi/Thunderbird%20Setup%20140.17.0esr.exe> |
| Windows SHA-256 | `6167ec7ee78c99fe61652226dc411bbc4dacfa3f2ee7951969d80d7eefbafda7` |
| macOS disk image | <https://archive.mozilla.org/pub/thunderbird/releases/140.17.0esr/mac/vi/Thunderbird%20140.17.0esr.dmg> |
| macOS SHA-256 | `c7f32fc711d97f13efc9e6d70a06dbde448c6409b9464205ba7ffb7e49368640` |
| Upstream SHA256SUMS | <https://archive.mozilla.org/pub/thunderbird/releases/140.17.0esr/SHA256SUMS> |
| Source code (comm-esr140) | <https://hg-edge.mozilla.org/releases/comm-esr140/> |
| Source tarball | <https://archive.mozilla.org/pub/thunderbird/releases/140.17.0esr/source/> |

Every modified file relative to this release lives in [`omni-patches/`](omni-patches/)
(files replaced inside `omni.ja`) and [`overlay/`](overlay/) (files added next to the
application). Anything not present in those folders is bit-identical to the official
release.

## Bumping the pin

The pin is deliberate (reproducibility + a controlled place to verify hMail's
own patches still apply), not a forgotten update — so it is bumped by hand,
not automatically. `build.ps1` prints a warning at build time when a newer
ESR point release exists upstream (it does not change anything by itself).

Previously pinned at **140.13.0esr** (02/08/2026 – 05/10/2026). Bumped to
140.17.0esr on 05/10/2026: a plain ESR point-release bump (140.13 → 140.17,
same branch — Mozilla's security/stability backports only, no UI/feature
change), verified by a full `build.ps1 -SkipInstaller` run against the new
base before switching the default (`omni.ja rewritten: 46 entries replaced`
on both the old and new base — every patch target still found; app launched
cleanly with an isolated test profile). hMail's `omni-patches/`/`omni_tool.py`
are unaffected; a jump to a different ESR channel (e.g. 140 → 145) is a much
bigger change and would need the same verification plus a careful read of
that channel's own release notes for structural changes.
