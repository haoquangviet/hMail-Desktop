#!/bin/bash
# hMail Desktop — cài một bản DMG lên chính máy Mac này.
#
# Viết ra vì bước cài tay để lại rác: `ditto` đè lên /Applications trong khi
# bản cũ VẪN ĐANG CHẠY khiến macOS coi bundle mới là ứng dụng khác — bản mới
# mở lên đụng khoá hồ sơ và báo "Một bản sao của hMail Desktop đã được mở",
# còn tiến trình cũ nằm lại nhiều ngày (có máy tích tới bốn tiến trình).
#
# Thứ tự đúng: thoát tử tế → chờ thật sự hết tiến trình → gắn DMG (tự tránh
# đụng tên volume) → chép → tháo → kiểm phiên bản → mở lại.
#
#   bash build/install-mac.sh ~/Downloads/hMailDesktop-1.0.15.dmg
#
set -euo pipefail

DMG="${1:-}"
APP="/Applications/hMail Desktop.app"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "Dùng: bash build/install-mac.sh <đường dẫn .dmg>" >&2
  exit 1
fi

echo "==> Thoát hMail Desktop nếu đang chạy"
osascript -e 'tell application "hMail Desktop" to quit' 2>/dev/null || true
for _ in $(seq 1 30); do
  pgrep -f "hMail Desktop.app/Contents/MacOS/hmail" >/dev/null || break
  sleep 1
done
# Bản cũ đã bị thay bundle thì AppleScript không gọi tới được nữa: SIGTERM là
# đường thoát sạch của Gecko (KHÔNG dùng kill -9 — hỏng cache .msf, hộp thư
# lớn phải đọc lại toàn bộ ở lần mở sau).
if pgrep -f "hMail Desktop.app/Contents/MacOS/hmail" >/dev/null; then
  echo "    còn tiến trình cũ — gửi SIGTERM"
  pkill -TERM -f "hMail Desktop.app/Contents/MacOS/hmail" || true
  for _ in $(seq 1 30); do
    pgrep -f "hMail Desktop.app/Contents/MacOS/hmail" >/dev/null || break
    sleep 1
  done
fi
if pgrep -f "hMail Desktop.app/Contents/MacOS/hmail" >/dev/null; then
  echo "hMail không chịu thoát (đang bận?) — dừng, không cài đè." >&2
  exit 1
fi

MOUNT="/Volumes/hMail-install-$$"
echo "==> Gắn $DMG tại $MOUNT"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT

SRC="$MOUNT/hMail Desktop.app"
if [ ! -d "$SRC" ]; then
  echo "Trong DMG không có \"hMail Desktop.app\"" >&2
  exit 1
fi

echo "==> Chép vào /Applications"
rm -rf "$APP"
ditto "$SRC" "$APP"
hdiutil detach "$MOUNT" >/dev/null
trap - EXIT

VER=$(grep -o '"[0-9][0-9.]*"' "$APP/Contents/Resources/defaults/pref/hmail.js" 2>/dev/null | tail -1 | tr -d '"')
echo "==> Đã cài bản: ${VER:-không đọc được}"
spctl -a -t exec -vv "$APP" 2>&1 | head -3 || true

echo "==> Mở lại"
open -a "$APP"
