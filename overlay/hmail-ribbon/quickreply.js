/* hMail Desktop — trả lời nhanh ngay dưới thư
 * MIT License, Copyright (c) 2026 HQV Software
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
        if (doc) {
          doc.getElementById(this.ID + "-holder")?.remove();
          this.releaseSpace(doc);
        }
        return;
      }
      if (!doc || doc.getElementById(this.ID)) {
        this._applyReserve?.();
        return;
      }
      const host = doc.getElementById("singleMessage") ||
                   doc.getElementById("messagepane")?.parentNode;
      if (!host || !this.message(win)) {
        return;
      }
      // #singleMessage is a XUL vbox: an HTML child dropped straight into it
      // lays out at zero size. A XUL vbox wrapper takes part in the box
      // layout and gives the HTML inside it a real height.
      const holder = doc.createXULElement("vbox");
      holder.id = this.ID + "-holder";
      const box = this.build(win, doc);
      holder.appendChild(box);
      host.appendChild(holder);
      this.reserveSpace(win, doc, box);
      this.log("added, rect=" +
               JSON.stringify(box.getBoundingClientRect().toJSON()));
    } catch (e) {
      this.log("failed: " + e + "\n" + (e.stack || ""));
    }
  },

  /**
   * The bar is pinned to the bottom of the message pane, so it covers
   * whatever the message ends with. The space is given back inside the
   * message document itself — padding on its body — rather than by pushing
   * the browser element up. A margin on the browser left a strip of the
   * window showing through below the message, which is not part of the page
   * the user is reading; padding on the body is.
   */
  reserveSpace(win, doc, box) {
    const pane = doc.getElementById("messagepane");
    const attachments = doc.getElementById("attachmentView");
    // The space has to go under whatever is last in the column. Reserving it
    // under the browser alone pushed the attachment bar down behind the fixed
    // reply box, so a message with attachments looked like it had none.
    const lastVisible = () =>
      attachments && !attachments.hidden &&
      attachments.getBoundingClientRect().height > 0 ? attachments : pane;

    const apply = () => {
      try {
        const height = Math.round(box.getBoundingClientRect().height);
        if (!height) {
          return;
        }
        doc.documentElement.style.setProperty(
          "--hmail-quickreply-height", `${height}px`);

        // Whatever is last in the column is what the bar covers. With an
        // attachment bar on screen that is the attachment bar — reserving
        // inside the message document instead pushed it down behind the
        // reply box, so a message with attachments looked like it had none.
        // Set on the body directly rather than through a variable that
        // userContent.css reads: that sheet only reaches documents whose URL
        // matches its @-moz-document list, and a message can be rendered from
        // more schemes than that list will ever cover. An inline style always
        // lands.
        const body = pane?.contentDocument?.body;
        if (lastVisible() === attachments) {
          attachments.style.marginBlockEnd = `${height}px`;
          if (body) {
            body.style.paddingBottom = "";
          }
        } else {
          if (attachments) {
            attachments.style.marginBlockEnd = "";
          }
          if (body) {
            body.style.paddingBottom = `${height + 12}px`;
          }
        }
        if (pane) {
          pane.style.marginBlockEnd = "";
        }
      } catch (e) {}
    };
    apply();
    // The message document is replaced for every message, so the reserve has
    // to be written again each time it loads.
    try {
      pane?.addEventListener("load", apply, true);
    } catch (e) {}
    try {
      const observer = new win.ResizeObserver(apply);
      observer.observe(box);
      this._spaceObserver?.disconnect();
      this._spaceObserver = observer;
    } catch (e) {
      // No observer: the initial reservation still covers the common case.
    }
    this._applyReserve = apply;
  },

  /** Give the space back when the bar goes away. */
  releaseSpace(doc) {
    try {
      this._spaceObserver?.disconnect();
      this._spaceObserver = null;
      this._applyReserve = null;
      const pane = doc.getElementById("messagepane");
      const body = pane?.contentDocument?.body;
      if (body) {
        body.style.paddingBottom = "";
      }
      for (const id of ["messagepane", "attachmentView"]) {
        const node = doc.getElementById(id);
        if (node) {
          node.style.marginBlockEnd = "";
        }
      }
      doc.documentElement.style.removeProperty("--hmail-quickreply-height");
    } catch (e) {}
  },

  build(win, doc) {
    const el = (t, c, x) => this.el(doc, t, c, x);
    const box = el("div", "hmail-quickreply");
    box.id = this.ID;

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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send(win, input, false);
      }
    });

    const send = el("button", "hmail-quickreply-send");
    send.title = "Gửi trả lời (Enter)";
    send.appendChild(hMailAI.arrowIcon(doc));
    send.addEventListener("click", () => this.send(win, input, false));

    row.append(input, send);
    box.appendChild(row);

    const tools = el("div", "hmail-quickreply-tools");

    const all = el("button", "hmail-quickreply-link", "Trả lời tất cả");
    all.addEventListener("click", () => this.send(win, input, true));

    const ai = el("button", "hmail-quickreply-link", "Nhờ AI viết");
    ai.id = "hmail-quickreply-ai";
    // The spinner lives inside the button so the wait is attached to the
    // thing that started it, not to a status line somewhere else.
    ai.appendChild(el("span", "hmail-quickreply-spin"));
    ai.addEventListener("click", () => this.draft(win, input, ai));

    const full = el("button", "hmail-quickreply-link", "Mở soạn thảo đầy đủ");
    full.addEventListener("click", () => this.expand(win, input));

    const status = el("span", "hmail-quickreply-status", "");
    status.id = "hmail-quickreply-status";

    tools.append(all, ai, full, status);
    box.appendChild(tools);
    hMailAI.applyLook(win, box);
    return box;
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
};
