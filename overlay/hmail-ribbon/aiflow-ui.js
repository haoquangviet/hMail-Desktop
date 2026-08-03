/* hMail Desktop — trang quản lý quy tắc tự động
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * One card per rule, read top to bottom as a sentence: when a message
 * arrives that looks like this, do that. The log underneath is the other
 * half of the page — an automation you cannot audit is one you should not
 * switch on.
 */

"use strict";

var hMailFlowUI = {
  TAB_MODE: "hmailFlow",

  init(win) {
    try {
      this.registerTabType(win);
    } catch (e) {
      Cu.reportError("hMail flow UI init failed: " + e);
    }
  },

  el(doc, tag, cls, text) {
    return hMailFlow.el(doc, tag, cls, text);
  },

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
      openTab(tab) {
        tab.title = "Tự động hoá AI";
        tab.panel.classList.add("hmail-import-tab");
        try {
          tab.panel.appendChild(self.build(win));
        } catch (e) {
          Cu.reportError("hMail flow page failed: " + e);
        }
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "Tự động hoá AI";
      },
      persistTab() {
        return null;
      },
      restoreTab(t) {
        t.openTab(self.TAB_MODE, {});
      },
      supportsCommand() {
        return false;
      },
    });
  },

  openTab(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this.registerTabType(win);
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      this.refresh(win);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
    const opened = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (opened) {
      tabmail.switchToTab(opened);
    }
  },

  // ------------------------------------------------------------------ page

  /**
   * The pages that are not rules. Each one is its own thing — a run, a
   * review queue, a log — and stacking them under the rule form meant that
   * scrolling a rule ran straight into somebody else's business.
   */
  PAGES: [
    { id: "general", label: "Cài đặt chung",
      note: "Bật/tắt tự động hoá cho thư đến" },
    { id: "run", label: "Chạy trên thư mục",
      note: "Áp quy tắc cho thư đã nhận" },
    { id: "review", label: "Chờ bạn duyệt",
      note: "Thư AI không đủ chắc chắn" },
    { id: "log", label: "Nhật ký",
      note: "Việc đã làm thay bạn" },
  ],

  build(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    // Laid out like the account settings page: a column of pages against the
    // edge of the tab, and one pane beside it showing whichever is chosen.
    const page = el("div", "hmail-flow-page hmail-ai");
    page.id = "hmail-flow-page";

    const side = el("div", "hmail-flow-side");

    const sideHead = el("div", "hmail-flow-side-head");
    const add = el("button", "hmail-flow-add", "+ Thêm quy tắc");
    add.addEventListener("click", () => {
      const rules = hMailFlow.rules();
      const rule = hMailFlow.blank();
      rules.push(rule);
      hMailFlow.saveRules(rules);
      this.selected = rule.id;
      this.refresh(win);
    });
    sideHead.appendChild(add);
    side.appendChild(sideHead);

    side.appendChild(el("div", "hmail-flow-side-title", "Quy tắc"));
    const list = el("div", "hmail-flow-rules");
    list.id = "hmail-flow-rules";
    side.appendChild(list);

    side.appendChild(el("div", "hmail-flow-side-title", "Khác"));
    const pages = el("div", "hmail-flow-pages");
    pages.id = "hmail-flow-pages";
    side.appendChild(pages);

    const splitter = el("div", "hmail-flow-splitter");
    splitter.id = "hmail-flow-splitter";
    splitter.title = "Kéo để đổi độ rộng";

    const main = el("div", "hmail-flow-main");
    main.id = "hmail-flow-main";

    page.append(side, splitter, main);
    this.makeResizable(win, side, splitter, page);
    win.setTimeout(() => this.refresh(win), 0);
    return page;
  },

  // ------------------------------------------------------------- các trang

  pageGeneral(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-flow-pane");

    box.appendChild(el("div", "hmail-import-title",
                       "Tự động hoá khi có thư mới"));
    box.appendChild(el("div", "hmail-ai-hint",
      "Bộ lọc thường chỉ so khớp chữ: một địa chỉ, một từ trong tiêu đề. " +
      "Ở đây mỗi quy tắc có hai nửa. Nửa rẻ tiền so khớp như bộ lọc thường " +
      "và chạy trước, không tốn gì. Chỉ khi nửa đó khớp, hMail mới đưa thư " +
      "cho AI và hỏi đúng một câu bạn tự viết — nhờ thứ tự đó mà hỏi AI " +
      "không biến thành một hoá đơn."));

    const master = el("div", "hmail-flow-master");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = hMailFlow.enabled();
    toggle.addEventListener("change", () => {
      Services.prefs.setBoolPref(hMailFlow.ENABLED_PREF, toggle.checked);
    });
    const label = el("label", "hmail-flow-master-label");
    label.append(toggle, el("span", null, "Bật tự động hoá cho thư đến"));
    master.appendChild(label);
    master.appendChild(el("div", "hmail-ai-hint",
      "Tắt thì không quy tắc nào chạy, kể cả quy tắc đang bật riêng. Chỉ " +
      "áp dụng cho thư mới về Hộp thư; thư đã có sẵn không bị đụng tới."));
    box.appendChild(master);

    box.appendChild(el("div", "hmail-ai-section", "Trang liên quan"));
    const links = el("div", "hmail-flow-links");
    const link = (text, note, fn) => {
      const b = el("button", "hmail-flow-link");
      b.append(el("span", "hmail-flow-link-name", text),
               el("span", "hmail-flow-link-note", note));
      b.addEventListener("click", () => {
        try {
          fn();
        } catch (e) {}
      });
      links.appendChild(b);
    };
    link("Cài đặt trợ lý AI", "Nhà cung cấp, mô hình, đơn giá",
         () => win.hMailAI?.open(win));
    link("AI trên máy", "Mô hình chạy tại chỗ, tìm theo ngữ nghĩa",
         () => win.hMailLocalAIUI?.openTab(win));
    link("Lọc theo máy chủ", "Xử lý theo kết luận bộ lọc của máy chủ",
         () => win.hMailServerFilter?.openTab(win));
    link("Bộ lọc thư của hMail", "Bộ lọc so khớp chữ, không dùng AI",
         () => win.MsgFilters());
    box.appendChild(links);

    box.appendChild(el("div", "hmail-ai-section", "Chưa có"));
    box.appendChild(el("div", "hmail-ai-hint",
      "Lịch chạy định kỳ · Điều kiện theo người nhận và ngày tháng · " +
      "Xuất báo cáo phân loại · Áp quy tắc cho nhiều thư mục một lượt"));
    return box;
  },

  pageRun(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-flow-pane");

    box.appendChild(el("div", "hmail-import-title",
                       "Chạy trên thư mục sẵn có"));
    box.appendChild(el("div", "hmail-ai-hint",
      "Áp một quy tắc cho thư đã nhận. Việc này đụng tới hàng nghìn thư một " +
      "lúc và tốn tiền thật, nên hMail ước tính chi phí trước, hỏi lại hai " +
      "lần, và mọi thư mà AI không chắc sẽ được đưa vào danh sách chờ bạn " +
      "duyệt thay vì tự xử lý."));

    const runRow = el("div", "hmail-ai-row");
    runRow.append(el("span", "hmail-flow-label", "Quy tắc"));
    const rulePick = el("select", "hmail-ai-field");
    rulePick.id = "hmail-flow-run-rule";
    for (const rule of hMailFlow.rules()) {
      const opt = el("option", null, rule.name || "(chưa đặt tên)");
      opt.value = rule.id;
      rulePick.appendChild(opt);
    }
    runRow.appendChild(rulePick);
    box.appendChild(runRow);

    const folderRow = el("div", "hmail-ai-row");
    folderRow.append(el("span", "hmail-flow-label", "Thư mục"));
    const folderPick = el("select", "hmail-ai-field");
    folderPick.id = "hmail-flow-run-folder";
    for (const folder of this.folders()) {
      const opt = el("option", null, folder.label);
      opt.value = folder.uri;
      folderPick.appendChild(opt);
    }
    folderRow.appendChild(folderPick);
    box.appendChild(folderRow);

    const capRow = el("div", "hmail-ai-row");
    capRow.append(el("span", "hmail-flow-label", "Mức trần chi phí (USD)"));
    const cap = el("input", "hmail-ai-field");
    cap.id = "hmail-flow-cap";
    cap.type = "number";
    cap.min = "0.1";
    cap.step = "0.5";
    cap.value = String(hMailFlow.budget());
    cap.addEventListener("change", () => {
      Services.prefs.setCharPref(hMailFlow.BUDGET_PREF, cap.value);
    });
    capRow.appendChild(cap);
    box.appendChild(capRow);
    box.appendChild(el("div", "hmail-ai-hint",
      "hMail dừng ngay khi tiêu tới mức này, kể cả khi chưa xử lý hết thư. " +
      "Số tiền tính theo đơn giá bạn khai trong cài đặt trợ lý."));

    const actions = el("div", "hmail-ai-actions");
    const run = el("button", "hmail-ai-btn primary", "Ước tính và chạy…");
    run.id = "hmail-flow-run";
    run.addEventListener("click", () => this.startRun(win));
    const stop = el("button", "hmail-ai-btn", "Dừng");
    stop.id = "hmail-flow-run-stop";
    stop.hidden = true;
    stop.addEventListener("click", () => {
      this.stopping = true;
    });
    actions.append(run, stop);
    box.appendChild(actions);

    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-flow-run-status";
    box.appendChild(status);

    const bar = el("div", "hmail-merge-bar");
    bar.id = "hmail-flow-run-bar";
    bar.hidden = true;
    bar.appendChild(el("div", "hmail-merge-bar-fill"));
    box.appendChild(bar);
    return box;
  },

  pageReview(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-flow-pane");
    box.appendChild(el("div", "hmail-import-title", "Chờ bạn duyệt"));
    box.appendChild(el("div", "hmail-ai-hint",
      "Những thư AI cho là khớp nhưng không đủ chắc chắn. hMail không tự " +
      "làm gì với chúng — một cái máy đoán mò trên hàng nghìn lá thư là " +
      "hàng nghìn lần đoán sai."));
    const review = el("div", "hmail-flow-review");
    review.id = "hmail-flow-review";
    box.appendChild(review);
    return box;
  },

  pageLog(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-flow-pane");
    box.appendChild(el("div", "hmail-import-title", "Nhật ký"));
    box.appendChild(el("div", "hmail-ai-hint",
      "Mỗi hành động tự động đều được ghi lại. Một thứ chạy thay bạn mà " +
      "bạn không soát lại được thì không nên bật."));
    const log = el("div", "hmail-flow-log");
    log.id = "hmail-flow-log";
    box.appendChild(log);
    return box;
  },

  WIDTH_PREF: "hmail.flow.sideWidth",

  /** Drag the handle to resize the list; the width is remembered. */
  makeResizable(win, side, splitter, split) {
    const apply = percent => {
      const clamped = Math.max(15, Math.min(60, percent));
      side.style.flexBasis = `${clamped}%`;
      return clamped;
    };

    let saved = 30;
    try {
      saved = parseFloat(
        Services.prefs.getCharPref(this.WIDTH_PREF, "30")) || 30;
    } catch (e) {}
    apply(saved);

    let dragging = false;
    splitter.addEventListener("mousedown", event => {
      dragging = true;
      event.preventDefault();
      split.classList.add("resizing");
    });
    win.addEventListener("mousemove", event => {
      if (!dragging) {
        return;
      }
      const box = split.getBoundingClientRect();
      if (!box.width) {
        return;
      }
      apply(((event.clientX - box.left) / box.width) * 100);
    });
    win.addEventListener("mouseup", () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      split.classList.remove("resizing");
      try {
        Services.prefs.setCharPref(this.WIDTH_PREF,
          String(parseFloat(side.style.flexBasis) || 30));
      } catch (e) {}
    });
  },

  refresh(win) {
    const doc = win.document;
    const list = doc.getElementById("hmail-flow-rules");
    const pages = doc.getElementById("hmail-flow-pages");
    const main = doc.getElementById("hmail-flow-main");
    if (!list || !pages || !main) {
      return;
    }
    const rules = hMailFlow.rules();
    const known = new Set([...rules.map(r => r.id),
                           ...this.PAGES.map(p => p.id)]);
    if (!known.has(this.selected)) {
      this.selected = rules[0]?.id || "general";
    }

    list.textContent = "";
    for (const [index, rule] of rules.entries()) {
      list.appendChild(this.sideRow(win, rule, index, rules));
    }
    if (!rules.length) {
      list.appendChild(this.el(doc, "div", "hmail-flow-side-empty",
        "Chưa có quy tắc nào."));
    }

    pages.textContent = "";
    for (const page of this.PAGES) {
      pages.appendChild(this.pageRow(win, page));
    }

    main.textContent = "";
    const rule = rules.find(r => r.id === this.selected);
    if (rule) {
      const pane = this.el(doc, "div", "hmail-flow-pane");
      pane.appendChild(this.card(win, rule, rules.indexOf(rule), rules));
      main.appendChild(pane);
    } else if (this.selected === "run") {
      main.appendChild(this.pageRun(win));
    } else if (this.selected === "review") {
      main.appendChild(this.pageReview(win));
      this.paintReview(win);
    } else if (this.selected === "log") {
      main.appendChild(this.pageLog(win));
      this.paintLog(win);
    } else {
      main.appendChild(this.pageGeneral(win));
    }
    main.scrollTop = 0;
  },

  /** One of the non-rule pages in the sidebar. */
  pageRow(win, page) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const row = el("div", "hmail-flow-side-row page" +
                   (page.id === this.selected ? " selected" : ""));
    const text = el("div", "hmail-flow-side-text");
    text.append(el("div", "hmail-flow-side-name", page.label),
                el("div", "hmail-flow-side-note", page.note));
    row.appendChild(text);
    row.addEventListener("click", () => {
      this.selected = page.id;
      this.refresh(win);
    });
    return row;
  },

  /**
   * One line in the sidebar: a switch, the name, and what it does in short.
   * The switch is here rather than only in the detail pane so a rule can be
   * turned off without opening it — which is what people do in a hurry.
   */
  sideRow(win, rule, index, rules) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const row = el("div", "hmail-flow-side-row" +
                   (rule.id === this.selected ? " selected" : ""));

    const on = el("input", "hmail-flow-side-toggle");
    on.type = "checkbox";
    on.checked = !!rule.on;
    on.title = "Bật quy tắc này";
    on.addEventListener("click", event => event.stopPropagation());
    on.addEventListener("change", () => {
      rule.on = on.checked;
      rules[index] = rule;
      hMailFlow.saveRules(rules);
      row.classList.toggle("off", !rule.on);
    });

    const text = el("div", "hmail-flow-side-text");
    text.append(
      el("div", "hmail-flow-side-name", rule.name || "(chưa đặt tên)"),
      el("div", "hmail-flow-side-note", this.summarise(rule)));

    row.append(on, text);
    row.classList.toggle("off", !rule.on);
    row.addEventListener("click", () => {
      this.selected = rule.id;
      this.refresh(win);
    });
    return row;
  },

  /** The rule in one line, for the sidebar. */
  summarise(rule) {
    const when = [];
    if (rule.from) {
      when.push(`từ ${rule.from}`);
    }
    if (rule.subject) {
      when.push(`tiêu đề "${rule.subject}"`);
    }
    if (rule.hasAttachment) {
      when.push("có đính kèm");
    }
    if (rule.serverSpam) {
      when.push("máy chủ báo rác");
    }
    if (rule.ask) {
      when.push("có hỏi AI");
    }

    const then = [];
    if (rule.moveTo) {
      then.push("chuyển thư mục");
    }
    if (rule.tag) {
      then.push("gắn nhãn");
    }
    if (rule.markRead) {
      then.push("đánh dấu đã đọc");
    }
    if (rule.flag) {
      then.push("gắn cờ");
    }
    if (rule.summarize) {
      then.push("tóm tắt");
    }
    if (rule.reply) {
      then.push(rule.send ? "gửi trả lời" : "soạn nháp");
    }

    if (!when.length && !then.length) {
      return "chưa cấu hình";
    }
    return `${when.join(", ") || "mọi thư"} → ${then.join(", ") || "chưa có hành động"}`;
  },

  card(win, rule, index, rules) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-flow-rule");

    const save = () => {
      rules[index] = rule;
      hMailFlow.saveRules(rules);
    };

    // --- head -------------------------------------------------------------
    const head = el("div", "hmail-flow-head");
    const name = el("input", "hmail-ai-field hmail-flow-name");
    name.value = rule.name || "";
    name.placeholder = "Tên quy tắc";
    name.addEventListener("change", () => {
      rule.name = name.value;
      save();
      this.refresh(win);
    });
    const remove = el("button", "hmail-warning-action", "Xoá");
    remove.addEventListener("click", () => {
      if (Services.prompt.confirm(win, "Tự động hoá AI",
            `Xoá quy tắc "${rule.name}"?`)) {
        rules.splice(index, 1);
        hMailFlow.saveRules(rules);
        this.selected = null;
        this.refresh(win);
      }
    });
    head.append(name, remove);
    box.appendChild(head);

    // --- when -------------------------------------------------------------
    box.appendChild(el("div", "hmail-flow-part", "Khi thư đến…"));

    const text = (label, key, placeholder) => {
      const row = el("div", "hmail-ai-row");
      row.append(el("span", "hmail-flow-label", label));
      const field = el("input", "hmail-ai-field");
      field.value = rule[key] || "";
      field.placeholder = placeholder;
      field.addEventListener("change", () => {
        rule[key] = field.value.trim();
        save();
      });
      row.appendChild(field);
      box.appendChild(row);
      return field;
    };
    text("Người gửi chứa", "from", "ví dụ: @domain.com");
    text("Tiêu đề chứa", "subject", "ví dụ: hóa đơn");

    const check = (label, key, note) => {
      const wrap = el("label", "hmail-flow-check");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !!rule[key];
      input.addEventListener("change", () => {
        rule[key] = input.checked;
        save();
      });
      wrap.append(input, el("span", null, label));
      box.appendChild(wrap);
      if (note) {
        box.appendChild(el("div", "hmail-ai-hint", note));
      }
      return input;
    };
    check("Có tệp đính kèm", "hasAttachment");
    check("Máy chủ đánh dấu là thư rác hoặc mã độc", "serverSpam");

    // Điều kiện tuổi — để dọn dẹp thư cũ.
    const ageRow = el("div", "hmail-ai-row");
    ageRow.append(el("span", "hmail-flow-label", "Chỉ thư cũ hơn"));
    const age = el("input", "hmail-ai-field");
    age.type = "number";
    age.min = "0";
    age.style.maxWidth = "90px";
    age.value = rule.olderThanDays || 0;
    age.addEventListener("change", () => {
      rule.olderThanDays = Math.max(0, parseInt(age.value, 10) || 0);
      save();
    });
    ageRow.append(age, el("span", "hmail-flow-label",
      "ngày (0 = không lọc theo tuổi)"));
    box.appendChild(ageRow);

    box.appendChild(el("div", "hmail-flow-part", "…và AI trả lời “có” cho:"));
    const ask = el("textarea", "hmail-ai-field");
    ask.rows = 2;
    ask.value = rule.ask || "";
    ask.placeholder =
      "Ví dụ: Đây có phải thư báo giá từ nhà cung cấp không?";
    ask.addEventListener("change", () => {
      rule.ask = ask.value.trim();
      save();
    });
    box.appendChild(ask);
    box.appendChild(el("div", "hmail-ai-hint",
      "Để trống nếu không cần AI đọc — quy tắc sẽ chạy hoàn toàn miễn phí. " +
      "Câu hỏi chỉ nên trả lời được bằng có hoặc không."));

    // --- then -------------------------------------------------------------
    box.appendChild(el("div", "hmail-flow-part", "…thì làm:"));

    const moveRow = el("div", "hmail-ai-row");
    moveRow.append(el("span", "hmail-flow-label", "Chuyển vào"));
    const move = el("select", "hmail-ai-field");
    const none = el("option", null, "— không chuyển —");
    none.value = "";
    move.appendChild(none);
    for (const folder of this.folders()) {
      const opt = el("option", null, folder.label);
      opt.value = folder.uri;
      move.appendChild(opt);
    }
    move.value = rule.moveTo || "";
    move.addEventListener("change", () => {
      rule.moveTo = move.value;
      save();
    });
    moveRow.appendChild(move);
    box.appendChild(moveRow);

    const tagRow = el("div", "hmail-ai-row");
    tagRow.append(el("span", "hmail-flow-label", "Gắn nhãn"));
    const tag = el("select", "hmail-ai-field");
    const noTag = el("option", null, "— không gắn —");
    noTag.value = "";
    tag.appendChild(noTag);
    try {
      for (const t of MailServices.tags.getAllTags()) {
        const opt = el("option", null, t.tag);
        opt.value = t.key;
        tag.appendChild(opt);
      }
    } catch (e) {}
    tag.value = rule.tag || "";
    tag.addEventListener("change", () => {
      rule.tag = tag.value;
      save();
    });
    tagRow.appendChild(tag);
    box.appendChild(tagRow);

    check("Đánh dấu đã đọc", "markRead");
    check("Gắn cờ theo dõi", "flag");
    check("Nhờ AI tóm tắt và lưu vào thư", "summarize",
          "Bản tóm tắt nằm sẵn trong thư khi bạn mở ra, không hiện lên giữa " +
          "lúc bạn đang làm việc khác.");

    // Dọn dẹp thư cũ.
    const cleanRow = el("div", "hmail-ai-row");
    cleanRow.append(el("span", "hmail-flow-label", "Dọn dẹp"));
    const clean = el("select", "hmail-ai-field");
    for (const [val, lbl] of [
      ["", "— không dọn —"],
      ["trash", "Chuyển vào Thùng rác"],
      ["archive", "Lưu trữ (chuyển vào Archive)"],
      ["ai", "Để AI quyết định (xóa / lưu / giữ)"],
    ]) {
      const opt = el("option", null, lbl);
      opt.value = val;
      clean.appendChild(opt);
    }
    clean.value = rule.cleanup || "";
    clean.addEventListener("change", () => {
      rule.cleanup = clean.value;
      save();
    });
    cleanRow.appendChild(clean);
    box.appendChild(cleanRow);
    box.appendChild(el("div", "hmail-ai-hint",
      "Đặt “Chỉ thư cũ hơn … ngày” rồi bấm “Chạy trên thư mục” để dọn hộp thư. " +
      "Thùng rác vẫn khôi phục được. Muốn chuyển vào thư mục tự chọn thì dùng ô " +
      "“Chuyển vào” ở trên (không cần Dọn dẹp)."));

    box.appendChild(el("div", "hmail-flow-part", "Trả lời tự động"));
    const reply = el("textarea", "hmail-ai-field");
    reply.rows = 2;
    reply.value = rule.reply || "";
    reply.placeholder =
      "Để trống nếu không trả lời. Ví dụ: Viết thư xác nhận đã nhận được " +
      "yêu cầu và sẽ phản hồi trong 24 giờ.";
    reply.addEventListener("change", () => {
      rule.reply = reply.value.trim();
      save();
    });
    box.appendChild(reply);

    const sendWrap = el("label", "hmail-flow-check danger");
    const send = el("input");
    send.type = "checkbox";
    send.checked = !!rule.send;
    send.addEventListener("change", () => {
      if (send.checked && !Services.prompt.confirm(win, "Trả lời tự động",
            "Thư trả lời sẽ được GỬI ĐI ngay, không ai đọc lại trước.\n\n" +
            "Một câu trả lời máy viết nhân danh bạn có thể hứa điều bạn " +
            "không định hứa, hoặc trả lời cả những thư giả mạo. Bạn chắc " +
            "chắn chứ?")) {
        send.checked = false;
        return;
      }
      rule.send = send.checked;
      save();
    });
    sendWrap.append(send,
      el("span", null, "Gửi luôn thay vì chỉ lưu vào Thư nháp"));
    box.appendChild(sendWrap);
    box.appendChild(el("div", "hmail-ai-hint",
      "Mặc định hMail chỉ soạn sẵn thư và để trong Thư nháp. Máy trả lời " +
      "thư nhân danh bạn mà không ai đọc lại là một chuyện khác hẳn với " +
      "máy sắp xếp thư."));

    return box;
  },

  folders() {
    const list = [];
    const walk = (folder, depth) => {
      try {
        if (folder.canFileMessages) {
          list.push({
            uri: folder.URI,
            label: `${"— ".repeat(depth)}${folder.prettyName}`,
          });
        }
        for (const child of folder.subFolders) {
          walk(child, depth + 1);
        }
      } catch (e) {}
    };
    for (const server of MailServices.accounts.allServers) {
      try {
        for (const child of server.rootFolder.subFolders) {
          walk(child, 0);
        }
      } catch (e) {}
    }
    return list;
  },

  // ------------------------------------------------------- chạy hàng loạt

  say(win, text) {
    const node = win.document.getElementById("hmail-flow-run-status");
    if (node) {
      node.textContent = text;
    }
  },

  /**
   * Two confirmations, and they are not the same question twice.
   *
   * The first says what will be touched and what it will cost. The second
   * says what will be done to the mail, in the plainest words available,
   * because "chuyển 3.400 thư vào Archive" is the sentence someone needs to
   * read before it happens rather than after.
   */
  async startRun(win) {
    const doc = win.document;
    const ruleId = doc.getElementById("hmail-flow-run-rule")?.value;
    const folderUri = doc.getElementById("hmail-flow-run-folder")?.value;
    const rule = hMailFlow.rules().find(r => r.id === ruleId);
    const folder = folderUri
      ? MailServices.folderLookup.getFolderForURL(folderUri) : null;
    if (!rule || !folder) {
      this.say(win, "Hãy chọn quy tắc và thư mục.");
      return;
    }

    const count = folder.getTotalMessages(false);
    const estimate = hMailFlow.estimate(count);
    const cap = hMailFlow.budget();

    const first = Services.prompt.confirmEx(
      win, "Chạy quy tắc trên thư mục",
      `Thư mục "${folder.prettyName}" có ${count.toLocaleString("vi-VN")} ` +
      `thư.

` +
      (rule.ask
        ? `hMail sẽ hỏi AI về những thư qua được phần so khớp, gộp ` +
          `${hMailFlow.BATCH_SIZE} thư mỗi lượt gọi.
` +
          `Ước tính tối đa: khoảng ${estimate.usd.toFixed(2)} USD ` +
          `(${estimate.batches.toLocaleString("vi-VN")} lượt gọi).
` +
          `Mức trần đang đặt: ${cap} USD — chạm tới là dừng.

`
        : "Quy tắc này không hỏi AI nên không tốn phí.\n") +
      "Đây là ước tính, không phải giá chốt. Số thực tế phụ thuộc độ dài " +
      "từng thư.",
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
      "Tiếp tục", "Huỷ", null, null, {});
    if (first !== 0) {
      return;
    }

    const willDo = [];
    if (rule.moveTo) {
      const target = MailServices.folderLookup.getFolderForURL(rule.moveTo);
      willDo.push(`chuyển vào "${target?.prettyName || rule.moveTo}"`);
    }
    if (rule.tag) {
      willDo.push("gắn nhãn");
    }
    if (rule.markRead) {
      willDo.push("đánh dấu đã đọc");
    }
    if (rule.flag) {
      willDo.push("gắn cờ");
    }
    if (rule.summarize) {
      willDo.push("tóm tắt bằng AI");
    }
    if (rule.reply) {
      willDo.push(rule.send ? "GỬI thư trả lời tự động"
                            : "soạn sẵn thư trả lời vào Thư nháp");
    }
    if (rule.cleanup === "trash") {
      willDo.push("CHUYỂN VÀO THÙNG RÁC");
    } else if (rule.cleanup === "archive") {
      willDo.push("lưu trữ (chuyển vào Archive)");
    } else if (rule.cleanup === "ai") {
      willDo.push("để AI quyết định xóa / lưu trữ / giữ");
    }

    const second = Services.prompt.confirmEx(
      win, "Xác nhận lần cuối",
      `Với mỗi thư khớp quy tắc "${rule.name}", hMail sẽ:

` +
      (willDo.length ? "  • " + willDo.join("• ")
                     : "  • (chưa chọn hành động nào)") +
      "\nViệc này không hoàn tác được hàng loạt. Thư mà AI không đủ chắc " +
      "chắn sẽ KHÔNG bị đụng tới — chúng vào danh sách chờ bạn duyệt.",
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
      "Tôi hiểu, chạy đi", "Quay lại", null, null, {});
    if (second !== 0) {
      return;
    }

    this.stopping = false;
    hMailBusy.start("flow-run", `Chạy quy tắc "${rule.name}"`,
                    "Thư đã xử lý giữ nguyên; phần còn lại chưa được xét.");
    hMailBusy.onStop("flow-run", () => {
      this.stopping = true;
    });
    doc.getElementById("hmail-flow-run").hidden = true;
    doc.getElementById("hmail-flow-run-stop").hidden = false;
    const bar = doc.getElementById("hmail-flow-run-bar");
    const fill = bar.firstChild;
    bar.hidden = false;

    try {
      const result = await hMailFlow.runFolder(win, folder, rule, {
        onProgress: (done, total, spent) => {
          fill.style.width = `${total ? (done / total) * 100 : 0}%`;
          this.say(win,
            `${done.toLocaleString("vi-VN")}/${total.toLocaleString("vi-VN")}` +
            ` — đã tiêu ≈ $${spent.toFixed(4)} / ${cap} USD`);
        },
        shouldStop: () => this.stopping,
      });

      this.pending = (this.pending || []).concat(
        result.review.map(r => ({ ...r, rule })));
      if (result.review.length) {
        // Land where the outcome is, not where the button was.
        this.selected = "review";
      }
      this.say(win,
        `Xong. Đã xử lý ${result.acted.length.toLocaleString("vi-VN")} thư, ` +
        `${result.review.length.toLocaleString("vi-VN")} thư chờ bạn duyệt, ` +
        `tiêu ≈ $${result.spent.toFixed(4)}` +
        (result.stoppedFor ? ` — dừng vì ${result.stoppedFor}.` : "."));
    } catch (e) {
      this.say(win, "Lỗi: " + (e.message || e));
    } finally {
      hMailBusy.end("flow-run");
      bar.hidden = true;
      doc.getElementById("hmail-flow-run").hidden = false;
      doc.getElementById("hmail-flow-run-stop").hidden = true;
      this.refresh(win);
    }
  },

  /**
   * The messages the model flagged but was not sure about. Nothing has been
   * done to them; each row offers the action and a way to dismiss it.
   */
  paintReview(win) {
    const doc = win.document;
    const box = doc.getElementById("hmail-flow-review");
    if (!box) {
      return;
    }
    box.textContent = "";
    const items = this.pending || [];
    if (!items.length) {
      box.appendChild(this.el(doc, "div", "hmail-ai-hint",
        "Không có thư nào đang chờ."));
      return;
    }

    for (const [index, item] of items.entries()) {
      const row = this.el(doc, "div", "hmail-flow-review-row");
      row.append(
        this.el(doc, "span", "hmail-flow-review-conf",
                `${Math.round((item.confidence || 0) * 100)}%`),
        this.el(doc, "span", "hmail-flow-review-from", item.from),
        this.el(doc, "span", "hmail-flow-review-subject", item.subject),
        this.el(doc, "span", "hmail-flow-review-why", item.why));

      const actions = this.el(doc, "div", "hmail-warning-group");
      const yes = this.el(doc, "button", "hmail-warning-action", "Áp dụng");
      yes.addEventListener("click", async () => {
        await hMailFlow.apply(item.hdr, item.rule);
        this.pending.splice(index, 1);
        this.refresh(win);
      });
      const no = this.el(doc, "button", "hmail-warning-action", "Bỏ qua");
      no.addEventListener("click", () => {
        this.pending.splice(index, 1);
        this.refresh(win);
      });
      actions.append(yes, no);
      row.appendChild(actions);
      box.appendChild(row);
    }
  },

  paintLog(win) {
    const doc = win.document;
    const box = doc.getElementById("hmail-flow-log");
    if (!box) {
      return;
    }
    hMailFlow.loadLog();
    box.textContent = "";
    const entries = hMailFlow.log || [];
    if (!entries.length) {
      box.appendChild(this.el(doc, "div", "hmail-ai-hint",
        "Chưa có hành động nào được ghi."));
      return;
    }
    for (const entry of entries.slice(0, 60)) {
      const row = this.el(doc, "div", "hmail-flow-log-row");
      row.append(
        this.el(doc, "span", "hmail-flow-log-time",
                new Date(entry.at).toLocaleString("vi-VN")),
        this.el(doc, "span", "hmail-flow-log-rule", entry.rule),
        this.el(doc, "span", "hmail-flow-log-subject",
                entry.subject || entry.from),
        this.el(doc, "span", "hmail-flow-log-what", entry.what));
      box.appendChild(row);
    }
  },
};
