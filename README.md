# hMail Desktop

**hMail Desktop** là ứng dụng email cho Windows của **HQV Software** — xây dựng trên nền mã nguồn mở Mozilla Thunderbird, với giao diện hiện đại lấy cảm hứng từ phong cách các ứng dụng mail văn phòng quen thuộc, tích hợp sẵn trợ lý AI do HQV Software tự phát triển (Google Gemini, các dịch vụ dùng API kiểu OpenAI, hoặc AI chạy ngay trên máy) và bộ cấu hình tối ưu cho người dùng doanh nghiệp.

**hMail Desktop** is a Windows email client by **HQV Software**, built on the open-source Mozilla Thunderbird codebase, with a modern office-style UI, an AI assistant developed by HQV Software (Google Gemini, any OpenAI-compatible service, or a model running locally), and enterprise-friendly defaults.

> **Notice / Tuyên bố:** hMail Desktop is based on Mozilla Thunderbird open source code.
> **hMail Desktop and Thunderbird are not officially associated with Mozilla or its products.**

---

## Tải về / Download

Bản cài đặt phát hành tại [GitHub Releases](https://github.com/haoquangviet/hMail-Desktop/releases) — Windows (x64) và macOS (universal, Intel + Apple Silicon).

- Yêu cầu: Windows 10/11 64-bit.
- Bản cài đặt được **ký số Authenticode** bởi *HAO QUANG VIET SOFTWARE COMPANY LIMITED* (chứng thư SSL.com, timestamp RFC3161). Bạn có thể kiểm chứng bằng chuột phải vào file → *Properties → Digital Signatures*.

## Tính năng chính

- **Giao diện kiểu Outlook**: bố cục dọc với khung đọc bên phải, danh sách thư dạng thẻ, avatar người gửi, nhóm thư theo ngày, tông màu xanh văn phòng.
- **Trợ lý AI tích hợp sẵn**: tóm tắt thư, soạn thư trả lời, phân loại, rút ra việc cần làm, dịch — ngay trong ngăn bên phải, không mở cửa sổ phụ. **Lưu lại lịch sử trao đổi theo từng thư**, và có thể **tự chạy một câu lệnh khi mở thư** (tùy bạn cấu hình, mặc định tắt).
  - **Làm được việc, không chỉ trả lời**: đánh dấu, gắn cờ, gắn nhãn, chuyển thư mục, lưu trữ, báo thư rác, mở sẵn cửa sổ trả lời — hỏi bằng lời, hMail làm; những việc khó hoàn tác đều hỏi xác nhận.
  - **Ngay trong trình soạn thảo**: soạn thư trả lời, gợi ý trả lời nhanh, viết lại, rút gọn, sửa chính tả, dịch — kết quả chèn vào thư khi bạn bấm, không bao giờ tự gửi.
  - **Chọn nhà cung cấp tuỳ ý**: Google Gemini, OpenAI, DeepSeek, Groq, OpenRouter, hoặc AI chạy ngay trên máy (Ollama, LM Studio, Windows AI Foundry Local) — mỗi dịch vụ giữ cấu hình và API key riêng.
  - **Biết mình tiêu bao nhiêu**: đếm số token thật do nhà cung cấp báo về và quy ra chi phí ước tính, theo từng dịch vụ.
- **Nhập dữ liệu từ Outlook (.pst)**: đọc thẳng tệp .pst — không cần cài Outlook — giữ nguyên cây thư mục và trạng thái đã đọc; nhập hàng trăm nghìn thư, dừng giữa chừng chạy lại tự bỏ qua thư đã nhập; nhận cả tệp .eml/.msg rời. Công cụ chuyển đổi trọn vẹn cho người rời Outlook.
- **Cảnh báo thư đáng ngờ & phân tích nội dung**: hMail soi từng thư đến — người lạ mới vào chuỗi thư, tên miền nhìn giống tên miền quen (đánh tráo ký tự), xác thực SPF/DKIM/DMARC không đạt, liên kết trỏ đi nơi khác với chữ hiển thị — và cảnh báo ngay trên thư kèm giải thích vấn đề bằng lời dễ hiểu, trước khi bạn kịp trả lời hay bấm nhầm. Huy hiệu xác thực người gửi (BIMI) hiển thị cạnh tên.
- **Quản lý thư rác trên máy chủ**: báo cáo spam, xem và nhận lại thư bị bộ lọc giữ, ngay trong hMail. Đánh dấu thư rác cũng tự huấn luyện máy chủ lọc.
- **Trả lời nhanh dưới thư**: ô trả lời nằm ngay dưới nội dung — gõ, Enter, xong; cần viết dài thì mở soạn thảo đầy đủ, chữ đã gõ vẫn giữ nguyên.
- **Gửi hàng loạt (mail merge)**: mỗi người nhận một bản riêng, thay tên và thông tin từng người, giãn cách gửi để không bị máy chủ chặn.
- **Tự động hóa bằng AI (hMail Flow)**: đặt quy tắc khi thư đến — điều kiện thường kết hợp câu hỏi ngữ nghĩa cho AI — tự gắn nhãn, phân loại, tóm tắt, trả lời; có hạn mức chi phí và nhật ký từng hành động.
- **Đầy đủ Lịch, Công việc, Danh bạ**: đồng bộ lịch + danh bạ Google tự động sau một lần cấp quyền; máy chủ CalDAV/CardDAV tự phát hiện từ tài khoản thư; tạo họp **Google Meet / Microsoft Teams** một nút bấm ngay trên tab Lịch.
- **Tinh gọn**: đã loại bỏ Chat, Newsgroups, RSS; tắt telemetry; không có quảng cáo/quyên góp.
- **Kênh cập nhật riêng**: ứng dụng kiểm tra phiên bản mới qua GitHub Releases của repo này.

## Mã nguồn & giấy phép (MPL 2.0 compliance)

hMail Desktop là bản **repack có tùy biến** của Mozilla Thunderbird phiên bản chính thức:

- Phiên bản Thunderbird gốc được ghim chính xác (số phiên bản + SHA256 + URL) trong [UPSTREAM.md](UPSTREAM.md).
- **Toàn bộ file đã sửa đổi** so với bản gốc nằm trong [omni-patches/](omni-patches/) và [overlay/](overlay/).
- Script dựng lại binary từ bản gốc + các sửa đổi: [build/build.ps1](build/build.ps1) — bất kỳ ai cũng có thể tái tạo đúng bản phát hành.
- Mã nguồn Thunderbird gốc: <https://hg-edge.mozilla.org/releases/comm-esr140/> và <https://archive.mozilla.org/pub/thunderbird/releases/>.

Chi tiết giấy phép trong [LICENSE.md](LICENSE.md):

| Thành phần | Giấy phép |
|---|---|
| Mã Mozilla Thunderbird + các file Mozilla được sửa đổi (trong `omni-patches/`) | MPL 2.0 |
| File mới do HQV Software viết (script build, cấu hình, CSS tùy biến, installer) | [Giấy phép Cộng đồng hMail](LICENSE-HQV.md) — miễn phí cho cá nhân, doanh nghiệp cần giấy phép thương mại |
| Theme cơ sở từ [Browmew/thunderbird-outlook-theme](https://github.com/Browmew/thunderbird-outlook-theme) | MIT |
| Trợ lý AI, ribbon, ngăn bên, lịch & họp Meet/Teams, nhập PST, lọc thư rác (do HQV Software phát triển) | [Giấy phép Cộng đồng hMail](LICENSE-HQV.md) — miễn phí cho cá nhân, doanh nghiệp cần giấy phép thương mại |
| Logo và tên "hMail" | © HQV Software, bảo lưu mọi quyền |

## Build từ source

```powershell
# Yêu cầu: Windows, PowerShell, 7-Zip, Python 3.10+ (Pillow), NSIS
git clone https://github.com/haoquangviet/hMail-Desktop.git
cd hMail-Desktop
.\build\build.ps1          # tải Thunderbird ESR chính thức, verify SHA256, áp patch, đóng gói installer
# Kết quả: dist\hMailDesktopSetup-<version>.exe

python build\compliance_check.py   # kiểm tra tuân thủ MPL 2.0 / trademark trên bản vừa build
```

Bản macOS build trên máy Mac — xem hướng dẫn chi tiết tại [docs/MACOS.md](docs/MACOS.md):

```bash
./build/build-mac.sh          # rebrand, ký Developer ID, notarize, đóng .dmg
```

Để build ra bản Windows đã ký số (cần quyền truy cập dịch vụ ký của HQV Software):

```powershell
$env:HMAIL_SIGN_TOKEN = "<token dịch vụ ký>"
.\build\build.ps1 -Sign                  # ký qua dịch vụ (mặc định)

# Hoặc ký bằng USB token cắm trực tiếp:
$env:HMAIL_SIGN_THUMBPRINT = "<thumbprint chứng thư>"
$env:HMAIL_SIGN_PIN        = "<PIN token>"
.\build\build.ps1 -Sign -SignVia local
```


## Trademark

"hMail" và logo hMail là nhãn hiệu của HQV Software.
Mozilla Thunderbird và logo Thunderbird là nhãn hiệu của Mozilla Foundation — sản phẩm này **không** sử dụng các nhãn hiệu đó và **không** liên kết chính thức với Mozilla.
