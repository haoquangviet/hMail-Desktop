/* hMail Desktop — the assistant inside the message composer
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Writing is where an assistant earns its place, so the composer gets the same
 * docked panel the reading window has: draft a reply, translate, tighten,
 * fix the grammar, or pick one of three quick replies — and put the result
 * into the message with one click.
 *
 * Nothing is ever sent. Text only reaches the message body when the user asks
 * for it, and the send button stays theirs.
 */

"use strict";

var hMailComposeAI = {
  PANEL_ID: "hmail-compose-ai",
  SPLITTER_ID: "hmail-compose-ai-splitter",
  WIDTH_PREF: "hmail.ai.composeWidth",
  BUTTON_ID: "hmail-compose-ai-button",

  /**
   * `scope` says what the model is given: "draft" is what the user has
   * written so far (the quoted message is stripped out), "quote" is the
   * message being replied to, "both" is both.
   */
  ACTIONS: [
    {
      id: "reply",
      label: "Soạn thư trả lời",
      scope: "both",
      prompt: "Soạn một thư trả lời lịch sự, chuyên nghiệp. Viết BẰNG ĐÚNG " +
              "NGÔN NGỮ CỦA THƯ ĐƯỢC TRẢ LỜI (thư tiếng Anh thì trả lời " +
              "tiếng Anh…), trừ khi người dùng yêu cầu ngôn ngữ khác. " +
              "Chỉ trả về nội dung thư, không thêm lời dẫn, không thêm tiêu " +
              "đề. Nếu người dùng đã viết dở thì tiếp tục ý của họ.",
    },
    {
      id: "quick",
      label: "Trả lời nhanh — 3 gợi ý",
      scope: "quote",
      quick: true,
      prompt: "Viết đúng 3 câu trả lời ngắn khác nhau cho thư này, mỗi câu " +
              "một dòng, bắt đầu bằng dấu gạch ngang. Mỗi câu tối đa 2 câu " +
              "văn, lịch sự, viết BẰNG ĐÚNG NGÔN NGỮ CỦA THƯ ĐƯỢC TRẢ LỜI. " +
              "Không giải thích gì thêm.",
    },
    {
      id: "polish",
      label: "Viết lại cho lịch sự, chuyên nghiệp",
      scope: "draft",
      prompt: "Viết lại đoạn văn sau cho lịch sự, chuyên nghiệp, giữ nguyên " +
              "ý và ngôn ngữ gốc. Chỉ trả về đoạn đã viết lại.",
    },
    {
      id: "short",
      label: "Rút gọn",
      scope: "draft",
      prompt: "Rút gọn đoạn văn sau, giữ đủ ý và giữ nguyên ngôn ngữ gốc. " +
              "Chỉ trả về đoạn đã rút gọn.",
    },
    {
      id: "spell",
      label: "Sửa chính tả và ngữ pháp",
      scope: "draft",
      prompt: "Sửa lỗi chính tả và ngữ pháp trong đoạn văn sau, giữ nguyên " +
              "ý, văn phong và ngôn ngữ gốc. Chỉ trả về đoạn đã sửa.",
    },
    {
      id: "vi",
      label: "Dịch sang tiếng Việt",
      scope: "draft",
      prompt: "Dịch đoạn văn sau sang tiếng Việt tự nhiên, giữ nguyên ý và " +
              "văn phong. Chỉ trả về bản dịch.",
    },
    {
      id: "en",
      label: "Dịch sang tiếng Anh",
      scope: "draft",
      prompt: "Translate the following into natural English, preserving " +
              "meaning and tone. Return only the translation.",
    },
  ],

  // ------------------------------------------------------------------ setup

  init(win) {
    try {
      this.addButton(win);
    } catch (e) {
      Cu.reportError("hMail compose AI init failed: " + e);
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

  addButton(win) {
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
    button.setAttribute("label", "Trợ lý AI");
    button.setAttribute("tooltiptext",
      "Trợ lý AI — soạn, dịch, viết lại thư");
    // Only one listener: a toolbarbutton fires both "click" and "command",
    // and two toggles in a row would open the panel and shut it again.
    button.addEventListener("command", () => this.toggle(win));
    toolbar.appendChild(button);
  },

  // ------------------------------------------------------------------ panel

  toggle(win) {
    const panel = win.document.getElementById(this.PANEL_ID);
    if (panel) {
      this.close(win);
    } else {
      this.open(win);
    }
  },

  close(win) {
    const doc = win.document;
    doc.getElementById(this.PANEL_ID)?.remove();
    doc.getElementById(this.SPLITTER_ID)?.remove();
  },

  open(win) {
    try {
      this.build(win);
    } catch (e) {
      Cu.reportError("hMail compose AI failed to open: " + e);
    }
  },

  build(win) {
    const doc = win.document;
    const area = doc.getElementById("messageArea");
    if (!area || doc.getElementById(this.PANEL_ID)) {
      return;
    }

    // Thunderbird's own pane-splitter handles the dragging, the same element
    // the contacts sidebar in this window uses.
    let splitter;
    try {
      splitter = doc.createElement("hr", { is: "pane-splitter" });
      splitter.setAttribute("is", "pane-splitter");
      splitter.setAttribute("resize-direction", "horizontal");
      splitter.setAttribute("resize-id", this.PANEL_ID);
    } catch (e) {
      splitter = this.el(doc, "div");
    }
    splitter.id = this.SPLITTER_ID;

    const panel = this.el(doc, "div", "hmail-ai hmail-compose-ai");
    panel.id = this.PANEL_ID;
    let width = 380;
    try {
      width = Services.prefs.getIntPref(this.WIDTH_PREF);
    } catch (e) {}
    panel.style.width = `${width}px`;

    // Header ---------------------------------------------------------------
    const header = this.el(doc, "div", "hmail-compose-ai-header");
    header.append(this.el(doc, "span", "hmail-compose-ai-title", "hMail AI"));
    const close = this.el(doc, "button", "hmail-compose-ai-close", "✕");
    close.title = "Đóng";
    close.addEventListener("click", () => this.close(win));
    header.appendChild(close);
    panel.appendChild(header);

    // What to do -----------------------------------------------------------
    const bar = this.el(doc, "div", "hmail-ai-bar");
    const picker = this.el(doc, "select", "hmail-ai-prompt");
    for (const action of this.ACTIONS) {
      const opt = this.el(doc, "option", null, action.label);
      opt.value = action.id;
      picker.appendChild(opt);
    }
    const run = this.el(doc, "button", "hmail-ai-btn primary", "Chạy");
    run.addEventListener("click", () => this.run(win, picker.value));
    bar.append(picker, run);
    panel.appendChild(bar);

    const status = this.el(doc, "div", "hmail-ai-status", "");
    status.id = "hmail-compose-ai-status";
    panel.appendChild(status);

    const out = this.el(doc, "div", "hmail-ai-log");
    out.id = "hmail-compose-ai-out";
    panel.appendChild(out);

    // Free-form instruction ------------------------------------------------
    const ask = this.el(doc, "div", "hmail-ai-ask");
    const composer = this.el(doc, "div", "hmail-ai-composer");
    const input = this.el(doc, "textarea", "hmail-ai-input");
    input.rows = 1;
    input.placeholder = "Yêu cầu khác cho thư này…";
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    const submit = () => {
      const text = input.value.trim();
      if (text) {
        input.value = "";
        grow();
        this.run(win, null, text);
      }
    };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", e => {
      // A Vietnamese input method uses Enter to commit the syllable it is
      // still composing ("thuwr" -> "thử"). Taking that Enter away sends the
      // half-typed text and drops the raw keystrokes into the message, so
      // composition always wins: isComposing covers the standard event, and
      // keyCode 229 the platforms that only report it there.
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    const send = this.el(doc, "button", "hmail-ai-send");
    send.title = "Gửi (Enter)";
    send.appendChild(hMailAI.arrowIcon(doc));
    send.addEventListener("click", submit);
    composer.append(input, send);
    ask.appendChild(composer);
    panel.appendChild(ask);

    area.append(splitter, panel);
    hMailAI.applyLook(win, panel);

    // Remember the width the user drags it to.
    const remember = () => {
      const w = Math.round(panel.getBoundingClientRect().width);
      if (w > 150) {
        try {
          Services.prefs.setIntPref(this.WIDTH_PREF, w);
        } catch (e) {}
      }
    };
    win.addEventListener("mouseup", remember);
  },

  notify(win, text, busy = false) {
    const status = win.document.getElementById("hmail-compose-ai-status");
    if (status) {
      status.textContent = text;
    }
    win.document.getElementById(this.PANEL_ID)
      ?.classList.toggle("busy", busy);
  },

  // -------------------------------------------------------------- the text

  bodyDoc(win) {
    try {
      return win.getBrowser()?.contentDocument || null;
    } catch (e) {
      return null;
    }
  },

  cap(text) {
    const max = hMailAI.pref("hmail.ai.maxChars", 12000);
    const value = String(text || "").trim();
    return value.length > max ? value.slice(0, max) + "\n…" : value;
  },

  /** What the user has written, with the quoted message taken out. */
  draftText(win) {
    const doc = this.bodyDoc(win);
    if (!doc?.body) {
      return "";
    }
    const clone = doc.body.cloneNode(true);
    for (const quote of clone.querySelectorAll("blockquote")) {
      quote.remove();
    }
    return this.cap(clone.innerText);
  },

  /** The message being replied to, if this is a reply. */
  quoteText(win) {
    const doc = this.bodyDoc(win);
    const quote = doc?.body?.querySelector("blockquote");
    return quote ? this.cap(quote.innerText) : "";
  },

  selectionText(win) {
    const doc = this.bodyDoc(win);
    const selection = doc?.getSelection();
    return selection && !selection.isCollapsed ? this.cap(String(selection))
                                               : "";
  },

  subject(win) {
    return win.document.getElementById("msgSubject")?.value || "";
  },

  /**
   * Build what the model sees. A selection always wins: acting on exactly
   * what is highlighted is what people expect from a "rewrite" command.
   */
  context(win, scope) {
    const parts = [];
    const subject = this.subject(win);
    if (subject) {
      parts.push(`Tiêu đề: ${subject}`);
    }

    const selected = this.selectionText(win);
    if (selected && scope !== "quote") {
      parts.push(`Đoạn đang chọn:\n${selected}`);
      return parts.join("\n\n");
    }

    if (scope === "draft" || scope === "both") {
      const draft = this.draftText(win);
      parts.push(draft ? `Nội dung người dùng đang viết:\n${draft}`
                       : "Người dùng chưa viết gì.");
    }
    if (scope === "quote" || scope === "both") {
      const quote = this.quoteText(win);
      if (quote) {
        parts.push(`Thư được trả lời:\n${quote}`);
      }
    }
    return parts.join("\n\n");
  },

  // --------------------------------------------------------------- running

  async run(win, actionId, freeText = "") {
    const action = actionId
      ? this.ACTIONS.find(a => a.id === actionId)
      : { id: "custom", scope: "both", prompt: freeText };
    if (!action) {
      return;
    }
    const context = this.context(win, action.scope || "both");
    if (!context) {
      this.notify(win, "Chưa có nội dung nào để xử lý.");
      return;
    }

    this.notify(win, "Đang suy nghĩ…", true);
    try {
      const reply = await hMailAI.ask([{
        role: "user",
        text: `${action.prompt}\n\n---\n${context}`,
      }]);
      this.show(win, reply, !!action.quick);
      this.notify(win, hMailAI.usageLine());
      // Đang trả lời một thư có thật: lượt soạn hộ này ghi vào lịch sử
      // hMail AI của chính thư đó — panel bên khung đọc kể lại được.
      const hdr = this.originalHdr(win);
      if (hdr) {
        hMailAI.logFeature?.(hdr,
          "Soạn thảo trong thư trả lời: " +
          (action.label || freeText || action.id), reply);
      }
    } catch (e) {
      this.notify(win, "Lỗi: " + hMailAI.explain(e));
    }
  },

  /** Thư gốc mà composer này đang trả lời/chuyển tiếp, nếu có. */
  originalHdr(win) {
    try {
      const uri = win.gMsgCompose?.originalMsgURI;
      if (!uri) {
        return null;
      }
      return MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
    } catch (e) {
      return null;
    }
  },

  /** Show the answer with the ways to put it into the message. */
  show(win, text, asChoices) {
    const doc = win.document;
    const out = doc.getElementById("hmail-compose-ai-out");
    if (!out) {
      return;
    }
    out.textContent = "";

    if (asChoices) {
      const lines = String(text).split("\n")
        .map(l => l.replace(/^\s*[-*\d.)\s]+/, "").trim())
        .filter(Boolean);
      out.appendChild(this.el(doc, "div", "hmail-ai-role",
        "Bấm một câu để chèn vào thư"));
      for (const line of lines) {
        const choice = this.el(doc, "button", "hmail-compose-ai-choice", line);
        choice.addEventListener("click", () => this.insert(win, line));
        out.appendChild(choice);
      }
      return;
    }

    const turn = this.el(doc, "div", "hmail-ai-turn assistant");
    turn.append(this.el(doc, "div", "hmail-ai-role", "Trợ lý"),
                hMailAI.renderMarkdown(doc, text));
    out.appendChild(turn);

    const row = this.el(doc, "div", "hmail-ai-actions");
    const insert = this.el(doc, "button", "hmail-ai-btn primary",
                           "Chèn vào vị trí con trỏ");
    insert.addEventListener("click", () => this.insert(win, text));
    const top = this.el(doc, "button", "hmail-ai-btn", "Chèn lên đầu thư");
    top.addEventListener("click", () => this.insert(win, text, true));
    const copy = this.el(doc, "button", "hmail-ai-btn", "Sao chép");
    copy.addEventListener("click", () => {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper).copyString(text);
      this.notify(win, "Đã sao chép.");
    });
    row.append(insert, top, copy);
    out.appendChild(row);
  },

  escape(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  /**
   * Put text into the message body. Built as escaped text with <br> for the
   * line breaks — the model's output is never treated as markup.
   */
  insert(win, text, atTop = false) {
    const doc = this.bodyDoc(win);
    if (!doc) {
      return;
    }
    try {
      win.getBrowser().focus();
      if (atTop) {
        const selection = doc.getSelection();
        const range = doc.createRange();
        range.setStart(doc.body, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const html = this.escape(text).replace(/\r?\n/g, "<br>") +
                   (atTop ? "<br><br>" : "");
      doc.execCommand("insertHTML", false, html);
      this.notify(win, "Đã chèn vào thư.");
    } catch (e) {
      this.notify(win, "Không chèn được: " + (e.message || e));
    }
  },
};
