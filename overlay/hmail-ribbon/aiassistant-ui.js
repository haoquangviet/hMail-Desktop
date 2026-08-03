/* hMail Desktop — AI assistant, panel and automation
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * The chat surface itself, plus the "run a prompt when a message is opened"
 * automation. Loaded after aiassistant.js, which holds the model, message and
 * history plumbing.
 */

"use strict";

Object.assign(hMailAI, {
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

  /**
   * What the exchange that just finished cost, shown under the prompt bar so
   * spending is visible as it happens rather than only on the bill.
   */
  usageLine() {
    const u = this.lastUsage;
    if (!u || (!u.in && !u.out)) {
      return "";
    }
    const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const detail = `${fmt(u.in + u.out)} token (${fmt(u.in)} gửi / ` +
                   `${fmt(u.out)} nhận)`;
    const value = this.cost(u);
    return value > 0 ? `${detail} · ≈ $${value.toFixed(4)}`
                     : `${detail} · miễn phí`;
  },

  /**
   * A button in the message's own action row, beside Trả lời and Chuyển tiếp.
   * The assistant is about the message being read, so it belongs where the
   * other things you do to that message are — not only on a ribbon tab that
   * may not be the one you are looking at.
   *
   * The header is rebuilt as messages load, so this runs from the same poll
   * that watches the selection and simply puts the button back when it is
   * gone.
   */
  addHeaderButton(win) {
    try {
      const doc = typeof hMailInsight !== "undefined"
        ? hMailInsight.messageDocument(win) : null;
      if (!doc || doc.getElementById("hmail-ai-header-button")) {
        return;
      }
      const bar = doc.getElementById("header-view-toolbar");
      if (!bar) {
        return;
      }
      const button = doc.createXULElement("toolbarbutton");
      button.id = "hmail-ai-header-button";
      button.className = "message-header-view-button toolbarbutton-1";
      button.setAttribute("label", "hMail AI");
      button.setAttribute("tooltiptext",
        "Mở trợ lý AI cho thư này");
      button.addEventListener("command", () => this.toggle(win));
      // Before the reply buttons would push them off; the assistant is a
      // secondary action, so it goes at the end of the row.
      bar.appendChild(button);
    } catch (e) {}
  },

  init(win) {
    try {
      this.migrateConfig();
      this.watchMessageDisplay(win);
    } catch (e) {
      Cu.reportError("hMail AI init failed: " + e);
    }
  },

  // ----------------------------------------------------------------- panel

  toggle(win) {
    const panel = win.document.getElementById("hmail-ai-sidebar");
    const mine = win.document.getElementById(this.PANEL_ID);
    if (mine && panel && !panel.hidden) {
      win.hMailSidebar.hide(win);
      return;
    }
    this.open(win);
  },

  open(win) {
    const node = this.build(win);
    win.hMailSidebar.showNode(win, node, "hMail AI");
    this.restore(win);
  },

  build(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const root = el("div", "hmail-ai");
    root.id = this.PANEL_ID;

    // Prompt bar ---------------------------------------------------------
    const bar = el("div", "hmail-ai-bar");
    const select = el("select", "hmail-ai-prompt");
    select.id = "hmail-ai-prompt";
    for (const p of this.prompts()) {
      const opt = el("option", null, p.label);
      opt.value = p.id;
      select.appendChild(opt);
    }
    const run = el("button", "hmail-ai-btn primary", "Chạy");
    run.addEventListener("click", () => this.runPrompt(win, select.value));

    const settings = el("button", "hmail-ai-btn", "⚙");
    settings.title = "Cài đặt trợ lý";
    settings.addEventListener("click", () => this.showSettings(win));

    bar.append(select, run, settings);
    root.appendChild(bar);

    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-ai-status";
    root.appendChild(status);

    const log = el("div", "hmail-ai-log");
    log.id = "hmail-ai-log";
    root.appendChild(log);

    // Ask box ------------------------------------------------------------
    // Text area and send button share one rounded surface, and the box grows
    // with what is typed up to a few lines before it starts scrolling.
    const ask = el("div", "hmail-ai-ask");
    const composer = el("div", "hmail-ai-composer");

    const input = el("textarea", "hmail-ai-input");
    input.id = "hmail-ai-input";
    input.rows = 1;
    input.placeholder = "Hỏi thêm về thư này…";

    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    };
    const submit = () => {
      this.send(win, input.value);
      win.setTimeout(grow, 0);
    };

    input.addEventListener("input", grow);
    input.addEventListener("keydown", e => {
      // Enter sends and Shift+Enter breaks the line, the way every chat box
      // now works. Ctrl+Enter keeps working for anyone already used to it.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    const sendBtn = el("button", "hmail-ai-send");
    sendBtn.title = "Gửi (Enter)";
    sendBtn.appendChild(this.arrowIcon(doc));
    sendBtn.addEventListener("click", submit);

    composer.append(input, sendBtn);
    ask.append(composer,
      el("div", "hmail-ai-tip", "Enter để gửi · Shift+Enter xuống dòng"));
    root.appendChild(ask);

    this.applyLook(win, root);
    return root;
  },

  /** The upward arrow on the send button, drawn rather than typed. */
  arrowIcon(doc) {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "17");
    svg.setAttribute("height", "17");
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", "M12 19.5V5.5M12 5.5l-6.5 6.5M12 5.5l6.5 6.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  },

  /**
   * Font size and colour are the user's choice, carried as custom properties
   * on the panel root so one assignment repaints everything inside it.
   */
  applyLook(win, root = null) {
    const panel = root || win.document.getElementById(this.PANEL_ID);
    if (!panel) {
      return;
    }
    const size = Math.min(22, Math.max(11,
      parseInt(this.pref("hmail.ai.fontSize", "14"), 10) || 14));
    panel.style.setProperty("--hmail-ai-font", `${size}px`);
    panel.style.setProperty("--hmail-ai-accent",
      this.pref("hmail.ai.accent", "#0F6CBD"));

    const theme = this.pref("hmail.ai.theme", "system");
    panel.classList.toggle("theme-light", theme === "light");
    panel.classList.toggle("theme-dark", theme === "dark");
  },

  notify(win, text, busy = false) {
    const status = win.document.getElementById("hmail-ai-status");
    if (status) {
      status.textContent = text;
    }
    const panel = win.document.getElementById(this.PANEL_ID);
    if (panel) {
      panel.classList.toggle("busy", busy);
    }
  },

  /**
   * Render the light Markdown models actually emit — headings, bold, italics,
   * inline code and bullets — as DOM nodes.
   *
   * Built node by node rather than by assigning HTML: this runs in a chrome
   * document with system privileges, and the text comes from a remote service
   * quoting attacker-controlled mail. Nothing here can inject markup.
   */
  renderMarkdown(doc, text) {
    const box = this.el(doc, "div", "hmail-ai-text");

    const inline = (target, line) => {
      // **bold** / *italic* / `code`
      const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
      let last = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        if (m.index > last) {
          target.appendChild(doc.createTextNode(line.slice(last, m.index)));
        }
        const token = m[0];
        if (token.startsWith("**")) {
          target.appendChild(this.el(doc, "b", null, token.slice(2, -2)));
        } else if (token.startsWith("`")) {
          target.appendChild(this.el(doc, "code", null, token.slice(1, -1)));
        } else {
          target.appendChild(this.el(doc, "i", null, token.slice(1, -1)));
        }
        last = pattern.lastIndex;
      }
      if (last < line.length) {
        target.appendChild(doc.createTextNode(line.slice(last)));
      }
    };

    let list = null;
    for (const raw of String(text).split("\n")) {
      const line = raw.replace(/\s+$/, "");

      const bullet = line.match(/^\s*[*-]\s+(.*)$/);
      if (bullet) {
        if (!list) {
          list = this.el(doc, "ul", "hmail-ai-list");
          box.appendChild(list);
        }
        const li = this.el(doc, "li");
        inline(li, bullet[1]);
        list.appendChild(li);
        continue;
      }
      list = null;

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const h = this.el(doc, "div", "hmail-ai-heading");
        inline(h, heading[2]);
        box.appendChild(h);
        continue;
      }

      if (!line.trim()) {
        box.appendChild(this.el(doc, "div", "hmail-ai-gap"));
        continue;
      }

      const p = this.el(doc, "div", "hmail-ai-para");
      inline(p, line);
      box.appendChild(p);
    }
    return box;
  },

  /**
   * The local reading of the message, shown above the conversation: a short
   * summary, what was found in the headers, and anything worth being careful
   * about. Costs nothing and needs no network.
   */
  async showInsight(win, hdr) {
    const doc = win.document;
    const log = doc.getElementById("hmail-ai-log");
    if (!log || typeof hMailInsight === "undefined") {
      return;
    }
    const result = await hMailInsight.analyze(hdr);
    if (doc.getElementById("hmail-ai-insight")) {
      return;
    }

    const el = (t, c, x) => this.el(doc, t, c, x);
    const card = el("div", `hmail-ai-insight ${result.level}`);
    card.id = "hmail-ai-insight";

    card.appendChild(el("div", "hmail-ai-insight-head", "Đọc nhanh tại chỗ"));

    // A bounce answers a different question from an ordinary message, so it
    // gets its own block at the top: why it came back and what to do.
    if (result.bounce) {
      const b = result.bounce;
      const box = el("div",
        `hmail-ai-bounce ${b.temporary ? "temporary" : "permanent"}`);
      box.appendChild(el("div", "hmail-ai-bounce-title", b.title));
      if (b.recipient) {
        box.appendChild(el("div", "hmail-ai-bounce-line",
                           `Không tới được: ${b.recipient}`));
      }
      box.appendChild(el("div", "hmail-ai-bounce-why", b.why));
      box.appendChild(el("div", "hmail-ai-bounce-todo", `Nên làm: ${b.todo}`));
      const codes = [b.basic || null, b.enhanced || null]
        .filter(Boolean).join(" / ");
      if (codes || b.serverSaid) {
        const detail = el("details", "hmail-ai-bounce-detail");
        detail.appendChild(el("summary", null,
          codes ? `Máy chủ báo mã ${codes}` : "Nguyên văn máy chủ"));
        detail.appendChild(el("div", "hmail-ai-bounce-raw", b.serverSaid ||
                              "(không có mô tả)"));
        box.appendChild(detail);
      }
      card.appendChild(box);
    }

    if (result.summary.length) {
      const list = el("ul", "hmail-ai-list");
      for (const line of result.summary) {
        list.appendChild(el("li", null, line));
      }
      card.appendChild(list);
    } else {
      card.appendChild(el("div", "hmail-ai-hint",
        "Thư quá ngắn để tóm tắt."));
    }

    const chips = el("div", "hmail-ai-chips");
    const chip = (label, value) => {
      if (!value || (Array.isArray(value) && !value.length)) {
        return;
      }
      chips.appendChild(el("span", "hmail-ai-chip",
        `${label}: ${Array.isArray(value) ? value.join(", ") : value}`));
    };
    chip("Ngày", result.facts.dates);
    chip("Số tiền", result.facts.amounts);
    const auth = result.facts.auth;
    if (auth && (auth.spf || auth.dkim || auth.dmarc)) {
      chip("Xác thực",
        [auth.spf && `SPF ${auth.spf}`, auth.dkim && `DKIM ${auth.dkim}`,
         auth.dmarc && `DMARC ${auth.dmarc}`].filter(Boolean).join(" · "));
    }
    if (chips.children.length) {
      card.appendChild(chips);
    }

    if (result.findings.length) {
      const list = el("ul", "hmail-ai-findings");
      for (const finding of result.findings) {
        list.appendChild(el("li", `hmail-ai-finding ${finding.level}`,
                            finding.text));
      }
      card.appendChild(list);
    }

    const contact = this.contactBlock(win, doc, result.contact);
    if (contact) {
      card.appendChild(contact);
    }

    log.insertBefore(card, log.firstChild);
  },

  /**
   * The company and contact details found in the sign-off, with an offer to
   * file them. Nothing is written to the address book without a click: the
   * details are read out first so the user can see exactly what would be
   * saved.
   */
  contactBlock(win, doc, contact) {
    if (!contact) {
      return null;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-ai-contact");

    box.appendChild(el("div", "hmail-ai-contact-head", "Liên hệ trong thư"));

    const line = (label, value) => {
      if (!value || (Array.isArray(value) && !value.length)) {
        return;
      }
      const row = el("div", "hmail-ai-contact-line");
      row.append(el("span", "hmail-ai-contact-label", label),
                 el("span", "hmail-ai-contact-value",
                    Array.isArray(value) ? value.join(" · ") : value));
      box.appendChild(row);
    };
    line("Tên", contact.name);
    line("Công ty", contact.org);
    line("Chức danh", contact.title);
    line("Email", contact.email);
    line("Điện thoại", contact.phones);
    line("Địa chỉ", contact.address);
    line("Website", contact.site);

    const known = hMailInsight.knownContact(contact.email);
    const status = el("div", "hmail-ai-contact-status",
      known ? "Địa chỉ này đã có trong danh bạ." : "");
    const actions = el("div", "hmail-ai-contact-actions");

    if (!known) {
      const books = hMailInsight.addressBooks();
      let target = books[0]?.URI || "";
      // Only ask which book when there is more than one to choose from.
      if (books.length > 1) {
        const pick = el("select", "hmail-ai-field");
        for (const book of books) {
          const opt = el("option", null, book.dirName);
          opt.value = book.URI;
          pick.appendChild(opt);
        }
        pick.value = target;
        pick.addEventListener("change", () => {
          target = pick.value;
        });
        actions.appendChild(pick);
      }

      const save = el("button", "hmail-ai-action", "Lưu vào danh bạ");
      save.addEventListener("click", () => {
        save.setAttribute("disabled", "true");
        status.textContent = hMailInsight.saveContact(contact, target);
        if (books.length > 1) {
          actions.firstChild?.setAttribute("disabled", "true");
        }
      });
      actions.appendChild(save);
    }

    box.append(actions, status);
    return box;
  },

  addTurn(win, role, text) {
    const doc = win.document;
    const log = doc.getElementById("hmail-ai-log");
    if (!log) {
      return null;
    }
    const turn = this.el(doc, "div", `hmail-ai-turn ${role}`);
    const label = { assistant: "Trợ lý", user: "Bạn", action: "Hành động" };
    turn.append(
      this.el(doc, "div", "hmail-ai-role", label[role] || role),
      role === "assistant"
        ? this.renderMarkdown(doc, text)
        : this.el(doc, "div", "hmail-ai-text", text)
    );
    log.appendChild(turn);
    log.scrollTop = log.scrollHeight;
    return turn;
  },

  /** Repaint the panel with whatever was already said about this message. */
  async restore(win) {
    const doc = win.document;
    const log = doc.getElementById("hmail-ai-log");
    if (!log) {
      return;
    }
    this._settingsOpen = false;
    log.textContent = "";

    const hdr = this.selectedMessage(win);
    if (!hdr) {
      this.notify(win, "Chưa chọn thư nào — chọn một thư để bắt đầu.");
      return;
    }
    // What the machine can work out on its own comes first: it is instant,
    // free, and does not send the message anywhere. The model is for what
    // this cannot do.
    this.showInsight(win, hdr).catch(() => {});

    const convo = await this.conversationFor(hdr);
    for (const t of convo.turns) {
      this.addTurn(win, t.role, t.text);
    }
    this.notify(win, convo.turns.length
      ? `${convo.turns.length} lượt trao đổi về thư này`
      : "Chọn một câu lệnh rồi bấm Chạy.");
  },

  // -------------------------------------------------------------- running

  async runPrompt(win, promptId, { silent = false } = {}) {
    const prompt = this.promptById(promptId);
    if (!prompt) {
      return;
    }
    const hdr = this.selectedMessage(win);
    if (!hdr) {
      if (!silent) {
        this.notify(win, "Hãy chọn một thư trước.");
      }
      return;
    }

    if (!silent) {
      this.addTurn(win, "user", prompt.label);
    }
    this.notify(win, "Đang suy nghĩ…", true);

    try {
      const text = await this.messageText(hdr);
      const turns = [{ role: "user", text: `${prompt.text}\n\n---\n${text}` }];
      const reply = await this.ask(turns);

      await this.remember(hdr, "user", prompt.label);
      await this.remember(hdr, "assistant", reply);
      this.addTurn(win, "assistant", reply);
      this.notify(win, this.usageLine());
    } catch (e) {
      this.notify(win, "Lỗi: " + this.explain(e));
    }
  },

  async send(win, question) {
    const text = (question || "").trim();
    if (!text) {
      return;
    }
    const hdr = this.selectedMessage(win);
    if (!hdr) {
      this.notify(win, "Hãy chọn một thư trước.");
      return;
    }
    const input = win.document.getElementById("hmail-ai-input");
    if (input) {
      input.value = "";
    }
    this.addTurn(win, "user", text);
    this.notify(win, "Đang suy nghĩ…", true);

    try {
      const convo = await this.conversationFor(hdr);
      const turns = [];
      // Give the model the message once, then the conversation so far.
      turns.push({
        role: "user",
        text: "Đây là email đang được xem. Hãy dùng nó để trả lời các câu " +
              "hỏi tiếp theo. Bạn có thể thực hiện hành động trên thư này " +
              "(đánh dấu, gắn nhãn, gắn cờ, chuyển thư mục, lưu trữ, mở cửa " +
              "sổ trả lời) khi người dùng yêu cầu.\n\n---\n" +
              await this.messageText(hdr),
      });
      for (const t of convo.turns) {
        turns.push({ role: t.role, text: t.text });
      }
      turns.push({ role: "user", text });

      const reply = await this.ask(turns, {
        win,
        allowActions: true,
        onAction: line => this.addTurn(win, "action", line),
      });
      await this.remember(hdr, "user", text);
      await this.remember(hdr, "assistant", reply);
      this.addTurn(win, "assistant", reply);
      this.notify(win, this.usageLine());
    } catch (e) {
      this.notify(win, "Lỗi: " + this.explain(e));
    }
  },

  // ------------------------------------------------------------ settings

  showSettings(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const log = doc.getElementById("hmail-ai-log");
    if (!log) {
      return;
    }
    log.textContent = "";

    const form = el("div", "hmail-ai-settings");

    form.appendChild(el("div", "hmail-ai-section", "Dịch vụ AI"));

    // Every service keeps its own address, model, key and prices, so the
    // fields below always show the selected service's own settings rather
    // than one shared set.
    const SERVICES = this.SERVICES;

    form.appendChild(el("label", "hmail-ai-label", "Nhà cung cấp"));
    const service = el("select", "hmail-ai-field");
    for (const s of SERVICES) {
      const opt = el("option", null, s.label);
      opt.value = s.id;
      service.appendChild(opt);
    }
    service.value = this.service();
    form.appendChild(service);

    form.appendChild(el("label", "hmail-ai-label", "Địa chỉ dịch vụ"));
    const endpoint = el("input", "hmail-ai-field");
    form.appendChild(endpoint);

    form.appendChild(el("label", "hmail-ai-label", "Mô hình"));
    const model = el("input", "hmail-ai-field");
    form.appendChild(model);

    form.appendChild(el("label", "hmail-ai-label", "API key"));
    const key = el("input", "hmail-ai-field");
    key.type = "password";
    key.placeholder = "Để trống nếu dịch vụ chạy trên máy này";
    form.appendChild(key);

    const hint = el("div", "hmail-ai-hint", "");
    form.appendChild(hint);

    // --- on-device model -------------------------------------------------
    // The providers above all answer in prose; the on-device model does not
    // — it turns text into vectors, which is what semantic search needs. It
    // is a different kind of thing, so it gets its own section rather than a
    // ninth entry in the provider list, where picking it would silently
    // break every prompt.
    form.appendChild(el("div", "hmail-ai-section", "AI trên máy"));
    form.appendChild(el("div", "hmail-ai-hint",
      "Mô hình all-MiniLM-L6-v2 chạy hoàn toàn trên máy này: không cần API " +
      "key, không mất phí, thư không rời khỏi máy. Nó dùng cho tìm kiếm theo " +
      "ngữ nghĩa chứ không trả lời bằng lời văn, nên vẫn cần một nhà cung " +
      "cấp ở trên nếu bạn muốn tóm tắt hay soạn thư."));

    const localState = el("div", "hmail-ai-hint", "");
    form.appendChild(localState);

    const localBtn = el("button", "hmail-ai-action", "Mở trang AI trên máy…");
    localBtn.addEventListener("click", () => {
      try {
        win.hMailLocalAIUI.openTab(win);
      } catch (e) {
        Cu.reportError("hMail AI: không mở được trang AI trên máy: " + e);
      }
    });
    form.appendChild(localBtn);

    try {
      const on = Services.prefs.getBoolPref("hmail.localai.enabled", false);
      const modelId = this.pref("hmail.localai.model", "");
      localState.textContent = on
        ? `Đang bật${modelId ? ` — ${modelId}` : ""}.`
        : "Chưa kích hoạt. Mở trang bên dưới để chọn và tải mô hình về.";
    } catch (e) {}

    // --- prices and spend ------------------------------------------------
    form.appendChild(el("div", "hmail-ai-section", "Chi phí"));
    form.appendChild(el("label", "hmail-ai-label",
      "Đơn giá của dịch vụ này (USD cho mỗi 1 triệu token)"));
    const priceRow = el("div", "hmail-ai-row");
    const priceIn = el("input", "hmail-ai-field");
    priceIn.title = "Token gửi đi (input)";
    const priceOut = el("input", "hmail-ai-field");
    priceOut.title = "Token nhận về (output)";
    priceRow.append(el("span", "hmail-ai-badge", "Gửi"), priceIn,
                    el("span", "hmail-ai-badge", "Nhận"), priceOut);
    form.appendChild(priceRow);

    const spend = el("div", "hmail-ai-usage");
    form.appendChild(spend);

    const money = value =>
      value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
    const number = value => String(Math.round(value)).replace(
      /\B(?=(\d{3})+(?!\d))/g, ".");

    const showSpend = () => {
      spend.textContent = "";
      const all = this.usage();
      const ids = SERVICES.map(s => s.id).filter(id => all[id]);
      if (!ids.length) {
        spend.appendChild(el("div", "hmail-ai-hint",
          "Chưa có lượt gọi nào được ghi nhận."));
        return;
      }
      let total = 0;
      for (const id of ids) {
        const u = all[id];
        const value = this.cost(u, id);
        total += value;
        const row = el("div", "hmail-ai-usage-row");
        row.append(
          el("span", "hmail-ai-usage-name", this.serviceDef(id).label),
          el("span", "hmail-ai-usage-num",
             `${number(u.calls)} lượt · ${number(u.in)} gửi / ` +
             `${number(u.out)} nhận`),
          el("span", "hmail-ai-usage-cost", money(value)));
        spend.appendChild(row);
      }
      const sum = el("div", "hmail-ai-usage-row total");
      sum.append(el("span", "hmail-ai-usage-name", "Tổng cộng"),
                 el("span", "hmail-ai-usage-num", ""),
                 el("span", "hmail-ai-usage-cost", money(total)));
      spend.appendChild(sum);
      spend.appendChild(el("div", "hmail-ai-hint",
        "Số token do chính nhà cung cấp báo về sau mỗi lượt gọi. Chi phí là " +
        "ước tính theo đơn giá ở trên — hãy đối chiếu với hoá đơn thật, vì " +
        "nhà cung cấp có thể đổi giá."));
    };

    // Fill every field from the selected service's own stored settings.
    const load = id => {
      const def = this.serviceDef(id);
      endpoint.value = this.endpoint(id);
      model.value = this.model(id);
      key.value = this.apiKey(id);
      const p = this.price(id);
      priceIn.value = String(p.in);
      priceOut.value = String(p.out);
      hint.textContent = def.key
        ? "Dịch vụ này cần API key và tính phí theo lượng dùng. Với Gemini " +
          "hoặc OpenAI, nên chọn tên model có đuôi -latest hoặc -mini để " +
          "khỏi phải sửa lại khi nhà cung cấp ngừng một phiên bản."
        : "Chạy ngay trên máy này: không cần API key, không mất phí, và nội " +
          "dung thư không rời khỏi máy. Cần cài sẵn phần mềm tương ứng và " +
          "tải model về trước.";
    };

    // Switching services saves what is on screen first, so nothing typed for
    // the previous one is lost.
    let shown = service.value;
    service.addEventListener("change", async () => {
      await store(shown);
      shown = service.value;
      load(shown);
    });
    load(shown);
    showSpend();

    form.appendChild(el("div", "hmail-ai-section", "Chạy tự động khi mở thư"));

    const auto = el("select", "hmail-ai-field");
    const none = el("option", null, "Tắt — không chạy gì");
    none.value = "";
    auto.appendChild(none);
    for (const p of this.prompts()) {
      const opt = el("option", null, p.label);
      opt.value = p.id;
      auto.appendChild(opt);
    }
    auto.value = this.pref("hmail.ai.autoPrompt", "");
    form.appendChild(auto);

    const scope = el("select", "hmail-ai-field");
    for (const [value, label] of [
      ["unread", "Chỉ thư chưa đọc"],
      ["inbox", "Chỉ thư trong Hộp thư đến"],
      ["all", "Mọi thư được mở"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      scope.appendChild(opt);
    }
    scope.value = this.pref("hmail.ai.autoScope", "unread");
    form.appendChild(scope);
    form.appendChild(el("div", "hmail-ai-hint",
      "Mỗi lần chạy tự động là một lượt gọi có tính phí tới nhà cung cấp AI, " +
      "và nội dung thư sẽ được gửi đi. Hãy chọn phạm vi hẹp nhất đủ dùng."));

    // --- appearance -----------------------------------------------------
    // Every control here previews live, so the choice is judged on the panel
    // itself rather than on a swatch.
    form.appendChild(el("div", "hmail-ai-section", "Giao diện"));

    const panelOf = () => doc.getElementById(this.PANEL_ID);

    form.appendChild(el("label", "hmail-ai-label", "Cỡ chữ"));
    const sizeRow = el("div", "hmail-ai-row");
    const size = el("input", "hmail-ai-range");
    size.type = "range";
    size.min = "11";
    size.max = "22";
    size.step = "1";
    size.value = String(
      parseInt(this.pref("hmail.ai.fontSize", "14"), 10) || 14);
    const sizeVal = el("span", "hmail-ai-badge", `${size.value} px`);
    size.addEventListener("input", () => {
      sizeVal.textContent = `${size.value} px`;
      panelOf()?.style.setProperty("--hmail-ai-font", `${size.value}px`);
    });
    sizeRow.append(size, sizeVal);
    form.appendChild(sizeRow);

    form.appendChild(el("label", "hmail-ai-label", "Màu nhấn"));
    const colorRow = el("div", "hmail-ai-row");
    const color = el("input", "hmail-ai-color");
    color.type = "color";
    color.value = this.pref("hmail.ai.accent", "#0F6CBD");
    const paint = value => {
      color.value = value;
      panelOf()?.style.setProperty("--hmail-ai-accent", value);
    };
    color.addEventListener("input", () => paint(color.value));
    colorRow.appendChild(color);
    for (const [name, value] of [
      ["Xanh Outlook", "#0F6CBD"],
      ["Xanh ngọc", "#0F7B6C"],
      ["Tím", "#6B4FBB"],
      ["Cam", "#C05621"],
      ["Xám than", "#44546F"],
    ]) {
      const dot = el("button", "hmail-ai-swatch");
      dot.title = name;
      dot.style.backgroundColor = value;
      dot.addEventListener("click", () => paint(value));
      colorRow.appendChild(dot);
    }
    form.appendChild(colorRow);

    form.appendChild(el("label", "hmail-ai-label", "Nền khung trò chuyện"));
    const theme = el("select", "hmail-ai-field");
    for (const [value, label] of [
      ["system", "Theo hệ thống"],
      ["light", "Luôn sáng"],
      ["dark", "Luôn tối"],
    ]) {
      const opt = el("option", null, label);
      opt.value = value;
      theme.appendChild(opt);
    }
    theme.value = this.pref("hmail.ai.theme", "system");
    theme.addEventListener("change", () => {
      const panel = panelOf();
      if (panel) {
        panel.classList.toggle("theme-light", theme.value === "light");
        panel.classList.toggle("theme-dark", theme.value === "dark");
      }
    });
    form.appendChild(theme);

    const actions = el("div", "hmail-ai-actions");

    /** Write what is on screen into one service's own settings. */
    const store = async id => {
      this.setSvcPref("endpoint", endpoint.value.trim(), id);
      this.setSvcPref("model", model.value.trim(), id);
      this.setSvcPref("priceIn", parseFloat(priceIn.value) || 0, id);
      this.setSvcPref("priceOut", parseFloat(priceOut.value) || 0, id);
      if (key.value.trim()) {
        await this.setApiKey(key.value.trim(), id);
      }
    };

    const apply = async () => {
      await store(service.value);
      Services.prefs.setCharPref("hmail.ai.service", service.value);
    };

    const save = el("button", "hmail-ai-btn primary", "Lưu");
    save.addEventListener("click", async () => {
      try {
        await apply();
        Services.prefs.setCharPref("hmail.ai.autoPrompt", auto.value);
        Services.prefs.setCharPref("hmail.ai.autoScope", scope.value);
        Services.prefs.setCharPref("hmail.ai.fontSize", size.value);
        Services.prefs.setCharPref("hmail.ai.accent", color.value);
        Services.prefs.setCharPref("hmail.ai.theme", theme.value);
        this.applyLook(win);
        this.notify(win, "Đã lưu cài đặt.");
        this.restore(win);
      } catch (e) {
        this.notify(win, "Không lưu được: " + (e.message || e));
      }
    });
    const back = el("button", "hmail-ai-btn", "Quay lại");
    back.addEventListener("click", () => {
      // Leaving without saving drops the live preview too.
      this.applyLook(win);
      this.restore(win);
    });

    const test = el("button", "hmail-ai-btn", "Kiểm tra kết nối");
    test.addEventListener("click", async () => {
      this.notify(win, "Đang kiểm tra…", true);
      try {
        await apply();
        const reply = await this.ask([
          { role: "user", text: "Trả lời đúng một từ: OK" },
        ]);
        this.notify(win, "Kết nối tốt — AI trả lời: " + reply.slice(0, 40));
      } catch (e) {
        this.notify(win, "Kết nối lỗi: " + this.explain(e));
      }
    });

    const reset = el("button", "hmail-ai-btn", "Xoá thống kê");
    reset.addEventListener("click", () => {
      if (Services.prompt.confirm(win, "hMail AI",
            "Xoá toàn bộ số liệu token và chi phí đã ghi nhận?")) {
        this.clearUsage();
        showSpend();
      }
    });

    actions.append(save, test, back, reset);
    form.appendChild(actions);
    log.appendChild(form);
    // The log keeps the conversation's scroll position; settings start at top.
    log.scrollTop = 0;
    this._settingsOpen = true;
  },

  // ------------------------------------------------------------ automation

  /**
   * Run the configured prompt when a message is opened. Deliberately narrow by
   * default: every run costs money and sends the message to the provider.
   */
  watchMessageDisplay(win) {
    if (this._watching) {
      return;
    }
    this._watching = true;
    this._autoDone = new Set();
    // Whether a message was unread *when it was picked*. By the time the
    // poll below notices the selection changed, Thunderbird has usually
    // marked it read already, so asking hdr.isRead then always says "read"
    // and the "chỉ thư chưa đọc" scope would never fire.
    this._wasUnread = new Map();
    this._watchSelection = () => {
      try {
        const tree = win.document.getElementById("tabmail")
          ?.currentAbout3Pane?.threadTree;
        if (!tree || tree._hmailWatched) {
          return;
        }
        tree._hmailWatched = true;
        tree.addEventListener("select", () => {
          const hdr = this.selectedMessage(win);
          if (hdr) {
            this._wasUnread.set(this.messageKey(hdr), !hdr.isRead);
          }
        }, true);
      } catch (e) {}
    };

    const check = () => {
      try {
        const promptId = this.pref("hmail.ai.autoPrompt", "");
        if (!promptId) {
          return;
        }
        const hdr = this.selectedMessage(win);
        if (!hdr) {
          return;
        }
        const key = this.messageKey(hdr);
        if (this._autoDone.has(key)) {
          return;
        }

        const scope = this.pref("hmail.ai.autoScope", "unread");
        if (scope === "unread") {
          const wasUnread = this._wasUnread.has(key)
            ? this._wasUnread.get(key) : !hdr.isRead;
          if (!wasUnread) {
            return;
          }
        }
        if (scope === "inbox") {
          const isInbox = !!(hdr.folder?.flags & Ci.nsMsgFolderFlags.Inbox);
          if (!isInbox) {
            return;
          }
        }

        this._autoDone.add(key);
        // Show the panel so the answer has somewhere to land.
        if (!win.document.getElementById(this.PANEL_ID)) {
          this.open(win);
        }
        win.setTimeout(() => this.runPrompt(win, promptId, { silent: false }), 300);
      } catch (e) {
        Cu.reportError("hMail AI auto-run failed: " + e);
      }
    };

    win.addEventListener("MsgLoaded", check);
    // MsgLoaded does not fire for every selection change in the 3-pane, so
    // also poll the selection cheaply.
    let lastKey = null;
    win.setInterval(() => {
      this._watchSelection();
      this.addHeaderButton(win);
      const hdr = this.selectedMessage(win);
      const key = hdr ? this.messageKey(hdr) : null;
      if (key !== lastKey) {
        lastKey = key;
        // Refresh an open panel to this message's conversation — but never
        // while settings are on screen, or a half-filled form would vanish
        // under the user.
        if (win.document.getElementById(this.PANEL_ID) && !this._settingsOpen) {
          this.restore(win);
        }
        check();
      }
    }, 700);
  },
});
