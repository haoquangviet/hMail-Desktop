/* hMail Desktop — trộn thư
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Write one message, send it to many people, each one addressed personally.
 * The recipients come from a CSV file or from an address book, and anything
 * written as {{Tên cột}} in the subject or the body is replaced with that
 * person's value.
 *
 * Everything is prepared from the message already open in the composer, so
 * what is sent is what the user wrote and saw. Nothing is sent until they say
 * so, and the safe choice — putting the copies in Drafts to look at first —
 * is offered alongside sending.
 */

"use strict";

var hMailMerge = {
  BUTTON_ID: "hmail-merge-button",

  init(win) {
    try {
      const doc = win.document;
      if (doc.getElementById(this.BUTTON_ID)) {
        return;
      }
      const toolbar = doc.getElementById("composeToolbar2");
      if (!toolbar) {
        return;
      }
      const button = doc.createXULElement("toolbarbutton");
      button.id = this.BUTTON_ID;
      button.className = "toolbarbutton-1";
      button.setAttribute("label", "Trộn thư");
      button.setAttribute("tooltiptext",
        "Gửi thư này cho nhiều người, mỗi người một bản riêng");
      button.addEventListener("command", () => this.open(win));
      toolbar.appendChild(button);
    } catch (e) {
      Cu.reportError("hMail merge init failed: " + e);
    }
  },

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

  // --------------------------------------------------------------- nguồn

  /**
   * A small CSV reader: quoted fields, doubled quotes inside them, commas or
   * semicolons as the separator (Excel in a Vietnamese locale writes
   * semicolons).
   */
  parseCsv(text) {
    const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const sample = clean.split("\n")[0] || "";
    const sep = (sample.match(/;/g) || []).length >
                (sample.match(/,/g) || []).length ? ";" : ",";

    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (quoted) {
        if (ch === '"') {
          if (clean[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        quoted = true;
      } else if (ch === sep) {
        row.push(field.trim());
        field = "";
      } else if (ch === "\n") {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field || row.length) {
      row.push(field.trim());
      rows.push(row);
    }

    const header = (rows.shift() || []).map(h => h.trim());
    return rows
      .filter(r => r.some(cell => cell !== ""))
      .map(r => {
        const record = {};
        header.forEach((name, i) => {
          record[name] = r[i] ?? "";
        });
        return record;
      });
  },

  /** Which column holds the address, guessed then confirmed by the user. */
  emailField(records) {
    const names = Object.keys(records[0] || {});
    const guess = names.find(n => /mail|thư|dia chi|địa chỉ/i.test(n));
    if (guess) {
      return guess;
    }
    return names.find(n =>
      records.some(r => String(r[n]).includes("@"))) || names[0];
  },

  fromAddressBook() {
    const records = [];
    for (const book of MailServices.ab.directories) {
      for (const card of book.childCards) {
        const email = card.primaryEmail;
        if (!email) {
          continue;
        }
        records.push({
          "Email": email,
          "Tên": card.displayName ||
                 [card.firstName, card.lastName].filter(Boolean).join(" "),
          "Tên gọi": card.firstName || card.displayName || "",
          "Công ty": card.getProperty("Company", ""),
          "Sổ địa chỉ": book.dirName,
        });
      }
    }
    return records;
  },

  // -------------------------------------------------------------- thay thế

  /** {{Cột}} becomes that row's value; unknown columns are left visible. */
  fill(template, record) {
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
      const found = Object.keys(record).find(
        name => name.toLowerCase() === key.toLowerCase());
      return found ? String(record[found] ?? "") : whole;
    });
  },

  placeholders(text) {
    const found = new Set();
    for (const m of String(text).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      found.add(m[1].trim());
    }
    return [...found];
  },

  // ------------------------------------------------------------------ UI

  open(win) {
    const doc = win.document;
    if (doc.getElementById("hmail-merge-panel")) {
      return;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);

    const overlay = el("div", "hmail-merge-overlay");
    overlay.id = "hmail-merge-panel";
    const panel = el("div", "hmail-merge hmail-ai");

    const head = el("div", "hmail-merge-head");
    head.append(el("span", "hmail-merge-title", "Trộn thư"));
    const close = el("button", "hmail-compose-ai-close", "✕");
    close.addEventListener("click", () => overlay.remove());
    head.appendChild(close);
    panel.appendChild(head);

    panel.appendChild(el("div", "hmail-ai-hint",
      "Viết thư như bình thường, dùng {{Tên cột}} ở tiêu đề hoặc nội dung để " +
      "chèn thông tin riêng của từng người. Mỗi người sẽ nhận một thư riêng, " +
      "không ai thấy địa chỉ của ai."));

    const sourceRow = el("div", "hmail-ai-row");
    const fromCsv = el("button", "hmail-ai-btn", "Mở tệp CSV…");
    const fromBook = el("button", "hmail-ai-btn", "Lấy từ sổ địa chỉ");
    sourceRow.append(fromCsv, fromBook);
    panel.appendChild(sourceRow);

    const status = el("div", "hmail-ai-status", "Chưa có danh sách người nhận.");
    status.id = "hmail-merge-status";
    panel.appendChild(status);

    const fieldRow = el("div", "hmail-ai-row");
    fieldRow.hidden = true;
    fieldRow.append(el("span", "hmail-ai-label", "Cột địa chỉ"));
    const field = el("select", "hmail-ai-field");
    fieldRow.appendChild(field);
    panel.appendChild(fieldRow);

    const preview = el("div", "hmail-merge-preview");
    preview.id = "hmail-merge-preview";
    panel.appendChild(preview);

    const actions = el("div", "hmail-ai-actions");
    const draft = el("button", "hmail-ai-btn", "Lưu vào Nháp");
    const send = el("button", "hmail-ai-btn primary", "Gửi tất cả");
    draft.hidden = true;
    send.hidden = true;
    actions.append(send, draft);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    doc.documentElement.appendChild(overlay);
    hMailAI.applyLook(win, panel);

    const state = { records: [] };

    const refresh = () => {
      const doc2 = win.document;
      const status2 = doc2.getElementById("hmail-merge-status");
      if (!state.records.length) {
        return;
      }
      field.textContent = "";
      for (const name of Object.keys(state.records[0])) {
        const opt = el("option", null, name);
        opt.value = name;
        field.appendChild(opt);
      }
      field.value = this.emailField(state.records);
      fieldRow.hidden = false;

      const subject = doc2.getElementById("msgSubject")?.value || "";
      const body = this.bodyText(win);
      const keys = new Set([...this.placeholders(subject),
                            ...this.placeholders(body)]);
      const columns = Object.keys(state.records[0]);
      const unknown = [...keys].filter(k =>
        !columns.some(c => c.toLowerCase() === k.toLowerCase()));

      status2.textContent =
        `${state.records.length} người nhận. ` +
        (keys.size
          ? `Ô thay thế: ${[...keys].join(", ")}.`
          : "Thư không có ô thay thế nào — mọi người sẽ nhận nội dung giống nhau.") +
        (unknown.length
          ? ` Không tìm thấy cột: ${unknown.join(", ")}.`
          : "");

      preview.textContent = "";
      preview.appendChild(el("div", "hmail-ai-label", "Xem trước ba thư đầu"));
      for (const record of state.records.slice(0, 3)) {
        const item = el("div", "hmail-merge-item");
        item.append(
          el("div", "hmail-merge-to", this.fill(record[field.value], record)),
          el("div", "hmail-merge-subject", this.fill(subject, record)));
        preview.appendChild(item);
      }
      draft.hidden = false;
      send.hidden = false;
    };

    field.addEventListener("change", refresh);

    fromCsv.addEventListener("click", () => {
      const picker = Cc["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);
      picker.init(win.browsingContext, "Chọn danh sách người nhận",
                  Ci.nsIFilePicker.modeOpen);
      picker.appendFilter("Bảng CSV (*.csv, *.txt)", "*.csv; *.txt");
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      picker.open(async result => {
        if (result !== Ci.nsIFilePicker.returnOK || !picker.file) {
          return;
        }
        try {
          const text = await IOUtils.readUTF8(picker.file.path);
          state.records = this.parseCsv(text);
          if (!state.records.length) {
            status.textContent = "Tệp không có dòng dữ liệu nào.";
            return;
          }
          refresh();
        } catch (e) {
          status.textContent = "Không đọc được tệp: " + (e.message || e);
        }
      });
    });

    fromBook.addEventListener("click", () => {
      state.records = this.fromAddressBook();
      if (!state.records.length) {
        status.textContent = "Sổ địa chỉ chưa có liên hệ nào có email.";
        return;
      }
      refresh();
    });

    const run = mode => {
      overlay.remove();
      this.run(win, state.records, field.value, mode).catch(e =>
        Services.prompt.alert(win, "Trộn thư",
          "Lỗi khi trộn thư: " + (e.message || e)));
    };
    send.addEventListener("click", () => {
      if (Services.prompt.confirm(win, "Trộn thư",
            `Gửi ${state.records.length} thư ngay bây giờ?`)) {
        run("send");
      }
    });
    draft.addEventListener("click", () => run("draft"));
  },

  bodyText(win) {
    try {
      return win.getBrowser().contentDocument.body.innerHTML || "";
    } catch (e) {
      return "";
    }
  },

  // ---------------------------------------------------------------- chạy

  /**
   * Build and hand off one message per row. Each is a separate message with a
   * single recipient, so nobody sees anybody else's address.
   */
  async run(win, records, emailField, mode) {
    const doc = win.document;
    const subject = doc.getElementById("msgSubject")?.value || "";
    const html = this.bodyText(win);
    const identity = win.gMsgCompose?.identity ||
      MailServices.accounts.defaultAccount?.defaultIdentity;
    if (!identity) {
      throw new Error("chưa có tài khoản gửi thư");
    }
    const accountKey = win.gMsgCompose?.savedFolderURI
      ? "" : (MailServices.accounts.defaultAccount?.key || "");

    let sent = 0;
    let skipped = 0;

    for (const record of records) {
      const to = String(record[emailField] || "").trim();
      if (!to.includes("@")) {
        skipped++;
        continue;
      }

      const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);
      fields.from = identity.fullName
        ? `${identity.fullName} <${identity.email}>` : identity.email;
      fields.to = to;
      fields.subject = this.fill(subject, record);
      fields.body = this.fill(html, record);
      fields.forcePlainText = false;

      const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      params.composeFields = fields;
      params.identity = identity;
      params.type = Ci.nsIMsgCompType.New;
      params.format = Ci.nsIMsgCompFormat.HTML;

      const compose = MailServices.compose.initCompose(params);
      compose.type = Ci.nsIMsgCompType.New;
      // Thunderbird 140: sendMsg(deliverMode, identity, accountKey,
      // msgWindow, progress), returning a promise.
      const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"]
        .createInstance(Ci.nsIMsgWindow);
      await compose.sendMsg(
        mode === "send" ? Ci.nsIMsgCompDeliverMode.Now
                        : Ci.nsIMsgCompDeliverMode.SaveAsDraft,
        identity, accountKey, msgWindow, null);
      sent++;
    }

    Services.prompt.alert(win, "Trộn thư",
      mode === "send"
        ? `Đã gửi ${sent} thư.` +
          (skipped ? ` Bỏ qua ${skipped} dòng không có địa chỉ hợp lệ.` : "")
        : `Đã lưu ${sent} thư vào Nháp để bạn xem lại trước khi gửi.` +
          (skipped ? ` Bỏ qua ${skipped} dòng không có địa chỉ hợp lệ.` : ""));
  },
};
