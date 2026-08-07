# Backlog 2026-08-07 — việc dở dang trên hMail Desktop (handoff)

> Ghi bởi session mailserver 07/08/2026 ~10:00. Working tree có **5 file sửa CHƯA commit, CHƯA build**.
> Đọc `git diff` trước khi làm tiếp. Bản đang phát hành: 1.0.6.
>
> **CẬP NHẬT 07/08 ~10:15:** đã review xong cả 5 file, hoàn thiện và commit. Bổ sung: sửa bug
> toggle nút "+" (click lại không đóng menu vì e.target là SVG con); áp cùng fix tab-riêng cho
> `mailinsight.js` (selected() + chỗ gắn banner) và `spamreport.js`. Comment CSS "blocked by
> policy" hoá ra đã được sửa sẵn trong diff dở dang. Còn lại: build 1.0.7 + user test (mục 2, 3).
>
> **CẬP NHẬT 07/08 ~10:30:** đã build + ký số Windows `dist/hMailDesktopSetup-1.0.7.exe`
> (Authenticode Valid, SHA-256 `CFFF2E16AA0269EED5BF829794D98DC34D0AD9A825110E45E078FF48C364EC6E`).
> Lưu ý build.ps1 phải chạy với `-Sign` (kèm HMAIL_SIGN_TOKEN) — lần chạy đầu thiếu cờ, ra bản
> không ký. Chưa build macOS, chưa release GitHub — chờ user test theo checklist mục 5.

## Trạng thái working tree (git status)

| File | Mục đích thay đổi | Trạng thái |
|---|---|---|
| `overlay/hmail-ribbon/aiassistant-ui.js` (+210) | Redesign menu "+" kiểu Gemini + guard chống rebuild khi đang gõ | XONG, `node --check` pass |
| `overlay/hmail-chrome/custom.css` (+120) | CSS menu "+", plus-button; GIỮ NGUYÊN `.hmail-ai-bar` cũ vì `compose-ai.js` còn dùng | XONG, còn 1 việc nhỏ (xem mục 4) |
| `overlay/hmail-ribbon/aiassistant.js` (+28) | Sửa nhận diện thư mở ở TAB RIÊNG (mục 3) | SỬA DỞ — cần review diff |
| `overlay/distribution/policies.json` | Sửa vụ không gỡ được addon (mục 4) | SỬA DỞ — cần review diff |
| `overlay/hmail.cfg` (+18) | Liên quan mục 4 (cơ chế cài extension) | SỬA DỞ — cần review diff |

Lời nhắn cuối của agent trước khi bị dừng: *"update the CSS comment referencing 'blocked by policy' since the mechanism changed"* — còn 1 comment CSS nói về search-bar bị ẩn "blocked by policy" cần sửa lại cho đúng cơ chế mới.

## 1. ✅ Redesign panel hMail AI kiểu Gemini (yêu cầu owner 07/08)

Bỏ thanh trên đầu (dropdown lệnh mẫu + nút Chạy + ⚙). Composer dưới cùng giờ là `[+] [textarea] [gửi]`; bấm "+" mở popup phía trên (mỗi prompt mẫu 1 dòng, ngăn cách, rồi "⚙ Cài đặt trợ lý…"). Đóng bằng click ngoài/Escape. Status (model · token · $) nằm ngay trên composer. Màu theo `--hmail-ai-*` nên tự ăn dark mode.
**Lưu ý:** `compose-ai.js` (panel AI trong cửa sổ soạn thư) CHƯA đổi theo — vẫn UX cũ, owner chưa yêu cầu; CSS cũ phải giữ.
**Cần:** kiểm tra vị trí menu sau khi build (hiện span ngang ask-box, max-width 320px).

## 2. ✅ Guard chống rebuild khi đang gõ — nghi án chính vụ "không gõ được tiếng Việt trong ô chat AI"

**Lịch sử chẩn đoán (đừng lặp lại):**
- Fix 1.0.6 (`70032f7`, guard isComposing/keyCode 229) KHÔNG đủ — user vẫn gõ ra thô "Ddaay laf thuw gif" (chụp màn hình 07/08).
- Đã loại trừ: app không chạy elevated (đã probe cả 4 process hmail); máy user KHÔNG có bàn phím Telex TSF của Windows (chỉ layout US 0409) → bộ gõ là **UniKeyNT** (hook + inject backspace, KHÔNG dùng composition events → guard isComposing vô nghĩa với UniKey).
- Nghi phạm còn lại phía app: `watchMessageDisplay` poll 700ms gọi `restore(win)` rebuild panel khi message-key đổi → **thay thế textarea giữa lúc gõ** (mất draft + phá chuỗi backspace-injection của UniKey).
- Fix đã code: `composerBusy(win)` (input focused hoặc còn chữ) → hoãn restore/check qua `_pendingRestore`, flush khi blur/empty.

**Cần sau khi build:** user test gõ tiếng Việt lại. Nếu VẪN thô → thủ phạm phía hệ thống/UniKey, cô lập bằng: gõ thử vào ô Tìm kiếm thư (quick filter) cùng cửa sổ; thử EVKey; thử bật bàn phím Telex built-in Win11.

## 3. ✅ Thư mở ở TAB RIÊNG → hMail AI báo "Hãy chọn một thư trước"

Nguyên nhân: `selectedMessage(win)` chỉ đọc selection 3-pane, không xử lý tab kiểu `mailMessageTab`. Fix đã hoàn thiện: dùng `tabmail.currentAboutMessage?.gMessage` (TB140 expose cho cả 2 mode tab), fallback 3-pane. Watcher 700ms tự đổi key khi chuyển tab vì nó poll `selectedMessage` mỗi tick. Cùng lỗi đã fix luôn ở `mailinsight.js` (cả `selected()` lẫn chỗ chọn document gắn banner — phải cùng trỏ vào about:message của tab) và `spamreport.js`. **Còn:** test cả 3 ngữ cảnh (3-pane / tab riêng / cửa sổ riêng) sau khi build.

## 4. 🚧 Không gỡ được addon/extension đã cài

Dấu vết từ diff dở dang: nguyên nhân là extension bị cài qua **`policies.json` ExtensionSettings (force_installed)** → Add-ons Manager ẩn nút Remove. Agent đã đổi cơ chế trong `policies.json` + `overlay/hmail.cfg` (đọc diff 2 file này để biết cơ chế mới). Việc còn: sửa comment trong `custom.css` nhắc "blocked by policy" cho khớp cơ chế mới; verify extension bundled vẫn được cài nhưng addon user tự cài gỡ được bình thường.

## 5. ✅ ĐÃ KẾT LUẬN — Lời nhắc "Chúc mừng sinh nhật" không Bỏ qua được (lỗi 400)

KHÔNG phải bug hMail Desktop hay mailserver. Log `cyrus/http` trên mail.haoquangviet.com sạch (chỉ REPORT 207, không có PUT lỗi). Lỗi "Server Replied with 400" (mã 0x80004005) đến từ **Google CalDAV** khi Thunderbird PUT `X-MOZ-LASTACK` (dismiss) lên event sinh nhật trên lịch Google ("Gia đình"/Gmail). Workaround cho user: chuột phải lịch Google → Thuộc tính → "Chỉ đọc" hoặc tắt "Hiện lời nhắc". Cải tiến tương lai (tùy chọn): surface lỗi ghi lịch rõ hơn thay vì dialog chung chung.

## 6. 🆕 (07/08 chiều) Banner "Lời mời họp" (meetings.js): chậm + vỡ layout + không check trạng thái

Screenshot owner: thư mời Google Calendar (invite.ics, METHOD:REQUEST) mở trong hMail Desktop —
banner "Lời mời họp" CÓ hiện nhưng: (1) **hiện rất chậm** (owner tưởng không có); (2) **bảng vỡ layout** —
các cột (Sự kiện/Thời gian/Địa điểm/Người tổ chức) bị ép rộng ~1 ký tự, chữ xuống dòng dọc từng ký tự
(table không có width/table-layout trong pane hẹp; cần đổi sang layout dọc label:value hoặc grid + min-width,
responsive theo độ rộng message pane); (3) nút Chấp nhận/Có thể/Từ chối **không check CalDAV** xem event
(cùng UID) đã tồn tại/đã trả lời chưa → bấm nhiều lần tạo trùng sự kiện. Yêu cầu owner: check lịch theo UID
trước khi render (hiện "Đã chấp nhận ✓" + cho đổi câu trả lời thay vì 3 nút trơn), tạo event idempotent theo UID,
và tối ưu tốc độ hiện banner (parse ics + render trước, đừng chờ network).
File: `overlay/hmail-ribbon/meetings.js` (+ css tương ứng). Tham khảo cách webmail làm: `hqv_itip` (mailserver repo).

> **CẬP NHẬT 07/08 ~16:15 (điều tra + fix một phần):**
> - Banner này KHÔNG phải meetings.js (file đó là tạo họp Meet/Teams). Nó là **panel built-in
>   của Thunderbird**: `imip-bar.js` + custom element `calendar-invitation-panel` (shadow DOM).
> - Vì shadow DOM nên userChrome/custom.css KHÔNG với tới — mọi chỉnh giao diện phải append vào
>   `chrome/calendar/skin/.../shared/widgets/calendar-invitation-panel.css` **trong omni.ja**
>   (đã thêm case trong `build/omni_tool.py`, commit `209897f`).
> - ✅ (2) Vỡ layout: đã fix — bảng props xếp dọc nhãn-trên-giá-trị, sống ở mọi độ rộng pane.
>   Đã hot-patch omni.ja bản Windows đang cài (kèm .purgecaches); vào bản build kế cho macOS.
> - ⏳ (1) Chậm hiện banner và (3) check trạng thái theo UID/idempotent: chưa làm — nằm trong
>   logic `imip-bar.js`/`calItipUtils` (itip lookup chờ calendar khởi động xong; nút Accept
>   không hỏi lịch CalDAV xem UID đã có/đã trả lời chưa). Cần thư mời thật để repro; hướng:
>   patch omni thêm bước tra `calendar.getItem(uid)` trước khi render nút, và render phần
>   tĩnh (parse ics) ngay khi thư mở, đừng chờ itip processing.

## 7. 🆕 (07/08 tối) `hmail://quit` không còn tác dụng với instance đang chạy

Phát hiện khi deploy: `hmail.exe -osint -hmail-url "hmail://quit"` từng hoạt động (xác nhận 05/08),
nay gửi tới instance đang chạy thì không có gì xảy ra (app idle, không dialog chặn, window vẫn mở,
thử nhiều lần 45–60s). Đây cũng là đường Quit của **menu khay hệ thống** → nếu hỏng thật thì user
không thoát được app từ tray. Cần: repro với app vừa khởi động sạch (không index), kiểm tra
command-line forwarding có gọi tới handler trong hmail.cfg không (thêm log tạm), soát lại
`Services.startup.quit(eAttemptQuit|eForceQuit)` — hai hằng này KHÔNG phải bitflag, OR ra 0x03
(eForceQuit) vẫn đúng nhưng nên viết tường minh. Lưu ý file JS/CSS deploy được khi app đang chạy
(không bị khoá) — chỉ cần restart tự nhiên để nhận.

## 8. ✅ (07/08 đêm, ĐÃ FIX) hmailmovedata.exe không tự mở lại app sau move

Move thật sang D:\hMailData: copy + trỏ profiles.ini + xoá nguồn đều chuẩn, nhưng bước
`Process.Start(app)` của helper không làm hMail chạy (không exception, không process) → helper
chờ 60s không thấy app rồi bung prompt "chuyển ngược" (may là chưa ai bấm Yes). Chạy tay
`explorer.exe hmail.exe` ngay sau đó thì lên bình thường trên đúng profile mới. Nghi:
môi trường/working-dir của tiến trình helper. Hướng: đặt ProcessStartInfo WorkingDirectory =
thư mục app + UseShellExecute=true, hoặc mở qua explorer.exe như deploy-dev; thêm retry +
báo lỗi rõ nếu app không xuất hiện sau 10s. Cũng nên sửa monitor grep profiles.ini trong
quy trình vận hành (lần này grep bash báo âm tính giả do escaping, gây chẩn đoán nhầm).

## Checklist hoàn tất

1. ~~Review diff 5 file (nhất là 3 file "SỬA DỞ")~~ ✅
2. ~~Sửa comment CSS "blocked by policy"~~ ✅ (đã nằm sẵn trong diff dở dang)
3. ~~`node --check` mọi file JS đã sửa~~ ✅ (aiassistant.js, aiassistant-ui.js, mailinsight.js, spamreport.js đều pass; policies.json parse OK)
4. ~~Commit (tiếng Việt, conventional, không AI references)~~ ✅
5. Build 1.0.7 + ký số, test: gõ tiếng Việt UniKey trong ô chat AI · menu "+" (sáng/tối) · nhận diện thư ở tab riêng (cả banner cảnh báo + nút báo thư rác) · gỡ addon user-installed · compose-ai không vỡ · lời nhắc Google (chỉ hướng dẫn user, không code)
