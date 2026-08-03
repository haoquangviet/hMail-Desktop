/* hMail Desktop — quy tắc tự động có AI đọc hiểu
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Thunderbird's own filters match on strings: a sender, a word in the subject.
 * That covers "everything from the bank goes in the Bank folder" and nothing
 * else, because the interesting rules are about meaning — "báo giá từ nhà
 * cung cấp", "thư mời họp", "khiếu nại của khách" — and a keyword cannot tell
 * a complaint from a compliment.
 *
 * So a rule here has two halves. The cheap half is ordinary matching: sender,
 * subject, attachments, what the server's spam filter concluded. It runs
 * first and costs nothing. Only if it passes does the expensive half run: the
 * model is shown the message and asked one yes/no question in the user's own
 * words. That ordering matters — a rule that asks the model about every
 * message that arrives would be a bill, not a feature.
 *
 * On the actions, three deliberate choices:
 *
 *   - Everything is off until switched on. A rule that files mail before the
 *     user has seen it work is how invoices go missing.
 *   - An automatic reply writes a draft. Sending without a person reading it
 *     is a different thing entirely, and it is a separate switch with its own
 *     warning.
 *   - Every action is written to a log the user can read, because an
 *     automation nobody can audit is one nobody should trust.
 */

"use strict";

var hMailFlow = {
  TAB_MODE: "hmailFlow",
  RULES_PREF: "hmail.flow.rules",
  ENABLED_PREF: "hmail.flow.enabled",
  LOG_FILE: "hmail-flow-log.json",
  MAX_LOG: 200,
  /** Model calls per hour, so a burst of mail cannot run up a bill. */
  MAX_CALLS_PER_HOUR: 60,

  calls: [],
  log: null,

  // ------------------------------------------------------------------ setup

  init(win) {
    try {
      this.registerTabType(win);
      this.loadLog();
      if (this.listening) {
        return;
      }
      this.listening = true;
      this.win = win;
      MailServices.mfn.addListener(this, MailServices.mfn.msgAdded);
    } catch (e) {
      Cu.reportError("hMail flow init failed: " + e);
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

  enabled() {
    try {
      return Services.prefs.getBoolPref(this.ENABLED_PREF, false);
    } catch (e) {
      return false;
    }
  },

  rules() {
    try {
      const raw = Services.prefs.getStringPref(this.RULES_PREF, "[]");
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  saveRules(rules) {
    try {
      Services.prefs.setStringPref(this.RULES_PREF, JSON.stringify(rules));
    } catch (e) {}
  },

  blank() {
    return {
      id: `r${Date.now().toString(36)}`,
      name: "Quy tắc mới",
      on: false,
      // cheap half
      from: "",
      subject: "",
      hasAttachment: false,
      serverSpam: false,
      // expensive half
      ask: "",
      // actions
      moveTo: "",
      tag: "",
      markRead: false,
      flag: false,
      summarize: false,
      reply: "",
      send: false,
    };
  },

  // --------------------------------------------------------------- new mail

  /** nsIMsgFolderListener */
  msgAdded(hdr) {
    try {
      if (!this.enabled()) {
        return;
      }
      const folder = hdr.folder;
      if (!folder?.getFlag(Ci.nsMsgFolderFlags.Inbox)) {
        return;
      }
      const rules = this.rules().filter(r => r.on);
      if (!rules.length) {
        return;
      }
      this.run(hdr, rules).catch(e =>
        Cu.reportError("hMail flow: " + e));
    } catch (e) {}
  },

  async run(hdr, rules) {
    const from = String(hdr.mime2DecodedAuthor || hdr.author || "")
      .toLowerCase();
    const subject = String(hdr.mime2DecodedSubject || "").toLowerCase();

    let verdict = null;
    for (const rule of rules) {
      // --- the cheap half -------------------------------------------------
      if (rule.from && !from.includes(rule.from.toLowerCase())) {
        continue;
      }
      if (rule.subject && !subject.includes(rule.subject.toLowerCase())) {
        continue;
      }
      if (rule.hasAttachment &&
          !(hdr.flags & Ci.nsMsgMessageFlags.Attachment)) {
        continue;
      }
      if (rule.serverSpam) {
        if (!verdict) {
          verdict = await this.verdictOf(hdr);
        }
        if (!verdict.spam && !verdict.virus) {
          continue;
        }
      }

      // --- the expensive half ---------------------------------------------
      if (rule.ask) {
        if (!this.budgetLeft()) {
          this.note(hdr, rule, "bỏ qua — đã chạm giới hạn số lượt hỏi AI " +
                               "trong một giờ");
          continue;
        }
        const yes = await this.askModel(hdr, rule.ask);
        if (!yes) {
          continue;
        }
      }

      await this.apply(hdr, rule);
      // One rule per message: two rules moving the same message to two
      // folders is a race, and the second one would act on a message that is
      // no longer where it thinks it is.
      return;
    }
  },

  async verdictOf(hdr) {
    try {
      const raw = await hMailInsight.raw(hdr);
      return hMailInsight.serverVerdict(hMailInsight.headers(raw));
    } catch (e) {
      return { spam: false, virus: false };
    }
  },

  budgetLeft() {
    const hourAgo = Date.now() - 3600 * 1000;
    this.calls = this.calls.filter(t => t > hourAgo);
    return this.calls.length < this.MAX_CALLS_PER_HOUR;
  },

  /**
   * One yes/no question about one message. Deliberately not a classification
   * into categories: a rule the user wrote in their own words is easier to
   * reason about than a taxonomy hMail invented, and "có" or "không" is the
   * only part of the answer that matters here.
   */
  async askModel(hdr, question) {
    this.calls.push(Date.now());
    try {
      const text = await hMailAI.messageText(hdr);
      const answer = await hMailAI.ask([{
        role: "user",
        text: `Đọc email dưới đây và trả lời đúng một từ: "có" hoặc ` +
              `"không".\n\nCâu hỏi: ${question}\n\n---\n${text}`,
      }]);
      return /^\s*(có|co|yes|true|đúng)\b/i.test(String(answer || "").trim());
    } catch (e) {
      Cu.reportError("hMail flow: không hỏi được AI: " + e);
      return false;
    }
  },

  // ---------------------------------------------------------------- actions

  async apply(hdr, rule) {
    const done = [];
    const folder = hdr.folder;

    try {
      if (rule.markRead) {
        folder.markMessagesRead([hdr], true);
        done.push("đánh dấu đã đọc");
      }
      if (rule.flag) {
        folder.markMessagesFlagged([hdr], true);
        done.push("gắn cờ");
      }
      if (rule.tag) {
        hdr.setStringProperty("keywords",
          [hdr.getStringProperty("keywords"), rule.tag]
            .filter(Boolean).join(" "));
        done.push(`gắn nhãn "${rule.tag}"`);
      }
      if (rule.summarize) {
        const summary = await this.summarize(hdr);
        if (summary) {
          // Kept on the message rather than shown: the summary is there when
          // the message is opened, and nothing pops up while the user is
          // doing something else.
          hdr.setStringProperty("hmail-summary", summary.slice(0, 900));
          done.push("tóm tắt");
        }
      }
      if (rule.reply) {
        const sent = await this.reply(hdr, rule);
        done.push(sent ? "gửi thư trả lời tự động" : "soạn sẵn thư trả lời");
      }
      // Moving comes last: everything above needs the message where it is.
      if (rule.moveTo) {
        const target = MailServices.folderLookup.getFolderForURL(rule.moveTo);
        if (target && target.URI !== folder.URI) {
          MailServices.copy.copyMessages(
            folder, [hdr], target, true, null, null, false);
          done.push(`chuyển vào "${target.prettyName}"`);
        }
      }
    } catch (e) {
      done.push("lỗi: " + (e.message || e));
    }

    this.note(hdr, rule, done.join(", ") || "không có hành động nào");
  },

  async summarize(hdr) {
    if (!this.budgetLeft()) {
      return "";
    }
    this.calls.push(Date.now());
    try {
      const text = await hMailAI.messageText(hdr);
      return await hMailAI.ask([{
        role: "user",
        text: "Tóm tắt email sau trong tối đa ba câu tiếng Việt, nêu rõ " +
              "người gửi muốn gì và có việc gì cần làm không.\n\n---\n" + text,
      }]);
    } catch (e) {
      return "";
    }
  },

  /**
   * Write the reply. Whether it is sent or left as a draft is the rule's
   * choice, and the default is a draft — a machine answering mail in someone
   * else's name, unread, is a different proposition from one filing it.
   */
  async reply(hdr, rule) {
    if (!this.budgetLeft()) {
      return false;
    }
    this.calls.push(Date.now());
    const text = await hMailAI.messageText(hdr);
    const body = await hMailAI.ask([{
      role: "user",
      text: `${rule.reply}\n\nChỉ trả về nội dung thư trả lời, không thêm ` +
            `lời dẫn, không thêm dòng chào ký tên.\n\n---\n${text}`,
    }]);
    if (!body) {
      return false;
    }
    return hMailQuickReply.sendReply(this.win, hdr, body, {
      send: !!rule.send,
    });
  },

  // -------------------------------------------------------------------- log

  logPath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(this.LOG_FILE);
    return f.path;
  },

  loadLog() {
    if (this.log) {
      return;
    }
    this.log = [];
    IOUtils.readJSON(this.logPath()).then(data => {
      if (Array.isArray(data)) {
        this.log = data;
      }
    }).catch(() => {});
  },

  note(hdr, rule, what) {
    this.loadLog();
    this.log.unshift({
      at: Date.now(),
      rule: rule.name,
      from: String(hdr.mime2DecodedAuthor || hdr.author || ""),
      subject: String(hdr.mime2DecodedSubject || ""),
      what,
    });
    this.log = this.log.slice(0, this.MAX_LOG);
    try {
      IOUtils.writeJSON(this.logPath(), this.log).catch(() => {});
    } catch (e) {}
  },
};
