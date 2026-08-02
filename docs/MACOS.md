# hMail Desktop trên macOS

Bản macOS dùng chung toàn bộ phần cấu hình với Windows (`overlay/`, `omni-patches/`);
chỉ khác ở cách đóng gói và ký. Script: [`build/build-mac.sh`](../build/build-mac.sh).

> **Trạng thái:** đã build và notarize thành công trên macOS 15.6.1 (Apple Silicon)
> với chứng thư *Developer ID Application: HAO QUANG VIET SOFTWARE COMPANY LIMITED
> (TSGHKT73MA)*. Gatekeeper xác nhận `accepted — source=Notarized Developer ID`.

## Chuẩn bị (làm một lần)

Trên máy Mac, cần:

1. **Xcode command line tools**: `xcode-select --install`
2. **Python 3 + Pillow**: `pip3 install pillow`
3. **Chứng thư "Developer ID Application"** của HQV Software trong login keychain.
   Kiểm tra: `security find-identity -v -p codesigning`
4. **Hồ sơ notarytool.** Dự án dùng App Store Connect API key (bền hơn
   app-specific password vì không gắn với tài khoản cá nhân). Đặt file `.p8`
   ở `~/.private_keys/` với quyền `600`, rồi:

```bash
xcrun notarytool store-credentials hmail-notary \
    --key ~/.private_keys/AuthKey_<KEYID>.p8 \
    --key-id <KEYID> --issuer <ISSUER_ID>

xcrun notarytool history --keychain-profile hmail-notary   # kiểm tra kết nối
```

**Không commit file `.p8` vào repo.**

## Build

```bash
git clone https://github.com/haoquangviet/hMail-Desktop.git
cd hMail-Desktop
./build/build-mac.sh              # ký + notarize + staple đầy đủ
./build/build-mac.sh --no-sign    # bản chưa ký, chỉ để test cục bộ
```

Kết quả: `dist/hMailDesktop-<version>.dmg`.

Ghi đè bằng biến môi trường khi cần: `VERSION`, `TB_VERSION`, `LOCALE`,
`SIGN_IDENTITY`, `NOTARY_PROFILE`.

## Những khác biệt so với Windows

| Hạng mục | Windows | macOS |
|---|---|---|
| Thư mục "install root" | `C:\Program Files\hMail Desktop\` | `hMail Desktop.app/Contents/Resources/` |
| Thương hiệu | PE version strings + `.ico` | `Info.plist` + `.icns` |
| Vị trí `policies.json` | `distribution\policies.json` | `Contents/Resources/distribution/policies.json` |
| Autoconfig | `hmail.cfg` cạnh exe | `Contents/Resources/hmail.cfg` |
| Ký số | Authenticode (SSL.com) | Developer ID + **notarize bắt buộc** |
| Đóng gói | NSIS installer | `.dmg` kéo-thả vào Applications |

## Vì sao bắt buộc notarize

Từ macOS 10.15, ứng dụng ký Developer ID mà không notarize sẽ bị Gatekeeper chặn.
Từ macOS 15 Sequoia, Apple đã **bỏ luôn cách bấm chuột phải → Open** để lách —
người dùng phải vào System Settings → Privacy & Security bật thủ công. Không thể
phát hành thương mại theo kiểu đó.

Script notarize **hai lần**, có lý do: staple vào `.app` trước, rồi mới đóng `.dmg`,
sau đó notarize và staple luôn `.dmg`. Nếu chỉ staple `.dmg`, khi người dùng kéo app
ra `/Applications` thì ticket không đi theo, và Gatekeeper phải kiểm tra online —
máy không có mạng sẽ báo lỗi.

## Điểm cần lưu ý khi bump phiên bản Thunderbird

- Script tự dump entitlements của bản Thunderbird chính thức ra
  `work-mac/upstream-entitlements.plist` trước khi xóa chữ ký cũ. **Hãy diff** file
  đó với [`installer/hmail.entitlements`](../installer/hmail.entitlements) để phát
  hiện entitlement mới mà Gecko cần.
- Trình cập nhật thật nằm ở `Contents/Library/LaunchServices/org.mozilla.updater`,
  còn `Contents/MacOS/updater.app/...` chỉ là symlink trỏ vào đó. Phải xóa **cả hai**,
  nếu bỏ sót thì symlink chết sẽ làm hỏng chữ ký (`invalid sealed resource`).
- `embedded.provisionprofile` của Mozilla phải xóa — ta không ký lại được.
- Đổi `CFBundleIdentifier` thành `com.hqvsoftware.hmail` cũng đổi domain đọc
  cấu hình MDM (`/Library/Preferences/com.hqvsoftware.hmail.plist`). `policies.json`
  trong bundle không bị ảnh hưởng.
- Mọi file trong bundle đều nằm trong phạm vi chữ ký. Muốn đổi `policies.json` cho
  từng khách hàng thì **phải ký lại** — hoặc phát cấu hình qua MDM configuration
  profile để khỏi đụng vào bundle.
- Bundle còn hai thành phần mang tên Thunderbird mà script phải đổi tên:
  `Contents/Library/Spotlight/thunderbird.mdimporter` (kèm executable
  `thunderbird-mdimport`) và `media-plugin-helper.app/Contents/MacOS/Thunderbird
  Media Plugin Helper`. Cả hai đều hiện ra với người dùng (Spotlight, danh sách
  Force Quit, hộp thoại xin quyền), nên bắt buộc phải rebrand. Sau khi đổi tên
  phải xóa `_CodeSignature` cũ của chúng rồi ký lại.
- Máy Mac dùng Python hệ thống **3.9**, không phải 3.10+ — tránh dùng API mới
  trong các script build dùng chung với Windows.
- Khi ký qua SSH, `codesign` báo `errSecInternalComponent` nếu keychain chưa mở
  khóa. Chạy `security unlock-keychain` trước.

## Nếu sau này muốn build không cần máy Mac

Toàn bộ phần rebrand (`omni.ja`, `.icns`, `Info.plist`, overlay) chạy được trên
Windows/Linux — `make_icns.py` sinh `.icns` không cần công cụ Apple. Chỉ khâu ký và
notarize là cần macOS. Hai lựa chọn:

- **GitHub Actions `macos-latest` runner** (khuyến nghị): repack ở đâu cũng được, job
  macOS lo ký + notarize + staple, chứng thư `.p12` và App Store Connect API key để
  trong GitHub Secrets. Đây là cách Mozilla và dự án `librewolf-signed` đang làm.
- **`rcodesign`** (Rust, chạy trên Windows): ký và notarize được, nhưng tác giả cảnh
  báo phần ký bundle còn nhiều lỗi tinh vi, và bundle của Thunderbird có đủ thứ khó
  (nested app, symlink helper, Spotlight importer, mấy chục dylib). Ngoài ra
  `rcodesign` không staple được vào `.dmg` vì không ghi được HFS+. Chỉ nên coi là
  phương án dự phòng.
