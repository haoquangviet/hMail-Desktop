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
      olderThanDays: 0,        // 0 = không lọc theo tuổi; >0 = chỉ thư cũ hơn N ngày
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
      cleanup: "",             // "" | "trash" | "archive" | "ai" (dọn dẹp thư cũ)
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
      // Tuổi thư — dọn dẹp thư cũ: chỉ khớp nếu thư cũ hơn N ngày.
      if (rule.olderThanDays > 0) {
        const ageDays = (Date.now() - (hdr.dateInSeconds || 0) * 1000) / 86400000;
        if (ageDays < rule.olderThanDays) {
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
      // Dọn dẹp thư cũ — thao tác có thể mất thư, nên đặt cuối cùng.
      if (rule.cleanup) {
        await this.cleanup(hdr, rule, done);
      }
    } catch (e) {
      done.push("lỗi: " + (e.message || e));
    }

    this.note(hdr, rule, done.join(", ") || "không có hành động nào");
  },

  /**
   * Dọn dẹp một thư cũ theo lựa chọn của quy tắc:
   *   "trash"   -> chuyển vào Thùng rác (còn khôi phục được).
   *   "archive" -> chuyển vào Lưu trữ (giữ lại, chỉ dọn khỏi hộp thư).
   *   "ai"      -> hỏi model quyết định xóa / lưu / giữ nguyên.
   * "Chuyển vào thư mục tự chọn" dùng action moveTo sẵn có (kết hợp điều kiện tuổi).
   */
  async cleanup(hdr, rule, done) {
    const folder = hdr.folder;
    let dest = rule.cleanup;
    if (dest === "ai") {
      dest = await this.decideCleanup(hdr);
      if (dest !== "trash" && dest !== "archive") {
        done.push("AI quyết định giữ lại");
        return;
      }
      done.push("AI quyết định");
    }
    if (dest === "trash") {
      // deleteMessages -> chuyển vào Thùng rác của tài khoản, có thể hoàn tác.
      folder.deleteMessages([hdr], this.win?.msgWindow || null,
        false /* deleteStorage */, false /* isMove */, null, true /* allowUndo */);
      done.push("chuyển vào Thùng rác");
    } else if (dest === "archive") {
      const archive = this.specialFolder(folder, Ci.nsMsgFolderFlags.Archive);
      if (archive && archive.URI !== folder.URI) {
        MailServices.copy.copyMessages(
          folder, [hdr], archive, true, null, null, false);
        done.push("lưu trữ");
      } else {
        done.push("không tìm thấy thư mục Lưu trữ");
      }
    }
  },

  /** Thư mục đặc biệt (Archive/Trash) của tài khoản chứa thư này. */
  specialFolder(folder, flag) {
    try {
      return folder.server.rootFolder.getFolderWithFlags(flag);
    } catch (e) {
      return null;
    }
  },

  /**
   * Hỏi model một từ về cách xử lý một thư cũ: "xóa" / "lưu" / "giữ".
   * Trả về "trash" | "archive" | "keep". Lỗi/không chắc -> "keep" (an toàn).
   */
  async decideCleanup(hdr) {
    if (!this.budgetLeft()) {
      return "keep";
    }
    this.calls.push(Date.now());
    try {
      const text = await hMailAI.messageText(hdr);
      const ans = await hMailAI.ask([{
        role: "user",
        text: "Thư dưới đây đã cũ. Trả lời đúng MỘT từ về cách xử lý:\n" +
              "- \"xóa\" nếu là thư rác/quảng cáo/thông báo hết giá trị;\n" +
              "- \"lưu\" nếu nên giữ lại để tra cứu (hóa đơn, hợp đồng, biên lai);\n" +
              "- \"giữ\" nếu còn quan trọng, để nguyên trong hộp thư.\n\n---\n" + text,
      }]);
      const a = String(ans || "").toLowerCase();
      if (/x[oó]a|delete|rác|spam/.test(a)) {
        return "trash";
      }
      if (/l[uư]u|archive|tr[uữ]/.test(a)) {
        return "archive";
      }
      return "keep";
    } catch (e) {
      return "keep";
    }
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

  // =====================================================================
  // Chạy trên thư mục sẵn có
  //
  // Running a rule over mail that has already arrived is a different act
  // from running it on one message as it lands. It touches thousands of
  // messages at once, it costs real money, and a mistake is thousands of
  // mistakes. So it is built around three things the per-message path does
  // not need: an estimate the user sees before agreeing, batching so the
  // bill is a fraction of what one call per message would be, and a review
  // list for everything the model was not sure about.
  // =====================================================================

  BATCH_SIZE: 10,
  /** Below this the model's own answer is not acted on; it goes to review. */
  CONFIDENT: 0.8,
  BUDGET_PREF: "hmail.flow.budgetUSD",
  DEFAULT_BUDGET: 5,

  budget() {
    try {
      const value = parseFloat(
        Services.prefs.getCharPref(this.BUDGET_PREF,
                                   String(this.DEFAULT_BUDGET)));
      return Number.isFinite(value) && value > 0
        ? value : this.DEFAULT_BUDGET;
    } catch (e) {
      return this.DEFAULT_BUDGET;
    }
  },

  /**
   * What a run would cost, roughly. Deliberately an over-estimate: a number
   * that turns out low is a broken promise, and a number that turns out high
   * is a pleasant surprise.
   */
  estimate(count) {
    const perMessage = 1200;          // tokens of prompt, generously
    const perAnswer = 60;
    const batches = Math.ceil(count / this.BATCH_SIZE);
    const inTokens = count * perMessage + batches * 300;
    const outTokens = count * perAnswer;
    const price = hMailAI.price();
    return {
      batches,
      inTokens,
      outTokens,
      usd: (inTokens / 1e6) * price.in + (outTokens / 1e6) * price.out,
    };
  },

  /** Money spent on this run so far, from the assistant's own counters. */
  spent(since) {
    const now = hMailAI.usageFor();
    return hMailAI.cost({
      in: Math.max(0, now.in - since.in),
      out: Math.max(0, now.out - since.out),
    });
  },

  /**
   * Ask about a batch of messages in one call and get one verdict each.
   *
   * Ten messages per call rather than one is most of the saving: the rule,
   * the instructions and the output format are sent once instead of ten
   * times, and short mail is mostly overhead.
   */
  async askBatch(items, question) {
    const parts = items.map((it, i) =>
      `### Thư ${i + 1}\nTừ: ${it.from}\nTiêu đề: ${it.subject}\nNội dung: ${it.body}`);

    const answer = await hMailAI.ask([{
      role: "user",
      text:
        `Với mỗi thư dưới đây, trả lời câu hỏi: ${question}\n\n` +
        "Trả về DUY NHẤT một mảng JSON, mỗi phần tử là " +
        '{"i": số thứ tự thư, "yes": true hoặc false, "c": độ chắc chắn từ ' +
        '0 đến 1, "why": lý do ngắn}. Không thêm chữ nào ngoài mảng JSON.' +
        "\nNếu thư không đủ thông tin để kết luận, đặt c thấp thay vì " +
        "đoán.\n\n" +
        parts.join("\n\n"),
    }]);

    try {
      const json = String(answer).replace(/^[^[]*/, "").replace(/[^\]]*$/, "");
      const list = JSON.parse(json);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      // An unparseable answer is not a "no": it is an unknown, and unknowns
      // belong in the review list rather than being silently dropped.
      return items.map((it, i) => ({ i: i + 1, yes: false, c: 0,
                                     why: "không đọc được trả lời của AI" }));
    }
  },

  /**
   * Run one rule across a folder.
   *
   * @param {object} opts
   * @param {function} opts.onProgress  (done, total, spentUSD)
   * @param {function} opts.shouldStop  called between batches
   */
  async runFolder(win, folder, rule, opts = {}) {
    const { onProgress = () => {}, shouldStop = () => false } = opts;
    const since = { ...hMailAI.usageFor() };
    const cap = this.budget();
    const review = [];
    const acted = [];
    let done = 0;
    let stoppedFor = "";

    // The cheap half first, on every message, before a single call is made.
    const candidates = [];
    for (const hdr of folder.msgDatabase.enumerateMessages()) {
      const from = String(hdr.mime2DecodedAuthor || "").toLowerCase();
      const subject = String(hdr.mime2DecodedSubject || "").toLowerCase();
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
      // Tuổi thư — dọn dẹp thư cũ: chỉ lấy thư cũ hơn N ngày.
      if (rule.olderThanDays > 0) {
        const ageDays = (Date.now() - (hdr.dateInSeconds || 0) * 1000) / 86400000;
        if (ageDays < rule.olderThanDays) {
          continue;
        }
      }
      candidates.push(hdr);
    }

    if (!rule.ask) {
      // No question to ask: every candidate matched on the cheap half alone,
      // and the model is not involved at all.
      for (const hdr of candidates) {
        if (shouldStop()) {
          break;
        }
        await this.apply(hdr, rule);
        acted.push(hdr);
        onProgress(++done, candidates.length, 0);
      }
      return { acted, review, total: candidates.length, spent: 0, stoppedFor };
    }

    for (let i = 0; i < candidates.length; i += this.BATCH_SIZE) {
      if (shouldStop()) {
        stoppedFor = "người dùng dừng";
        break;
      }
      const spentSoFar = this.spent(since);
      if (spentSoFar >= cap) {
        stoppedFor = `chạm mức trần ${cap} USD`;
        break;
      }

      const slice = candidates.slice(i, i + this.BATCH_SIZE);
      const items = [];
      for (const hdr of slice) {
        items.push({
          hdr,
          from: String(hdr.mime2DecodedAuthor || ""),
          subject: String(hdr.mime2DecodedSubject || ""),
          body: (await this.shortBody(hdr)).slice(0, 1500),
        });
      }

      let verdicts = [];
      try {
        verdicts = await this.askBatch(items, rule.ask);
      } catch (e) {
        stoppedFor = "lỗi khi gọi AI: " + (e.message || e);
        break;
      }

      for (const [index, item] of items.entries()) {
        const v = verdicts.find(x => Number(x.i) === index + 1) || {};
        const confidence = Number(v.c);
        if (!v.yes) {
          continue;
        }
        if (!(confidence >= this.CONFIDENT)) {
          // Sure enough to raise, not sure enough to act on.
          review.push({
            hdr: item.hdr,
            from: item.from,
            subject: item.subject,
            confidence: Number.isFinite(confidence) ? confidence : 0,
            why: String(v.why || ""),
          });
          continue;
        }
        await this.apply(item.hdr, rule);
        acted.push(item.hdr);
      }

      done = Math.min(candidates.length, i + this.BATCH_SIZE);
      onProgress(done, candidates.length, this.spent(since));
      await new Promise(r => win.setTimeout(r, 0));
    }

    return {
      acted,
      review,
      total: candidates.length,
      spent: this.spent(since),
      stoppedFor,
    };
  },

  /** Enough of a message for a yes/no question, and no more. */
  async shortBody(hdr) {
    try {
      const raw = await hMailInsight.raw(hdr);
      return hMailInsight.plainBody(raw);
    } catch (e) {
      return "";
    }
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
