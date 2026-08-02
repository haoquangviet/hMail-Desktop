/* hMail Desktop — trộn thư
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Sending the same letter to two hundred people, each addressed personally, is
 * a job rather than a command: it needs a list, a draft, settings, a preview,
 * and something to watch while it runs. So it lives in its own tab, and the
 * run keeps going when that tab is closed — the job is held by the module,
 * not by the page showing it.
 *
 * Sending is paced on purpose. Mail servers throttle or block clients that
 * fire hundreds of messages in a burst, so the delay between messages and the
 * batch pause are settings, not hard-coded numbers.
 *
 * Nothing is sent until the user presses Gửi, and "Lưu vào Nháp" is offered
 * alongside so the whole run can be inspected first.
 */

"use strict";

var hMailMerge = {
  TAB_MODE: "hmailMerge",
  BUTTON_ID: "hmail-merge-button",

  /**
   * The running job. Kept on the module so closing the tab does not stop it.
   * { rows, index, sent, failed, results, paused, stopped, settings }
   */
  job: null,

  // ------------------------------------------------------------ khởi động

  init(win) {
    try {
      this.registerTabType(win);
    } catch (e) {
      Cu.reportError("hMail merge init failed: " + e);
    }
  },

  /** In the composer: a button that carries the draft into the merge tab. */
  initCompose(win) {
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
      button.addEventListener("command", () => this.fromComposer(win));
      toolbar.appendChild(button);
    } catch (e) {
      Cu.reportError("hMail merge compose button failed: " + e);
    }
  },

  fromComposer(win) {
    let seed = { subject: "", body: "" };
    try {
      seed.subject = win.document.getElementById("msgSubject")?.value || "";
      seed.body = win.getBrowser()?.contentDocument?.body?.innerHTML || "";
    } catch (e) {}

    const main = Services.wm.getMostRecentWindow("mail:3pane");
    if (!main) {
      Services.prompt.alert(win, "Trộn thư",
        "Hãy mở cửa sổ thư chính trước.");
      return;
    }
    main.hMailMerge.openTab(main, seed);
    main.focus();
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

  // --------------------------------------------------------------- the tab

  registerTabType(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail || tabmail.tabModes?.[this.TAB_MODE]) {
      return;
    }
    const self = this;
    tabmail.registerTabType({
      name: self.TAB_MODE,
      perTabPanel: "vbox",
      modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
      openTab(tab, args) {
        tab.title = "Trộn thư";
        tab.panel.classList.add("hmail-merge-tab");
        tab.panel.appendChild(self.buildPage(win, args?.seed));
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "Trộn thư";
      },
      persistTab() {
        return null;
      },
      restoreTab(tabmailToRestore) {
        tabmailToRestore.openTab(self.TAB_MODE, {});
      },
      supportsCommand() {
        return false;
      },
    });
  },

  openTab(win, seed) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this.registerTabType(win);
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      if (seed) {
        this.applySeed(win, seed);
      }
      return;
    }
    tabmail.openTab(this.TAB_MODE, { seed });
    const opened = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (opened) {
      tabmail.switchToTab(opened);
    }
  },

  applySeed(win, seed) {
    const doc = win.document;
    const subject = doc.getElementById("hmail-merge-subject");
    const body = doc.getElementById("hmail-merge-body");
    if (subject && seed.subject) {
      subject.value = seed.subject;
    }
    if (body && seed.body) {
      body.value = this.htmlToText(seed.body);
    }
    this.refresh(win);
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

  // -------------------------------------------------------------- the page

  buildPage(win, seed) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const page = el("div", "hmail-merge-page hmail-ai");
    page.id = "hmail-merge-page";

    page.appendChild(el("div", "hmail-merge-title", "Trộn thư"));
    page.appendChild(el("div", "hmail-ai-hint",
      "Một thư, nhiều người nhận, mỗi người một bản riêng. Dùng {{Tên cột}} " +
      "trong tiêu đề và nội dung để chèn thông tin của từng người; mỗi thư " +
      "chỉ có một người nhận nên không ai thấy địa chỉ của ai."));

    // --- 1. danh sách người nhận -----------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "1. Danh sách người nhận"));
    const source = el("div", "hmail-ai-row");
    const fromCsv = el("button", "hmail-ai-btn", "Mở tệp CSV…");
    fromCsv.addEventListener("click", () => this.pickCsv(win));
    const fromBook = el("button", "hmail-ai-btn", "Lấy từ sổ địa chỉ");
    fromBook.addEventListener("click", () => {
      this.rows = this.fromAddressBook();
      this.refresh(win);
    });
    source.append(fromCsv, fromBook);
    page.appendChild(source);

    const summary = el("div", "hmail-ai-status", "Chưa có danh sách.");
    summary.id = "hmail-merge-summary";
    page.appendChild(summary);

    const table = el("div", "hmail-merge-table");
    table.id = "hmail-merge-table";
    page.appendChild(table);

    // --- 2. nội dung ------------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "2. Nội dung thư"));
    page.appendChild(el("label", "hmail-ai-label", "Tiêu đề"));
    const subject = el("input", "hmail-ai-field");
    subject.id = "hmail-merge-subject";
    subject.value = seed?.subject || "";
    subject.addEventListener("input", () => this.refresh(win));
    page.appendChild(subject);

    page.appendChild(el("label", "hmail-ai-label", "Nội dung"));
    page.appendChild(this.buildEditorToolbar(win, doc));

    const body = el("div", "hmail-merge-editor");
    body.id = "hmail-merge-body";
    body.setAttribute("contenteditable", "true");
    if (seed?.body) {
      // Seeded from the composer, which produced this markup itself.
      body.innerHTML = seed.body;
    }
    body.addEventListener("input", () => this.refresh(win));
    page.appendChild(body);

    const attachRow = el("div", "hmail-ai-row");
    const attachBtn = el("button", "hmail-ai-btn", "Đính kèm tệp…");
    attachBtn.addEventListener("click", () => this.pickAttachments(win));
    const attachList = el("span", "hmail-merge-attachments",
                          "Không có tệp đính kèm");
    attachList.id = "hmail-merge-attachments";
    attachRow.append(attachBtn, attachList);
    page.appendChild(attachRow);

    // --- 3. tham số -------------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "3. Tham số gửi"));

    const grid = el("div", "hmail-merge-grid");

    const field = (label, node, hint) => {
      const cell = el("div", "hmail-merge-cell");
      cell.appendChild(el("label", "hmail-ai-label", label));
      cell.appendChild(node);
      if (hint) {
        cell.appendChild(el("div", "hmail-ai-hint", hint));
      }
      grid.appendChild(cell);
      return node;
    };

    const toField = el("select", "hmail-ai-field");
    toField.id = "hmail-merge-to";
    field("Cột địa chỉ người nhận", toField);

    const ccField = el("select", "hmail-ai-field");
    ccField.id = "hmail-merge-cc";
    field("Cột CC (tuỳ chọn)", ccField);

    const identity = el("select", "hmail-ai-field");
    identity.id = "hmail-merge-identity";
    for (const one of MailServices.accounts.allIdentities) {
      if (!one.email) {
        continue;
      }
      const opt = el("option", null,
        one.fullName ? `${one.fullName} <${one.email}>` : one.email);
      opt.value = one.key;
      identity.appendChild(opt);
    }
    field("Gửi từ tài khoản", identity);

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

    const delay = el("input", "hmail-ai-field");
    delay.id = "hmail-merge-delay";
    delay.type = "number";
    delay.min = "0";
    delay.max = "600";
    delay.value = "3";
    field("Giãn cách giữa hai thư (giây)", delay,
      "Gửi dồn dập dễ bị máy chủ chặn hoặc xếp vào thư rác.");

    const batch = el("input", "hmail-ai-field");
    batch.id = "hmail-merge-batch";
    batch.type = "number";
    batch.min = "0";
    batch.value = "50";
    field("Số thư mỗi đợt", batch, "0 nghĩa là không chia đợt.");

    const pause = el("input", "hmail-ai-field");
    pause.id = "hmail-merge-pause";
    pause.type = "number";
    pause.min = "0";
    pause.value = "300";
    field("Nghỉ giữa hai đợt (giây)", pause);

    const limit = el("input", "hmail-ai-field");
    limit.id = "hmail-merge-limit";
    limit.type = "number";
    limit.min = "0";
    limit.value = "0";
    field("Giới hạn số thư lần chạy này", limit,
      "0 nghĩa là gửi hết danh sách.");

    const skipInvalid = el("select", "hmail-ai-field");
    skipInvalid.id = "hmail-merge-skip";
    for (const [value, label] of [
      ["skip", "Bỏ qua và ghi vào kết quả"],
      ["stop", "Dừng cả lần chạy"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      skipInvalid.appendChild(opt);
    }
    field("Khi gặp dòng lỗi", skipInvalid);

    page.appendChild(grid);

    // --- 4. xem trước -----------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "4. Xem trước"));
    const preview = el("div", "hmail-merge-preview");
    preview.id = "hmail-merge-preview";
    page.appendChild(preview);

    // --- 5. chạy ----------------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "5. Thực hiện"));

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
    const exportBtn = el("button", "hmail-ai-btn", "Xuất kết quả CSV");
    exportBtn.id = "hmail-merge-export";
    exportBtn.hidden = true;
    exportBtn.addEventListener("click", () => this.exportResults(win));
    actions.append(start, pauseBtn, stopBtn, exportBtn);
    page.appendChild(actions);

    const progress = el("div", "hmail-merge-progress");
    progress.id = "hmail-merge-progress";
    page.appendChild(progress);

    const log = el("div", "hmail-merge-log");
    log.id = "hmail-merge-log";
    page.appendChild(log);

    win.setTimeout(() => {
      this.refresh(win);
      this.paint(win);
    }, 0);
    return page;
  },

  /**
   * The formatting row above the editor. execCommand is deprecated on the
   * web, but it is exactly what Thunderbird's own composer uses and it is the
   * only thing that edits a contenteditable region without pulling in an
   * editor library.
   */
  buildEditorToolbar(win, doc) {
    const el = (t, c, x) => this.el(doc, t, c, x);
    const bar = el("div", "hmail-merge-toolbar");

    const focusEditor = () => {
      const editor = doc.getElementById("hmail-merge-body");
      if (editor && doc.activeElement !== editor) {
        editor.focus();
      }
      return editor;
    };

    const command = (label, title, cmd, arg) => {
      const button = el("button", "hmail-merge-tool", label);
      button.title = title;
      // mousedown, not click: clicking a button would take the selection away
      // from the editor before the command could act on it.
      button.addEventListener("mousedown", event => {
        event.preventDefault();
        focusEditor();
        try {
          doc.execCommand(cmd, false, arg);
        } catch (e) {}
        this.refresh(win);
      });
      return button;
    };

    bar.append(
      command("B", "Đậm (Ctrl+B)", "bold"),
      command("I", "Nghiêng (Ctrl+I)", "italic"),
      command("U", "Gạch chân (Ctrl+U)", "underline"),
      command("S", "Gạch ngang", "strikeThrough"),
      el("span", "hmail-merge-tool-sep"),
      command("•", "Danh sách dấu chấm", "insertUnorderedList"),
      command("1.", "Danh sách đánh số", "insertOrderedList"),
      command("⇤", "Giảm thụt lề", "outdent"),
      command("⇥", "Tăng thụt lề", "indent"),
      el("span", "hmail-merge-tool-sep"),
      command("↤", "Canh trái", "justifyLeft"),
      command("↔", "Canh giữa", "justifyCenter"),
      command("↦", "Canh phải", "justifyRight"));

    // Font size.
    const size = el("select", "hmail-merge-tool-select");
    size.title = "Cỡ chữ";
    for (const [value, label] of [
      ["", "Cỡ chữ"], ["2", "Nhỏ"], ["3", "Thường"], ["4", "Lớn"],
      ["5", "Rất lớn"], ["6", "Tiêu đề"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      size.appendChild(opt);
    }
    size.addEventListener("change", () => {
      if (!size.value) {
        return;
      }
      focusEditor();
      try {
        doc.execCommand("fontSize", false, size.value);
      } catch (e) {}
      size.value = "";
      this.refresh(win);
    });
    bar.appendChild(size);

    // Text colour.
    const colour = el("input", "hmail-merge-tool-colour");
    colour.type = "color";
    colour.title = "Màu chữ";
    colour.value = "#1b1b1f";
    colour.addEventListener("change", () => {
      focusEditor();
      try {
        doc.execCommand("foreColor", false, colour.value);
      } catch (e) {}
      this.refresh(win);
    });
    bar.appendChild(colour);

    bar.appendChild(el("span", "hmail-merge-tool-sep"));

    // Link.
    const link = el("button", "hmail-merge-tool", "🔗");
    link.title = "Chèn liên kết";
    link.addEventListener("mousedown", event => {
      event.preventDefault();
      const url = { value: "https://" };
      if (!Services.prompt.prompt(win, "Chèn liên kết",
            "Địa chỉ liên kết:", url, null, {})) {
        return;
      }
      focusEditor();
      try {
        doc.execCommand("createLink", false, url.value);
      } catch (e) {}
      this.refresh(win);
    });
    bar.appendChild(link);

    bar.appendChild(command("✕", "Xoá định dạng", "removeFormat"));

    // Insert a placeholder for one of the columns, which is the whole point
    // of a merge and awkward to type by hand.
    const insert = el("select", "hmail-merge-tool-select");
    insert.id = "hmail-merge-insert";
    insert.title = "Chèn ô thay thế";
    bar.appendChild(insert);
    insert.addEventListener("change", () => {
      if (!insert.value) {
        return;
      }
      focusEditor();
      try {
        doc.execCommand("insertText", false, `{{${insert.value}}}`);
      } catch (e) {}
      insert.value = "";
      this.refresh(win);
    });

    return bar;
  },

  // ------------------------------------------------------------- dữ liệu

  pickCsv(win) {
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
        Services.prompt.alert(win, "Trộn thư",
          "Không đọc được tệp: " + (e.message || e));
      }
      this.refresh(win);
    });
  },

  pickAttachments(win) {
    const picker = Cc["@mozilla.org/filepicker;1"]
      .createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Chọn tệp đính kèm",
                Ci.nsIFilePicker.modeOpenMultiple);
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    picker.open(result => {
      if (result !== Ci.nsIFilePicker.returnOK) {
        return;
      }
      this.attachments = [];
      for (const file of picker.files) {
        this.attachments.push(file.QueryInterface(Ci.nsIFile));
      }
      const label = win.document.getElementById("hmail-merge-attachments");
      if (label) {
        label.textContent = this.attachments.length
          ? this.attachments.map(f => f.leafName).join(", ")
          : "Không có tệp đính kèm";
      }
    });
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
    this.sourceName = "Sổ địa chỉ";
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

  /**
   * Same substitution, but for a template that is already HTML: the value
   * from the list is escaped so a stray "<" in someone's company name cannot
   * become markup.
   */
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

  // ---------------------------------------------------------- vẽ lại trang

  refresh(win) {
    const doc = win.document;
    if (!doc.getElementById("hmail-merge-page")) {
      return;
    }
    const rows = this.rows || [];
    const summary = doc.getElementById("hmail-merge-summary");
    const table = doc.getElementById("hmail-merge-table");
    const toField = doc.getElementById("hmail-merge-to");
    const ccField = doc.getElementById("hmail-merge-cc");
    const preview = doc.getElementById("hmail-merge-preview");
    const el = (t, c, x) => this.el(doc, t, c, x);

    // Recipient columns.
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

    // The column list for the "insert placeholder" menu.
    const insert = doc.getElementById("hmail-merge-insert");
    if (insert) {
      insert.textContent = "";
      const head = el("option", null, "Chèn ô thay thế");
      head.value = "";
      insert.appendChild(head);
      for (const name of this.columns()) {
        const opt = el("option", null, name);
        opt.value = name;
        insert.appendChild(opt);
      }
    }

    // Summary and the placeholder check.
    const subject = doc.getElementById("hmail-merge-subject").value;
    const body = doc.getElementById("hmail-merge-body").innerHTML || "";
    const keys = [...new Set([...this.placeholders(subject),
                              ...this.placeholders(body)])];
    const missing = keys.filter(k =>
      !this.columns().some(c => c.toLowerCase() === k.toLowerCase()));

    summary.textContent = rows.length
      ? `${rows.length} người nhận từ ${this.sourceName || "danh sách"}. ` +
        (keys.length ? `Ô thay thế: ${keys.join(", ")}. ` : "") +
        (missing.length ? `Không tìm thấy cột: ${missing.join(", ")}.` : "")
      : "Chưa có danh sách.";

    // First rows, so the columns can be checked at a glance.
    table.textContent = "";
    if (rows.length) {
      const head = el("div", "hmail-merge-tr head");
      for (const name of this.columns()) {
        head.appendChild(el("span", "hmail-merge-td", name));
      }
      table.appendChild(head);
      for (const row of rows.slice(0, 5)) {
        const tr = el("div", "hmail-merge-tr");
        for (const name of this.columns()) {
          tr.appendChild(el("span", "hmail-merge-td", String(row[name] ?? "")));
        }
        table.appendChild(tr);
      }
      if (rows.length > 5) {
        table.appendChild(el("div", "hmail-ai-hint",
          `… và ${rows.length - 5} dòng nữa.`));
      }
    }

    // Preview of the first three letters as they will be sent.
    preview.textContent = "";
    for (const row of rows.slice(0, 3)) {
      const item = el("div", "hmail-merge-item");
      item.append(
        el("div", "hmail-merge-to-line",
           `Đến: ${this.fill(row[toField.value] || "", row)}`),
        el("div", "hmail-merge-subject", this.fill(subject, row)),
        // Shown as text: the letter's own markup is the user's, but the
        // values coming from the list are not, and this page runs in chrome.
        el("div", "hmail-merge-bodyline",
           this.htmlToText(this.fillHtml(body, row)).slice(0, 400)));
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
      identityKey: doc.getElementById("hmail-merge-identity").value,
      mode: doc.getElementById("hmail-merge-mode").value,
      delay: number("hmail-merge-delay", 3),
      batch: number("hmail-merge-batch", 0),
      pause: number("hmail-merge-pause", 0),
      limit: number("hmail-merge-limit", 0),
      onError: doc.getElementById("hmail-merge-skip").value,
      subject: doc.getElementById("hmail-merge-subject").value,
      body: doc.getElementById("hmail-merge-body").innerHTML || "",
    };
  },

  identityByKey(key) {
    for (const one of MailServices.accounts.allIdentities) {
      if (one.key === key) {
        return one;
      }
    }
    return MailServices.accounts.defaultAccount?.defaultIdentity || null;
  },

  start(win) {
    if (this.job && !this.job.finished) {
      Services.prompt.alert(win, "Trộn thư", "Một lần chạy đang diễn ra.");
      return;
    }
    const rows = this.rows || [];
    if (!rows.length) {
      Services.prompt.alert(win, "Trộn thư", "Chưa có danh sách người nhận.");
      return;
    }
    const settings = this.settings(win);
    if (!settings.to) {
      Services.prompt.alert(win, "Trộn thư", "Chưa chọn cột địa chỉ.");
      return;
    }
    const total = settings.limit ? Math.min(settings.limit, rows.length)
                                 : rows.length;

    if (settings.mode === "send") {
      const minutes = Math.round(total * settings.delay / 60);
      if (!Services.prompt.confirm(win, "Trộn thư",
            `Gửi ${total} thư, cách nhau ${settings.delay} giây` +
            (minutes ? ` (khoảng ${minutes} phút)` : "") + "?\n\n" +
            "Việc gửi vẫn tiếp tục kể cả khi bạn đóng thẻ này.")) {
        return;
      }
    }

    this.job = {
      rows: rows.slice(0, total),
      settings,
      attachments: (this.attachments || []).slice(),
      index: 0,
      sent: 0,
      failed: 0,
      results: [],
      paused: false,
      stopped: false,
      finished: false,
      startedAt: Date.now(),
    };
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

  /** One message, then schedule the next. Never blocks the interface. */
  async step(win) {
    const job = this.job;
    if (!job || job.paused) {
      return;
    }
    if (job.stopped || job.index >= job.rows.length) {
      job.finished = true;
      this.paint(win);
      this.announce(win);
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
      this.paint(win);
      this.announce(win);
      return;
    }

    // Pace it: a delay between messages, and a longer rest between batches.
    let wait = job.settings.delay * 1000;
    if (job.settings.batch && job.index % job.settings.batch === 0) {
      wait = Math.max(wait, job.settings.pause * 1000);
    }
    win.setTimeout(() => this.step(win), wait);
  },

  async sendOne(row, address, job) {
    const identity = this.identityByKey(job.settings.identityKey);
    if (!identity) {
      throw new Error("chưa có tài khoản gửi");
    }

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
    // The letter is already HTML from the editor; only the values merged into
    // it need escaping.
    fields.body = this.fillHtml(job.settings.body, row);

    for (const file of job.attachments) {
      const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
        .createInstance(Ci.nsIMsgAttachment);
      attachment.url = Services.io.newFileURI(file).spec;
      attachment.name = file.leafName;
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
    const accountKey = MailServices.accounts
      .getFirstIdentityAccount?.(identity)?.key ||
      MailServices.accounts.defaultAccount?.key || "";

    await compose.sendMsg(
      job.settings.mode === "send" ? Ci.nsIMsgCompDeliverMode.Now
                                   : Ci.nsIMsgCompDeliverMode.SaveAsDraft,
      identity, accountKey, msgWindow, null);
  },

  announce(win) {
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
      alert.init("hmail-merge", "", "Trộn thư", text, false, "");
      alerts.showAlert(alert, null);
    } catch (e) {}
  },

  /** Progress and the per-row result list, redrawn as the job advances. */
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
    for (const result of (job?.results || []).slice(-40).reverse()) {
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
    picker.defaultString = "ket-qua-tron-thu.csv";
    picker.appendFilter("CSV", "*.csv");
    picker.open(async result => {
      if (result === Ci.nsIFilePicker.returnCancel || !picker.file) {
        return;
      }
      try {
        await IOUtils.writeUTF8(picker.file.path,
                                "﻿" + lines.join("\r\n"));
      } catch (e) {
        Services.prompt.alert(win, "Trộn thư",
          "Không lưu được: " + (e.message || e));
      }
    });
  },
};
