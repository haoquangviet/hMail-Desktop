#!/bin/bash
# MIT License — Copyright (c) 2026 HQV Software
#
# build-mac.sh — reproducible build of hMail Desktop for macOS from the pinned
# official Mozilla Thunderbird release (see UPSTREAM.md). Run on a Mac.
#
#   ./build/build-mac.sh                 # build, sign, notarize, staple, package
#   ./build/build-mac.sh --no-sign       # unsigned build, local testing only
#
# Requirements:
#   - macOS with Xcode command line tools (codesign, notarytool, stapler, hdiutil)
#   - Python 3 with Pillow            (pip3 install pillow)
#   - "Developer ID Application" certificate in the login keychain
#   - A notarytool keychain profile:
#       xcrun notarytool store-credentials hmail-notary \
#           --apple-id <apple-id> --team-id <TEAMID> --password <app-specific-password>
#
set -euo pipefail

VERSION="${VERSION:-0.1.1}"
TB_VERSION="${TB_VERSION:-140.13.0esr}"
LOCALE="${LOCALE:-vi}"
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application: HAO QUANG VIET SOFTWARE COMPANY LIMITED}"
NOTARY_PROFILE="${NOTARY_PROFILE:-hmail-notary}"
DO_SIGN=1
DO_NOTARIZE=1
case "${1:-}" in
    --no-sign)   DO_SIGN=0; DO_NOTARIZE=0 ;;
    # Sign with the Developer ID but skip Apple's notary service. Useful when
    # the notarytool credentials are not set up yet; the result runs locally
    # but Gatekeeper will still block it on other machines.
    --no-notarize) DO_NOTARIZE=0 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO/work-mac"
DIST="$REPO/dist"
APP="$WORK/hMail Desktop.app"
ENTITLEMENTS="$REPO/installer/hmail.entitlements"
mkdir -p "$WORK" "$DIST"

log() { printf '\033[36m[build-mac]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------- 1. download
DMG="$WORK/Thunderbird $TB_VERSION.dmg"
BASE_URL="https://archive.mozilla.org/pub/thunderbird/releases/$TB_VERSION"
if [ ! -f "$DMG" ]; then
    log "Downloading Thunderbird $TB_VERSION ($LOCALE, mac)"
    curl -fL --progress-bar \
        "$BASE_URL/mac/$LOCALE/Thunderbird%20$TB_VERSION.dmg" -o "$DMG"
fi

# --------------------------------------------------- 2. verify the SHA-256 pin
log "Verifying SHA-256 against upstream SHA256SUMS"
SUMS="$WORK/SHA256SUMS-$TB_VERSION.txt"
[ -f "$SUMS" ] || curl -fsSL "$BASE_URL/SHA256SUMS" -o "$SUMS"
EXPECTED=$(grep "mac/$LOCALE/Thunderbird $TB_VERSION.dmg" "$SUMS" | awk '{print $1}')
ACTUAL=$(shasum -a 256 "$DMG" | awk '{print $1}')
[ -n "$EXPECTED" ] || { echo "No SHA256SUMS entry for mac/$LOCALE"; exit 1; }
[ "$EXPECTED" = "$ACTUAL" ] || { echo "SHA-256 mismatch: $ACTUAL != $EXPECTED"; exit 1; }
log "SHA-256 OK: $ACTUAL"

# ------------------------------------------------------------ 3. unpack .app
log "Mounting disk image"
MOUNT=$(mktemp -d)
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null
rm -rf "$APP"
ditto "$MOUNT/Thunderbird.app" "$APP"

# Capture the official entitlements before we destroy the signature. They are
# the ground truth for what a Gecko app needs under the hardened runtime;
# compare them against installer/hmail.entitlements whenever the ESR is bumped.
codesign -d --entitlements :- "$MOUNT/Thunderbird.app" \
    > "$WORK/upstream-entitlements.plist" 2>/dev/null || true
hdiutil detach "$MOUNT" >/dev/null
rmdir "$MOUNT" 2>/dev/null || true
log "Bundle copied to $APP"

RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"

# ----------------------------------- 4. rebrand omni.ja / ini / Info.plist
log "Patching omni.ja, application.ini and Info.plist"
python3 "$REPO/build/omni_tool.py" \
    --core "$RES" --repo "$REPO" --platform mac --app-bundle "$APP"

# --------------------------------------------------------------- 5. icons
log "Replacing application icon"
python3 "$REPO/build/make_icns.py" \
    "$REPO/branding/hMail-transparent.png" "$RES/hmail.icns"
rm -f "$RES/thunderbird.icns"

# ------------------------------------------- 6. executable + updater removal
if [ -f "$MACOS/thunderbird" ]; then
    mv "$MACOS/thunderbird" "$MACOS/hmail"
    log "Renamed main executable to hmail"
fi

# hMail ships its own update channel (GitHub Releases). The real updater binary
# lives in Contents/Library/LaunchServices and is symlinked from updater.app;
# remove BOTH, or the leftover dangling symlink breaks the code signature.
rm -rf "$MACOS/updater.app"
rm -f  "$APP/Contents/Library/LaunchServices/org.mozilla.updater"
rm -f  "$RES/updater.ini" "$RES/precomplete" "$RES/removed-files" \
       "$RES/update-settings.ini"
# A provisioning profile issued to Mozilla cannot be re-signed by us.
rm -f  "$APP/Contents/embedded.provisionprofile"
log "Removed Mozilla updater and provisioning profile"

# ------------------------------------------ 6b. rebrand the Spotlight importer
# The importer lets Spotlight index mail; it ships under the Thunderbird name,
# which the trademark rules require us to drop, so rename the bundle, its
# executable and its identifiers rather than losing the feature.
SPOTLIGHT="$APP/Contents/Library/Spotlight"
if [ -d "$SPOTLIGHT/thunderbird.mdimporter" ]; then
    mv "$SPOTLIGHT/thunderbird.mdimporter" "$SPOTLIGHT/hmail.mdimporter"
    MD="$SPOTLIGHT/hmail.mdimporter"
    if [ -f "$MD/Contents/MacOS/thunderbird-mdimport" ]; then
        mv "$MD/Contents/MacOS/thunderbird-mdimport" "$MD/Contents/MacOS/hmail-mdimport"
    fi
    /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable hmail-mdimport" \
        "$MD/Contents/Info.plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleName hMail Desktop" \
        "$MD/Contents/Info.plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.hqvsoftware.hmail.mdimporter" \
        "$MD/Contents/Info.plist" 2>/dev/null || true
    # Its old signature no longer matches the renamed contents.
    rm -rf "$MD/Contents/_CodeSignature"
    log "Rebranded the Spotlight importer"
fi

# The media plugin helper's executable name is user-visible (it appears in the
# Force Quit list and in permission prompts), so it carries the brand too.
MPH="$MACOS/media-plugin-helper.app"
if [ -f "$MPH/Contents/MacOS/Thunderbird Media Plugin Helper" ]; then
    mv "$MPH/Contents/MacOS/Thunderbird Media Plugin Helper" \
       "$MPH/Contents/MacOS/hMail Media Plugin Helper"
    /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable hMail Media Plugin Helper" \
        "$MPH/Contents/Info.plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleName hMail Media Plugin Helper" \
        "$MPH/Contents/Info.plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName hMail Media Plugin Helper" \
        "$MPH/Contents/Info.plist" 2>/dev/null || true
    rm -rf "$MPH/Contents/_CodeSignature"
    log "Rebranded the media plugin helper"
fi

# ------------------------------------------------------------- 7. overlay
log "Applying configuration overlay"
mkdir -p "$RES/distribution/extensions" "$RES/defaults/pref"
cp -R "$REPO/overlay/distribution/." "$RES/distribution/"
cp "$REPO/overlay/defaults/pref/autoconfig.js" "$RES/defaults/pref/"
cp "$REPO/overlay/hmail.cfg" "$RES/"
rm -rf "$RES/hmail-chrome" "$RES/hmail-ribbon"
cp -R "$REPO/overlay/hmail-chrome" "$RES/hmail-chrome"
cp -R "$REPO/overlay/hmail-ribbon" "$RES/hmail-ribbon"
printf 'pref("hmail.version", "%s");\n' "$VERSION" > "$RES/defaults/pref/hmail.js"
# One-shot startup cache purge on first launch (GreD is Contents/Resources).
: > "$RES/.purgecaches"

# The AI assistant is privileged chrome in overlay/hmail-ribbon/aiassistant*.js,
# not an add-on; it ships with the rest of the overlay copied above.

# ------------------------------------------------------------- 8. codesign
if [ "$DO_SIGN" = "1" ]; then
    log "Signing bundle with: $SIGN_IDENTITY"

    # Mozilla's signature no longer describes this bundle; drop it entirely
    # rather than letting codesign try to amend it.
    find "$APP" -name _CodeSignature -type d -prune -exec rm -rf {} +

    sign() {
        codesign --force --timestamp --options runtime \
            --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$1"
    }

    # Inside-out: every Mach-O and nested bundle before the outer .app.
    log "  signing Mach-O binaries"
    while IFS= read -r f; do
        # Skip anything living inside a nested bundle; those are signed as a unit.
        case "$f" in *.app/*|*.framework/*|*.mdimporter/*) continue ;; esac
        if file -b "$f" | grep -q "Mach-O"; then sign "$f"; fi
    done < <(find "$MACOS" "$APP/Contents/Library" -type f 2>/dev/null)

    log "  signing nested bundles"
    for nested in "$APP/Contents/Frameworks"/*.framework \
                  "$MACOS"/*.app \
                  "$SPOTLIGHT"/*.mdimporter; do
        [ -e "$nested" ] && sign "$nested"
    done

    log "  signing the app bundle"
    sign "$APP"

    codesign --verify --deep --strict --verbose=2 "$APP"
    log "Bundle signature verified"

    # ------------------------------------- 9. notarize + staple the .app
    # The app is stapled separately from the disk image: once a user drags it
    # to /Applications the DMG's ticket no longer travels with it, and an
    # unstapled app fails Gatekeeper when the machine is offline.
    if [ "$DO_NOTARIZE" = "1" ]; then
        log "Notarizing the app (this can take several minutes)"
        ZIP="$WORK/hMailDesktop-$VERSION-app.zip"
        rm -f "$ZIP"
        ditto -c -k --keepParent "$APP" "$ZIP"
        xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
        xcrun stapler staple "$APP"
        xcrun stapler validate "$APP"
        log "App notarized and stapled"
    else
        log "Skipping notarization (--no-notarize)"
    fi
fi

# ------------------------------------------------------- 10. build the .dmg
DMG_OUT="$DIST/hMailDesktop-$VERSION.dmg"
rm -f "$DMG_OUT"
STAGE="$WORK/dmg-stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/hMail Desktop.app"
ln -s /Applications "$STAGE/Applications"
log "Building disk image"
hdiutil create -volname "hMail Desktop" -srcfolder "$STAGE" \
    -ov -format UDZO "$DMG_OUT" >/dev/null

# --------------------------------------- 11. sign, notarize, staple the .dmg
if [ "$DO_SIGN" = "1" ]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_OUT"
    if [ "$DO_NOTARIZE" = "1" ]; then
        log "Notarizing the disk image"
        xcrun notarytool submit "$DMG_OUT" --keychain-profile "$NOTARY_PROFILE" --wait
        xcrun stapler staple "$DMG_OUT"
        xcrun stapler validate "$DMG_OUT"
        log "Disk image notarized and stapled"
    fi
    # Gatekeeper's verdict on what the user actually launches. Without
    # notarization this is expected to report "rejected".
    spctl --assess --type execute --verbose=4 "$APP" || true
fi

log "Done: $DMG_OUT"
