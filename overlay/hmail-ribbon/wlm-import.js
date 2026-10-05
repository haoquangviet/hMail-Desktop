/* hMail Desktop — nhập dữ liệu từ Windows Live Mail
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Windows Live Mail cổ điển (bản 2009–2012, cài qua Windows Essentials) lưu
 * mỗi thư thành một tệp .eml trong cây thư mục dưới
 *   %LOCALAPPDATA%\Microsoft\Windows Live Mail\
 * Mỗi thư mục trên đĩa = một thư mục thư trong ứng dụng, nên chỉ cần duyệt
 * cây thư mục là giữ nguyên được PHÂN LOẠI thư (thư nào ở hộp nào).
 *
 * TRẠNG THÁI ĐỌC / CỜ: WLM KHÔNG lưu trong .eml mà trong metadata nội bộ
 * (định dạng nhị phân riêng, không có tài liệu). Khi chỉ còn các tệp .eml —
 * đúng thứ khách hàng chép sang máy mới — trạng thái đó không đọc lại được,
 * kể cả công cụ thương mại cũng thường bỏ qua. Vì vậy module dùng lựa chọn
 * của người dùng (mặc định: đánh dấu đã đọc) cho mọi thư. Chỗ gán isRead
 * trong messages() là điểm móc sẵn: nếu sau này có store WLM thật để dịch
 * ngược metadata, chỉ cần thay đúng dòng đó.
 *
 * Module này phơi ra ĐÚNG giao diện của hMailPst (open/folders/messages/
 * close) để panel nhập dữ liệu (outlook-import.js) dùng chung mọi thứ:
 * cây thư mục, chống trùng, dựng lại thư mục, thanh tiến trình.
 */

"use strict";

var hMailWlm = {
  // Bỏ qua các thư mục KHÔNG phải hộp thư nằm trong store WLM.
  SKIP_DIRS: new Set(["DBStore", "backup", "Backup"]),

  /** Đường dẫn store mặc định của WLM cổ điển, hoặc null nếu không dò được. */
  defaultStore() {
    try {
      const local = Services.env.get("LOCALAPPDATA");
      if (!local) {
        return null;
      }
      return local + "\\Microsoft\\Windows Live Mail";
    } catch (e) {
      return null;
    }
  },

  async exists(path) {
    try {
      return await IOUtils.exists(path);
    } catch (e) {
      return false;
    }
  },

  basename(path) {
    return String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  },

  /**
   * Mở store: duyệt toàn bộ cây thư mục, đếm .eml mỗi thư mục và dựng cây
   * node {name, path, messageCount, children} — đúng dạng hMailPst.folders()
   * trả về — kèm map path→thư mục tuyệt đối để messages() tra ngược.
   *
   * `path` của node là đường tương đối trong store, ngăn bằng "/" (ví dụ
   * "Quyet (hotmail)/Inbox"). Nhiều tài khoản → nhiều gốc, nên phân loại
   * theo tài khoản cũng được giữ.
   */
  async open(root, { markRead = true } = {}) {
    const norm = String(root).replace(/[\\/]+$/, "");
    const handle = {
      root: norm,
      dirs: new Map(),
      errors: [],
      markRead,
      tree: [],
    };
    const top = await this._walk(handle, norm, "");
    handle.tree = top.children;
    return handle;
  },

  /** Trả về {messageCount, children} cho một thư mục tuyệt đối. */
  async _walk(handle, absDir, relPath) {
    let messageCount = 0;
    const children = [];
    let entries;
    try {
      entries = await IOUtils.getChildren(absDir);
    } catch (e) {
      return { messageCount, children };
    }

    const subdirs = [];
    for (const child of entries) {
      const name = this.basename(child);
      // Đếm .eml theo đuôi tên, KHÔNG stat: hộp thư có thể hàng chục nghìn
      // tệp, stat từng cái lúc quét sẽ rất chậm. Chỉ stat các mục không phải
      // .eml (số ít) để biết thư mục con.
      if (/\.eml$/i.test(name)) {
        messageCount++;
        continue;
      }
      let info;
      try {
        info = await IOUtils.stat(child);
      } catch (e) {
        continue;
      }
      if (info.type === "directory") {
        if (this.SKIP_DIRS.has(name) || name.startsWith(".")) {
          continue;
        }
        subdirs.push({ abs: child, name });
      }
    }

    for (const sd of subdirs) {
      const childRel = relPath ? `${relPath}/${sd.name}` : sd.name;
      handle.dirs.set(childRel, sd.abs);
      const sub = await this._walk(handle, sd.abs, childRel);
      children.push({
        name: sd.name,
        path: childRel,
        messageCount: sub.messageCount,
        children: sub.children,
      });
    }
    return { messageCount, children };
  },

  folders(handle) {
    return handle?.tree || [];
  },

  /**
   * Duyệt các .eml trong một thư mục, trả về từng thư một (async iterator),
   * cùng giao diện hMailPst.messages(). Đọc lỗi tệp nào thì ghi vào
   * handle.errors và bỏ qua, không làm hỏng cả lượt nhập.
   */
  async *messages(handle, path) {
    const dir = handle.dirs.get(path);
    if (!dir) {
      return;
    }
    let entries = [];
    try {
      entries = await IOUtils.getChildren(dir);
    } catch (e) {
      return;
    }
    for (const file of entries) {
      if (!/\.eml$/i.test(file)) {
        continue;
      }
      let rfc822;
      try {
        rfc822 = await hMailMsg.readEml(file);
      } catch (e) {
        handle.errors.push(file);
        continue;
      }
      // Điểm móc trạng thái đọc: metadata WLM không đọc được từ .eml, dùng
      // lựa chọn của người dùng cho mọi thư (xem ghi chú đầu tệp).
      yield { rfc822, isRead: handle.markRead };
    }
  },

  close(handle) {
    // Không giữ tài nguyên gì mở — chỉ dọn tham chiếu cho nhẹ.
    if (handle) {
      handle.dirs = new Map();
      handle.tree = [];
    }
  },
};
