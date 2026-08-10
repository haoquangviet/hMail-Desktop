/* hMail Desktop — trình tạo chữ ký thư trực quan
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Thunderbird đưa người dùng một ô textarea và câu đố "Dùng HTML (vd.:
 * <b>đậm</b>)" — nghĩa là muốn chữ ký có logo và liên kết thì phải viết mã.
 * Tab này là trình soạn WYSIWYG: gõ thấy ngay, đậm nghiêng màu mè bằng nút,
 * ảnh chèn từ máy thành data URI, và một mẫu danh thiếp sẵn cho người muốn
 * xong việc trong một phút. Lưu là ghi vào identity.htmlSigText — đúng chỗ
 * Thunderbird đọc khi soạn thư, không thêm cơ chế nào mới.
 */

"use strict";

var hMailSignature = {
  TAB_MODE: "hmailSignature",

  openTab(email = "") {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const tabmail = win?.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this._preselect = String(email || "").toLowerCase();
    if (!tabmail.tabModes?.[this.TAB_MODE]) {
      const self = this;
      tabmail.registerTabType({
        name: self.TAB_MODE,
        perTabPanel: "vbox",
        modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
        openTab(tab) {
          tab.title = "Chữ ký thư";
          tab.panel.classList.add("hmail-import-tab");
          try {
            tab.panel.appendChild(self.buildPanel(win));
          } catch (e) {
            // Lỗi dựng panel không được phép để lại một tab trắng câm:
            // ghi rõ tại chỗ và vào pref cho người gỡ lỗi.
            Cu.reportError("hMail signature panel failed: " + e + "\n" +
                           (e.stack || ""));
            try {
              Services.prefs.setCharPref("hmail.debug.sig",
                String(e) + " @ " +
                String(e.stack || "").split("\n").slice(0, 3).join(" | "));
            } catch (e2) {}
            const err = win.document.createElementNS(
              "http://www.w3.org/1999/xhtml", "div");
            err.style.cssText = "padding: 24px; font-size: 14px;";
            err.textContent = "Không dựng được trình soạn chữ ký: " + e;
            tab.panel.appendChild(err);
          }
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Chữ ký thư";
        },
        persistTab() {
          return null;
        },
      });
    }
    tabmail.openTab(this.TAB_MODE, {});
    // Tab đã mở từ trước: chuyển identity theo yêu cầu mới.
    const select = win.document.getElementById("hmail-sig-identity");
    if (select && this._preselect) {
      select.value = this._preselect;
      select.dispatchEvent(new win.Event("change"));
    }
  },

  /**
   * Đổ HTML vào editor. KHÔNG dùng innerHTML: document 3-pane là XHTML,
   * innerHTML ở đó parse theo luật XML — một chữ ký sẵn có chứa "<br>"
   * (không tự đóng) là ném SyntaxError ngay. DOMParser text/html nhai được
   * mọi HTML đời thực, xong import từng node sang.
   */
  setHtml(win, editor, html) {
    editor.textContent = "";
    if (!html) {
      return;
    }
    const parsed = new win.DOMParser().parseFromString(html, "text/html");
    for (const node of Array.from(parsed.body.childNodes)) {
      editor.appendChild(editor.ownerDocument.importNode(node, true));
    }
  },

  identities() {
    const seen = new Map();
    for (const identity of MailServices.accounts.allIdentities) {
      const email = (identity.email || "").trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.set(email, identity);
      }
    }
    return seen;
  },

  buildPanel(win) {
    const doc = win.document;
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (t, c, x) => {
      const n = doc.createElementNS(NS, t);
      if (c) {
        n.className = c;
      }
      if (x !== undefined) {
        n.textContent = x;
      }
      return n;
    };

    const root = el("div", "hmail-import hmail-ai");
    root.appendChild(el("div", "hmail-import-title", "Chữ ký thư"));
    root.appendChild(el("div", "hmail-import-note",
      "Soạn chữ ký như soạn thư: thấy gì lưu nấy. Ảnh chèn từ máy được " +
      "nhúng thẳng vào chữ ký; liên kết bấm được trong thư người nhận."));

    // --- identity -------------------------------------------------------
    const idRow = el("div", "hmail-move-row");
    idRow.appendChild(el("span", null, "Chữ ký cho tài khoản:"));
    const select = el("select", "hmail-ai-field");
    select.id = "hmail-sig-identity";
    const ids = this.identities();
    for (const email of ids.keys()) {
      const opt = el("option", null, email);
      opt.value = email;
      select.appendChild(opt);
    }
    if (this._preselect && ids.has(this._preselect)) {
      select.value = this._preselect;
    }
    idRow.appendChild(select);
    root.appendChild(idRow);

    // --- toolbar --------------------------------------------------------
    const bar = el("div", "hmail-sig-toolbar");
    const editor = el("div", "hmail-sig-editor");
    editor.setAttribute("contenteditable", "true");

    const exec = (cmd, value = null) => {
      editor.focus();
      try {
        doc.execCommand(cmd, false, value);
      } catch (e) {}
    };
    const tool = (label, title, run) => {
      const b = el("button", "hmail-sig-tool", label);
      b.type = "button";
      b.title = title;
      // Giữ focus + vùng chọn trong editor — nút cướp focus là mất selection.
      b.addEventListener("mousedown", e => e.preventDefault());
      b.addEventListener("click", run);
      bar.appendChild(b);
      return b;
    };

    tool("Đ", "In đậm", () => exec("bold")).style.fontWeight = "700";
    tool("N", "In nghiêng", () => exec("italic")).style.fontStyle = "italic";
    tool("G", "Gạch chân",
         () => exec("underline")).style.textDecoration = "underline";

    const size = el("select", "hmail-sig-tool");
    for (const [v, label] of [["2", "Chữ nhỏ"], ["3", "Chữ thường"],
                              ["5", "Chữ lớn"]]) {
      const opt = el("option", null, label);
      opt.value = v;
      size.appendChild(opt);
    }
    size.value = "3";
    size.title = "Cỡ chữ";
    size.addEventListener("mousedown", e => e.stopPropagation());
    size.addEventListener("change", () => exec("fontSize", size.value));
    bar.appendChild(size);

    const color = el("input", "hmail-sig-tool hmail-sig-color");
    color.type = "color";
    color.value = "#0F6CBD";
    color.title = "Màu chữ";
    color.addEventListener("change", () => exec("foreColor", color.value));
    bar.appendChild(color);

    tool("🔗", "Chèn liên kết (bôi đen chữ trước)", () => {
      const url = { value: "https://" };
      if (Services.prompt.prompt(win, "Chèn liên kết",
            "Địa chỉ liên kết:", url, null, {})) {
        const target = url.value.trim();
        if (target) {
          exec("createLink", target);
        }
      }
    });

    tool("🖼", "Chèn ảnh từ máy (logo, danh thiếp…)", () => {
      const fp = Cc["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, "Chọn ảnh", Ci.nsIFilePicker.modeOpen);
      fp.appendFilters(Ci.nsIFilePicker.filterImages);
      fp.open(rv => {
        if (rv !== Ci.nsIFilePicker.returnOK) {
          return;
        }
        try {
          // Ảnh phải sống bên trong chữ ký, không tham chiếu đường dẫn
          // trên máy người gửi: data URI được Thunderbird đổi thành phần
          // đính kèm nội tuyến khi gửi.
          const bytes = IOUtils.read(fp.file.path);
          bytes.then(data => {
            const ext = fp.file.leafName.split(".").pop().toLowerCase();
            const mime = { png: "image/png", gif: "image/gif",
                           webp: "image/webp", svg: "image/svg+xml" }[ext] ||
                         "image/jpeg";
            let binary = "";
            for (let i = 0; i < data.length; i += 32768) {
              binary += String.fromCharCode
                .apply(null, data.subarray(i, i + 32768));
            }
            const uri = `data:${mime};base64,${win.btoa(binary)}`;
            editor.focus();
            doc.execCommand("insertImage", false, uri);
          });
        } catch (e) {
          Cu.reportError("hMail signature image failed: " + e);
        }
      });
    });

    tool("¶", "Xoá định dạng vùng bôi đen", () => exec("removeFormat"));

    tool("Mẫu", "Chèn mẫu danh thiếp", () => {
      const identity = this.identities().get(select.value);
      const name = identity?.fullName || "Họ và tên";
      const email = select.value;
      this.setHtml(win, editor,
        '<div style="font-family: Arial, sans-serif; font-size: 13px; ' +
        'color: #333;">--<br><b style="font-size:14px; color:#0F6CBD;">' +
        name + "</b><br>Chức danh · Tên công ty<br>" +
        '📧 <a href="mailto:' + email + '">' + email + "</a> · 📞 09xx xxx " +
        "xxx<br>🌐 <a href=\"https://example.com\">example.com</a></div>");
      editor.focus();
    });

    root.appendChild(bar);
    root.appendChild(editor);

    // --- load / save ----------------------------------------------------
    const status = el("div", "hmail-import-note", "");
    const load = () => {
      const identity = this.identities().get(select.value);
      if (!identity) {
        return;
      }
      this.setHtml(win, editor, identity.htmlSigText
        ? (identity.htmlSigFormat
            ? identity.htmlSigText
            // Chữ ký cũ dạng chữ trơn: bê nguyên vào, giữ xuống dòng.
            : identity.htmlSigText.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;").replace(/\r?\n/g, "<br>"))
        : "");
      status.textContent = "";
    };
    select.addEventListener("change", load);
    load();

    const actions = el("div", "hmail-move-row");
    const save = el("button", "hmail-ai-btn primary", "Lưu chữ ký");
    save.addEventListener("click", () => {
      try {
        const identity = this.identities().get(select.value);
        if (!identity) {
          return;
        }
        identity.htmlSigText = editor.innerHTML.trim();
        identity.htmlSigFormat = true;
        // Chữ ký lấy từ đây, không phải từ tập tin đính kèm nữa.
        identity.attachSignature = false;
        status.textContent =
          "Đã lưu. Thư mới soạn từ " + select.value + " sẽ mang chữ ký này.";
      } catch (e) {
        status.textContent = "Không lưu được: " + (e.message || e);
      }
    });
    const clear = el("button", "hmail-ai-btn", "Xoá chữ ký");
    clear.addEventListener("click", () => {
      const identity = this.identities().get(select.value);
      if (!identity) {
        return;
      }
      identity.htmlSigText = "";
      editor.innerHTML = "";
      status.textContent = "Đã xoá chữ ký của " + select.value + ".";
    });
    actions.append(save, clear);
    root.appendChild(actions);
    root.appendChild(status);
    return root;
  },
};
