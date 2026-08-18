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
    "- NGOẠI LỆ khi được nhờ SOẠN NỘI DUNG THƯ (trả lời, viết hộ): viết " +
    "bằng đúng ngôn ngữ của thư gốc trừ khi người dùng chỉ định ngôn ngữ " +
    "khác — quy tắc tiếng Việt ở trên chỉ áp dụng cho phần trao đổi với " +
    "người dùng, không áp cho nội dung thư soạn hộ. Tương tự khi được nhờ " +
    "DỊCH: kết quả phải bằng ngôn ngữ đích được yêu cầu.\n" +
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
    "- Không thêm lời dẫn thừa, không nhắc lại đề bài.\n" +
    "- Bạn CÓ CÔNG CỤ để hành động thật (đánh dấu đọc, gắn cờ, gắn nhãn, " +
    "chuyển thư mục, lưu trữ, báo thư rác, mở thư TRẢ LỜI soạn sẵn, mở thư " +
    "MỚI soạn sẵn). Khi người dùng nhờ LÀM một việc — \"viết thư cho X\", " +
    "\"trả lời thư này\", \"gắn nhãn\", \"chuyển vào thư mục\" — hãy GỌI " +
    "công cụ tương ứng thay vì chỉ in nội dung ra khung trò chuyện.\n" +
    "- KHÔNG cần người dùng mở thư mới làm việc được: khi họ hỏi \"hôm nay " +
    "có việc gì\", \"có thư mới nào\", \"tìm thư của X\"… hãy dùng " +
    "search_messages (lọc theo từ khoá/ngày/chưa đọc), rồi read_message để " +
    "đọc nội dung các thư đáng chú ý và tổng hợp; open_message khi người " +
    "dùng muốn xem tận mắt. Tuyệt đối không bảo người dùng \"cung cấp nội " +
    "dung hộp thư\" — bạn tự tra được. Quy trình tổng hợp đúng: " +
    "search_messages KHÔNG kèm từ khoá trước (lấy toàn cảnh), rồi " +
    "read_message 3–5 thư đáng chú ý nhất, rồi mới kết luận kèm nguồn. " +
    "Kết quả rỗng thì nói rõ đã tìm khoảng thời gian nào, đừng suy diễn.\n" +
    "- XỬ LÝ HÀNG LOẠT (xoá/chuyển/gắn nhãn cả một nhóm thư): dùng " +
    "filter_messages để đổ từ khoá vào ô lọc nhanh — danh sách trên màn " +
    "hình thu lại đúng nhóm thư, người dùng nhìn thấy; báo số lượng và hỏi " +
    "xác nhận; rồi act_on_filtered để làm một lần cho tất cả. KHÔNG bao giờ " +
    "bảo người dùng \"tự thao tác thủ công\" — bạn làm được.\n" +
    "- Khi bạn hỏi người dùng chọn giữa vài hướng xử lý, KẾT THÚC câu trả " +
    "lời bằng đúng một dòng dạng [[chọn: Lựa chọn 1 | Lựa chọn 2 | Lựa " +
    "chọn 3]] (tối đa 5 mục, mỗi mục là một câu lệnh ngắn người dùng có " +
    "thể gửi nguyên văn, ví dụ [[chọn: Chuyển 524 thư vào Thùng rác | " +
    "Đánh dấu đã đọc | Chuyển sang thư mục khác | Thôi]]) — hMail vẽ chúng " +
    "thành nút bấm sẵn. Không dùng khối này khi không có lựa chọn thật.\n" +
    "- \"Nhắc tôi…\", \"nhắc lại hằng ngày\", \"đừng để tôi quên\", \"theo " +
    "dõi việc này\" = set_reminder (lời nhắc có báo thức trong Lịch, lặp " +
    "hằng ngày/tuần được). KHÔNG dùng bộ lọc thư hay gắn cờ thay cho lời " +
    "nhắc — bộ lọc chỉ sắp xếp thư đến, không nhắc ai cả.\n" +
    "- \"Từ giờ / tự động / mỗi khi thư của X đến thì…\" = tạo BỘ LỌC lâu " +
    "dài bằng create_filter (điều kiện người gửi/tiêu đề/người nhận chứa; " +
    "hành động chuyển thư mục/gắn nhãn/đánh dấu đọc/xoá/gắn cờ). Khác với " +
    "act_on_filtered chỉ làm một lần cho thư đã có.",

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
    // Dịch vụ demo trên hạ tầng HQV: khách đăng nhập bằng chính hộp thư
    // (auth: "email" — Basic auth bằng email + mật khẩu email, không API
    // key). Đứng đầu mảng nên cũng là fallback của serviceDef() và là mặc
    // định cho bản cài mới (hmail.cfg). HQV trả tiền hạ tầng — hạn mức do
    // máy chủ quyết, client chỉ cần thuật lại lỗi 429 cho tử tế.
    // Endpoint KHÔNG cố định: dịch vụ chạy ngay trên máy chủ thư của từng
    // tài khoản (https://<mail-host>/ai/v1), đăng nhập bằng chính email +
    // mật khẩu hộp thư. Ô endpoint để trống = tự suy từ tài khoản; điền
    // vào chỉ khi máy chủ AI đứng riêng.
    { id: "hqv", label: "hMail AI services (HQV)", provider: "openai",
      endpoint: "", model: "hmail-default",
      key: false, auth: "email", priceIn: 0, priceOut: 0, actions: true,
      tested: true, where: "máy chủ thư của chính tài khoản (mail.<miền>/ai)" },
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
    // Nhật ký từng lượt gọi — trang Chi phí AI đọc lại toàn bộ lịch sử.
    this.appendUsageLog({ in: input, out: output });
  },

  USAGE_LOG: "hmail-ai-usage.jsonl",

  usageLogPath() {
    const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
    file.append(this.USAGE_LOG);
    return file.path;
  },

  /**
   * Ghi một dòng JSON vào nhật ký chi phí: thời điểm, dịch vụ, model,
   * token vào/ra, chi phí ước tính, tính năng đang dùng và tiêu đề thư
   * (nếu có). Ghi nối tiếp — không đọc lại file, hộp thư dùng lâu năm vẫn
   * nhẹ. Bối cảnh (feature/subject) do nơi gọi đặt qua this.usageContext
   * trước khi ask().
   */
  appendUsageLog(counters) {
    try {
      const id = this.service();
      const def = this.serviceDef(id);
      const line = JSON.stringify({
        t: Date.now(),
        service: id,
        label: def.label,
        model: this.svcPref("model", def.model || "", id),
        in: counters.in,
        out: counters.out,
        cost: this.cost(counters, id),
        feature: this.usageContext?.feature || "chat",
        subject: String(this.usageContext?.subject || "").slice(0, 120),
      }) + "\n";
      // Nối tiếp bằng hàng đợi promise: hai lượt gọi liền nhau không giẫm
      // lên nhau. IOUtils.writeUTF8 mode "append" ở bản Gecko này không
      // ghi được (file không hề được tạo) — dùng write byte với mode
      // append của IOUtils.write, có kiểm tra lỗi ra pref để không mù.
      const bytes = new TextEncoder().encode(line);
      this._usageQueue = (this._usageQueue || Promise.resolve()).then(() =>
        IOUtils.write(this.usageLogPath(), bytes, { mode: "append" })
      ).catch(async e => {
        try {
          // Rơi về đọc-nối-ghi khi mode append không được hỗ trợ.
          let old = new Uint8Array(0);
          try {
            old = await IOUtils.read(this.usageLogPath());
          } catch (e2) {}
          const merged = new Uint8Array(old.length + bytes.length);
          merged.set(old, 0);
          merged.set(bytes, old.length);
          await IOUtils.write(this.usageLogPath(), merged);
        } catch (e3) {
          try {
            Services.prefs.setCharPref("hmail.debug.usagelog",
                                       "err: " + (e3.message || e3));
          } catch (e4) {}
        }
      });
    } catch (e) {
      try {
        Services.prefs.setCharPref("hmail.debug.usagelog",
                                   "err-sync: " + (e.message || e));
      } catch (e2) {}
    }
  },

  /** Đọc toàn bộ nhật ký (mới nhất trước); dòng hỏng bị bỏ qua. */
  async readUsageLog() {
    try {
      const text = await IOUtils.readUTF8(this.usageLogPath());
      const out = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          out.push(JSON.parse(line));
        } catch (e) {}
      }
      return out.reverse();
    } catch (e) {
      return [];
    }
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
    // Đăng nhập bằng chính hộp thư (hMail AI services): không có API key.
    if (this.serviceDef().auth === "email") {
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

  /**
   * Đăng nhập hMail AI services bằng chính hộp thư: email lấy từ pref
   * hmail.ai.svc.hqv.account (mặc định: identity của tài khoản mặc định),
   * mật khẩu đọc thẳng từ incoming server đã lưu — không sao chép vào đâu
   * cả, mỗi request đọc lại một lần.
   */
  /**
   * Endpoint AI của một tài khoản: dịch vụ chạy trên chính máy chủ thư —
   * https://<hostName IMAP/POP>/ai/v1. Người dùng điền endpoint riêng trong
   * Cài đặt thì dùng cái đó cho mọi tài khoản.
   */
  mailAiEndpoint(server) {
    let custom = String(this.svcPref("endpoint", "", "hqv") || "").trim();
    // Hồ sơ cũ còn lưu endpoint mặc định đời trước (máy chủ AI chung) —
    // đó không phải lựa chọn của người dùng, xoá để tự suy theo tài khoản.
    if (/^https?:\/\/aiservices\.hqv\.biz(\/v1)?\/?$/i.test(custom)) {
      try {
        Services.prefs.clearUserPref("hmail.ai.svc.hqv.endpoint");
      } catch (e) {}
      custom = "";
    }
    if (custom) {
      return custom.replace(/\/+$/, "");
    }
    const host = String(server?.hostName || "").trim();
    if (!host) {
      return "";
    }
    return `https://${host}/ai/v1`;
  },

  /**
   * Mật khẩu đã lưu của một incoming server. server.password chỉ là cache
   * trong phiên — app mới mở thì rỗng dù người dùng đã "Ghi nhớ mật khẩu";
   * bản lưu thật nằm trong login manager dưới origin imap://host (POP3:
   * mailbox://host), đúng như Thunderbird cất khi nhận thư.
   */
  serverPassword(server) {
    const cached = server.password;
    if (cached) {
      return cached;
    }
    try {
      const scheme = server.type === "pop3" ? "mailbox" : server.type;
      const origin = `${scheme}://${server.hostName}`;
      const logins = Services.logins.findLogins(origin, null, origin);
      const hit = logins.find(l => l.username === server.username) ||
                  logins[0];
      return hit?.password || "";
    } catch (e) {
      return "";
    }
  },

  /**
   * Tài khoản dùng để đăng nhập dịch vụ AI-trên-máy-chủ-thư. Ưu tiên theo
   * NGỮ CẢNH ĐANG LÀM VIỆC (thư đang mở / hộp thư đang mở) — mỗi máy chủ
   * chỉ xác thực được tài khoản của nó; rồi tới tài khoản người dùng chỉ
   * định; rồi tài khoản mặc định có mật khẩu.
   */
  mailCredentials(context = null) {
    const wanted = this.svcPref("account", "", "hqv");
    // Chế độ "một tài khoản cho tất cả": người dùng có một hộp thư HQV và
    // vài hộp thư ngoài (Gmail…) muốn AI của hộp thư HQV lo hết — bỏ qua
    // ngữ cảnh, luôn đăng nhập bằng tài khoản đã chọn.
    const forAll = this.svcPref("scope", "context", "hqv") === "all";
    if (forAll) {
      context = null;
    }
    const candidates = [];
    for (const server of MailServices.accounts.allServers) {
      if (!["imap", "pop3"].includes(server.type)) {
        continue;
      }
      const account = MailServices.accounts.findAccountForServer(server);
      const identity = (account?.defaultIdentity?.email || "")
        .trim().toLowerCase();
      const user = String(server.username || "").trim().toLowerCase();
      candidates.push({
        server,
        email: identity || user,
        matches: e => e && (e === identity || e === user),
        isDefault: account === MailServices.accounts.defaultAccount,
      });
    }

    // Ngữ cảnh: server của thư/thư mục đang mở — đúng máy chủ đang giữ
    // hộp thư này, và là máy chủ duy nhất xác thực được nó.
    const ctxServer = context?.server ||
      context?.folder?.server || context?.hdr?.folder?.server || null;
    if (ctxServer) {
      const picked = candidates.find(c => c.server === ctxServer);
      if (picked) {
        const password = this.serverPassword(picked.server);
        if (password) {
          return { email: picked.email, password, server: picked.server };
        }
        throw Object.assign(
          new Error("tài khoản " + picked.email + " chưa lưu mật khẩu"),
          { code: "no_mail_pass", email: picked.email });
      }
    }

    // Người dùng chỉ định tài khoản nào thì đúng tài khoản đó, kể cả khi nó
    // chưa lưu mật khẩu — báo lỗi rõ còn hơn lặng lẽ dùng hộp thư khác.
    if (wanted) {
      const picked = candidates.find(c => c.matches(wanted.toLowerCase()));
      const password = picked ? this.serverPassword(picked.server) : "";
      if (password) {
        return { email: wanted.toLowerCase(), password, server: picked.server };
      }
      throw Object.assign(
        new Error("tài khoản " + wanted + " chưa lưu mật khẩu"),
        { code: "no_mail_pass" });
    }

    // Chưa chỉ định: tài khoản mặc định nếu nó có mật khẩu lưu, không thì
    // tài khoản ĐẦU TIÊN có mật khẩu — hồ sơ hay có tài khoản kỹ thuật
    // (spam-report…) đứng làm mặc định mà không lưu mật khẩu bao giờ.
    const usable = c => c.email && this.serverPassword(c.server);
    const chosen = candidates.find(c => c.isDefault && usable(c)) ||
                   candidates.find(usable);
    if (chosen) {
      return { email: chosen.email,
               password: this.serverPassword(chosen.server),
               server: chosen.server };
    }
    throw Object.assign(
      new Error("chưa có tài khoản thư nào lưu mật khẩu"),
      { code: "no_mail_pass" });
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

      const tabmail = win.document.getElementById("tabmail");
      if (!tabmail) {
        return null;
      }

      // A message opened in its own TAB (mode "mailMessageTab") has no row
      // selected in the 3-pane's gDBView — that view belongs to whichever
      // 3-pane tab is behind it, not to this tab. currentAboutMessage is the
      // one accessor Thunderbird exposes for the about:message window in
      // both tab modes: the reading pane embedded in a 3-pane tab, or the
      // standalone message tab's own browser. Reading gMessage off it covers
      // both without caring which mode the current tab is in.
      const aboutMessage = tabmail.currentAboutMessage;
      if (aboutMessage?.gMessage) {
        return aboutMessage.gMessage;
      }

      // Fall back to the 3-pane's selected row — covers a 3-pane tab whose
      // reading pane is collapsed, where currentAboutMessage has no message
      // loaded even though a row is highlighted. Asking for the first
      // selected message with nothing selected throws; see the note in
      // mailinsight.selected().
      const view = tabmail.currentAbout3Pane?.gDBView;
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

  /**
   * Các tính năng NGOÀI panel (dịch thư, trả lời nhanh, soạn hộ trong
   * composer…) cũng phải để lại vết trong hMail AI của đúng thư đó — mở
   * panel là thấy lại thư này đã được AI làm gì, đọc lại được kết quả.
   * Ghi vào lịch sử chung rồi vẽ lại panel nào đang mở đúng thư.
   */
  async logFeature(hdr, userText, assistantText) {
    try {
      if (!hdr || !userText) {
        return;
      }
      // Đọc lại file trước khi ghi: mỗi cửa sổ giữ một bản cache của cùng
      // một file lịch sử — không đọc lại là cửa sổ này đè mất lượt cửa sổ
      // kia vừa ghi (composer và 3-pane là hai cửa sổ khác nhau).
      this._history = null;
      await this.remember(hdr, "user", String(userText).slice(0, 2000));
      if (assistantText) {
        await this.remember(hdr, "assistant",
                            String(assistantText).slice(0, 8000));
      }
      for (const type of ["mail:3pane", "mail:messageWindow"]) {
        const win = Services.wm.getMostRecentWindow(type);
        const ai = win?.hMailAI;
        try {
          const current = ai?.selectedMessage?.(win);
          if (current && ai.messageKey(current) === this.messageKey(hdr) &&
              win.document.getElementById("hmail-ai-log")) {
            ai._history = null;
            ai.restore(win);
          }
        } catch (e) {}
      }
    } catch (e) {
      Cu.reportError("hMail AI logFeature failed: " + e);
    }
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
    let base = this.endpoint().replace(/\/+$/, "");
    if (this.serviceDef().auth === "email") {
      // hMail AI services: đăng nhập bằng chính hộp thư — Basic auth,
      // đọc mật khẩu đã lưu ngay lúc gọi, không giữ lại ở đâu. Endpoint
      // là máy chủ thư của đúng tài khoản đang làm việc.
      const cred = this.mailCredentials(this.usageContext?.scope || null);
      headers.Authorization = "Basic " + btoa(
        unescape(encodeURIComponent(cred.email + ":" + cred.password)));
      base = this.mailAiEndpoint(cred.server) || base;
      if (!base) {
        throw Object.assign(
          new Error("không xác định được máy chủ AI của tài khoản " + cred.email),
          { code: "no_ai_endpoint", email: cred.email });
      }
      this._lastAiAccount = cred.email;
    } else if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const body = await this.fetchJSON(
      `${base}/chat/completions`,
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
        // hMail AI services (đăng nhập bằng hộp thư): lỗi HTTP phải được đọc
    // theo NGỮ CẢNH tài khoản trước khi rơi vào các mã chung của provider.
    if (this.serviceDef().auth === "email") {
      const who = this._lastAiAccount ? ` (${this._lastAiAccount})` : "";
      if (e?.status === 401 || e?.status === 403) {
        return "máy chủ thư không chấp nhận đăng nhập AI của tài khoản" + who +
               " — kiểm tra mật khẩu hộp thư, hoặc tài khoản chưa được mở " +
               "dịch vụ AI";
      }
      if (e?.status === 404 || e?.code === "network" ||
          e?.code === "NOT_FOUND") {
        return "máy chủ thư của tài khoản" + who + " chưa bật dịch vụ hMail " +
               "AI (không có mail.<miền>/ai) — dịch vụ này chỉ dùng được với " +
               "hộp thư trên máy chủ HQV; với tài khoản khác hãy chọn nhà " +
               "cung cấp AI khác trong Cài đặt trợ lý";
      }
    }
    switch (e?.code) {
      case "no_key":
        return "chưa nhập API key — mở phần cài đặt trong bảng trợ lý";
      case "no_mail_pass":
        return "hMail AI services đăng nhập bằng tài khoản thư của bạn, " +
               "nhưng tài khoản chưa lưu mật khẩu trong hMail (" +
               (e.message || "") + "). Hãy nhận thư một lần và chọn " +
               "\"Ghi nhớ mật khẩu\", hoặc chọn dịch vụ khác trong cài đặt.";
      case "no_ai_endpoint":
        return "không xác định được máy chủ AI cho tài khoản " +
               (e.email || "") + " — điền endpoint riêng trong Cài đặt trợ lý " +
               "nếu máy chủ AI không nằm trên máy chủ thư.";
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
