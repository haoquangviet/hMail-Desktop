/* hMail Desktop — AI assistant
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Written for hMail rather than adapted from an add-on. The add-on this
 * replaces was built around popup windows and kept the "which message am I
 * about?" state in a background script keyed to the toolbar button that opened
 * it, so a docked panel could never be given the current message. Everything
 * here runs as privileged chrome, in the same window as the mail, and reads
 * the selected message directly — the context problem disappears.
 *
 * What that buys us:
 *   - no popup windows, ever; the panel is the interface
 *   - conversation history kept per message, restored when it is reopened
 *   - a prompt can be run automatically when a message is opened
 *   - no CORS or host permissions: privileged fetch talks to the provider
 *   - the API key lives in the login manager, not a plain-text pref
 */

"use strict";

// Two patterns used while reading a message, kept out of the function so
// the escapes are written once and read easily.
const BLANK_LINE = /\r?\n\r?\n/;
const FILENAME = /filename\*?=\s*"?([^";\r\n]+)/gi;

var hMailAI = {
  PANEL_ID: "hmail-ai-panel",
  REALM: "hMail AI",
  HISTORY_FILE: "hmail-ai-history.json",
  MAX_HISTORY_MESSAGES: 40,

  /**
   * System prompt — dat vai tro + khuon chat luong cho model. Gemini-flash tu suy
   * ra duoc tu prompt nguoi dung, nhung cac model yeu hon (deepseek-chat, model
   * openai-compatible, on-device) tra loi tot HON HAN khi co system prompt ro rang.
   * Gui qua systemInstruction (Gemini) / role:"system" (OpenAI-compatible).
   */
  SYSTEM_PROMPT:
    "Bạn là trợ lý email chuyên nghiệp tích hợp trong hMail. Nguyên tắc:\n" +
    "- Luôn trả lời bằng TIẾNG VIỆT, chính xác, ngắn gọn, đúng trọng tâm.\n" +
    "- Viết tiếng Việt CÓ DẤU đầy đủ, đúng chính tả (\"đơn hàng\", không " +
    "phải \"don hang\"). Tuyệt đối không trả lời bằng tiếng Việt không dấu, " +
    "kể cả khi thư gốc viết không dấu.\n" +
    "- CHỈ dựa vào dữ liệu email được cung cấp (Từ, Đến, Tiêu đề, Ngày, Tệp đính " +
    "kèm, nội dung). TUYỆT ĐỐI không bịa thông tin không có trong thư; nếu thiếu " +
    "dữ liệu thì nói rõ là không có.\n" +
    "- Khi tóm tắt: nêu rõ NGƯỜI GỬI là ai, họ MUỐN GÌ, và VIỆC CẦN LÀM (nếu có). " +
    "Trình bày mạch lạc, ưu tiên gạch đầu dòng, in đậm nhãn mục bằng **...**.\n" +
    "- Cảnh giác dấu hiệu lừa đảo/giả mạo (tên miền lạ, địa chỉ trả lời khác người " +
    "gửi, yêu cầu khẩn cấp/chuyển tiền/cung cấp mật khẩu, tệp đính kèm đáng ngờ) và " +
    "nêu ngắn gọn cảnh báo nếu phát hiện.\n" +
    "- Không thêm lời dẫn thừa, không nhắc lại đề bài.",

  /** Built-in prompts. Users can add their own; these are the defaults. */
  BUILTIN_PROMPTS: [
    {
      id: "summarize",
      label: "Tóm tắt thư",
      text: "Tóm tắt email dưới đây bằng tiếng Việt theo đúng bố cục sau:\n" +
            "**Người gửi:** ai, thuộc tổ chức nào (dựa trên Từ:/chữ ký).\n" +
            "**Nội dung chính:** 2–4 gạch đầu dòng, mỗi ý một dòng.\n" +
            "**Việc cần làm:** gạch đầu dòng; nếu không có thì ghi \"Không có\".\n" +
            "Chỉ dựa vào nội dung thư, không suy diễn thêm. Ngắn gọn, súc tích.",
    },
    {
      id: "reply",
      label: "Soạn thư trả lời",
      text: "Soạn một thư trả lời lịch sự, chuyên nghiệp bằng tiếng Việt cho " +
            "email sau. Chỉ trả về nội dung thư, không thêm lời dẫn.",
    },
    {
      id: "classify",
      label: "Phân loại thư",
      text: "Phân loại email sau vào một trong các nhóm: Công việc, Khách " +
            "hàng, Hóa đơn, Quảng cáo, Cá nhân, Thư rác. Trả lời đúng một " +
            "nhóm kèm một câu giải thích ngắn.",
    },
    {
      id: "todo",
      label: "Rút ra việc cần làm",
      text: "Liệt kê các việc cần làm rút ra từ email sau, dạng gạch đầu " +
            "dòng, bằng tiếng Việt. Nếu không có việc gì thì nói rõ.",
    },
    {
      id: "translate-vi",
      label: "Dịch sang tiếng Việt",
      text: "Dịch toàn bộ nội dung email sau sang tiếng Việt, giữ nguyên ý " +
            "và văn phong.",
    },
    {
      id: "translate-en",
      label: "Dịch sang tiếng Anh",
      text: "Translate the following email into natural English, preserving " +
            "meaning and tone.",
    },
  ],

  // --------------------------------------------------------------- config

  pref(name, fallback) {
    try {
      switch (typeof fallback) {
        case "boolean":
          return Services.prefs.getBoolPref(name);
        case "number":
          return Services.prefs.getIntPref(name);
        default:
          return Services.prefs.getCharPref(name);
      }
    } catch (e) {
      return fallback;
    }
  },

  /**
   * The services offered in settings.
   *
   * `provider` is the wire protocol, not the company: "gemini" is Google's
   * Generative Language API, and "openai" is the chat-completions shape that
   * most vendors and every local runner speak — Ollama, LM Studio and Windows
   * AI Foundry Local included. Local ones need no key, cost nothing, and the
   * mail never leaves the machine.
   *
   * `priceIn`/`priceOut` are US dollars per million tokens and are only used
   * to estimate spend. Vendors change them, so they are editable per service.
   */
  SERVICES: [
    { id: "gemini", label: "Google Gemini", provider: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-flash-latest", key: true, priceIn: 0.30, priceOut: 2.50,
      actions: true, tested: true, where: "máy chủ Google (Hoa Kỳ)" },
    { id: "openai", label: "OpenAI (ChatGPT)", provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini", key: true, priceIn: 0.15, priceOut: 0.60,
      actions: true, where: "máy chủ OpenAI (Hoa Kỳ)" },
    { id: "deepseek", label: "DeepSeek", provider: "openai",
      endpoint: "https://api.deepseek.com/v1",
      model: "deepseek-chat", key: true, priceIn: 0.27, priceOut: 1.10,
      // deepseek-chat accepts the tools field but calls them erratically, so
      // hMail does not offer it actions. It answers; it does not act.
      actions: false, where: "máy chủ DeepSeek (Trung Quốc)" },
    { id: "groq", label: "Groq", provider: "openai",
      endpoint: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile", key: true,
      priceIn: 0.59, priceOut: 0.79,
      actions: false, where: "máy chủ Groq (Hoa Kỳ)" },
    { id: "openrouter", label: "OpenRouter", provider: "openai",
      endpoint: "https://openrouter.ai/api/v1",
      model: "google/gemini-flash-1.5", key: true,
      priceIn: 0.30, priceOut: 2.50,
      actions: false,
      where: "OpenRouter, rồi chuyển tiếp tới nhà cung cấp của model bạn chọn" },
    { id: "ollama", label: "Ollama (chạy trên máy này)", provider: "openai",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "llama3.2", key: false, priceIn: 0, priceOut: 0 },
    { id: "lmstudio", label: "LM Studio (chạy trên máy này)",
      provider: "openai", endpoint: "http://127.0.0.1:1234/v1",
      model: "local-model", key: false, priceIn: 0, priceOut: 0 },
    { id: "foundry", label: "Windows AI Foundry Local", provider: "openai",
      endpoint: "http://127.0.0.1:5273/v1",
      model: "phi-3.5-mini", key: false, priceIn: 0, priceOut: 0 },
    { id: "custom", label: "Khác — tự nhập địa chỉ", provider: "openai",
      endpoint: "", model: "", key: true, priceIn: 0, priceOut: 0 },
    // Not a service at all: the model runs inside hMail. No address, no key,
    // no cost, and the message never leaves the machine.
    { id: "local", label: "AI trên máy (không cần API key)", provider: "local",
      endpoint: "", model: "", key: false, priceIn: 0, priceOut: 0 },
  ],

  /** Which service is in use. Each keeps its own settings and its own key. */
  service() {
    return this.pref("hmail.ai.service", "gemini");
  },

  serviceDef(id = null) {
    const wanted = id || this.service();
    return this.SERVICES.find(s => s.id === wanted) || this.SERVICES[0];
  },

  /**
   * Settings are stored per service — hmail.ai.svc.<service>.<key> — so
   * switching from Gemini to a local runner and back does not overwrite
   * either one's address, model or price.
   */
  svcPref(key, fallback, id = null) {
    return this.pref(`hmail.ai.svc.${id || this.service()}.${key}`, fallback);
  },

  setSvcPref(key, value, id = null) {
    Services.prefs.setCharPref(
      `hmail.ai.svc.${id || this.service()}.${key}`, String(value));
  },

  provider(id = null) {
    const def = this.serviceDef(id);
    // The "custom" slot may speak either protocol; the rest are fixed.
    return def.id === "custom"
      ? this.svcPref("provider", def.provider, id)
      : def.provider;
  },

  model(id = null) {
    return this.svcPref("model", this.serviceDef(id).model, id);
  },

  endpoint(id = null) {
    return this.svcPref("endpoint", this.serviceDef(id).endpoint, id);
  },

  /** US dollars per million tokens, as configured for a service. */
  price(id = null) {
    const def = this.serviceDef(id);
    return {
      in: parseFloat(this.svcPref("priceIn", String(def.priceIn), id)) || 0,
      out: parseFloat(this.svcPref("priceOut", String(def.priceOut), id)) || 0,
    };
  },

  /** Every service's counters: {<service>: {in, out, calls}}. */
  usage() {
    try {
      const all = JSON.parse(this.pref("hmail.ai.usage", "{}"));
      return all && typeof all === "object" ? all : {};
    } catch (e) {
      return {};
    }
  },

  usageFor(id = null) {
    return this.usage()[id || this.service()] || { in: 0, out: 0, calls: 0 };
  },

  cost(counters, id = null) {
    const p = this.price(id);
    return (counters.in / 1e6) * p.in + (counters.out / 1e6) * p.out;
  },

  /** Called after every answer, with whatever the provider reported. */
  recordUsage(inTokens, outTokens) {
    const input = Number(inTokens) || 0;
    const output = Number(outTokens) || 0;
    // One question can take several round-trips when actions are involved;
    // lastUsage totals them so the status line reports the whole exchange.
    const last = this.lastUsage || { in: 0, out: 0 };
    this.lastUsage = { in: last.in + input, out: last.out + output };
    if (!input && !output) {
      return;
    }
    const all = this.usage();
    const id = this.service();
    const u = all[id] || { in: 0, out: 0, calls: 0 };
    u.in += input;
    u.out += output;
    u.calls += 1;
    all[id] = u;
    try {
      Services.prefs.setCharPref("hmail.ai.usage", JSON.stringify(all));
    } catch (e) {}
  },

  clearUsage() {
    try {
      Services.prefs.setCharPref("hmail.ai.usage", "{}");
    } catch (e) {}
    this.lastUsage = null;
  },

  /**
   * Settings used to be one shared set of prefs and one Gemini key. Move them
   * into the current service's slot once, so nobody has to retype anything.
   */
  async migrateConfig() {
    if (this.pref("hmail.ai.migrated", false)) {
      return;
    }
    try {
      const id = this.service();
      const legacyEndpoint = this.provider(id) === "openai"
        ? this.pref("hmail.ai.openaiEndpoint", "")
        : this.pref("hmail.ai.endpoint", "");
      const legacyModel = this.provider(id) === "openai"
        ? this.pref("hmail.ai.openaiModel", "")
        : this.pref("hmail.ai.model", "");
      if (legacyEndpoint) {
        this.setSvcPref("endpoint", legacyEndpoint, id);
      }
      if (legacyModel) {
        this.setSvcPref("model", legacyModel, id);
      }

      const old = Services.logins.findLogins(
        "https://generativelanguage.googleapis.com", null, this.REALM);
      if (old.length && !this.apiKey("gemini")) {
        await this.setApiKey(old[0].password, "gemini");
      }
      Services.prefs.setBoolPref("hmail.ai.migrated", true);
    } catch (e) {
      Cu.reportError("hMail AI config migration failed: " + e);
    }
  },

  /** Local runners usually need no key; remote OpenAI-compatible ones do. */
  needsKey() {
    // The on-device model has no service behind it and therefore no key.
    // Without this line the check said "provider is not openai, so it needs a
    // key", and every local request died with "chưa nhập API key" before it
    // reached the model.
    if (this.provider() === "local") {
      return false;
    }
    return this.provider() !== "openai" ||
           !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(this.endpoint());
  },

  /** Prompts: built-ins plus anything the user added. */
  prompts() {
    let extra = [];
    try {
      extra = JSON.parse(this.pref("hmail.ai.customPrompts", "[]"));
    } catch (e) {}
    return this.BUILTIN_PROMPTS.concat(Array.isArray(extra) ? extra : []);
  },

  promptById(id) {
    return this.prompts().find(p => p.id === id) || null;
  },

  // ----------------------------------------------------------- credentials

  /** One stored key per service, so several can be configured at once. */
  keyOrigin(id = null) {
    return `hmail://ai/${id || this.service()}`;
  },

  apiKey(id = null) {
    try {
      const logins = Services.logins.findLogins(
        this.keyOrigin(id), null, this.REALM);
      return logins.length ? logins[0].password : "";
    } catch (e) {
      return "";
    }
  },

  async setApiKey(key, id = null) {
    const origin = this.keyOrigin(id);
    const info = Cc["@mozilla.org/login-manager/loginInfo;1"]
      .createInstance(Ci.nsILoginInfo);
    info.init(origin, null, this.REALM, "api", key, "", "");
    const logins = Services.logins.findLogins(origin, null, this.REALM);
    if (logins.length) {
      Services.logins.modifyLogin(logins[0], info);
    } else {
      await Services.logins.addLoginAsync(info);
    }
  },

  // -------------------------------------------------------------- message

  selectedMessage(win) {
    try {
      // A message opened in its own window has no tabmail; the message it is
      // showing hangs off the browser that hosts about:message.
      const standalone = win.document.getElementById("messageBrowser");
      if (standalone && !win.document.getElementById("tabmail")) {
        return standalone.contentWindow?.gMessage || null;
      }
      // Asking for the first selected message with nothing selected throws;
      // see the note in mailinsight.selected().
      const view = win.document.getElementById("tabmail")
        ?.currentAbout3Pane?.gDBView;
      if (!view || !view.numSelected) {
        return null;
      }
      return view.hdrForFirstSelectedMessage || null;
    } catch (e) {
      return null;
    }
  },

  /** Raw source of a message. */
  rawMessage(hdr) {
    return new Promise((resolve, reject) => {
      try {
        const uri = hdr.folder.getUriForMsg(hdr);
        const service = MailServices.messageServiceFromURI(uri);
        const chunks = [];
        const LIMIT = 1024 * 1024;
        let read = 0;
        const listener = {
          QueryInterface: ChromeUtils.generateQI([
            "nsIStreamListener", "nsIRequestObserver",
          ]),
          onStartRequest() {},
          onDataAvailable(request, stream, offset, count) {
            const binary = Cc["@mozilla.org/binaryinputstream;1"]
              .createInstance(Ci.nsIBinaryInputStream);
            binary.setInputStream(stream);
            const text = binary.readBytes(count);
            // A message with a 20 MB attachment is 27 MB of base64, and none
            // of it is anything the model can read. Reading it all built a
            // string and a typed array of that size on the main thread, which
            // is what made the assistant sit still on heavy messages. The
            // text parts of a message come before its attachments, so a cap
            // costs nothing that matters.
            if (read < LIMIT) {
              chunks.push(text);
              read += text.length;
            }
          },
          onStopRequest(request, status) {
            if (Components.isSuccessCode(status)) {
              resolve(chunks.join(""));
            } else {
              reject(new Error("không đọc được nội dung thư"));
            }
          },
        };
        service.streamMessage(uri, listener, null, null, false, "", false);
      } catch (e) {
        reject(e);
      }
    });
  },

  /**
   * Plain-text rendition of a message, small enough to send: headers the model
   * needs plus a body with markup and quoted history trimmed.
   */
  /**
   * The message as text the model can read: headers worth knowing, then the
   * body with the markup and the attachments gone.
   *
   * The extraction is mailinsight's, not a second copy of it. That one picks
   * the right MIME part, decodes it with the charset the message declares,
   * and turns entities back into letters — all of which this used to do
   * worse, and Vietnamese suffered for it.
   */
  async messageText(hdr) {
    const raw = await this.rawMessage(hdr);
    let body = "";
    try {
      body = hMailInsight.plainBody(raw);
    } catch (e) {
      const split = raw.search(BLANK_LINE);
      body = split >= 0 ? raw.slice(split + 2) : raw;
    }

    const limit = this.pref("hmail.ai.maxChars", 12000);
    if (body.length > limit) {
      body = body.slice(0, limit) + "\n\n[... nội dung đã được cắt bớt ...]";
    }

    // Attachments are described rather than sent: the model cannot open
    // them, and their bytes are the reason heavy messages failed at all.
    const attachments = [...raw.matchAll(FILENAME)]
      .map(m => m[1].trim()).filter(Boolean).slice(0, 12);

    return [
      `Từ: ${hdr.mime2DecodedAuthor || ""}`,
      `Đến: ${hdr.mime2DecodedRecipients || ""}`,
      `Tiêu đề: ${hdr.mime2DecodedSubject || ""}`,
      `Ngày: ${new Date(hdr.date / 1000).toLocaleString()}`,
      attachments.length
        ? `Tệp đính kèm: ${[...new Set(attachments)].join(", ")}`
        : "",
      "",
      body,
    ].filter(line => line !== "").join("\n");
  },

  // -------------------------------------------------------------- history
  // Conversations are kept per message, so reopening a message brings back
  // what was already asked about it.

  historyPath() {
    const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
    file.append(this.HISTORY_FILE);
    return file.path;
  },

  async loadHistory() {
    if (this._history) {
      return this._history;
    }
    try {
      const text = await IOUtils.readUTF8(this.historyPath());
      this._history = JSON.parse(text);
    } catch (e) {
      this._history = {};
    }
    return this._history;
  },

  async saveHistory() {
    try {
      await IOUtils.writeUTF8(this.historyPath(),
                              JSON.stringify(this._history || {}));
    } catch (e) {
      Cu.reportError("hMail AI: could not save history: " + e);
    }
  },

  messageKey(hdr) {
    return hdr?.messageId || `${hdr?.folder?.URI}#${hdr?.messageKey}`;
  },

  async conversationFor(hdr) {
    const history = await this.loadHistory();
    const key = this.messageKey(hdr);
    if (!history[key]) {
      history[key] = {
        subject: hdr?.mime2DecodedSubject || "",
        updated: Date.now(),
        turns: [],
      };
    }
    return history[key];
  },

  async remember(hdr, role, text) {
    const convo = await this.conversationFor(hdr);
    // Which service produced this. A conversation can span providers — a
    // question asked of Gemini, the next one of the on-device model — and
    // without this the transcript reads as one voice.
    convo.turns.push({
      role,
      text,
      at: Date.now(),
      service: role === "assistant" ? this.service() : undefined,
    });
    convo.updated = Date.now();
    if (convo.turns.length > this.MAX_HISTORY_MESSAGES) {
      convo.turns = convo.turns.slice(-this.MAX_HISTORY_MESSAGES);
    }
    await this.saveHistory();
  },

  async forget(hdr) {
    const history = await this.loadHistory();
    delete history[this.messageKey(hdr)];
    await this.saveHistory();
  },

  // ------------------------------------------------------------- provider

  /**
   * Send a conversation to the model. Returns the reply text.
   * Only Google Gemini is wired up; the shape is deliberately provider-shaped
   * so another can be added beside it.
   */
  /**
   * One round-trip to the model, normalised to Gemini's part shape:
   * [{text}] and/or [{functionCall:{name,args}}]. The OpenAI branch translates
   * both ways so the rest of the assistant does not care which service is in
   * use.
   */
  async call(contents, { tools } = {}) {
    // Answered here, before any talk of keys: nothing about the on-device
    // model involves an account.
    if (this.provider() === "local") {
      return this.callLocal(contents);
    }
    const key = this.apiKey();
    if (this.needsKey() && !key) {
      throw Object.assign(new Error("chưa có API key"), { code: "no_key" });
    }
    return this.provider() === "openai"
      ? this.callOpenAICompatible(contents, tools, key)
      : this.callGemini(contents, tools, key);
  },

  async fetchJSON(url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      throw Object.assign(new Error("không kết nối được máy chủ AI"),
                          { code: "network" });
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {}
    if (!res.ok) {
      const err = body?.error || {};
      throw Object.assign(
        new Error(err.message || `HTTP ${res.status}`),
        { status: res.status, code: err.status || err.type });
    }
    return body;
  },

  /**
   * Ghi payload request ra Error Console (Công cụ → Nhà phát triển → Error
   * Console / Ctrl+Shift+J) khi bật pref `hmail.ai.debug` = true. Dùng để kiểm
   * tra CHÍNH XÁC những gì gửi cho model — đặc biệt: đủ header (Từ/Đến/Tiêu đề/
   * Ngày) trong nội dung và system prompt — khi một dịch vụ (vd DeepSeek) trả
   * lời kém. Bật: about:config → hmail.ai.debug = true.
   */
  debugLog(shape, model, payload) {
    try {
      if (!this.pref("hmail.ai.debug", false)) return;
      const json = JSON.stringify(payload, null, 2);
      const clip = json.length > 20000
        ? json.slice(0, 20000) + "\n…(đã cắt bớt để xem log)"
        : json;
      Services.console.logStringMessage(
        `[hMail AI] gửi -> ${shape} (${model})\n${clip}`);
    } catch (e) {}
  },

  /**
   * The on-device model. It cannot call the assistant's tools — a half-billion
   * parameter model asked to emit a function call produces something that
   * looks like one and is not — so it answers in prose and nothing else.
   *
   * If the feature has not been switched on, the error carries code
   * "local_off" and the panel offers to open the setup page rather than
   * showing a failure the user cannot act on.
   */
  async callLocal(contents) {
    if (typeof hMailLocalAI === "undefined") {
      throw Object.assign(new Error("AI trên máy chưa sẵn sàng"),
                          { code: "local_off" });
    }
    const turns = contents.map(c => ({
      role: c.role === "model" ? "assistant" : "user",
      text: (c.parts || []).map(p => p.text || "").join(" ").trim(),
    })).filter(t => t.text);

    const text = await hMailLocalAI.generate(turns);
    // Token counts are meaningless here — nothing is billed — but the usage
    // line still wants numbers, and characters/4 is the usual rough guide.
    this.recordUsage(
      Math.round(turns.reduce((n, t) => n + t.text.length, 0) / 4),
      Math.round(text.length / 4));
    // The array itself, exactly as callGemini and callOpenAICompatible
    // return it. Handing back {parts, usage} instead was why ask() said
    // "parts.filter is not a function".
    return [{ text }];
  },

  async callGemini(contents, tools, key) {
    const url = `${this.endpoint()}/models/${this.model()}:generateContent` +
                `?key=${encodeURIComponent(key)}`;
    const payload = { contents };
    if (this.SYSTEM_PROMPT) {
      payload.systemInstruction = { parts: [{ text: this.SYSTEM_PROMPT }] };
    }
    if (tools) {
      payload.tools = tools;
    }
    this.debugLog("gemini", this.model(), payload);
    const body = await this.fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const used = body?.usageMetadata || {};
    this.recordUsage(used.promptTokenCount, used.candidatesTokenCount);
    return body?.candidates?.[0]?.content?.parts || [];
  },

  async callOpenAICompatible(contents, tools, key) {
    // Gemini "contents" -> OpenAI "messages".
    //
    // A system message goes first. Gemini infers the register from the
    // prompt; the OpenAI-protocol models — DeepSeek and Llama especially —
    // answer in English, or wander into pleasantries, unless told plainly
    // what they are and what shape the answer takes.
    const messages = [{
      role: "system",
      content:
        "Bạn là trợ lý trong ứng dụng thư hMail Desktop, làm việc với thư " +
        "công việc tiếng Việt và tiếng Anh.\n" +
        "- Luôn trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu ngôn " +
        "ngữ khác.\n" +
        "- Viết tiếng Việt có dấu đầy đủ, đúng chính tả; tuyệt đối không " +
        "viết tiếng Việt không dấu, kể cả khi thư gốc viết không dấu.\n" +
        "- Trả lời thẳng vào việc. Không mở đầu bằng lời chào hay lời cảm " +
        "ơn, không nhắc lại câu hỏi, không kết bằng lời mời hỏi thêm.\n" +
        "- Giữ nguyên số liệu, ngày tháng, tên riêng, địa chỉ email, số hóa " +
        "đơn và mã đơn hàng đúng như trong thư. Không suy đoán khi thư " +
        "không nói.\n" +
        "- Nếu thư có dấu hiệu lừa đảo hoặc mạo danh thì nói rõ ngay ở câu " +
        "đầu.",
    }];
    for (const c of contents) {
      const role = c.role === "model" ? "assistant" : "user";
      const calls = (c.parts || []).filter(p => p.functionCall);
      const results = (c.parts || []).filter(p => p.functionResponse);
      const text = (c.parts || []).map(p => p.text || "").join("");

      if (calls.length) {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: calls.map((p, i) => ({
            id: `call_${messages.length}_${i}`,
            type: "function",
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {}),
            },
          })),
        });
        continue;
      }
      if (results.length) {
        for (const r of results) {
          messages.push({
            role: "tool",
            tool_call_id: `call_${messages.length - 1}_0`,
            name: r.functionResponse.name,
            content: JSON.stringify(r.functionResponse.response),
          });
        }
        continue;
      }
      messages.push({ role, content: text });
    }

    // System prompt o dau danh sach — day la yeu to giup DeepSeek / model yeu
    // tra loi sat de va dung dinh dang hon han.
    if (this.SYSTEM_PROMPT) {
      messages.unshift({ role: "system", content: this.SYSTEM_PROMPT });
    }

    const payload = { model: this.model(), messages };
    this.debugLog("openai:" + this.service(), this.model(), payload);
    if (tools) {
      payload.tools = tools[0].functionDeclarations.map(f => ({
        type: "function",
        function: {
          name: f.name,
          description: f.description,
          parameters: f.parameters,
        },
      }));
    }

    const headers = { "Content-Type": "application/json" };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const body = await this.fetchJSON(
      `${this.endpoint().replace(/\/+$/, "")}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(payload) });

    const used = body?.usage || {};
    this.recordUsage(used.prompt_tokens, used.completion_tokens);

    // OpenAI message -> Gemini parts.
    const message = body?.choices?.[0]?.message || {};
    const parts = [];
    if (message.content) {
      parts.push({ text: message.content });
    }
    for (const call of message.tool_calls || []) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch (e) {}
      parts.push({ functionCall: { name: call.function?.name, args } });
    }
    return parts;
  },

  /**
   * Ask the model, letting it call actions. When it asks for one, the action
   * runs here and the result goes back so it can continue — up to a few
   * rounds, so a mistaken loop cannot run away.
   *
   * `onAction` is called with a human-readable line for each action performed.
   */
  async ask(turns, { win = null, onAction = null, allowActions = false } = {}) {
    const contents = turns.map(t => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.text }],
    }));
    // Only where hMail has seen the service call a tool correctly. A model
    // that emits something tool-shaped but wrong is worse than one that
    // cannot: it moves the wrong message to the wrong folder.
    const canAct = this.serviceDef().actions !== false;
    const tools = allowActions && win && canAct ? this.toolDeclarations() : null;

    this.lastUsage = { in: 0, out: 0 };
    let acted = false;

    for (let round = 0; round < 4; round++) {
      const parts = await this.call(contents, { tools });

      // Keep the model's own parts, not just the functionCall inside them.
      // Gemini attaches a thoughtSignature to each call and refuses the next
      // request if it is missing, so the parts must go back verbatim.
      const callParts = parts.filter(p => p.functionCall);
      const calls = callParts.map(p => p.functionCall);
      if (!calls.length) {
        const reply = parts.map(p => p.text || "").join("").trim();
        if (!reply) {
          // After carrying out an action some models simply stop rather than
          // narrating it. The transcript already shows what was done, so that
          // is an ending, not a failure.
          if (acted) {
            return "Đã thực hiện xong.";
          }
          throw new Error("máy chủ AI không trả về nội dung");
        }
        return reply;
      }

      // Echo the model's request, then answer each call.
      contents.push({ role: "model", parts: callParts });
      const responses = [];
      for (const call of calls) {
        const result = await this.runTool(win, call.name, call.args || {});
        acted = acted || result.ok;
        if (onAction) {
          onAction(result.ok
            ? `Đã thực hiện: ${result.done || call.name}`
            : `Không thực hiện được ${call.name}: ${result.error}`);
        }
        responses.push({
          functionResponse: { name: call.name, response: result },
        });
      }
      contents.push({ role: "user", parts: responses });
    }

    return "Đã dừng vì trợ lý yêu cầu quá nhiều hành động liên tiếp.";
  },

  explain(e) {
    switch (e?.code) {
      case "no_key":
        return "chưa nhập API key — mở phần cài đặt trong bảng trợ lý";
      case "local_off":
        return "AI trên máy chưa được kích hoạt";
      case "network":
        return "không kết nối được máy chủ AI";
      case "RESOURCE_EXHAUSTED":
        return "tài khoản AI đã hết hạn mức";
      case "PERMISSION_DENIED":
        return "API key không hợp lệ hoặc bị từ chối";
      case "NOT_FOUND":
        return `mô hình "${this.model()}" không còn khả dụng`;
      default:
        return e?.message || "lỗi không xác định";
    }
  },
};
