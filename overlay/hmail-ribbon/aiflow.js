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
      match: "all",            // "all" = mọi điều kiện | "any" = bất kỳ điều kiện
      from: "",
      notFrom: "",
      to: "",
      subject: "",
      notSubject: "",
      body: "",
      hasAttachment: false,
      attachExt: "",           // "pdf, docx" — chỉ xét khi có đính kèm
      serverSpam: false,
      unreadOnly: false,
      listMail: "any",         // "any" | "yes" | "no" — thư từ danh sách gửi
      knownContact: "any",     // "any" | "yes" | "no" — người gửi có trong danh bạ
      minKB: 0,
      olderThanDays: 0,        // 0 = không lọc theo tuổi; >0 = chỉ thư cũ hơn N ngày
      // expensive half
      ai: {
        on: false,
        categories: [],        // xem CATEGORIES
        intents: [],           // xem INTENTS
        sentiments: [],        // xem SENTIMENTS
        minUrgency: 0,         // 0 = không xét; 1..5
        needsReply: "any",     // "any" | "yes" | "no"
        topic: "",             // chủ đề, đối chiếu theo nghĩa chứ không theo chữ
      },
      ask: "",
      // actions
      moveTo: "",
      tag: "",
      markRead: false,
      flag: false,
      summarize: false,
      tagCategory: false,
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
    // Shared between rules so a folder run does not fetch the same message,
    // or ask the model about it, once per rule.
    const ctx = { verdict: null, raw: null, analysis: null };

    for (const rule of rules) {
      // --- the cheap half -------------------------------------------------
      if (!await this.matchCheap(hdr, rule, ctx)) {
        continue;
      }

      // --- the expensive half ---------------------------------------------
      if (this.usesAI(rule)) {
        if (!this.budgetLeft()) {
          this.note(hdr, rule, "bỏ qua — đã chạm giới hạn số lượt hỏi AI " +
                               "trong một giờ");
          continue;
        }
        if (this.usesAnalysis(rule)) {
          ctx.analysis = ctx.analysis || await this.analyze(hdr);
          if (!this.matchAnalysis(ctx.analysis, rule)) {
            continue;
          }
        }
        if (rule.ask) {
          const yes = await this.askModel(hdr, rule.ask);
          if (!yes) {
            continue;
          }
        }
      }

      await this.apply(hdr, rule, ctx.analysis);
      // One rule per message: two rules moving the same message to two
      // folders is a race, and the second one would act on a message that is
      // no longer where it thinks it is.
      return;
    }
  },

  // ------------------------------------------------------- nửa rẻ: so khớp

  /**
   * The string half of a rule. Each condition the user filled in becomes one
   * test; blank fields are not conditions and do not count either way.
   *
   * `match: "any"` exists because the useful rules are rarely a single
   * conjunction — "from the bank OR the subject says invoice" needs one rule,
   * not two that then both fire on the same message.
   */
  async matchCheap(hdr, rule, ctx = {}) {
    const from = String(hdr.mime2DecodedAuthor || hdr.author || "")
      .toLowerCase();
    const to = [hdr.mime2DecodedRecipients, hdr.ccList]
      .filter(Boolean).join(", ").toLowerCase();
    const subject = String(hdr.mime2DecodedSubject || "").toLowerCase();
    const any = rule.match === "any";
    const tests = [];

    const has = (haystack, needle) =>
      needle.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
        .some(s => haystack.includes(s));

    if (rule.from) {
      tests.push(has(from, rule.from));
    }
    if (rule.notFrom) {
      tests.push(!has(from, rule.notFrom));
    }
    if (rule.to) {
      tests.push(has(to, rule.to));
    }
    if (rule.subject) {
      tests.push(has(subject, rule.subject));
    }
    if (rule.notSubject) {
      tests.push(!has(subject, rule.notSubject));
    }
    if (rule.hasAttachment) {
      tests.push(!!(hdr.flags & Ci.nsMsgMessageFlags.Attachment));
    }
    if (rule.unreadOnly) {
      tests.push(!hdr.isRead);
    }
    if (rule.minKB > 0) {
      tests.push((hdr.messageSize || 0) / 1024 >= rule.minKB);
    }
    if (rule.olderThanDays > 0) {
      const days = (Date.now() - (hdr.dateInSeconds || 0) * 1000) / 86400000;
      tests.push(days >= rule.olderThanDays);
    }
    if (rule.knownContact && rule.knownContact !== "any") {
      const known = this.isKnown(from);
      tests.push(rule.knownContact === "yes" ? known : !known);
    }

    // These read the message off disk, so they run only when asked for, and
    // only after the free tests have had their say.
    const needsBody = rule.body ||
                      (rule.attachExt && rule.hasAttachment) ||
                      (rule.listMail && rule.listMail !== "any") ||
                      rule.serverSpam;
    if (needsBody) {
      try {
        ctx.raw = ctx.raw || await hMailInsight.raw(hdr);
      } catch (e) {
        ctx.raw = "";
      }
      const headers = hMailInsight.headers(ctx.raw || "");
      if (rule.serverSpam) {
        ctx.verdict = ctx.verdict ||
          hMailInsight.serverVerdict(headers);
        tests.push(!!(ctx.verdict.spam || ctx.verdict.virus));
      }
      if (rule.listMail && rule.listMail !== "any") {
        const isList = !!(headers["list-unsubscribe"] || headers["list-id"] ||
                          headers["precedence"]);
        tests.push(rule.listMail === "yes" ? isList : !isList);
      }
      if (rule.body) {
        const text = hMailInsight.plainBody(ctx.raw || "").toLowerCase();
        tests.push(has(text, rule.body));
      }
      if (rule.attachExt && rule.hasAttachment) {
        const names = (ctx.raw || "").match(/filename\*?=[^\r\n;]+/gi) || [];
        const joined = names.join(" ").toLowerCase();
        tests.push(rule.attachExt.split(",").map(s => s.trim().toLowerCase())
          .filter(Boolean)
          .some(ext => joined.includes("." + ext.replace(/^\./, ""))));
      }
    }

    if (!tests.length) {
      // No conditions at all means every message, which is what "run this on
      // the whole folder" is for. It is only dangerous with an action, and
      // the action side already asks twice.
      return true;
    }
    return any ? tests.some(Boolean) : tests.every(Boolean);
  },

  /** Người gửi đã có trong sổ địa chỉ chưa. */
  isKnown(from) {
    try {
      const addr = (from.match(/[\w.+-]+@[\w.-]+/) || [""])[0];
      if (!addr) {
        return false;
      }
      return !!MailServices.ab.cardForEmailAddress(addr);
    } catch (e) {
      return false;
    }
  },

  // ----------------------------------------------- nửa đắt: AI đọc hiểu thư

  /** Bảng phân loại — cố định để quy tắc còn so khớp được. */
  CATEGORIES: [
    "công việc", "cá nhân", "tài chính", "đơn hàng", "tiếp thị",
    "thông báo hệ thống", "lừa đảo", "thư rác", "khác",
  ],
  INTENTS: [
    "yêu cầu hành động", "hỏi thông tin", "thông báo", "xác nhận",
    "nhắc nhở", "mời họp", "khiếu nại", "chào hàng", "khác",
  ],
  SENTIMENTS: ["tích cực", "trung tính", "tiêu cực", "giận dữ"],

  usesAnalysis(rule) {
    const ai = rule.ai;
    if (!ai || !ai.on) {
      return false;
    }
    return !!(ai.categories?.length || ai.intents?.length ||
              ai.sentiments?.length || ai.minUrgency > 0 ||
              (ai.needsReply && ai.needsReply !== "any") || ai.topic);
  },

  usesAI(rule) {
    return !!rule.ask || this.usesAnalysis(rule);
  },

  /**
   * One reading of the message, in one call, producing every field a rule can
   * test. Asking separately per condition would multiply the bill by the
   * number of conditions for no more information.
   *
   * The result is kept on the message, so a second rule — or a second run
   * over the same folder next week — costs nothing.
   */
  async analyze(hdr) {
    try {
      const cached = hdr.getStringProperty("hmail-analysis");
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {}

    this.calls.push(Date.now());
    try {
      const text = await hMailAI.messageText(hdr);
      const answer = await hMailAI.ask([{
        role: "user",
        text:
          "Đọc email dưới đây và trả về DUY NHẤT một đối tượng JSON, không " +
          "kèm giải thích, không kèm dấu ```:\n" +
          `{"category": một trong [${this.CATEGORIES.join(", ")}],\n` +
          ` "intent": một trong [${this.INTENTS.join(", ")}],\n` +
          ` "sentiment": một trong [${this.SENTIMENTS.join(", ")}],\n` +
          ` "urgency": số nguyên 1-5 (5 = phải xử lý ngay),\n` +
          ` "needsReply": true/false,\n` +
          ` "deadline": "mô tả hạn chót nếu thư có nhắc, không thì null",\n` +
          ` "topics": ["2-5 chủ đề chính, mỗi chủ đề vài từ"],\n` +
          ` "summary": "tóm tắt 1-2 câu bằng tiếng Việt",\n` +
          ` "confidence": số thực 0-1 (mức chắc chắn của bạn)}\n\n---\n` + text,
      }]);
      const data = this.parseJSON(answer);
      if (!data) {
        return null;
      }
      const analysis = {
        category: this.pick(data.category, this.CATEGORIES),
        intent: this.pick(data.intent, this.INTENTS),
        sentiment: this.pick(data.sentiment, this.SENTIMENTS),
        urgency: Math.min(5, Math.max(1, parseInt(data.urgency, 10) || 3)),
        needsReply: data.needsReply === true || data.needsReply === "true",
        deadline: data.deadline || null,
        topics: Array.isArray(data.topics) ? data.topics.slice(0, 5) : [],
        summary: String(data.summary || "").slice(0, 600),
        confidence: Math.min(1, Math.max(0, Number(data.confidence) || 0.5)),
      };
      try {
        hdr.setStringProperty("hmail-analysis", JSON.stringify(analysis));
      } catch (e) {}
      return analysis;
    } catch (e) {
      Cu.reportError("hMail flow: không phân tích được thư: " + e);
      return null;
    }
  },

  /** Models wrap JSON in prose and fences no matter how firmly you ask. */
  parseJSON(answer) {
    const raw = String(answer || "");
    const body = raw.replace(/```(?:json)?/gi, "");
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  },

  /** Kéo câu trả lời tự do về đúng một giá trị trong bảng. */
  pick(value, list) {
    const v = String(value || "").toLowerCase().trim();
    return list.find(x => v === x) || list.find(x => v.includes(x)) ||
           list[list.length - 1];
  },

  matchAnalysis(analysis, rule) {
    if (!analysis) {
      // Không đọc được thì không hành động. Đoán mò trên thư của người ta là
      // cách nhanh nhất để mất một lá thư quan trọng.
      return false;
    }
    const ai = rule.ai || {};
    if (ai.categories?.length && !ai.categories.includes(analysis.category)) {
      return false;
    }
    if (ai.intents?.length && !ai.intents.includes(analysis.intent)) {
      return false;
    }
    if (ai.sentiments?.length &&
        !ai.sentiments.includes(analysis.sentiment)) {
      return false;
    }
    if (ai.minUrgency > 0 && analysis.urgency < ai.minUrgency) {
      return false;
    }
    if (ai.needsReply === "yes" && !analysis.needsReply) {
      return false;
    }
    if (ai.needsReply === "no" && analysis.needsReply) {
      return false;
    }
    if (ai.topic) {
      // Chủ đề đối chiếu theo nghĩa: model đã rút ra topics và summary, nên
      // so ở đây là so trên thứ nó hiểu chứ không phải trên chữ trong thư.
      const hay = [...(analysis.topics || []), analysis.summary]
        .join(" ").toLowerCase();
      const wanted = ai.topic.split(",").map(s => s.trim().toLowerCase())
        .filter(Boolean);
      if (!wanted.some(w => hay.includes(w))) {
        return false;
      }
    }
    return true;
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

  async apply(hdr, rule, analysis = null) {
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
      // Nhãn theo phân loại của AI — chỉ khi quy tắc đã cho AI đọc thư, nên
      // không tốn thêm lượt hỏi nào.
      if (rule.tagCategory && analysis?.category) {
        const key = this.tagKeyFor(analysis.category);
        if (key) {
          hdr.setStringProperty("keywords",
            [hdr.getStringProperty("keywords"), key]
              .filter(Boolean).join(" "));
          done.push(`gắn nhãn "${analysis.category}"`);
        }
      }
      if (rule.summarize) {
        // Bản phân tích đã có sẵn phần tóm tắt; hỏi lại là trả tiền hai lần
        // cho cùng một câu trả lời.
        const summary = analysis?.summary || await this.summarize(hdr);
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

  /**
   * Nhãn ứng với một phân loại của AI, tạo mới nếu chưa có. Dùng tên phân
   * loại làm khoá để chạy lại không sinh ra nhãn trùng.
   */
  tagKeyFor(category) {
    try {
      const key = "hmail" + category.normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z]/gi, "").toLowerCase();
      const existing = MailServices.tags.getAllTags()
        .find(t => t.key === key);
      if (!existing) {
        MailServices.tags.addTagForKey(key, category, null, "");
      }
      return key;
    } catch (e) {
      return "";
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
      if (await this.matchCheap(hdr, rule, {})) {
        candidates.push(hdr);
      }
    }

    // A rule whose AI half reads the message rather than answering a yes/no
    // question: each message is analysed once — and the analysis is kept on
    // the message, so a second rule or a later run pays nothing for it.
    if (this.usesAnalysis(rule)) {
      for (const hdr of candidates) {
        if (shouldStop()) {
          stoppedFor = "người dùng dừng";
          break;
        }
        if (this.spent(since) >= cap) {
          stoppedFor = `chạm mức trần ${cap} USD`;
          break;
        }
        const analysis = await this.analyze(hdr);
        if (!this.matchAnalysis(analysis, rule)) {
          onProgress(++done, candidates.length, this.spent(since));
          continue;
        }
        if (analysis.confidence >= this.CONFIDENT) {
          await this.apply(hdr, rule, analysis);
          acted.push(hdr);
        } else {
          review.push({
            hdr,
            from: String(hdr.mime2DecodedAuthor || ""),
            subject: String(hdr.mime2DecodedSubject || ""),
            confidence: analysis.confidence,
            why: `${analysis.category} · ${analysis.intent} — ` +
                 analysis.summary,
          });
        }
        onProgress(++done, candidates.length, this.spent(since));
        await new Promise(r => win.setTimeout(r, 0));
      }
      return {
        acted, review, total: candidates.length,
        spent: this.spent(since), stoppedFor,
      };
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
