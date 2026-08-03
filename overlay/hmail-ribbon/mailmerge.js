/* hMail Desktop — gửi hàng loạt
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * One letter, many recipients, each addressed personally.
 *
 * The letter is written in Thunderbird's own composer — its editor, its
 * formatting toolbar, its spell checker, its attachments. Nothing about
 * writing is reimplemented here, because a home-made editor is always going
 * to be worse than the real one. What this adds is the part the composer has
 * no idea about: the recipient list, the substitution, the pacing, and the
 * run itself, in a panel docked beside the message being written.
 *
 * Sending is paced on purpose: mail servers throttle or block clients that
 * fire hundreds of messages in a burst, so the delay between messages and the
 * batch pause are settings rather than hard-coded numbers.
 *
 * The job is held by this module, not by the window showing it, so closing
 * the composer mid-run does not stop the run.
 */

"use strict";

var hMailMerge = {
  PANEL_ID: "hmail-merge-panel",
  BUTTON_ID: "hmail-merge-button",

  /** { rows, index, sent, failed, results, paused, stopped, settings } */
  job: null,

  // ------------------------------------------------------------ khởi động

  /** In the 3-pane: the ribbon opens a composer with the panel already up. */
  init() {},

  /**
   * From the ribbon: a bulk send starts by writing the letter, so this opens
   * the composer with the panel already up — or brings a composer that is
   * already open to the front instead of opening another.
   */
  openTab(win) {
    for (const other of Services.wm.getEnumerator("msgcompose")) {
      other.focus();
      if (other.hMailMerge) {
        other.hMailMerge.open(other);
      }
      return;
    }

    try {
      const identity =
        MailServices.accounts.defaultAccount?.defaultIdentity ||
        MailServices.accounts.allIdentities[0];
      if (!identity) {
        Services.prompt.alert(win, "Gửi hàng loạt",
          "Chưa có tài khoản thư nào để gửi.");
        return;
      }
      // composeFields is not optional: without it the compose window fails to
      // build and Thunderbird only says "đã xảy ra lỗi".
      const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);
      const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      params.composeFields = fields;
      params.type = Ci.nsIMsgCompType.New;
      params.format = Ci.nsIMsgCompFormat.HTML;
      params.identity = identity;
      this.pendingOpen = true;
      MailServices.compose.OpenComposeWindowWithParams(null, params);
    } catch (e) {
      this.pendingOpen = false;
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Không mở được cửa sổ soạn thư: " + (e.message || e));
    }
  },

  initCompose(win) {
    try {
      const doc = win.document;
      if (!doc.getElementById(this.BUTTON_ID)) {
        const toolbar = doc.getElementById("composeToolbar2");
        if (toolbar) {
          const button = doc.createXULElement("toolbarbutton");
          button.id = this.BUTTON_ID;
          button.className = "toolbarbutton-1";
          button.setAttribute("label", "Gửi hàng loạt");
          button.setAttribute("tooltiptext",
            "Gửi thư này cho nhiều người, mỗi người một bản riêng");
          button.addEventListener("command", () => this.toggle(win));
          toolbar.appendChild(button);
        }
      }
      // Opened from the ribbon: show the panel as soon as the window is up.
      if (this.pendingOpen) {
        this.pendingOpen = false;
        win.setTimeout(() => this.open(win), 600);
      }
    } catch (e) {
      Cu.reportError("hMail bulk send init failed: " + e);
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

  log(text) {
    Cu.reportError("hMail bulk send: " + text);
  },

  // ---------------------------------------------------------------- panel

  toggle(win) {
    if (win.document.getElementById(this.PANEL_ID)) {
      this.close(win);
    } else {
      this.open(win);
    }
  },

  close(win) {
    const doc = win.document;
    doc.getElementById(this.PANEL_ID)?.remove();
    doc.getElementById(this.PANEL_ID + "-splitter")?.remove();
  },

  open(win) {
    try {
      this.build(win);
    } catch (e) {
      this.log("panel failed: " + e + "\n" + (e.stack || ""));
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Không mở được bảng gửi hàng loạt: " + (e.message || e));
    }
  },

  build(win) {
    const doc = win.document;
    const area = doc.getElementById("messageArea");
    if (!area || doc.getElementById(this.PANEL_ID)) {
      return;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);

    // Thunderbird's own splitter, the one the contacts sidebar uses.
    let splitter;
    try {
      splitter = doc.createElement("hr", { is: "pane-splitter" });
      splitter.setAttribute("is", "pane-splitter");
      splitter.setAttribute("resize-direction", "horizontal");
      splitter.setAttribute("resize-id", this.PANEL_ID);
    } catch (e) {
      splitter = el("div");
    }
    splitter.id = this.PANEL_ID + "-splitter";

    const panel = el("div", "hmail-ai hmail-merge-panel");
    panel.id = this.PANEL_ID;
    let width = 420;
    try {
      width = Services.prefs.getIntPref("hmail.merge.width");
    } catch (e) {}
    panel.style.width = `${width}px`;

    // Header ---------------------------------------------------------------
    const header = el("div", "hmail-compose-ai-header");
    header.append(el("span", "hmail-compose-ai-title", "Gửi hàng loạt"));
    const close = el("button", "hmail-compose-ai-close", "✕");
    close.title = "Đóng";
    close.addEventListener("click", () => this.close(win));
    header.appendChild(close);
    panel.appendChild(header);

    const scroll = el("div", "hmail-merge-scroll");
    panel.appendChild(scroll);

    scroll.appendChild(el("div", "hmail-ai-hint",
      "Viết thư như bình thường ở bên trái. Dùng {{Tên cột}} trong tiêu đề " +
      "và nội dung để chèn thông tin riêng của từng người. Mỗi người nhận " +
      "một thư riêng nên không ai thấy địa chỉ của ai."));

    // 1. list --------------------------------------------------------------
    scroll.appendChild(el("div", "hmail-ai-section", "1. Danh sách người nhận"));
    const source = el("div", "hmail-ai-row");
    const fromCsv = el("button", "hmail-ai-btn", "Mở tệp CSV…");
    fromCsv.addEventListener("click", () => this.pickCsv(win));
    const fromBook = el("button", "hmail-ai-btn", "Sổ địa chỉ");
    fromBook.addEventListener("click", () => {
      this.rows = this.fromAddressBook();
      this.refresh(win);
    });
    const fromPaste = el("button", "hmail-ai-btn", "Dán…");
    fromPaste.addEventListener("click", () => this.pasteList(win));
    source.append(fromCsv, fromBook, fromPaste);
    scroll.appendChild(source);

    const summary = el("div", "hmail-ai-status", "Chưa có danh sách.");
    summary.id = "hmail-merge-summary";
    scroll.appendChild(summary);

    const table = el("div", "hmail-merge-table");
    table.id = "hmail-merge-table";
    scroll.appendChild(table);

    // 2. settings ----------------------------------------------------------
    scroll.appendChild(el("div", "hmail-ai-section", "2. Tham số gửi"));

    const field = (label, node, hint) => {
      scroll.appendChild(el("label", "hmail-ai-label", label));
      scroll.appendChild(node);
      if (hint) {
        scroll.appendChild(el("div", "hmail-ai-hint", hint));
      }
      return node;
    };

    const toField = el("select", "hmail-ai-field");
    toField.id = "hmail-merge-to";
    toField.addEventListener("change", () => this.refresh(win));
    field("Cột địa chỉ người nhận", toField);

    const ccField = el("select", "hmail-ai-field");
    ccField.id = "hmail-merge-cc";
    field("Cột CC (tuỳ chọn)", ccField);

    const mode = el("select", "hmail-ai-field");
    mode.id = "hmail-merge-mode";
    for (const [value, label] of [
      ["draft", "Lưu vào Nháp để xem lại"],
      ["send", "Gửi ngay"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      mode.appendChild(opt);
    }
    field("Cách gửi", mode);

    const number = (id, value, min, max) => {
      const input = el("input", "hmail-ai-field");
      input.id = id;
      input.type = "number";
      input.min = String(min);
      if (max !== undefined) {
        input.max = String(max);
      }
      input.value = String(value);
      return input;
    };

    field("Giãn cách giữa hai thư (giây)",
          number("hmail-merge-delay", 3, 0, 600),
          "Gửi dồn dập dễ bị máy chủ chặn hoặc xếp vào thư rác.");
    field("Số thư mỗi đợt", number("hmail-merge-batch", 50, 0),
          "0 nghĩa là không chia đợt.");
    field("Nghỉ giữa hai đợt (giây)", number("hmail-merge-pause", 300, 0));
    field("Giới hạn số thư lần chạy này", number("hmail-merge-limit", 0, 0),
          "0 nghĩa là gửi hết danh sách.");

    const onError = el("select", "hmail-ai-field");
    onError.id = "hmail-merge-skip";
    for (const [value, label] of [
      ["skip", "Bỏ qua và ghi vào kết quả"],
      ["stop", "Dừng cả lần chạy"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      onError.appendChild(opt);
    }
    field("Khi gặp dòng lỗi", onError);

    // 3. preview -----------------------------------------------------------
    scroll.appendChild(el("div", "hmail-ai-section", "3. Xem trước"));
    const refreshBtn = el("button", "hmail-ai-btn", "Cập nhật xem trước");
    refreshBtn.addEventListener("click", () => this.refresh(win));
    scroll.appendChild(refreshBtn);
    const preview = el("div", "hmail-merge-preview");
    preview.id = "hmail-merge-preview";
    scroll.appendChild(preview);

    // 4. run ---------------------------------------------------------------
    scroll.appendChild(el("div", "hmail-ai-section", "4. Thực hiện"));
    const actions = el("div", "hmail-ai-actions");
    const start = el("button", "hmail-ai-btn primary", "Bắt đầu");
    start.id = "hmail-merge-start";
    start.addEventListener("click", () => this.start(win));
    const pauseBtn = el("button", "hmail-ai-btn", "Tạm dừng");
    pauseBtn.id = "hmail-merge-pausebtn";
    pauseBtn.hidden = true;
    pauseBtn.addEventListener("click", () => this.togglePause(win));
    const stopBtn = el("button", "hmail-ai-btn", "Dừng hẳn");
    stopBtn.id = "hmail-merge-stop";
    stopBtn.hidden = true;
    stopBtn.addEventListener("click", () => {
      if (this.job) {
        this.job.stopped = true;
      }
    });
    const exportBtn = el("button", "hmail-ai-btn", "Xuất kết quả");
    exportBtn.id = "hmail-merge-export";
    exportBtn.hidden = true;
    exportBtn.addEventListener("click", () => this.exportResults(win));
    actions.append(start, pauseBtn, stopBtn, exportBtn);
    scroll.appendChild(actions);

    const progress = el("div", "hmail-merge-progress");
    progress.id = "hmail-merge-progress";
    scroll.appendChild(progress);

    const log = el("div", "hmail-merge-log");
    log.id = "hmail-merge-log";
    scroll.appendChild(log);

    area.append(splitter, panel);
    hMailAI.applyLook(win, panel);

    const remember = () => {
      const w = Math.round(panel.getBoundingClientRect().width);
      if (w > 200) {
        try {
          Services.prefs.setIntPref("hmail.merge.width", w);
        } catch (e) {}
      }
    };
    win.addEventListener("mouseup", remember);

    win.setTimeout(() => {
      this.refresh(win);
      this.paint(win);
    }, 0);
  },

  // ------------------------------------------------- what the composer has

  subject(win) {
    return win.document.getElementById("msgSubject")?.value || "";
  },

  bodyHtml(win) {
    try {
      return win.getBrowser()?.contentDocument?.body?.innerHTML || "";
    } catch (e) {
      return "";
    }
  },

  bodyText(win) {
    return this.htmlToText(this.bodyHtml(win));
  },

  htmlToText(html) {
    return String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  },

  attachments(win) {
    const list = [];
    try {
      const bucket = win.document.getElementById("attachmentBucket");
      for (const item of bucket?.children || []) {
        if (item.attachment?.url) {
          list.push(item.attachment.url);
        }
      }
    } catch (e) {}
    return list;
  },

  // ------------------------------------------------------------- dữ liệu

  pasteList(win) {
    const text = { value: "" };
    const ok = Services.prompt.prompt(win, "Dán danh sách",
      "Dán bảng vào đây — dòng đầu là tên cột, các cột cách nhau bằng dấu " +
      "phẩy hoặc chấm phẩy.\n\nVí dụ:\nEmail,Tên,Công ty\n" +
      "an@vidu.com,Anh An,Công ty A",
      text, null, {});
    if (!ok || !text.value.trim()) {
      return;
    }
    try {
      this.rows = this.parseCsv(text.value);
      this.sourceName = "danh sách dán vào";
    } catch (e) {
      this.rows = [];
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Không đọc được danh sách: " + (e.message || e));
    }
    this.refresh(win);
  },

  pickCsv(win) {
    try {
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
          this.rows = this.parseCsv(await IOUtils.readUTF8(picker.file.path));
          this.sourceName = picker.file.leafName;
        } catch (e) {
          this.rows = [];
          Services.prompt.alert(win, "Gửi hàng loạt",
            "Không đọc được tệp: " + (e.message || e));
        }
        this.refresh(win);
      });
    } catch (e) {
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Không mở được hộp thoại chọn tệp: " + (e.message || e));
    }
  },

  /** Quoted fields, doubled quotes, comma or semicolon. */
  parseCsv(text) {
    const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const first = clean.split("\n")[0] || "";
    const sep = (first.match(/;/g) || []).length >
                (first.match(/,/g) || []).length ? ";" : ",";

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
    this.sourceName = "sổ địa chỉ";
    return records;
  },

  columns() {
    return this.rows?.length ? Object.keys(this.rows[0]) : [];
  },

  guessEmailColumn() {
    const names = this.columns();
    const guess = names.find(n => /mail|thư|địa chỉ|dia chi/i.test(n));
    if (guess) {
      return guess;
    }
    return names.find(n =>
      this.rows.some(r => String(r[n]).includes("@"))) || names[0] || "";
  },

  fill(template, record) {
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
      const found = Object.keys(record).find(
        name => name.toLowerCase() === key.toLowerCase());
      return found ? String(record[found] ?? "") : whole;
    });
  },

  /** Same, for a template that is already HTML: values get escaped. */
  fillHtml(template, record) {
    return String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
      const found = Object.keys(record).find(
        name => name.toLowerCase() === key.toLowerCase());
      if (!found) {
        return whole;
      }
      return String(record[found] ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    });
  },

  placeholders(text) {
    const found = new Set();
    for (const m of String(text).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      found.add(m[1].trim());
    }
    return [...found];
  },

  // ---------------------------------------------------------- vẽ lại bảng

  refresh(win) {
    const doc = win.document;
    if (!doc.getElementById(this.PANEL_ID)) {
      return;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);
    const rows = this.rows || [];
    const summary = doc.getElementById("hmail-merge-summary");
    const table = doc.getElementById("hmail-merge-table");
    const toField = doc.getElementById("hmail-merge-to");
    const ccField = doc.getElementById("hmail-merge-cc");
    const preview = doc.getElementById("hmail-merge-preview");

    const previousTo = toField.value;
    const previousCc = ccField.value;
    toField.textContent = "";
    ccField.textContent = "";
    const none = el("option", null, "— không dùng —");
    none.value = "";
    ccField.appendChild(none);
    for (const name of this.columns()) {
      for (const select of [toField, ccField]) {
        const opt = el("option", null, name);
        opt.value = name;
        select.appendChild(opt);
      }
    }
    toField.value = this.columns().includes(previousTo)
      ? previousTo : this.guessEmailColumn();
    ccField.value = this.columns().includes(previousCc) ? previousCc : "";

    const subject = this.subject(win);
    const body = this.bodyHtml(win);
    const keys = [...new Set([...this.placeholders(subject),
                              ...this.placeholders(body)])];
    const missing = keys.filter(k =>
      !this.columns().some(c => c.toLowerCase() === k.toLowerCase()));

    summary.textContent = rows.length
      ? `${rows.length} người nhận từ ${this.sourceName || "danh sách"}. ` +
        (keys.length ? `Ô thay thế: ${keys.join(", ")}. ` : "") +
        (missing.length ? `Không có cột: ${missing.join(", ")}.` : "")
      : "Chưa có danh sách.";

    table.textContent = "";
    if (rows.length) {
      const head = el("div", "hmail-merge-tr head");
      for (const name of this.columns()) {
        head.appendChild(el("span", "hmail-merge-td", name));
      }
      table.appendChild(head);
      for (const row of rows.slice(0, 4)) {
        const tr = el("div", "hmail-merge-tr");
        for (const name of this.columns()) {
          tr.appendChild(el("span", "hmail-merge-td", String(row[name] ?? "")));
        }
        table.appendChild(tr);
      }
      if (rows.length > 4) {
        table.appendChild(el("div", "hmail-ai-hint",
          `… và ${rows.length - 4} dòng nữa.`));
      }
    }

    preview.textContent = "";
    for (const row of rows.slice(0, 2)) {
      const item = el("div", "hmail-merge-item");
      item.append(
        el("div", "hmail-merge-to-line",
           `Đến: ${this.fill(row[toField.value] || "", row)}`),
        el("div", "hmail-merge-subject", this.fill(subject, row)),
        el("div", "hmail-merge-bodyline",
           this.htmlToText(this.fillHtml(body, row)).slice(0, 300)));
      preview.appendChild(item);
    }
  },

  // ------------------------------------------------------------- chạy việc

  settings(win) {
    const doc = win.document;
    const number = (id, fallback) => {
      const value = parseInt(doc.getElementById(id)?.value, 10);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    return {
      to: doc.getElementById("hmail-merge-to").value,
      cc: doc.getElementById("hmail-merge-cc").value,
      mode: doc.getElementById("hmail-merge-mode").value,
      delay: number("hmail-merge-delay", 3),
      batch: number("hmail-merge-batch", 0),
      pause: number("hmail-merge-pause", 0),
      limit: number("hmail-merge-limit", 0),
      onError: doc.getElementById("hmail-merge-skip").value,
      subject: this.subject(win),
      body: this.bodyHtml(win),
      attachments: this.attachments(win),
      identity: win.gMsgCompose?.identity ||
        MailServices.accounts.defaultAccount?.defaultIdentity || null,
    };
  },

  start(win) {
    if (this.job && !this.job.finished) {
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Một lần chạy đang diễn ra.");
      return;
    }
    const rows = this.rows || [];
    if (!rows.length) {
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Chưa có danh sách người nhận.");
      return;
    }
    const settings = this.settings(win);
    if (!settings.to) {
      Services.prompt.alert(win, "Gửi hàng loạt", "Chưa chọn cột địa chỉ.");
      return;
    }
    if (!settings.identity) {
      Services.prompt.alert(win, "Gửi hàng loạt",
        "Chưa có tài khoản để gửi.");
      return;
    }
    if (!settings.subject.trim()) {
      if (!Services.prompt.confirm(win, "Gửi hàng loạt",
            "Thư chưa có tiêu đề. Vẫn tiếp tục?")) {
        return;
      }
    }

    const total = settings.limit ? Math.min(settings.limit, rows.length)
                                 : rows.length;
    if (settings.mode === "send") {
      const minutes = Math.round(total * settings.delay / 60);
      if (!Services.prompt.confirm(win, "Gửi hàng loạt",
            `Gửi ${total} thư, cách nhau ${settings.delay} giây` +
            (minutes ? ` (khoảng ${minutes} phút)` : "") + "?\n\n" +
            "Việc gửi vẫn tiếp tục kể cả khi bạn đóng cửa sổ này.")) {
        return;
      }
    }

    this.job = {
      rows: rows.slice(0, total),
      settings,
      index: 0,
      sent: 0,
      failed: 0,
      results: [],
      paused: false,
      stopped: false,
      finished: false,
    };
    // Half a mailing list wondering why they got nothing is the worst way to
    // find out the window was closed.
    hMailBusy.start("merge", "Gửi hàng loạt",
                    "Người chưa được gửi sẽ không nhận được gì.");
    hMailBusy.onStop("merge", () => {
      if (this.job) {
        this.job.stopped = true;
      }
    });
    this.paint(win);
    this.step(win);
  },

  togglePause(win) {
    if (!this.job) {
      return;
    }
    this.job.paused = !this.job.paused;
    this.paint(win);
    if (!this.job.paused) {
      this.step(win);
    }
  },

  async step(win) {
    const job = this.job;
    if (!job || job.paused) {
      return;
    }
    if (job.stopped || job.index >= job.rows.length) {
      job.finished = true;
      hMailBusy.end("merge");
      this.paint(win);
      this.announce();
      return;
    }

    const row = job.rows[job.index];
    const address = String(row[job.settings.to] || "").trim();
    let error = "";

    if (!address.includes("@")) {
      error = "địa chỉ không hợp lệ";
    } else {
      try {
        await this.sendOne(row, address, job);
        job.sent++;
      } catch (e) {
        error = String(e.message || e);
      }
    }

    if (error) {
      job.failed++;
      if (job.settings.onError === "stop") {
        job.stopped = true;
      }
    }
    job.results.push({ address: address || "(trống)", error });
    job.index++;
    this.paint(win);

    if (job.stopped || job.index >= job.rows.length) {
      job.finished = true;
      hMailBusy.end("merge");
      this.paint(win);
      this.announce();
      return;
    }

    let wait = job.settings.delay * 1000;
    if (job.settings.batch && job.index % job.settings.batch === 0) {
      wait = Math.max(wait, job.settings.pause * 1000);
    }
    // The window may be gone; fall back to a timer that outlives it.
    const later = () => this.step(win);
    try {
      win.setTimeout(later, wait);
    } catch (e) {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback({ notify: later }, wait,
                             Ci.nsITimer.TYPE_ONE_SHOT);
    }
  },

  async sendOne(row, address, job) {
    const identity = job.settings.identity;

    const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
      .createInstance(Ci.nsIMsgCompFields);
    fields.from = identity.fullName
      ? `${identity.fullName} <${identity.email}>` : identity.email;
    fields.to = this.fill(address, row);
    if (job.settings.cc) {
      const cc = String(row[job.settings.cc] || "").trim();
      if (cc) {
        fields.cc = cc;
      }
    }
    fields.subject = this.fill(job.settings.subject, row);
    fields.body = this.fillHtml(job.settings.body, row);

    for (const url of job.settings.attachments) {
      const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
        .createInstance(Ci.nsIMsgAttachment);
      attachment.url = url;
      fields.addAttachment(attachment);
    }

    const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
      .createInstance(Ci.nsIMsgComposeParams);
    params.composeFields = fields;
    params.identity = identity;
    params.type = Ci.nsIMsgCompType.New;
    params.format = Ci.nsIMsgCompFormat.HTML;

    const compose = MailServices.compose.initCompose(params);
    const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"]
      .createInstance(Ci.nsIMsgWindow);
    const accountKey = MailServices.accounts.defaultAccount?.key || "";

    await compose.sendMsg(
      job.settings.mode === "send" ? Ci.nsIMsgCompDeliverMode.Now
                                   : Ci.nsIMsgCompDeliverMode.SaveAsDraft,
      identity, accountKey, msgWindow, null);
  },

  announce() {
    const job = this.job;
    if (!job) {
      return;
    }
    const text = job.settings.mode === "send"
      ? `Đã gửi ${job.sent} thư` +
        (job.failed ? `, ${job.failed} thư lỗi.` : ".")
      : `Đã lưu ${job.sent} thư vào Nháp` +
        (job.failed ? `, ${job.failed} dòng lỗi.` : ".");
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"]
        .getService(Ci.nsIAlertsService);
      const alert = Cc["@mozilla.org/alert-notification;1"]
        .createInstance(Ci.nsIAlertNotification);
      alert.init("hmail-merge", "", "Gửi hàng loạt", text, false, "");
      alerts.showAlert(alert, null);
    } catch (e) {}
  },

  paint(win) {
    const doc = win.document;
    const progress = doc.getElementById("hmail-merge-progress");
    const log = doc.getElementById("hmail-merge-log");
    if (!progress || !log) {
      return;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);
    const job = this.job;

    const start = doc.getElementById("hmail-merge-start");
    const pauseBtn = doc.getElementById("hmail-merge-pausebtn");
    const stopBtn = doc.getElementById("hmail-merge-stop");
    const exportBtn = doc.getElementById("hmail-merge-export");
    const running = !!job && !job.finished;
    start.hidden = running;
    pauseBtn.hidden = !running;
    stopBtn.hidden = !running;
    exportBtn.hidden = !job || !job.results.length;
    pauseBtn.textContent = job?.paused ? "Tiếp tục" : "Tạm dừng";

    progress.textContent = "";
    if (job) {
      const done = job.index;
      const total = job.rows.length;
      const bar = el("div", "hmail-merge-bar");
      const fill = el("div", "hmail-merge-bar-fill");
      fill.style.width = `${total ? Math.round(done / total * 100) : 0}%`;
      bar.appendChild(fill);
      progress.appendChild(bar);
      progress.appendChild(el("div", "hmail-ai-status",
        job.finished
          ? `Xong: ${job.sent} thành công, ${job.failed} lỗi.`
          : `${done}/${total} — thành công ${job.sent}, lỗi ${job.failed}` +
            (job.paused ? " (đang tạm dừng)" : "")));
    }

    log.textContent = "";
    for (const result of (job?.results || []).slice(-30).reverse()) {
      const line = el("div",
        `hmail-merge-result ${result.error ? "bad" : "ok"}`);
      line.append(
        el("span", "hmail-merge-result-address", result.address),
        el("span", "hmail-merge-result-note",
           result.error ? result.error : "đã xử lý"));
      log.appendChild(line);
    }
  },

  exportResults(win) {
    const job = this.job;
    if (!job) {
      return;
    }
    const lines = ["Địa chỉ,Kết quả"];
    for (const result of job.results) {
      const note = result.error ? `Lỗi: ${result.error}` : "Thành công";
      lines.push(`"${result.address.replace(/"/g, '""')}","${note}"`);
    }

    const picker = Cc["@mozilla.org/filepicker;1"]
      .createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Lưu kết quả",
                Ci.nsIFilePicker.modeSave);
    picker.defaultString = "ket-qua-gui-hang-loat.csv";
    picker.appendFilter("CSV", "*.csv");
    picker.open(async result => {
      if (result === Ci.nsIFilePicker.returnCancel || !picker.file) {
        return;
      }
      try {
        await IOUtils.writeUTF8(picker.file.path,
                                "﻿" + lines.join("\r\n"));
      } catch (e) {
        Services.prompt.alert(win, "Gửi hàng loạt",
          "Không lưu được: " + (e.message || e));
      }
    });
  },
};
