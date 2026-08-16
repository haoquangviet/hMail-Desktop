/* hMail Desktop — xem bên trong tệp nén đính kèm, kiểu hộp kính
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Một tệp .zip đính kèm là một hộp đen: muốn biết bên trong có gì phải lưu
 * về máy rồi mở — đúng thao tác mà thư lừa đảo mong chờ. Tab này mở hộp mà
 * không đụng hàng: nsIZipReader của Gecko đọc mục lục và từng entry NGAY
 * TRONG BỘ NHỚ — không giải nén ra đĩa, không đưa cho ứng dụng ngoài, không
 * thực thi bất cứ gì.
 *
 * "Sandbox" ở đây là sự trơ tuyệt đối của cách hiển thị: file chữ hiện bằng
 * textContent (không parse), file HTML cũng chỉ hiện DƯỚI DẠNG CHỮ, ảnh hiện
 * qua data URI tĩnh. Mọi thứ khác chỉ có tên và kích thước. Trần dung lượng
 * chặn zip bomb; zip đặt mật khẩu thì nói thẳng là không mở được.
 */

"use strict";

var hMailZipView = {
  TAB_MODE: "hmailZipView",
  MAX_ARCHIVE: 50 * 1024 * 1024,
  MAX_PREVIEW: 256 * 1024,
  TEXT_EXT: /\.(txt|log|csv|json|xml|html?|md|ini|cfg|conf|yml|yaml|js|ts|css|php|py|sh|bat|ps1|sql|eml)$/i,
  IMAGE_EXT: /\.(png|jpe?g|gif|webp|bmp|ico)$/i,
  ZIP_EXT: /\.(zip|jar|xpi|docx|xlsx|pptx|odt|ods|odp|epub)$/i,

  // ------------------------------------------------------------- cài móc

  init(win) {
    try {
      win.setInterval(() => {
        try {
          const tabmail = win.document.getElementById("tabmail");
          this.attachMenu(win, tabmail?.currentAboutMessage?.document);
        } catch (e) {}
      }, 1500);
    } catch (e) {
      Cu.reportError("hMail zip view init failed: " + e);
    }
  },

  /** Thêm mục vào menu chuột phải của phần đính kèm trong about:message. */
  attachMenu(win, doc) {
    const menu = doc?.getElementById("attachmentItemContext");
    if (!menu || menu.dataset.hmailZip) {
      return;
    }
    menu.dataset.hmailZip = "1";
    menu.addEventListener("popupshowing", () => {
      try {
        let item = doc.getElementById("hmail-zip-view");
        if (!item) {
          item = doc.createXULElement("menuitem");
          item.id = "hmail-zip-view";
          item.setAttribute("label", "Xem bên trong tệp nén (an toàn)");
          item.addEventListener("command", () => {
            const attachment = this.pickedAttachment(doc);
            if (attachment) {
              this.openTab(win, attachment).catch(e =>
                Cu.reportError("hMail zip view failed: " + e));
            }
          });
          menu.appendChild(item);
        }
        const attachment = this.pickedAttachment(doc);
        item.hidden = !attachment ||
          !this.ZIP_EXT.test(String(attachment.name || ""));
      } catch (e) {}
    });
  },

  pickedAttachment(doc) {
    try {
      return doc.getElementById("attachmentList")?.selectedItem?.attachment ||
             null;
    } catch (e) {
      return null;
    }
  },

  // --------------------------------------------------------------- dữ liệu

  /** Kéo phần đính kèm về một file tạm để nsIZipReader mở được. */
  async fetchToTemp(attachment) {
    if ((attachment.size || 0) > this.MAX_ARCHIVE) {
      throw new Error("tệp nén quá lớn để xem an toàn (trần 50 MB)");
    }
    const { NetUtil } = ChromeUtils.importESModule(
      "resource://gre/modules/NetUtil.sys.mjs");
    const bytes = await new Promise((resolve, reject) => {
      NetUtil.asyncFetch({
        uri: attachment.url,
        loadUsingSystemPrincipal: true,
      }, (stream, status) => {
        try {
          if (!Components.isSuccessCode(status)) {
            reject(new Error("không đọc được phần đính kèm"));
            return;
          }
          const data = NetUtil.readInputStream(stream, stream.available());
          resolve(new Uint8Array(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    if (bytes.length > this.MAX_ARCHIVE) {
      throw new Error("tệp nén quá lớn để xem an toàn (trần 50 MB)");
    }
    const path = PathUtils.join(PathUtils.tempDir,
      `hmail-zipview-${Date.now()}.zip`);
    await IOUtils.write(path, bytes);
    return path;
  },

  openReader(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const reader = Cc["@mozilla.org/libjar/zip-reader;1"]
      .createInstance(Ci.nsIZipReader);
    reader.open(file);
    return reader;
  },

  entries(reader) {
    const out = [];
    for (const name of reader.findEntries("*")) {
      try {
        const entry = reader.getEntry(name);
        out.push({
          name,
          dir: entry.isDirectory,
          size: entry.realSize,
          packed: entry.size,
        });
      } catch (e) {}
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  },

  readEntryBytes(reader, name, cap) {
    const stream = reader.getInputStream(name);
    const binary = Cc["@mozilla.org/binaryinputstream;1"]
      .createInstance(Ci.nsIBinaryInputStream);
    binary.setInputStream(stream);
    const take = Math.min(stream.available(), cap);
    const bytes = new Uint8Array(take);
    for (let done = 0; done < take;) {
      const chunk = binary.readByteArray(Math.min(65536, take - done));
      bytes.set(chunk, done);
      done += chunk.length;
    }
    binary.close();
    return bytes;
  },

  // ------------------------------------------------------------------- UI

  el(doc, tag, cls, text) {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  },

  async openTab(win, attachment) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    const path = await this.fetchToTemp(attachment);
    let reader;
    try {
      reader = this.openReader(path);
    } catch (e) {
      await IOUtils.remove(path).catch(() => {});
      Services.prompt.alert(win, "Xem tệp nén",
        "Không mở được tệp nén này — có thể tệp hỏng, đặt mật khẩu, hoặc " +
        "không phải định dạng ZIP (RAR/7z chưa hỗ trợ).");
      return;
    }

    const self = this;
    if (!tabmail.tabModes?.[this.TAB_MODE]) {
      tabmail.registerTabType({
        name: self.TAB_MODE,
        perTabPanel: "vbox",
        modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 3 } },
        openTab(tab, args) {
          tab.title = "Bên trong: " + args.label;
          tab.panel.classList.add("hmail-import-tab");
          tab.panel.appendChild(
            self.buildPanel(win, args.reader, args.label, args.path));
          tab._hmailZip = args;
        },
        closeTab(tab) {
          try {
            tab._hmailZip?.reader.close();
          } catch (e) {}
          IOUtils.remove(tab._hmailZip?.path || "").catch(() => {});
        },
        saveTabState() {},
        showTab(tab) {
          tab.title = "Bên trong: " + (tab._hmailZip?.label || "tệp nén");
        },
        persistTab() {
          return null;
        },
      });
    }
    tabmail.openTab(this.TAB_MODE,
      { reader, path, label: attachment.name || "tệp nén" });
  },

  buildPanel(win, reader, label, path) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const root = el("div", "hmail-import hmail-zipview");
    root.appendChild(el("div", "hmail-import-title", "Bên trong " + label));
    root.appendChild(el("div", "hmail-import-note",
      "Chế độ xem an toàn: chỉ đọc trong bộ nhớ — không giải nén ra máy, " +
      "không chạy bất cứ tệp nào. File chữ hiện nguyên văn (HTML cũng chỉ " +
      "hiện dưới dạng chữ), ảnh hiện tĩnh. Muốn dùng tệp thật thì vẫn lưu " +
      "về máy như bình thường — sau khi đã nhìn rõ bên trong."));

    const wrap = el("div", "hmail-zip-wrap");
    const list = el("div", "hmail-zip-list");
    const view = el("div", "hmail-zip-preview");
    view.appendChild(el("div", "hmail-import-note",
      "Chọn một tệp bên trái để xem trước."));
    wrap.append(list, view);
    root.appendChild(wrap);

    const items = this.entries(reader);
    const fmt = n => n >= 1024 * 1024
      ? (n / 1024 / 1024).toFixed(1) + " MB"
      : Math.max(1, Math.round(n / 1024)) + " KB";
    if (!items.length) {
      list.appendChild(el("div", "hmail-import-note", "Tệp nén rỗng."));
    }
    for (const item of items) {
      const row = el("button", "hmail-zip-row");
      row.type = "button";
      row.append(
        el("span", "hmail-zip-name", (item.dir ? "📁 " : "") + item.name),
        el("span", "hmail-zip-size", item.dir ? "" : fmt(item.size)));
      if (!item.dir) {
        row.addEventListener("click", () =>
          this.preview(win, view, reader, item));
      }
      list.appendChild(row);
    }
    return root;
  },

  preview(win, view, reader, item) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    view.textContent = "";
    view.appendChild(el("div", "hmail-zip-preview-head",
      `${item.name} — ${Math.round(item.size / 1024)} KB`));
    try {
      if (this.IMAGE_EXT.test(item.name)) {
        const bytes = this.readEntryBytes(reader, item.name, this.MAX_PREVIEW * 8);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) {
          binary += String.fromCharCode
            .apply(null, bytes.subarray(i, i + 32768));
        }
        const ext = item.name.split(".").pop().toLowerCase();
        const mime = { png: "image/png", gif: "image/gif", webp: "image/webp",
                       bmp: "image/bmp", ico: "image/x-icon" }[ext] ||
                     "image/jpeg";
        const img = el("img", "hmail-zip-img");
        img.src = `data:${mime};base64,${win.btoa(binary)}`;
        view.appendChild(img);
        return;
      }
      if (this.TEXT_EXT.test(item.name)) {
        const bytes = this.readEntryBytes(reader, item.name, this.MAX_PREVIEW);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        // textContent — chữ là chữ, không bao giờ thành DOM hay mã chạy.
        const pre = el("pre", "hmail-zip-text", text);
        view.appendChild(pre);
        if (item.size > this.MAX_PREVIEW) {
          view.appendChild(el("div", "hmail-import-note",
            "(Hiện 256 KB đầu — tệp còn dài hơn.)"));
        }
        return;
      }
      view.appendChild(el("div", "hmail-import-note",
        "Loại tệp này chỉ hiện tên và kích thước — không có chế độ xem " +
        "trước an toàn. Đừng mở nếu bạn không chắc về người gửi."));
    } catch (e) {
      view.appendChild(el("div", "hmail-import-note",
        "Không đọc được tệp này bên trong archive: " + (e.message || e)));
    }
  },
};
