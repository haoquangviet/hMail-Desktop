#!/usr/bin/env python3
# Giấy phép Cộng đồng hMail (LICENSE-HQV.md) — Copyright (c) 2026 HQV Software
"""
compliance_check.py — verify a built hMail Desktop tree against the
Mozilla trademark / MPL 2.0 obligations documented in docs/COMPLIANCE.md.

    python build/compliance_check.py [--core work/app]

Exits non-zero if any mandatory check fails.
"""
import argparse
import hashlib
import os
import re
import sys
import zipfile

DISCLAIMER_MARKERS = ("not officially associated", "không liên kết chính thức")

REQUIRED_FILES = [
    "hmail.exe",
    "hmail.cfg",
    "hmail.VisualElementsManifest.xml",
    "distribution/distribution.ini",
    "distribution/policies.json",
    "defaults/pref/autoconfig.js",
    "defaults/pref/hmail.js",
    "hmail-chrome/userChrome.css",
    "hmail-chrome/custom.css",
]

# Mozilla update / crash-report machinery that must not ship.
FORBIDDEN_FILES = [
    "updater.exe", "updater.ini", "update-settings.ini", "precomplete",
    "removed-files", "maintenanceservice.exe", "maintenanceservice_installer.exe",
    "crashreporter.exe", "pingsender.exe",
]

failures = []
warnings = []


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        failures.append(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", default=os.path.join("work", "app"))
    ap.add_argument("--stock-omni", default=r"C:\Program Files\Mozilla Thunderbird\omni.ja",
                    help="optional stock Thunderbird omni.ja, to prove all branding art was replaced")
    args = ap.parse_args()
    app = os.path.abspath(args.core)
    if not os.path.isdir(app):
        sys.exit(f"app directory not found: {app}")

    print(f"Checking {app}\n")

    print("[1] No file named after Thunderbird")
    stray = [os.path.relpath(os.path.join(r, f), app)
             for r, _, fs in os.walk(app) for f in fs if "thunderbird" in f.lower()]
    check(not stray, f"no Thunderbird-named files on disk ({stray if stray else ''})")

    print("\n[2] Brand strings rebranded in every shipped locale")
    z = zipfile.ZipFile(os.path.join(app, "omni.ja"))
    brand_files = [n for n in z.namelist()
                   if re.fullmatch(r"localization/[^/]+/branding/brand\.ftl", n)
                   or re.fullmatch(r"chrome/[^/]+/locale/branding/brand\.(dtd|properties)", n)]
    for n in sorted(brand_files):
        text = z.read(n).decode("utf-8", "ignore")
        # Values only: strip comment lines so MPL headers do not trip the check.
        values = "\n".join(l for l in text.splitlines()
                           if not l.lstrip().startswith(("#", "<!--", "   -")))
        leaked = re.search(r"\bThunderbird\b", values) and not any(
            m in values for m in DISCLAIMER_MARKERS)
        check(not leaked, f"{n}")

    print("\n[3] Application identity strings")
    ini = os.path.join(app, "application.ini")
    text = open(ini, encoding="utf-8", errors="ignore").read() if os.path.exists(ini) else ""
    for key, forbidden in (("Name", "Thunderbird"), ("Vendor", "Mozilla")):
        m = re.search(rf"(?m)^{key}=(.*)$", text)
        check(bool(m) and forbidden not in m.group(1), f"application.ini {key}={m.group(1) if m else '?'}")

    print("\n[4] Mozilla update / crash machinery removed")
    for f in FORBIDDEN_FILES:
        check(not os.path.exists(os.path.join(app, f)), f"{f} removed")

    print("\n[5] MPL attribution preserved")
    lic = "chrome://global license page"
    has_license = any(n.endswith("global/license.html") for n in z.namelist())
    check(has_license, f"about:license page present ({lic})")
    check(any(n.endswith("messenger/aboutRights.xhtml") for n in z.namelist()),
          "about:rights page present")

    print("\n[6] hMail configuration shipped")
    for f in REQUIRED_FILES:
        check(os.path.exists(os.path.join(app, f.replace("/", os.sep))), f)

    print("\n[7] Source pointer and disclaimer reach the user")
    cfg = open(os.path.join(app, "hmail.cfg"), encoding="utf-8", errors="ignore").read()
    dist = open(os.path.join(app, "distribution", "distribution.ini"),
                encoding="utf-8", errors="ignore").read()
    check("github.com/haoquangviet/hMail-Desktop" in dist,
          "distribution.ini about= carries the source URL")
    check(any(m in dist for m in DISCLAIMER_MARKERS),
          "distribution.ini about= carries the non-association disclaimer")
    check("github.com/haoquangviet/hMail-Desktop" in cfg,
          "hmail.cfg points support/update URLs at hMail")

    print("\n[8] Thunderbird artwork fully replaced")
    if os.path.exists(args.stock_omni):
        stock = zipfile.ZipFile(args.stock_omni)
        same = []
        for n in z.namelist():
            if n.startswith("chrome/messenger/content/branding/") and n.endswith((".png", ".svg")):
                try:
                    if hashlib.sha256(z.read(n)).hexdigest() == hashlib.sha256(stock.read(n)).hexdigest():
                        same.append(n)
                except KeyError:
                    pass
        check(not same, f"all branding images replaced ({same if same else ''})")
    else:
        warnings.append("stock omni.ja not available; branding-art diff skipped")
        print("  SKIP  stock Thunderbird omni.ja not found, image diff skipped")

    print()
    for w in warnings:
        print("WARNING:", w)
    if failures:
        print(f"\n{len(failures)} check(s) FAILED")
        sys.exit(1)
    print("All compliance checks passed.")


if __name__ == "__main__":
    main()
