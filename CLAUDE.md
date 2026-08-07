# CLAUDE.md — quy tắc làm việc với hMail Desktop

## Ngôn ngữ và quy ước

- **Mọi chữ hiển thị cho người dùng phải là tiếng Việt CÓ DẤU đầy đủ** — UI overlay,
  hộp thoại, thông báo NSIS trong `installer/hmail.nsi` (file đã `Unicode true`,
  UTF-8 — không có lý do gì để viết "dang chay" thay vì "đang chạy").
- Commit message: tiếng Việt, kiểu mệnh đề ngắn nối bằng `;`, **không nhắc AI/Claude**,
  không Co-Authored-By.
- Icon trong UI: **vẽ SVG inline** (như `plusIcon`/`arrowIcon` trong aiassistant-ui.js),
  không dùng ký tự glyph ("⌄", "✕"…) làm icon chính — font trong document thư
  render bệt và lệch.

## Kiến trúc overlay

- Toàn bộ tính năng hMail nằm ở `overlay/hmail-ribbon/*.js`, nạp từng cửa sổ qua
  `loadSubScript` trong `overlay/hmail.cfg` (autoconfig, chạy với quyền chrome).
  Patch toàn cục (URL handler, updater, vá module Gecko) cũng đặt trong hmail.cfg,
  mỗi khối `try/catch` độc lập.
- `overlay/hmail-chrome/*` được hmail.cfg **chép vào profile `chrome/` mỗi lần
  khởi động**; `custom.css` được `userChrome.css` @import và có hiệu lực cả trong
  about:message. CSS cho document con trong `<browser>` (Settings…) phải đăng ký
  qua `hmail-agent.css` (USER_SHEET).
- Test nhanh trên máy dev: chép file overlay đè vào `C:\Program Files\hMail Desktop\`
  (cần UAC) rồi khởi động lại app — profile tự sync. `node --check` mọi file JS
  trước khi deploy.
- **Đóng app để deploy: dùng `hmail.exe -osint -hmail-url "hmail://quit"` (thoát
  tử tế), KHÔNG `Stop-Process -Force`** — force-kill làm hỏng cache tóm tắt thư
  mục (.msf); với hộp thư ~70k thư, lần khởi động sau phải đọc lại toàn bộ để
  dựng index, người dùng thấy app "treo". Nếu quit nhẹ không xong (app đang bận
  dựng index), chờ nó xong rồi thử lại thay vì giết.
- Các tính năng overlay có "startup grace" 8 giây (`win.performance.now() < 8000`):
  việc nặng (stream thư để phân tích, mở panel AI, gắn bar trả lời nhanh) nhường
  Thunderbird khởi động xong đã — giữ nguyên quy ước này khi thêm watcher mới.

## Dữ liệu người dùng

- **Hồ sơ (profile) nằm ở `%APPDATA%\Thunderbird\Profiles\…` — là CHỦ ĐÍCH**,
  không phải bug: đường dẫn profile được compile sẵn trong Gecko, và giữ nguyên
  để bản cài hMail đè lên Thunderbird cũ không mất thư/cấu hình của người dùng.
  Đổi sang thư mục riêng đòi hỏi migration cẩn thận — chưa làm. Đừng "sửa" vu vơ.

## Bẫy DOM/Gecko đã trả giá để biết

- **Cây DOM runtime của about:message KHÁC aboutMessage.xhtml**: `#messagepane`
  là con trực tiếp của `#messagepanebox` (flex); `#singleMessage` chỉ chứa header.
  UI muốn nằm đáy khung thư thì làm **con cuối in-flow của `#messagepanebox`**
  (browser tự co lại) — đừng dùng position:fixed + tự chừa chỗ.
- Lấy thư đang xem: `tabmail.currentAboutMessage?.gMessage` (đúng cho cả khung đọc
  lẫn tab riêng), fallback `currentAbout3Pane.gDBView`. Cửa sổ riêng: `#messageBrowser`.
- Thanh/banner gắn vào document about:message **sống qua các thư** (chỉ body bị
  thay) — phải tự theo dõi message key để dọn khi đổi thư.
- Toolkit gán margin mặc định cho mọi `<button>` trong document chrome — reset
  `margin: 0 !important` khi xếp nút bằng flex gap.
- Khi khoá style bằng `!important` hàng loạt, nhớ rằng rule ẩn/hiện tương ứng
  (`display: none`) cũng phải `!important` theo.
- IME tiếng Việt (UniKey bơm backspace): không rebuild/đụng DOM quanh textarea
  đang focus; guard Enter bằng `isComposing || keyCode === 229`; draft chưa gửi
  không được coi là "đang bận" nếu thao tác không đụng tới composer.

## Build và phát hành

- **Windows**: `build/build.ps1 -Version X.Y.Z -SkipDownload -Sign` với
  `$env:HMAIL_SIGN_TOKEN`. Ký qua `hAutoSignerService` chạy **ngay trên máy dev**,
  cần **YubiKey cắm vào máy này** — lỗi "No YubiKey/HSM detected" nghĩa là khoá
  bị rút. Log `build-X.Y.Z.log`, xong khi có dòng `Installer:`.
- **macOS**: Mac mini `hqv@192.168.0.14`, repo `~/hMail-Desktop`, version nằm ở
  dòng `env VERSION=…` trong `~/run-mac-build.sh`. Ký headless (màn hình khoá
  vẫn chạy): `security unlock-keychain` **rồi**
  `security set-key-partition-list -S "apple-tool:,apple:,codesign:" -s -k <pw>`;
  sau đó chạy thẳng `env VERSION=X.Y.Z bash build/build-mac.sh` qua SSH.
  Codesign DMG có thể fail thoáng qua vì máy chủ timestamp Apple — ký lại DMG,
  notarize, staple riêng là đủ, không cần build lại.
- Version hiển thị: `hmail.version` (pref stamp lúc build) + `distribution.ini`
  cũng được stamp; màn Giới thiệu ghi bản hMail kèm "(Thunderbird X)" qua patch
  `aboutDialog.js` trong omni_tool.py.
- Cài trên Mac qua SSH: coi chừng **đụng tên volume** — DMG cũ còn mount thì bản
  mới thành `/Volumes/hMail Desktop 1`; luôn kiểm tra `hdiutil info` trước khi
  `ditto`, và verify `hmail.js` version sau khi chép.
- Phát hành: điền SHA-256 vào release notes (placeholder `@WIN_SHA@`/`@MAC_SHA@`),
  `gh release create vX.Y.Z --target main --notes-file … <exe> <dmg>`; app đọc
  `releases/latest` để tự cập nhật (giờ tự tải bộ cài về).

## Debug khi không có DevTools

- Chụp màn hình bằng PowerShell (`CopyFromScreen`) + crop bằng PIL để tự xác minh
  UI; tránh giành chuột/bàn phím khi người dùng đang làm việc.
- Cần số liệu layout runtime: ghi JSON đo đạc vào một pref (`Services.prefs.setCharPref`)
  rồi đọc `prefs.js` của profile từ ngoài (flush trễ ~1 phút). Dọn instrumentation
  trước khi phát hành.
