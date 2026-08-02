#!/usr/bin/env python3
# MIT License — Copyright (c) 2026 HQV Software
"""
omni_tool.py — rebrand a Thunderbird application directory into hMail Desktop.

Operations (run from anywhere):
  python omni_tool.py --core <path-to-app-dir> --repo <repo-root> [--buildid YYYYMMDDHHMMSS]

What it does:
  1. Rewrites omni.ja, replacing:
       - localization/<loc>/branding/brand.ftl        (all locales found)
       - chrome/<loc>/locale/branding/brand.dtd       (all locales found)
       - chrome/<loc>/locale/branding/brand.properties
       - defaults/pref/thunderbird-branding.js
       - chrome/messenger/content/branding/*.png|*.svg (hMail art, sizes matched
         to the original files so no CSS/layout breaks)
     The archive is written the way Mozilla ships it: ZIP method 0 (Stored),
     no directory entries, no extra fields, normalized timestamps.
  2. Bumps BuildID= in application.ini and platform.ini (invalidates the
     startup cache so stale Thunderbird chrome is never shown).
  3. Generates VisualElements tiles + hmail.VisualElementsManifest.xml.

MPL 2.0 note: the replacement text files in omni-patches/ are modified Mozilla
files and remain MPL 2.0 (see LICENSE.md). This tool itself is MIT.
"""

import argparse
import io
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from PIL import Image

# Normalized timestamp used by Mozilla packaging.
ZIP_DATE = (2010, 1, 1, 0, 0, 0)

BRANDING_DIR = "chrome/messenger/content/branding/"

# Generic (English) fallbacks for locales that have no file in omni-patches/.
FALLBACK_DTD = """<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<!ENTITY brandShortName "hMail">
<!ENTITY brandShorterName "hMail">
<!ENTITY brandFullName "hMail Desktop">
<!ENTITY brandProductName "hMail">
<!ENTITY vendorShortName "HQV Software">
<!ENTITY trademarkInfo.part1 "hMail and the hMail logos are trademarks of HQV Software.">
"""

FALLBACK_PROPERTIES = """# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
brandShortName = hMail
brandShorterName = hMail
brandFullName = hMail Desktop
vendorShortName = HQV Software
"""

ABOUT_PARAGRAPH = (
    "about-paragraph = { -brand-full-name } is built by HQV Software on the "
    "Mozilla Thunderbird open source code base. { -brand-full-name } and "
    "Thunderbird are not officially associated with Mozilla or its products. "
    "Source code: https://github.com/haoquangviet/hMail-Desktop"
)

# Thunderbird's About dialog says the program is made by a global community.
# Rebranded, that sentence would claim HQV Software is one, which is untrue —
# and it also drops the attribution that actually matters. These say who wrote
# hMail and what it is built on. The <a data-l10n-name=...> elements must stay:
# Fluent overlays them onto anchors that exist in the dialog markup.
COMMUNITY_STRINGS = {
    "en-US": {
        "community-desc":
            "community-desc = { -brand-short-name } is developed by "
            "<a data-l10n-name=\"community-mozilla-link\">"
            "{ -vendor-short-name }</a> on the "
            "<a data-l10n-name=\"community-credits-link\">Mozilla Thunderbird "
            "open source code</a>.",
        "community-experimental":
            "community-experimental = "
            "<a data-l10n-name=\"community-exp-mozilla-link\">"
            "{ -vendor-short-name }</a> builds { -brand-short-name } on the "
            "<a data-l10n-name=\"community-exp-credits-link\">Mozilla "
            "Thunderbird open source code</a>.",
        "rights-intro":
            "rights-intro = { -brand-full-name } is developed by "
            "{ -vendor-short-name } from Mozilla Thunderbird, free and open "
            "source software built by a community of thousands of people all "
            "over the world. There are a few things you should know:",
        "about-rights-notification-text":
            "about-rights-notification-text = { -brand-short-name } is built "
            "on Mozilla Thunderbird, free and open source software made by a "
            "community of thousands of people all over the world.",
    },
    "vi": {
        "community-desc":
            "community-desc = { -brand-short-name } do "
            "<a data-l10n-name=\"community-mozilla-link\">"
            "{ -vendor-short-name }</a> phát triển trên "
            "<a data-l10n-name=\"community-credits-link\">mã nguồn mở Mozilla "
            "Thunderbird</a>.",
        "community-experimental":
            "community-experimental = "
            "<a data-l10n-name=\"community-exp-mozilla-link\">"
            "{ -vendor-short-name }</a> phát triển { -brand-short-name } trên "
            "<a data-l10n-name=\"community-exp-credits-link\">mã nguồn mở "
            "Mozilla Thunderbird</a>.",
        "rights-intro":
            "rights-intro = { -brand-full-name } do { -vendor-short-name } "
            "phát triển từ Mozilla Thunderbird — phần mềm tự do mã nguồn mở "
            "được xây dựng bởi cộng đồng gồm hàng nghìn người trên khắp thế "
            "giới. Có vài điều mà bạn nên biết:",
        "about-rights-notification-text":
            "about-rights-notification-text = { -brand-short-name } được xây "
            "dựng trên Mozilla Thunderbird — phần mềm nguồn mở và miễn phí, "
            "do cộng đồng gồm hàng ngàn người từ khắp nơi trên thế giới tạo "
            "ra.",
    },
}

# Which message lives in which file.
COMMUNITY_FILES = {
    "messenger/aboutDialog.ftl": ("community-desc", "community-experimental"),
    "messenger/aboutRights.ftl": ("rights-intro",),
    "messenger/messenger.ftl": ("about-rights-notification-text",),
}


def patch_community(text: str, locale: str, keys) -> str:
    """Replace whole Fluent messages, continuation lines included."""
    strings = COMMUNITY_STRINGS.get(locale, COMMUNITY_STRINGS["en-US"])
    for key in keys:
        replacement = strings.get(key)
        if not replacement:
            continue
        text = re.sub(
            r"(?m)^" + re.escape(key) + r"\s*=.*(?:\n[ \t]+.*)*",
            lambda _m, r=replacement: r,
            text,
        )
    return text


WORDMARK_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" width="320" height="80">
  <text x="0" y="56" font-family="'Segoe UI', system-ui, sans-serif" font-size="46"
        font-weight="600" fill="#FFFFFF">hMail Desktop</text>
</svg>
"""


def log(msg):
    print(f"[omni_tool] {msg}")


def load_repo_patch(repo: Path, rel: str):
    p = repo / "omni-patches" / Path(rel)
    return p.read_bytes() if p.exists() else None


def render_png(logo: Image.Image, width: int, height: int, opacity: float = 1.0) -> bytes:
    """Render the hMail logo centered on a transparent canvas of given size."""
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    side = min(width, height)
    scaled = logo.resize((side, side), Image.LANCZOS)
    if opacity < 1.0:
        alpha = scaled.getchannel("A").point(lambda a: int(a * opacity))
        scaled.putalpha(alpha)
    canvas.paste(scaled, ((width - side) // 2, (height - side) // 2), scaled)
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_replacements(zf: zipfile.ZipFile, repo: Path):
    """Map of omni.ja entry name -> new bytes."""
    logo = Image.open(repo / "branding" / "hMail-transparent.png").convert("RGBA")
    hmail_svg = (repo / "branding" / "hMail.svg").read_bytes()

    ftl_en = load_repo_patch(repo, "localization/en-US/branding/brand.ftl")
    if ftl_en is None:
        sys.exit("omni-patches/localization/en-US/branding/brand.ftl is required")

    repl = {}
    for info in zf.infolist():
        name = info.filename

        m = re.fullmatch(r"localization/([^/]+)/branding/brand\.ftl", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or ftl_en
            continue

        m = re.fullmatch(r"localization/([^/]+)/(.+)", name)
        if m and m.group(2) in COMMUNITY_FILES:
            text = zf.read(name).decode("utf-8")
            repl[name] = patch_community(
                text, m.group(1), COMMUNITY_FILES[m.group(2)]).encode("utf-8")
            continue

        # Account Central: drop the Thunderbird donation pitch, keep the rest
        # of the localized strings untouched.
        if re.fullmatch(r"localization/[^/]+/messenger/accountCentral\.ftl", name):
            text = zf.read(name).decode("utf-8")
            text = re.sub(
                r"(?m)^about-paragraph\s*=.*(?:\n[ \t]+.*)*",
                ABOUT_PARAGRAPH,
                text,
            )
            text = re.sub(
                r"(?m)^about-paragraph-consider-donation\s*=.*(?:\n[ \t]+.*)*",
                "about-paragraph-consider-donation = ",
                text,
            )
            repl[name] = text.encode("utf-8")
            continue

        # Append hMail rules to the Account Central stylesheet.
        if name.endswith("messenger/shared/accountCentral.css"):
            extra = load_repo_patch(repo, "appended/accountCentral.append.css")
            if extra:
                repl[name] = zf.read(name) + b"\n" + extra
            continue

        m = re.fullmatch(r"chrome/([^/]+)/locale/branding/brand\.dtd", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or FALLBACK_DTD.encode()
            continue

        m = re.fullmatch(r"chrome/([^/]+)/locale/branding/brand\.properties", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or FALLBACK_PROPERTIES.encode()
            continue

        if name == "defaults/pref/thunderbird-branding.js":
            patched = load_repo_patch(repo, name)
            if patched is None:
                sys.exit("omni-patches/defaults/pref/thunderbird-branding.js is required")
            repl[name] = patched
            continue

        # Thunderbird bird watermark on the Account Central page — outside the
        # branding directory, but still trademarked artwork that must go.
        if name.endswith(("images/account-watermark.png",
                          "images/account-watermark-light.png")):
            orig = Image.open(io.BytesIO(zf.read(name)))
            repl[name] = render_png(logo, orig.width, orig.height, opacity=0.10)
            continue

        if name.startswith(BRANDING_DIR):
            base = name[len(BRANDING_DIR):]
            if base.endswith(".png"):
                orig = Image.open(io.BytesIO(zf.read(name)))
                repl[name] = render_png(logo, orig.width, orig.height)
            elif base in ("about-logo.svg", "logo-gradient.svg"):
                repl[name] = hmail_svg
            elif base == "about-wordmark.svg":
                repl[name] = WORDMARK_SVG.encode()
            # aboutDialog.css and inAppNotificationData.json are kept as-is.
            continue

    return repl


def rewrite_omni(core: Path, repo: Path):
    omni = core / "omni.ja"
    if not omni.exists():
        sys.exit(f"omni.ja not found in {core}")

    tmp = core / "omni.ja.hmail-tmp"
    with zipfile.ZipFile(omni, "r") as zin:
        repl = build_replacements(zin, repo)
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as zout:
            for info in zin.infolist():
                data = repl.get(info.filename)
                if data is None:
                    data = zin.read(info.filename)
                out = zipfile.ZipInfo(info.filename, date_time=ZIP_DATE)
                out.compress_type = zipfile.ZIP_STORED
                out.create_system = 0
                out.external_attr = 0
                zout.writestr(out, data)
    omni.unlink()
    tmp.rename(omni)
    log(f"omni.ja rewritten: {len(repl)} entries replaced")


def patch_inis(core: Path, buildid: str):
    """Bump BuildID (invalidates the startup cache) and rebrand the ini strings.

    application.ini is documented as unused at runtime (the real values are
    compiled into xul.dll), but it ships in the install directory and is
    plainly readable, so the Mozilla/Thunderbird names are replaced there too.
    """
    for ini in ("application.ini", "platform.ini"):
        p = core / ini
        if not p.exists():
            log(f"WARN: {ini} not found, skipped")
            continue
        text = p.read_text(encoding="utf-8")
        text = re.sub(r"(?m)^BuildID=.*$", f"BuildID={buildid}", text)
        if ini == "application.ini":
            text = re.sub(r"(?m)^Vendor=.*$", "Vendor=HQV Software", text)
            text = re.sub(r"(?m)^Name=.*$", "Name=hMail Desktop", text)
            text = re.sub(r"(?m)^RemotingName=.*$", "RemotingName=hmail", text)
        # open() rather than Path.write_text: the newline argument only reached
        # write_text in Python 3.10, and the macOS system Python is 3.9.
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    log(f"ini files patched (BuildID {buildid})")


def visual_elements(core: Path, repo: Path):
    logo = Image.open(repo / "branding" / "hMail-transparent.png").convert("RGBA")
    ve = core / "VisualElements"
    ve.mkdir(exist_ok=True)
    # Remove Thunderbird tile art and manifest.
    for old in ve.glob("*.png"):
        old.unlink()
    for old in core.glob("*.VisualElementsManifest.xml"):
        old.unlink()
    (ve / "VisualElements_150.png").write_bytes(render_png(logo, 150, 150))
    (ve / "VisualElements_70.png").write_bytes(render_png(logo, 70, 70))
    manifest = (
        '<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        "  <VisualElements\n"
        '      ShowNameOnSquare150x150Logo="on"\n'
        '      Square150x150Logo="VisualElements\\VisualElements_150.png"\n'
        '      Square70x70Logo="VisualElements\\VisualElements_70.png"\n'
        '      ForegroundText="light"\n'
        '      BackgroundColor="#0F6CBD"/>\n'
        "</Application>\n"
    )
    (core / "hmail.VisualElementsManifest.xml").write_text(manifest, encoding="utf-8")
    log("VisualElements regenerated")


def patch_info_plist(app: Path):
    """Rebrand the macOS bundle's Info.plist (name, identifier, icon, executable)."""
    plist = app / "Contents" / "Info.plist"
    if not plist.exists():
        sys.exit(f"Info.plist not found: {plist}")
    text = plist.read_text(encoding="utf-8")

    def set_key(key: str, value: str, src: str) -> str:
        # <key>Name</key>\n\t<string>old</string>
        pattern = rf"(<key>{re.escape(key)}</key>\s*<string>)[^<]*(</string>)"
        new, n = re.subn(pattern, lambda m: m.group(1) + value + m.group(2), src)
        if n:
            return new
        # Thunderbird's plist omits some of the keys we want (CFBundleDisplayName,
        # NSHumanReadableCopyright); insert them rather than silently skipping.
        entry = f"\t<key>{key}</key>\n\t<string>{value}</string>\n"
        marker = "</dict>\n</plist>"
        if marker in src:
            return src.replace(marker, entry + marker, 1)
        log(f"WARN: could not set Info.plist key {key}")
        return src

    for key, value in (
        ("CFBundleName", "hMail Desktop"),
        ("CFBundleDisplayName", "hMail Desktop"),
        ("CFBundleIdentifier", "com.hqvsoftware.hmail"),
        ("CFBundleExecutable", "hmail"),
        ("CFBundleIconFile", "hmail.icns"),
        ("NSHumanReadableCopyright",
         "(c) HQV Software. Based on Mozilla Thunderbird (MPL 2.0)."),
    ):
        text = set_key(key, value, text)

    plist.write_text(text, encoding="utf-8")
    log("Info.plist rebranded")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True,
                    help="Windows: app dir containing omni.ja. "
                         "macOS: <bundle>.app/Contents/Resources")
    ap.add_argument("--repo", required=True, help="hMail-Desktop repo root")
    ap.add_argument("--platform", choices=("win", "mac"), default="win")
    ap.add_argument("--app-bundle", help="macOS: path to the .app bundle")
    ap.add_argument("--buildid", default=datetime.now().strftime("%Y%m%d%H%M%S"))
    args = ap.parse_args()

    core, repo = Path(args.core), Path(args.repo)
    rewrite_omni(core, repo)
    patch_inis(core, args.buildid)

    if args.platform == "win":
        visual_elements(core, repo)
    else:
        if not args.app_bundle:
            sys.exit("--app-bundle is required with --platform mac")
        patch_info_plist(Path(args.app_bundle))
    log("done")


if __name__ == "__main__":
    main()
