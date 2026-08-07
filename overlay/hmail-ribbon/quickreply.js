/* hMail Desktop — trả lời nhanh ngay dưới thư
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Most replies are one or two sentences. Opening a whole composer window for
 * "vâng, em nhận được rồi" is more ceremony than the answer deserves, so the
 * message gets a reply box of its own underneath it — type, send, done.
 *
 * Anything longer still belongs in the composer, and one button moves what
 * has been typed there without losing it. The assistant can fill the box too,
 * but nothing is ever sent without the user pressing send.
 */

"use strict";

var hMailQuickReply = {
  ID: "hmail-quickreply",

  init(win) {
    try {
      // The message pane is rebuilt for every message, so the box is put
      // back on the same tick that watches the selection.
      win.setInterval(() => this.ensure(win), 900);
    } catch (e) {
      Cu.reportError("hMail quick reply init failed: " + e);
    }
  },

  enabled() {
    try {
      return Services.prefs.getBoolPref("hmail.quickreply.enabled");
    } catch (e) {
      return true;
    }
  },

  doc(win) {
    return typeof hMailInsight !== "undefined"
      ? hMailInsight.messageDocument(win) : null;
  },

  message(win) {
    return typeof hMailInsight !== "undefined"
      ? hMailInsight.selected(win) : null;
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

  /** Diagnostics for a bar that lives in a document rebuilt per message. */
  log(text) {
    try {
      Services.console.logStringMessage("hMail quick reply: " + text);
    } catch (e) {}
  },

  ensure(win) {
    try {
      const doc = this.doc(win);
      if (!this.enabled()) {
        doc?.getElementById(this.ID + "-holder")?.remove();
        return;
      }
      if (!doc || doc.getElementById(this.ID)) {
        return;
      }
      // The bar goes at the END of #messagepanebox — the flex column that
      // really holds the message browser. (Not #singleMessage: despite what
      // aboutMessage.xhtml suggests, at runtime that box only contains the
      // header, which is why an earlier version of this bar appeared to
      // float over the message and had to reserve its space by hand. In
      // the pane's own flex column the browser simply shrinks above the
      // bar, and the end of the message is always scrollable into view.)
      const pane = doc.getElementById("messagepane");
      const host = pane?.parentNode || doc.getElementById("messagepanebox");
      if (!host || !this.message(win)) {
        return;
      }
      // A XUL vbox wrapper takes part in the box layout and gives the HTML
      // inside it a real height; an HTML child dropped straight into the
      // XUL column lays out at zero size.
      const holder = doc.createXULElement("vbox");
      holder.id = this.ID + "-holder";
      const box = this.build(win, doc);
      holder.appendChild(box);
      host.appendChild(holder);
      this.log("added, rect=" +
               JSON.stringify(box.getBoundingClientRect().toJSON()));
    } catch (e) {
      this.log("failed: " + e + "\n" + (e.stack || ""));
    }
  },

  build(win, doc) {
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-quickreply");
    box.id = this.ID;

    // Two faces. Folded (the default), all the message pane shows is a
    // small translucent badge floating in the corner, solid on hover.
    // Unfolded, the full composer sits in flow at the bottom of the pane,
    // where it cannot cover anything.
    const badge = el("button", "hmail-quickreply-badge");
    badge.type = "button";
    badge.title = "Trả lời nhanh";
    badge.appendChild(hMailAI.arrowIcon(doc));
    badge.appendChild(el("span", null, "Trả lời nhanh"));
    badge.addEventListener("click", () => this.setOpen(win, doc, true));

    const bar = el("div", "hmail-quickreply-bar");

    const row = el("div", "hmail-quickreply-row");
    const input = el("textarea", "hmail-quickreply-input");
    input.rows = 1;
    input.placeholder = "Trả lời nhanh… (Enter để gửi, Shift+Enter xuống dòng)";
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
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
      if (e.key === "Escape") {
        e.preventDefault();
        this.setOpen(win, doc, false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(win, input, false);
      }
    });

    const send = el("button", "hmail-quickreply-send");
    send.title = "Gửi trả lời (Enter)";
    send.appendChild(hMailAI.arrowIcon(doc));
    send.addEventListener("click", () => this.send(win, input, false));

    // The secondary actions used to be a row of links under the input, a
    // permanent extra line the bar had to reserve space for. They live
    // behind a "+" now, like the assistant's sample commands: the bar is
    // one line shorter and covers that much less of the message.
    const plus = el("button", "hmail-quickreply-plus");
    plus.type = "button";
    plus.title = "Trả lời tất cả, nhờ AI viết, mở soạn thảo đầy đủ";
    plus.setAttribute("aria-haspopup", "true");
    plus.setAttribute("aria-expanded", "false");
    plus.appendChild(hMailAI.plusIcon(doc));
    plus.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleMenu(win, doc, box, plus, input);
    });

    const fold = el("button", "hmail-quickreply-fold");
    fold.type = "button";
    fold.title = "Thu gọn (Esc)";
    // A drawn chevron, not a text glyph: "⌄" leans on whatever font the
    // message document picked and came out smeared and off-center there.
    fold.appendChild(this.chevronIcon(doc));
    fold.addEventListener("click", () => this.setOpen(win, doc, false));

    row.append(plus, input, send, fold);
    bar.appendChild(row);

    // Status keeps its own line but only when it has something to say —
    // .hmail-quickreply-status:empty collapses in CSS.
    const status = el("div", "hmail-quickreply-status", "");
    status.id = "hmail-quickreply-status";
    bar.appendChild(status);

    box.append(badge, bar);
    box.classList.toggle("open", !!this._open);
    hMailAI.applyLook(win, box);
    return box;
  },

  /** Chevron-down for the fold button. */
  chevronIcon(doc) {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", "M6 10l6 5 6-5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  },

  /** Unfold the composer from the badge, or fold it back down. */
  setOpen(win, doc, open) {
    this._open = !!open;
    const box = doc.getElementById(this.ID);
    if (!box) {
      return;
    }
    box.classList.toggle("open", this._open);
    if (this._open) {
      box.querySelector(".hmail-quickreply-input")?.focus();
    } else {
      this.closeMenu(doc);
    }
  },

  /** The "+" popup: one row per secondary action, opened above the bar. */
  toggleMenu(win, doc, box, anchor, input) {
    if (doc.getElementById("hmail-quickreply-menu")) {
      this.closeMenu(doc);
      return;
    }
    const el = (t, c, x) => this.el(doc, t, c, x);
    const menu = el("div", "hmail-quickreply-menu");
    menu.id = "hmail-quickreply-menu";
    menu.setAttribute("role", "menu");

    const item = (icon, label, run) => {
      const b = el("button", "hmail-quickreply-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(el("span", "hmail-quickreply-menu-icon", icon),
               el("span", "hmail-quickreply-menu-label", label));
      b.addEventListener("click", () => {
        this.closeMenu(doc);
        run();
      });
      menu.appendChild(b);
    };

    item("↩", "Trả lời tất cả", () => this.send(win, input, true));
    item("✎", "Nhờ AI viết", () => this.draft(win, input, anchor));
    item("⧉", "Mở soạn thảo đầy đủ", () => this.expand(win, input));

    box.appendChild(menu);
    anchor.setAttribute("aria-expanded", "true");

    const onKeyDown = e => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeMenu(doc);
        anchor.focus();
      }
    };
    const onPointerDown = e => {
      // anchor.contains, not a bare comparison: the button's label is an
      // SVG, so a click on the button lands on the SVG node (same lesson
      // as the assistant panel's "+").
      if (!menu.contains(e.target) && !anchor.contains(e.target)) {
        this.closeMenu(doc);
      }
    };
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("mousedown", onPointerDown, true);
    this._menuCleanup = () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("mousedown", onPointerDown, true);
    };
    menu.querySelector(".hmail-quickreply-menu-item")?.focus();
  },

  closeMenu(doc) {
    doc.getElementById("hmail-quickreply-menu")?.remove();
    doc.querySelector(".hmail-quickreply-plus")
      ?.setAttribute("aria-expanded", "false");
    this._menuCleanup?.();
    this._menuCleanup = null;
  },

  say(win, text) {
    const status = this.doc(win)?.getElementById("hmail-quickreply-status");
    if (status) {
      status.textContent = text;
    }
  },

  identityFor(hdr) {
    try {
      const account = MailServices.accounts.findAccountForServer(
        hdr.folder.server);
      return account?.defaultIdentity ||
        MailServices.accounts.defaultAccount?.defaultIdentity || null;
    } catch (e) {
      return MailServices.accounts.defaultAccount?.defaultIdentity || null;
    }
  },

  /** Let the assistant write it; the user still reads it before sending. */
  async draft(win, input, button) {
    const hdr = this.message(win);
    if (!hdr) {
      return;
    }
    // A model can take ten seconds or more. Without this the button looked
    // dead, and a second click started a second request.
    if (button?.hasAttribute("disabled")) {
      return;
    }
    button?.setAttribute("disabled", "true");
    button?.classList.add("busy");
    this.say(win, "Đang soạn…");
    try {
      const text = await hMailAI.messageText(hdr);
      const reply = await hMailAI.ask([{
        role: "user",
        text: "Soạn một thư trả lời ngắn gọn, lịch sự bằng tiếng Việt cho " +
              "email sau. Chỉ trả về nội dung thư, không thêm lời dẫn, " +
              "không thêm dòng chào ký tên.\n\n---\n" + text,
      }]);
      input.value = reply.trim();
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      this.say(win, hMailAI.usageLine());
    } catch (e) {
      this.say(win, "Lỗi: " + hMailAI.explain(e));
    } finally {
      button?.removeAttribute("disabled");
      button?.classList.remove("busy");
    }
  },

  /** Hand what has been typed to the full composer, unsent. */
  async expand(win, input) {
    const hdr = this.message(win);
    if (!hdr) {
      return;
    }
    try {
      const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);
      fields.body = this.htmlBody(input.value);
      await this.fillReply(hdr, fields, false, this.identityFor(hdr));
      params.composeFields = fields;
      params.type = Ci.nsIMsgCompType.ReplyToSender;
      params.format = Ci.nsIMsgCompFormat.HTML;
      params.originalMsgURI = hdr.folder.getUriForMsg(hdr);
      params.identity = this.identityFor(hdr);
      MailServices.compose.OpenComposeWindowWithParams(null, params);
      input.value = "";
    } catch (e) {
      this.say(win, "Không mở được cửa sổ soạn thảo: " + (e.message || e));
    }
  },

  /**
   * Fill in who the reply goes to, what it is called and what it answers.
   *
   * initCompose does not do this for us: supplying compose fields replaces
   * the ones it would have built from the original message, so a reply put
   * together this way has no recipient at all unless it is filled in here.
   */
  async fillReply(hdr, fields, replyAll, identity) {
    let replyTo = "";
    let to = "";
    let cc = "";
    try {
      const raw = await hMailInsight.raw(hdr);
      const headers = hMailInsight.headers(raw);
      replyTo = hMailInsight.first(headers, "reply-to");
      to = hMailInsight.first(headers, "to");
      cc = hMailInsight.first(headers, "cc");
    } catch (e) {}

    fields.to = replyTo || hdr.author || "";

    if (replyAll) {
      // Everyone who was on it, minus ourselves — nobody wants their own
      // reply back.
      const mine = new Set();
      for (const one of MailServices.accounts.allIdentities) {
        const email = (one.email || "").trim().toLowerCase();
        if (email) {
          mine.add(email);
        }
      }
      const target = hMailInsight.address(fields.to);
      const others = [];
      for (const value of [to, cc]) {
        for (const address of hMailInsight.addresses(value)) {
          if (!mine.has(address) && address !== target &&
              !others.includes(address)) {
            others.push(address);
          }
        }
      }
      if (others.length) {
        fields.cc = others.join(", ");
      }
    }

    const subject = hdr.mime2DecodedSubject || "";
    fields.subject = /^re:/i.test(subject.trim())
      ? subject : `Re: ${subject}`;

    // Threading, so the reply lands in the same conversation.
    if (hdr.messageId) {
      const id = `<${String(hdr.messageId).replace(/^<|>$/g, "")}>`;
      fields.references = id;
      try {
        fields.setHeader("In-Reply-To", id);
      } catch (e) {}
    }
    if (identity?.email) {
      fields.from = identity.fullName
        ? `${identity.fullName} <${identity.email}>` : identity.email;
    }
  },

  htmlBody(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r?\n/g, "<br>");
  },

  /**
   * Send the reply. Built the same way the composer builds one — same
   * identity, same threading headers — so the conversation stays intact and
   * the sent copy lands in the account's Sent folder.
   */
  async send(win, input, replyAll) {
    const text = input.value.trim();
    if (!text) {
      return;
    }
    const hdr = this.message(win);
    if (!hdr) {
      return;
    }
    const identity = this.identityFor(hdr);
    if (!identity) {
      this.say(win, "Chưa có tài khoản để gửi.");
      return;
    }

    this.say(win, "Đang gửi…");
    try {
      const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);
      fields.body = this.htmlBody(text);
      await this.fillReply(hdr, fields, replyAll, identity);
      if (!fields.to) {
        this.say(win, "Không xác định được người nhận của thư này.");
        return;
      }
      params.composeFields = fields;
      params.type = replyAll ? Ci.nsIMsgCompType.ReplyAll
                             : Ci.nsIMsgCompType.ReplyToSender;
      params.format = Ci.nsIMsgCompFormat.HTML;
      params.originalMsgURI = hdr.folder.getUriForMsg(hdr);
      params.identity = identity;

      const compose = MailServices.compose.initCompose(params);
      // Thunderbird 140: sendMsg(deliverMode, identity, accountKey,
      // msgWindow, progress) and it returns a promise.
      const accountKey = MailServices.accounts
        .findAccountForServer(hdr.folder.server)?.key || "";
      const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"]
        .createInstance(Ci.nsIMsgWindow);
      await compose.sendMsg(Ci.nsIMsgCompDeliverMode.Now, identity,
                            accountKey, msgWindow, null);

      input.value = "";
      input.style.height = "auto";
      this.say(win, "Đã gửi.");
      win.setTimeout(() => this.say(win, ""), 4000);
    } catch (e) {
      this.say(win, "Không gửi được: " + (e.message || e));
    }
  },
  /**
   * Send or save a reply that something other than the reply box composed —
   * the automation rules, for one. Shares the addressing and threading work
   * with send() so an automatic reply lands in the same conversation, with
   * the same References, as one typed by hand.
   *
   * @returns {Promise<boolean>} true if it was sent, false if it was filed
   *   as a draft.
   */
  async sendReply(win, hdr, body, { send = false, replyAll = false } = {}) {
    const identity = this.identityFor(hdr);
    if (!identity) {
      throw new Error("chưa có tài khoản để gửi");
    }
    const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
      .createInstance(Ci.nsIMsgComposeParams);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
      .createInstance(Ci.nsIMsgCompFields);
    fields.body = this.htmlBody(body);
    await this.fillReply(hdr, fields, replyAll, identity);
    if (!fields.to) {
      throw new Error("không xác định được người nhận");
    }
    params.composeFields = fields;
    params.type = replyAll ? Ci.nsIMsgCompType.ReplyAll
                           : Ci.nsIMsgCompType.ReplyToSender;
    params.format = Ci.nsIMsgCompFormat.HTML;
    params.originalMsgURI = hdr.folder.getUriForMsg(hdr);
    params.identity = identity;

    const compose = MailServices.compose.initCompose(params);
    const accountKey = MailServices.accounts
      .findAccountForServer(hdr.folder.server)?.key || "";
    const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"]
      .createInstance(Ci.nsIMsgWindow);
    // SaveAsDraft, not Now, unless the rule says otherwise: a machine
    // answering mail in someone's name without anyone reading it first is a
    // different proposition from one filing it.
    await compose.sendMsg(
      send ? Ci.nsIMsgCompDeliverMode.Now
           : Ci.nsIMsgCompDeliverMode.SaveAsDraft,
      identity, accountKey, msgWindow, null);
    return send;
  },
};
