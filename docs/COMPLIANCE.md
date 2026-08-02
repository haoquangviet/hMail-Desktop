# Compliance checklist — hMail Desktop

Trạng thái tuân thủ MPL 2.0 + Mozilla Trademark Policy cho từng bản phát hành.

Phần lớn checklist dưới đây được **kiểm tra tự động** bằng:

```powershell
python build\compliance_check.py        # chạy sau mỗi lần build, exit != 0 nếu có mục fail
```

Các mục còn lại (trang phát hành, release notes) kiểm tra thủ công trước khi publish.

**Kết quả v0.1.0 (base Thunderbird 140.13.0esr):** tất cả các mục tự động đều PASS.

## Trademark (Mozilla Trademark Guidelines / Distribution Policy)

- [ ] Không còn chữ "Thunderbird"/"Mozilla" trong: tiêu đề cửa sổ, About dialog, Start Menu, taskbar, Add/Remove Programs, installer/uninstaller UI.
- [ ] `brand.ftl` / `brand.dtd` / `brand.properties` đã thay ở **mọi locale** đóng gói (en-US, vi).
- [ ] Toàn bộ ảnh `chrome://branding/*` (about-logo, icon32–256, wordmark) đã thay bằng artwork hMail (vẽ mới, không phái sinh logo Thunderbird).
- [ ] `chrome\icons\default\*.ico`, `VisualElements\`, icon PE trong exe đã thay.
- [ ] PE version strings (CompanyName/ProductName/FileDescription/OriginalFilename) = HQV Software / hMail Desktop.
- [ ] Không có artwork Thunderbird chính thức nào bị commit vào repo.
- [ ] Câu miễn trừ đúng nguyên văn xuất hiện ở: About dialog, README, GitHub Release notes:
      "hMail Desktop is based on Mozilla Thunderbird open source code. hMail Desktop and Thunderbird are not officially associated with Mozilla or its products."
- [ ] Chỉ nhắc "Thunderbird" bằng chữ (không logo) và luôn kém nổi bật hơn thương hiệu hMail.

## MPL 2.0 (§3.1, §3.2, §3.4)

- [ ] UPSTREAM.md ghim đúng version + SHA-256 của bản Thunderbird gốc dùng để build.
- [ ] Mọi file Mozilla bị sửa đều nằm trong `omni-patches/` (giữ header MPL, không thêm license khác).
- [ ] `build/build.ps1` tái tạo được binary phát hành từ bản gốc + repo này (kiểm chứng độc lập).
- [ ] `license.txt` và `about:license` trong bản cài còn nguyên vẹn.
- [ ] Con trỏ tới source (URL repo này) hiển thị trong About dialog + Release notes.
- [ ] Repo public còn hoạt động chừng nào bản phát hành còn được tải.

## Ngắt kết nối hạ tầng Mozilla

- [ ] `DisableAppUpdate` active (kiểm tra `about:policies`), `updater.exe`/`precomplete`/`removed-files`/`update-settings.ini`/maintenanceservice đã xóa khỏi bản cài.
- [ ] Telemetry/Glean tắt (`DisableTelemetry` + `datareporting.*`).
- [ ] Crash reporter tắt (không gửi về socorro của Mozilla).
- [ ] Start page Thunderbird tắt; link Help/Support không trỏ về mozilla.org/thunderbird.net.
- [ ] Add-ons discovery không trỏ addons.thunderbird.net (add-on ngoài đã bị chặn qua policy).

## Giấy phép thành phần bên thứ ba

- [ ] MIT notice của Browmew/thunderbird-outlook-theme còn trong header CSS vendored.
- [ ] ThunderAI (GPL-3.0) đóng gói nguyên bản, ghi nhận trong LICENSE.md; link source upstream.
- [ ] Fluent icons (Microsoft, MIT) ghi nhận trong LICENSE.md.
