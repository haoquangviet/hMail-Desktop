/* hMail Desktop — AI assistant, panel and automation
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
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
    // Which service this exchange went to. The counters are already kept per
    // service, but this line never said which one, so a number from Gemini
    // and a number from the on-device model read as one running total.
    const who = this.serviceDef().label;
    const value = this.cost(u);
    return value > 0 ? `${who} · ${detail} · ≈ $${value.toFixed(4)}`
                     : `${who} · ${detail} · miễn phí`;
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
      // The sidebar records whether it was open (hmail.sidebar.open, kept
      // by show/showNode/hide), but nothing ever read it back — so the
      // panel had to be reopened by hand after every restart.
      let wasOpen = false;
      try {
        wasOpen = Services.prefs.getBoolPref("hmail.sidebar.open");
      } catch (e) {}
      if (wasOpen) {
        // Startup grace: the first seconds after launch belong to
        // Thunderbird itself — folder summaries may be rebuilding over tens
        // of thousands of messages, and opening the panel then (with its
        // message analysis) makes a busy start feel like a hang.
        win.setTimeout(() => {
          try {
            if (!win.document.getElementById(this.PANEL_ID)) {
              this.open(win);
            }
          } catch (e) {
            Cu.reportError("hMail AI reopen failed: " + e);
          }
        }, 8000);
      }
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

    const log = el("div", "hmail-ai-log");
    log.id = "hmail-ai-log";
    root.appendChild(log);

    // The old top bar (sample-command dropdown + Chạy + ⚙) sat above a log
    // that could be empty, reading as a dead header. Both now live behind
    // the "+" button next to the composer, Gemini-style, and this line is
    // the only thing left above the ask box.
    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-ai-status";
    root.appendChild(status);

    // Ask box ------------------------------------------------------------
    // Text area and send button share one rounded surface, and the box grows
    // with what is typed up to a few lines before it starts scrolling.
    const ask = el("div", "hmail-ai-ask");
    const composer = el("div", "hmail-ai-composer");

    const plusBtn = el("button", "hmail-ai-plus");
    plusBtn.type = "button";
    plusBtn.title = "Câu lệnh mẫu và cài đặt";
    plusBtn.setAttribute("aria-haspopup", "true");
    plusBtn.setAttribute("aria-expanded", "false");
    plusBtn.appendChild(this.plusIcon(doc));
    plusBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.togglePromptMenu(win, plusBtn);
    });

    const input = el("textarea", "hmail-ai-input");
    input.id = "hmail-ai-input";
    input.rows = 1;
    input.placeholder = "Nhấp ＋ để chọn hoặc nhập để hỏi…";

    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    };
    const submit = () => {
      this.send(win, input.value);
      win.setTimeout(grow, 0);
    };

    input.addEventListener("input", () => {
      grow();
      // The composer being empty is one of the two conditions that lets a
      // deferred panel refresh through — see watchMessageDisplay.
      if (!input.value.trim()) {
        this.flushPendingRestore(win);
      }
    });
    input.addEventListener("keydown", e => {
      // A Vietnamese input method uses Enter to commit the syllable it is
      // still composing ("thuwr" -> "thử"). Taking that Enter away sends the
      // half-typed text and drops the raw keystrokes into the message, so
      // composition always wins: isComposing covers the standard event, and
      // keyCode 229 the platforms that only report it there.
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
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

    composer.append(plusBtn, input, sendBtn);
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

  /** The "+" on the composer's sample-commands / settings menu button. */
  plusIcon(doc) {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "17");
    svg.setAttribute("height", "17");
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", "M12 5.5v13M5.5 12h13");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    return svg;
  },

  /**
   * The Gemini-style popup that used to be a permanent bar above the log:
   * one row per sample prompt, then a separator, then settings. It opens
   * above the "+" button so it never fights the composer for space, and
   * closes itself on outside click, Escape, or a picked action.
   */
  togglePromptMenu(win, anchor) {
    const doc = win.document;
    if (doc.getElementById("hmail-ai-menu")) {
      this.closePromptMenu(win);
      return;
    }
    this.openPromptMenu(win, anchor);
  },

  openPromptMenu(win, anchor) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const container = anchor.closest(".hmail-ai-ask");
    if (!container) {
      return;
    }

    const menu = el("div", "hmail-ai-menu");
    menu.id = "hmail-ai-menu";
    menu.setAttribute("role", "menu");

    const item = (icon, label, run) => {
      const b = el("button", "hmail-ai-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(el("span", "hmail-ai-menu-icon", icon),
               el("span", "hmail-ai-menu-label", label));
      b.addEventListener("click", () => {
        this.closePromptMenu(win);
        run();
      });
      menu.appendChild(b);
      return b;
    };

    for (const p of this.prompts()) {
      item("✦", p.label, () => this.runPrompt(win, p.id));
    }

    // Vietnamese and English have their fixed rows above; every other
    // target hides behind one picker. The last pick earns its own row, so
    // a person who always translates to Japanese clicks once, not twice.
    const languages = win.hMailTranslate?.LANGUAGES || [];
    const remembered = this.pref("hmail.ai.translateLang", "");
    if (remembered && !["vi", "en"].includes(remembered)) {
      const known = languages.find(l => l.id === remembered);
      if (known) {
        item("🌐", `Dịch sang ${known.label}`,
             () => win.hMailTranslate?.run(win, known.id));
      }
    }
    if (languages.length) {
      item("🌐", "Dịch sang ngôn ngữ khác…", () => {
        const selected = {};
        const ok = Services.prompt.select(
          win, "Dịch thư", "Dịch thư này sang:",
          languages.map(l => l.label), selected);
        if (!ok) {
          return;
        }
        const lang = languages[selected.value];
        try {
          Services.prefs.setCharPref("hmail.ai.translateLang", lang.id);
        } catch (e) {}
        win.hMailTranslate?.run(win, lang.id);
      });
    }

    menu.appendChild(el("div", "hmail-ai-menu-sep"));
    item("⚙", "Cài đặt trợ lý…", () => this.showSettings(win));

    container.appendChild(menu);
    anchor.setAttribute("aria-expanded", "true");

    const onKeyDown = e => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePromptMenu(win);
        anchor.focus();
      }
    };
    const onPointerDown = e => {
      // anchor.contains, not e.target !== anchor: the button's label is an
      // SVG, so a click on the button lands on the SVG node — comparing
      // against the button itself would close the menu here and let the
      // button's own click handler reopen it, and "+" would never toggle off.
      if (!menu.contains(e.target) && !anchor.contains(e.target)) {
        this.closePromptMenu(win);
      }
    };
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("mousedown", onPointerDown, true);
    this._menuCleanup = () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("mousedown", onPointerDown, true);
    };

    menu.querySelector(".hmail-ai-menu-item")?.focus();
  },

  closePromptMenu(win) {
    const doc = win.document;
    doc.getElementById("hmail-ai-menu")?.remove();
    doc.querySelector(".hmail-ai-plus")?.setAttribute("aria-expanded", "false");
    this._menuCleanup?.();
    this._menuCleanup = null;
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
    this.thinking(win, busy ? text : null);
  },

  /**
   * "Đang suy nghĩ…" belongs at the end of the conversation, where the answer
   * is going to appear, not on a status line above it. Above the log it sits
   * off the top of a long conversation and the reader cannot tell whether
   * anything is happening at all — which with a model that takes half a
   * minute is the one thing they need to know.
   *
   * @param {?string} text  the message, or null to take the bubble away.
   */
  thinking(win, text) {
    const doc = win.document;
    const log = doc.getElementById("hmail-ai-log");
    if (!log) {
      return;
    }
    const existing = doc.getElementById("hmail-ai-thinking");
    if (!text) {
      existing?.remove();
      return;
    }
    const bubble = existing || (() => {
      const node = this.el(doc, "div", "hmail-ai-turn assistant thinking");
      node.id = "hmail-ai-thinking";
      node.append(
        this.el(doc, "div", "hmail-ai-role", "Trợ lý"),
        this.el(doc, "div", "hmail-ai-thinking-body"));
      log.appendChild(node);
      return node;
    })();
    // Always last: an answer arriving in between would otherwise leave the
    // indicator stranded in the middle of the conversation.
    if (bubble.nextSibling) {
      log.appendChild(bubble);
    }
    const body = bubble.querySelector(".hmail-ai-thinking-body");
    body.textContent = "";
    const dots = this.el(doc, "span", "hmail-ai-thinking-dots");
    dots.append(
      this.el(doc, "span", "hmail-ai-thinking-dot"),
      this.el(doc, "span", "hmail-ai-thinking-dot"),
      this.el(doc, "span", "hmail-ai-thinking-dot"));
    body.append(dots, this.el(doc, "span", "hmail-ai-thinking-text", text));
    this.scrollToEnd(win, log);
  },

  /**
   * Cuộn log xuống đáy. Gọi cả ngay lập tức lẫn sau khi trình duyệt layout xong
   * (requestAnimationFrame) vì scrollHeight đọc ngay sau appendChild thường vẫn là
   * giá trị CŨ (chưa reflow) nên không cuộn hết -> cảm giác "không tự cuộn xuống".
   */
  scrollToEnd(win, log) {
    if (!log) return;
    const go = () => { log.scrollTop = log.scrollHeight; };
    go();
    try { win.requestAnimationFrame(go); } catch (e) { try { win.setTimeout(go, 0); } catch (e2) {} }
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

    const contacts = (result.contacts && result.contacts.length)
      ? result.contacts
      : (result.contact ? [result.contact] : []);
    contacts.forEach((c, i) => {
      const block = this.contactBlock(win, doc, c, i === 0);
      if (block) {
        card.appendChild(block);
      }
    });

    log.insertBefore(card, log.firstChild);
  },

  /**
   * The company and contact details found in the sign-off, with an offer to
   * file them. Nothing is written to the address book without a click: the
   * details are read out first so the user can see exactly what would be
   * saved.
   */
  contactBlock(win, doc, contact, showHead = true) {
    if (!contact) {
      return null;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-ai-contact");

    if (showHead) {
      box.appendChild(el("div", "hmail-ai-contact-head", "Liên hệ trong thư"));
    }

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

  addTurn(win, role, text, serviceId = null) {
    const doc = win.document;
    const log = doc.getElementById("hmail-ai-log");
    if (!log) {
      return null;
    }
    const turn = this.el(doc, "div", `hmail-ai-turn ${role}`);
    const label = { assistant: "Trợ lý", user: "Bạn", action: "Hành động" };

    const head = this.el(doc, "div", "hmail-ai-role", label[role] || role);
    // Say who answered. With several providers configured, and a
    // conversation that can move between them, "Trợ lý" alone does not tell
    // the reader whose words these are — which matters when one of them runs
    // on this machine and another sends the mail abroad.
    if (role === "assistant") {
      const def = this.serviceDef(serviceId || this.service());
      const badge = this.el(doc, "span", "hmail-ai-by");
      badge.dataset.service = def.id;
      badge.append(this.el(doc, "span", "hmail-ai-by-dot"),
                   this.el(doc, "span", "hmail-ai-by-name", def.label));
      head.appendChild(badge);
    }

    turn.append(
      head,
      role === "assistant"
        ? this.renderMarkdown(doc, text)
        : this.el(doc, "div", "hmail-ai-text", text)
    );
    log.appendChild(turn);
    this.scrollToEnd(win, log);
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
    // A refresh only ever reaches here once watchMessageDisplay has decided
    // the composer is not busy (see flushPendingRestore), but the "+" menu
    // is not part of what gets rebuilt below, so close it explicitly rather
    // than leave it floating over a log that just changed under it.
    this.closePromptMenu(win);
    log.textContent = "";

    const hdr = this.selectedMessage(win);
    if (!hdr) {
      this.notify(win, "Chưa chọn thư nào.");
      this.showWelcome(win, log);
      return;
    }
    // What the machine can work out on its own comes first: it is instant,
    // free, and does not send the message anywhere. The model is for what
    // this cannot do.
    this.showInsight(win, hdr).catch(() => {});

    const convo = await this.conversationFor(hdr);
    for (const t of convo.turns) {
      this.addTurn(win, t.role, t.text, t.service || null);
    }
    // No idle guidance here: the line above the composer belongs to live
    // status ("Đang suy nghĩ…", usage) and the guidance lives in the input
    // placeholder — two texts stacked there covered each other.
    this.notify(win, convo.turns.length
      ? `${convo.turns.length} lượt trao đổi về thư này` : "");
  },

  /**
   * With no message open the panel used to show one line of text and nothing
   * else — a blank column beside a blank reading pane. It now says what the
   * assistant can do and offers the things that do not need a message
   * selected in the first place.
   */
  showWelcome(win, log) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const card = el("div", "hmail-ai-welcome");
    card.appendChild(el("div", "hmail-ai-welcome-head", "Trợ lý hMail"));
    card.appendChild(el("div", "hmail-ai-hint",
      "Chọn một thư ở danh sách bên trái, rồi bấm ＋ cạnh ô nhập để tóm " +
      "tắt, phân loại, rút việc cần làm, dịch hoặc soạn thư trả lời. Phần " +
      "\"Đọc nhanh tại chỗ\" chạy ngay trên máy, không tốn phí và không " +
      "gửi thư đi đâu."));

    const list = el("div", "hmail-ai-welcome-list");
    const item = (label, note, run) => {
      const b = el("button", "hmail-ai-welcome-item");
      b.append(el("span", "hmail-ai-welcome-label", label),
               el("span", "hmail-ai-welcome-note", note));
      b.addEventListener("click", () => {
        try {
          run();
        } catch (e) {
          Cu.reportError("hMail AI welcome action failed: " + e);
        }
      });
      list.appendChild(b);
    };

    item("Soạn thư mới", "Mở trình soạn thảo — trợ lý có sẵn trong đó",
         () => win.goDoCommand("cmd_newMessage"));
    item("Gửi hàng loạt", "Mỗi người một bản riêng, chạy nền",
         () => win.hMailMerge?.openTab(win));
    item("AI trên máy", "Tải mô hình về máy, không cần API key",
         () => win.hMailLocalAIUI?.openTab(win));
    item("Lọc theo máy chủ", "Xử lý thư theo kết luận bộ lọc của máy chủ",
         () => win.hMailServerFilter?.openTab(win));
    item("Cài đặt trợ lý", "Nhà cung cấp, mô hình, đơn giá, giao diện",
         () => this.showSettings(win));

    card.appendChild(list);

    const service = this.serviceDef();
    card.appendChild(el("div", "hmail-ai-hint",
      `Đang dùng: ${service.label}.`));

    log.appendChild(card);
  },

  // -------------------------------------------------------------- running

  async runPrompt(win, promptId, { silent = false } = {}) {
    // A translation belongs where the message is, not in a column beside it:
    // read in the panel, you read every sentence twice — once to find your
    // place in the original, once to read it. translate.js replaces the body
    // and keeps the result until the reader asks for it again.
    const translated = /^translate-(.+)$/.exec(promptId);
    if (translated) {
      win.hMailTranslate?.run(win, translated[1]);
      return;
    }
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
      this.reportError(win, e);
    }
  },

  /**
   * Say what went wrong, and where it can be put right. An error the reader
   * cannot act on is only half a message: "AI trên máy chưa được kích hoạt"
   * with no way through to the page that activates it wastes their time.
   */
  reportError(win, e, prefix = "Lỗi") {
    const doc = win.document;
    this.notify(win, `${prefix}: ${this.explain(e)}`);
    const log = doc.getElementById("hmail-ai-log");
    if (!log || doc.getElementById("hmail-ai-fix")) {
      return;
    }
    const fixes = {
      local_off: {
        label: "Mở trang AI trên máy…",
        run: () => win.hMailLocalAIUI?.openTab(win),
      },
      no_key: {
        label: "Mở cài đặt trợ lý…",
        run: () => this.showSettings(win),
      },
    };
    const fix = fixes[e?.code];
    if (!fix) {
      return;
    }
    const button = this.el(doc, "button", "hmail-ai-action", fix.label);
    button.id = "hmail-ai-fix";
    button.addEventListener("click", () => {
      button.remove();
      fix.run();
    });
    log.appendChild(button);
    this.scrollToEnd(win, log);
  },

  async send(win, question) {
    const text = (question || "").trim();
    if (!text) {
      return;
    }
    // A question does not have to be about a message. Refusing "xin chào"
    // because nothing is selected made the box look broken, and with an
    // on-device model there is no cost to answering anyway. Without a
    // message the conversation is kept against the panel instead.
    const hdr = this.selectedMessage(win);
    const input = win.document.getElementById("hmail-ai-input");
    if (input) {
      input.value = "";
    }
    this.addTurn(win, "user", text);
    this.notify(win, "Đang suy nghĩ…", true);

    try {
      const turns = [];
      if (hdr) {
        // Give the model the message once, then the conversation so far.
        turns.push({
          role: "user",
          text: "Đây là email đang được xem. Hãy dùng nó để trả lời các câu " +
                "hỏi tiếp theo. Bạn có thể thực hiện hành động trên thư này " +
                "(đánh dấu, gắn nhãn, gắn cờ, chuyển thư mục, lưu trữ, mở " +
                "cửa sổ trả lời) khi người dùng yêu cầu.\n\n---\n" +
                await this.messageText(hdr),
        });
        const convo = await this.conversationFor(hdr);
        for (const t of convo.turns) {
          turns.push({ role: t.role, text: t.text });
        }
      } else {
        turns.push({
          role: "user",
          text: "Bạn là trợ lý trong ứng dụng thư hMail Desktop. Trả lời " +
                "ngắn gọn bằng tiếng Việt có dấu đầy đủ, đúng chính tả; " +
                "không viết tiếng Việt không dấu.",
        });
        for (const t of this.looseTurns || []) {
          turns.push(t);
        }
      }
      turns.push({ role: "user", text });

      const reply = await this.ask(turns, {
        win,
        // Actions operate on the open message; with none open there is
        // nothing for them to act on.
        allowActions: !!hdr,
        onAction: line => this.addTurn(win, "action", line),
      });
      if (hdr) {
        await this.remember(hdr, "user", text);
        await this.remember(hdr, "assistant", reply);
      } else {
        this.looseTurns = (this.looseTurns || []).concat(
          { role: "user", text },
          { role: "assistant", text: reply }).slice(-12);
      }
      this.addTurn(win, "assistant", reply);
      this.notify(win, this.usageLine());
    } catch (e) {
      this.reportError(win, e);
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

    const keyLabel = el("label", "hmail-ai-label", "API key");
    form.appendChild(keyLabel);
    const key = el("input", "hmail-ai-field");
    key.type = "password";
    key.placeholder = "Để trống nếu dịch vụ chạy trên máy này";
    form.appendChild(key);

    // hMail AI services đăng nhập bằng chính hộp thư: chỗ của API key trở
    // thành lựa chọn "tài khoản thư nào" — mật khẩu dùng lại của hộp thư,
    // không nhập gì thêm.
    const accountLabel = el("label", "hmail-ai-label",
                            "Đăng nhập bằng tài khoản thư");
    const account = el("select", "hmail-ai-field");
    accountLabel.hidden = true;
    account.hidden = true;
    form.appendChild(accountLabel);
    form.appendChild(account);

    const hint = el("div", "hmail-ai-hint", "");
    form.appendChild(hint);

    // What changes when the provider changes. Nobody reads a wall of terms,
    // but three facts fit on screen: where the mail goes, whether hMail can
    // still act on it, and whether this service has been tried.
    const caution = el("div", "hmail-ai-caution", "");
    caution.hidden = true;
    form.appendChild(caution);

    // --- on-device model -------------------------------------------------
    // The providers above all answer in prose; the on-device model does not
    // — it turns text into vectors, which is what semantic search needs. It
    // is a different kind of thing, so it gets its own section rather than a
    // ninth entry in the provider list, where picking it would silently
    // break every prompt.
    form.appendChild(el("div", "hmail-ai-section", "AI trên máy"));
    form.appendChild(el("div", "hmail-ai-hint",
      "Hai mô hình khác nhau, cho hai việc khác nhau. Một mô hình nhúng " +
      "(all-MiniLM-L6-v2) biến thư thành dãy số để tìm theo ngữ nghĩa — nó " +
      "không viết được câu nào. Một mô hình sinh văn bản (Qwen 2.5) mới là " +
      "thứ trả lời và soạn thư. Cả hai chạy trên máy này, không cần API key, " +
      "không mất phí, thư không rời khỏi máy."));

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
      const search = Services.prefs.getBoolPref("hmail.localai.enabled", false);
      const chat = Services.prefs.getBoolPref(
        "hmail.localai.chat.enabled", false);
      const chatId = this.pref("hmail.localai.chat.model", "");
      const lines = [
        search ? "Tìm theo ngữ nghĩa: đang bật." : "Tìm theo ngữ nghĩa: chưa bật.",
        chat
          ? `Trả lời trên máy: đang bật — ${chatId.split("/").pop() || chatId}.`
          : "Trả lời trên máy: chưa bật — chọn nhà cung cấp này thì chưa có " +
            "gì trả lời được.",
      ];
      localState.textContent = lines.join(" ");
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

      const emailAuth = def.auth === "email";
      keyLabel.hidden = emailAuth;
      key.hidden = emailAuth;
      accountLabel.hidden = !emailAuth;
      account.hidden = !emailAuth;
      if (emailAuth) {
        account.textContent = "";
        const seen = new Set();
        for (const identity of MailServices.accounts.allIdentities) {
          const email = (identity.email || "").trim().toLowerCase();
          if (!email || seen.has(email)) {
            continue;
          }
          seen.add(email);
          const opt = el("option", null, email);
          opt.value = email;
          account.appendChild(opt);
        }
        const chosen = this.svcPref("account", "", id) ||
          (MailServices.accounts.defaultAccount?.defaultIdentity?.email ||
           "").trim().toLowerCase();
        if (chosen && seen.has(chosen)) {
          account.value = chosen;
        }
      }

      hint.textContent = emailAuth
        ? "Dịch vụ demo do HQV Software vận hành. Đăng nhập bằng chính tài " +
          "khoản thư của bạn (mật khẩu đã lưu trong hMail) — không cần tạo " +
          "API key. Có hạn mức dùng thử; muốn dùng lâu dài, liên hệ HQV để " +
          "đặt mua."
        : def.key
        ? "Dịch vụ này cần API key và tính phí theo lượng dùng. Với Gemini " +
          "hoặc OpenAI, nên chọn tên model có đuôi -latest hoặc -mini để " +
          "khỏi phải sửa lại khi nhà cung cấp ngừng một phiên bản."
        : "Chạy ngay trên máy này: không cần API key, không mất phí, và nội " +
          "dung thư không rời khỏi máy. Cần cài sẵn phần mềm tương ứng và " +
          "tải model về trước.";

      const notes = [];
      if (def.where) {
        notes.push(`Nội dung thư được gửi tới ${def.where}. Với thư có hóa ` +
                   "đơn, hợp đồng hay thông tin khách hàng, hãy cân nhắc " +
                   "điều này trước.");
      }
      if (def.key && def.actions === false) {
        notes.push("Dịch vụ này chỉ trả lời, không thực hiện được các hành " +
                   "động trên thư (đánh dấu, gắn nhãn, chuyển thư mục) — mô " +
                   "hình của họ gọi lệnh không đủ tin cậy để hMail giao " +
                   "quyền đó.");
      }
      if (def.key && !def.tested) {
        notes.push("hMail thử nghiệm kỹ với Google Gemini; các dịch vụ khác " +
                   "chạy theo cùng một giao thức nhưng chưa được kiểm tra " +
                   "sâu như vậy.");
      }
      caution.textContent = "";
      caution.hidden = !notes.length;
      for (const note of notes) {
        caution.appendChild(el("div", "hmail-ai-caution-line", note));
      }
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
      if (!account.hidden && account.value) {
        this.setSvcPref("account", account.value, id);
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
        this.reportError(win, e, "Kết nối lỗi");
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

  /**
   * Whether refreshing the panel right now would land on top of the user:
   * they are mid-keystroke in the composer, where DOM churn beside the
   * focused textarea can break IME composition (a Vietnamese "thuwr"
   * mid-commit lands as raw "thuwr" instead of becoming "thử" — UniKey
   * injects backspaces into whatever holds focus, and it must not waver).
   *
   * An unsent draft alone does NOT count as busy: restore() only rebuilds
   * the log, never the composer, so the draft survives a refresh untouched.
   * Treating a parked draft as busy froze the panel on the previous message
   * whenever something was left in the box.
   */
  composerBusy(win) {
    const input = win.document.getElementById("hmail-ai-input");
    return !!input && win.document.activeElement === input;
  },

  /**
   * Runs the refresh that watchMessageDisplay deferred because the composer
   * was busy, once it no longer is. Called on blur and whenever the input
   * empties out.
   */
  flushPendingRestore(win) {
    if (!this._pendingRestore || this.composerBusy(win)) {
      return;
    }
    this._pendingRestore = false;
    if (win.document.getElementById(this.PANEL_ID) && !this._settingsOpen) {
      this.restore(win);
    }
    this._runCheck?.();
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
    this._pendingRestore = false;
    // Delegated so it survives a full panel rebuild (close/open replaces
    // the input element; a listener bound to it directly would be lost).
    win.document.addEventListener("blur", e => {
      if (e.target?.id === "hmail-ai-input") {
        win.setTimeout(() => this.flushPendingRestore(win), 0);
      }
    }, true);
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
    // flushPendingRestore needs to re-run this once the composer frees up.
    this._runCheck = check;

    win.addEventListener("MsgLoaded", () => {
      if (this.composerBusy(win)) {
        this._pendingRestore = true;
        return;
      }
      check();
    });
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
        if (this.composerBusy(win)) {
          // The user is typing: leave the panel alone and catch up on blur.
          this._pendingRestore = true;
          return;
        }
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
