/* hMail Desktop — ribbon cho cửa sổ soạn thư
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * The main window puts every command on a ribbon; the composer should work
 * the same way rather than growing extra buttons on Thunderbird's own
 * toolbar. So the composer gets its own ribbon, in the same style, holding
 * both Thunderbird's compose commands and hMail's own.
 *
 * Like the main ribbon this is presentation only: every button dispatches an
 * existing compose command through goDoCommand(), so behaviour always matches
 * what the menus do. Thunderbird's compose toolbar is hidden in CSS because
 * everything on it is here.
 */

"use strict";

var hMailComposeRibbon = {
  ID: "hmail-compose-ribbon",

  TABS: [
    {
      id: "message",
      label: "Thư",
      groups: [
        {
          label: "Gửi",
          buttons: [
            { id: "c-send", label: "Gửi ngay", icon: "sent",
              cmd: "cmd_sendNow" },
            { id: "c-later", label: "Gửi sau", icon: "outbox",
              cmd: "cmd_sendLater" },
            { id: "c-draft", label: "Lưu nháp", icon: "drafts",
              cmd: "cmd_saveAsDraft" },
          ],
        },
        {
          label: "Đính kèm",
          buttons: [
            { id: "c-attach", label: "Đính kèm", icon: "import",
              cmd: "cmd_attachFile" },
            { id: "c-image", label: "Chèn ảnh", icon: "image",
              cmd: "cmd_image" },
            { id: "c-link", label: "Chèn liên kết", icon: "extention",
              cmd: "cmd_link" },
            { id: "c-table", label: "Chèn bảng", icon: "list",
              cmd: "cmd_table" },
            // Chỉ hiện khi thân thư CHƯA có chữ ký (thư mở từ mẫu, nháp cũ,
            // hay identity không tự chèn) — updateState ẩn/hiện.
            { id: "c-signature", label: "Chèn chữ ký", icon: "signature",
              fn: win => win.hMailComposeRibbon.insertSignature(win) },
          ],
        },
        {
          label: "Người nhận",
          buttons: [
            { id: "c-contacts", label: "Sổ địa chỉ", icon: "contact",
              fn: win => win.toggleContactsSidebar() },
            { id: "c-quote", label: "Trích dẫn thư", icon: "reply",
              cmd: "cmd_quoteMessage" },
          ],
        },
        {
          label: "Soát lại",
          buttons: [
            { id: "c-spell", label: "Chính tả", icon: "spellcheck",
              cmd: "cmd_spelling" },
            { id: "c-find", label: "Tìm và thay", icon: "search",
              cmd: "cmd_findReplace" },
          ],
        },
        {
          label: "hMail",
          buttons: [
            { id: "c-ai", label: "Trợ lý AI", icon: "ai",
              fn: win => win.hMailComposeAI.toggle(win) },
            { id: "c-merge", label: "Gửi hàng loạt", icon: "contact",
              fn: win => win.hMailMerge.toggle(win) },
          ],
        },
      ],
    },
  ],

  init(win) {
    try {
      const doc = win.document;
      if (doc.getElementById(this.ID)) {
        return;
      }
      const toolbox = doc.getElementById("compose-toolbox");
      if (!toolbox || !toolbox.parentNode) {
        return;
      }
      const ribbon = this.build(win, doc);
      toolbox.parentNode.insertBefore(ribbon, toolbox.nextSibling);
      win.setTimeout(() => this.updateState(win, doc), 800);
      doc.addEventListener("click", () => this.updateState(win, doc), true);
    } catch (e) {
      Cu.reportError("hMail compose ribbon failed: " + e);
    }
  },

  build(win, doc) {
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (tag, cls) => {
      const node = doc.createElementNS(NS, tag);
      if (cls) {
        node.className = cls;
      }
      return node;
    };

    const root = el("div", "hmail-ribbon hmail-compose-ribbon");
    root.id = this.ID;

    // No tab strip: the composer has one set of commands, and a lone tab
    // labelled "Thư" is a row of chrome that tells the user nothing.
    const panes = el("div", "hmail-ribbon-panes");

    for (const tab of this.TABS) {
      const pane = el("div", "hmail-ribbon-pane selected");
      for (const group of tab.groups) {
        const box = el("div", "hmail-ribbon-group");
        // One row: the composer needs its height for the message, not for a
        // two-storey command bar, so every button is icon-beside-text and the
        // group captions are dropped.
        const items = el("div", "hmail-ribbon-group-items");

        for (const button of group.buttons) {
          const b = el("button", "hmail-ribbon-button" +
            (button.size === "large" ? " large" : " small"));
          b.dataset.icon = button.icon || "";
          b.dataset.id = button.id;
          if (button.cmd) {
            b.dataset.cmd = button.cmd;
          }

          const icon = el("span", "hmail-ribbon-icon");
          const label = el("span", "hmail-ribbon-label");
          if (button.label.includes("\n")) {
            for (const line of button.label.split("\n")) {
              const span = el("span", "hmail-ribbon-line");
              span.textContent = line;
              label.appendChild(span);
            }
          } else {
            label.textContent = button.label;
          }
          b.append(icon, label);

          // Bấm nút không được cướp focus: lệnh cấp editor (chèn ảnh, liên
          // kết, bảng…) đi qua commandDispatcher theo focus hiện tại — nút
          // HTML giữ focus là dispatcher không tìm thấy controller của
          // editor và lệnh chết im lặng.
          b.addEventListener("mousedown", event => event.preventDefault());
          b.addEventListener("click", () => {
            try {
              if (button.fn) {
                button.fn(win);
              } else if (button.cmd) {
                // Các lệnh chèn chỉ có nghĩa trong thân thư: kéo focus về
                // body trước, kể cả khi người dùng đang đứng ở ô Tiêu đề.
                if (["cmd_image", "cmd_link", "cmd_table",
                     "cmd_spelling", "cmd_findReplace"]
                      .includes(button.cmd)) {
                  try {
                    win.focusMsgBody();
                  } catch (e) {}
                }
                win.goDoCommand(button.cmd);
              }
            } catch (e) {
              Cu.reportError(`hMail compose ribbon "${button.id}": ${e}`);
            }
          });
          items.appendChild(b);
        }

        box.appendChild(items);
        box.title = group.label;
        pane.appendChild(box);
      }
      panes.appendChild(pane);
    }

    root.appendChild(panes);
    return root;
  },

  /** Grey out what the composer says is unavailable, as the menus do. */
  updateState(win, doc) {
    for (const button of doc.querySelectorAll(
           `#${this.ID} .hmail-ribbon-button[data-cmd]`)) {
      try {
        const controller = win.document.commandDispatcher
          ?.getControllerForCommand(button.dataset.cmd);
        const enabled = controller
          ? controller.isCommandEnabled(button.dataset.cmd) : true;
        button.toggleAttribute("disabled", !enabled);
      } catch (e) {}
    }
    // Nút Chèn chữ ký chỉ có ích khi thư chưa có chữ ký và identity có
    // chữ ký để chèn.
    try {
      const sig = doc.querySelector(
        `#${this.ID} .hmail-ribbon-button[data-id="c-signature"]`);
      if (sig) {
        sig.hidden = this.hasSignature(win) || !this.signatureHtml(win);
      }
    } catch (e) {}
  },

  // ------------------------------------------------------------ chữ ký

  /** Thân thư đã có khối chữ ký (Thunderbird bọc trong .moz-signature) chưa? */
  hasSignature(win) {
    try {
      const body = win.GetCurrentEditor?.()?.document?.body;
      return !!body?.querySelector(".moz-signature");
    } catch (e) {
      return false;
    }
  },

  /** HTML chữ ký của identity đang gửi (chữ ký chữ trơn được bọc lại). */
  signatureHtml(win) {
    try {
      const identity = win.gCurrentIdentity ||
        win.getCurrentIdentity?.() || null;
      const text = String(identity?.htmlSigText || "").trim();
      if (!text) {
        return "";
      }
      if (identity.htmlSigFormat) {
        return text;
      }
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/\r?\n/g, "<br>");
    } catch (e) {
      return "";
    }
  },

  /**
   * Chèn chữ ký của identity đang gửi vào cuối thư (trước phần trích dẫn
   * nếu có), bọc đúng khối .moz-signature như Thunderbird làm — bấm lần
   * nữa không chèn đôi.
   */
  insertSignature(win) {
    try {
      const editor = win.GetCurrentEditor?.();
      const doc = editor?.document;
      if (!doc?.body) {
        return;
      }
      if (this.hasSignature(win)) {
        return;
      }
      const html = this.signatureHtml(win);
      if (!html) {
        Services.prompt.alert(win, "Chèn chữ ký",
          "Tài khoản đang gửi chưa có chữ ký. Tạo trong Cài đặt tài khoản " +
          "▸ Tạo chữ ký trực quan…");
        return;
      }
      const wrapper = doc.createElement("div");
      wrapper.className = "moz-signature";
      // Nội dung chữ ký là của chính người dùng — nhưng vẫn parse tách
      // biệt rồi mới ghép, không nhét chuỗi thẳng vào thân thư.
      const parsed = new win.DOMParser().parseFromString(
        "-- <br>" + html, "text/html");
      for (const node of Array.from(parsed.body.childNodes)) {
        wrapper.appendChild(doc.importNode(node, true));
      }
      const body = doc.body;
      // Trước phần trích dẫn thư gốc (nếu là trả lời/chuyển tiếp) để chữ ký
      // đi liền nội dung mình viết, đúng chỗ Thunderbird tự đặt.
      const quote = body.querySelector(
        ".moz-cite-prefix, blockquote[type='cite'], .moz-forward-container");
      editor.beginTransaction?.();
      try {
        if (quote) {
          body.insertBefore(doc.createElement("br"), quote);
          body.insertBefore(wrapper, quote);
        } else {
          body.appendChild(doc.createElement("br"));
          body.appendChild(wrapper);
        }
      } finally {
        editor.endTransaction?.();
      }
      win.setTimeout(() => this.updateState(win, win.document), 50);
    } catch (e) {
      Cu.reportError("hMail insert signature failed: " + e);
    }
  },
};
