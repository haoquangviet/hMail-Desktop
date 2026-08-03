/* hMail Desktop — AI chạy trên máy, không cần API key
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Not every useful thing an assistant does needs a large language model or a
 * paid API. Turning a message into a vector — an embedding — is enough for the
 * three problems that matter most in a mailbox, and a 384-dimension model
 * small enough to run on any office machine does it in milliseconds:
 *
 *   Tìm theo ý nghĩa   — "hợp đồng tháng trước" finds a message that says
 *                        "thỏa thuận dịch vụ quý 1", with no shared keyword.
 *   Gom nhóm hội thoại — messages about the same thing cluster together by
 *                        vector distance, whatever their subject lines say.
 *   Phân loại nhanh    — cosine similarity against a handful of examples is a
 *                        classifier, without a training run.
 *
 * The runtime is already in the application: Gecko ships ONNX Runtime and the
 * transformers pipeline for its own features, so hMail adds no binaries. The
 * model is NOT shipped in the installer — the user chooses it, hMail downloads
 * it from Mozilla's model hub on request, and it is cached on their machine.
 * Vectors live in an SQLite file in the profile. Nothing leaves the computer.
 */

"use strict";

var hMailLocalAI = {
  ENABLED_PREF: "hmail.localai.enabled",
  MODEL_PREF: "hmail.localai.model",
  DTYPE_PREF: "hmail.localai.dtype",
  DB_FILE: "hmail-vectors.sqlite",

  /**
   * What we offer to download. Both are all-MiniLM-L6-v2 — the same weights,
   * quantised or not. The quantised build is a quarter of the size and about
   * as good for search; the full one is there for anyone who would rather
   * have the extra accuracy.
   */
  MODELS: [
    {
      id: "Xenova/all-MiniLM-L6-v2",
      dtype: "q8",
      dim: 384,
      label: "all-MiniLM-L6-v2 — bản rút gọn",
      size: "khoảng 16 MB",
      note: "Đủ tốt cho tìm kiếm và gom nhóm, tải nhanh, chạy nhẹ.",
    },
    {
      id: "Xenova/all-MiniLM-L6-v2",
      dtype: "fp32",
      dim: 384,
      label: "all-MiniLM-L6-v2 — bản đầy đủ",
      size: "khoảng 83 MB",
      note: "Chính xác hơn một chút, vẫn chạy được trên máy văn phòng.",
    },
  ],

  /**
   * Models that write, as opposed to the ones above that only turn text into
   * vectors. A vector model cannot answer a question or draft a reply, so
   * running the assistant on this machine needs one of these as well.
   *
   * These are small on purpose. A model that fits in the memory of an office
   * laptop will not write like Gemini; it summarises and drafts short replies
   * in Vietnamese acceptably, and it never sends the message anywhere.
   */
  CHAT_MODELS: [
    {
      id: "Xenova/Qwen1.5-0.5B-Chat",
      dtype: "q4",
      label: "Qwen 0.5B — nhẹ nhất",
      size: "khoảng 350 MB",
      note: "Chạy được trên hầu hết máy. Trả lời ngắn, đủ dùng cho tóm tắt.",
    },
    {
      id: "Xenova/Qwen1.5-1.8B-Chat",
      dtype: "q4",
      label: "Qwen 1.8B — cân bằng",
      size: "khoảng 1,1 GB",
      note: "Viết tiếng Việt tự nhiên hơn. Cần khoảng 4 GB RAM trống.",
    },
  ],

  CHAT_ENABLED_PREF: "hmail.localai.chat.enabled",
  CHAT_MODEL_PREF: "hmail.localai.chat.model",

  // ------------------------------------------------------------ cấu hình

  pref(name, fallback) {
    try {
      return typeof fallback === "boolean"
        ? Services.prefs.getBoolPref(name)
        : Services.prefs.getCharPref(name);
    } catch (e) {
      return fallback;
    }
  },

  enabled() {
    return this.pref(this.ENABLED_PREF, false);
  },

  model() {
    const id = this.pref(this.MODEL_PREF, this.MODELS[0].id);
    const dtype = this.pref(this.DTYPE_PREF, this.MODELS[0].dtype);
    return this.MODELS.find(m => m.id === id && m.dtype === dtype) ||
           this.MODELS[0];
  },

  /**
   * Whether this machine can run it at all. The ML runtime refuses below its
   * own thresholds, and saying so up front is kinder than a failed download.
   */
  capability(win) {
    let memoryGB = 0;
    let cores = 0;
    try {
      const utils = Cc["@mozilla.org/ml-utils;1"].getService(Ci.nsIMLUtils);
      memoryGB = Math.round(utils.totalPhysicalMemory / (1024 ** 3));
    } catch (e) {}
    if (!memoryGB) {
      try {
        memoryGB = Math.round(
          Services.sysinfo.getProperty("memsize") / (1024 ** 3));
      } catch (e) {}
    }
    // sysinfo's cpucount is not populated on every platform; the window's
    // hardwareConcurrency always is.
    try {
      cores = win?.navigator?.hardwareConcurrency || 0;
    } catch (e) {}
    if (!cores) {
      try {
        cores = Services.sysinfo.getProperty("cpucount") || 0;
      } catch (e) {}
    }
    return {
      memoryGB,
      cores,
      ok: memoryGB >= 4 && cores >= 2,
    };
  },

  // ------------------------------------------------- kênh cấu hình Mozilla

  /**
   * The ONNX runtime itself is delivered through Mozilla's Remote Settings
   * channel, which hMail keeps switched off — nothing should talk to Mozilla
   * unless the user asked for something that needs it. Switching on the
   * on-device AI is exactly that request, so the channel is opened here and
   * closed again when the feature is turned off.
   */
  SETTINGS_PREF: "services.settings.server",
  SETTINGS_SERVER: "https://firefox.settings.services.mozilla.com/v1",

  settingsChannelOpen() {
    return !!this.pref(this.SETTINGS_PREF, "");
  },

  openSettingsChannel() {
    try {
      Services.prefs.setCharPref(this.SETTINGS_PREF, this.SETTINGS_SERVER);
    } catch (e) {}
  },

  closeSettingsChannel() {
    try {
      Services.prefs.setCharPref(this.SETTINGS_PREF, "");
    } catch (e) {}
  },

  // --------------------------------------------------------------- engine

  /**
   * Bring the engine up, downloading the model the first time. `onProgress`
   * receives a 0–100 number so the settings pane can show where it is.
   */
  async engine(onProgress) {
    if (this._engine) {
      return this._engine;
    }
    const { createEngine } = ChromeUtils.importESModule(
      "chrome://global/content/ml/EngineProcess.sys.mjs");
    const model = this.model();

    this._engine = await createEngine(
      {
        taskName: "feature-extraction",
        featureId: "simple-text-embedder",
        modelId: model.id,
        modelRevision: "main",
        dtype: model.dtype,
        timeoutMS: -1,
        numThreads: 2,
      },
      data => {
        if (!onProgress) {
          return;
        }
        try {
          // The runtime reports bytes for each file it fetches.
          if (data?.total) {
            onProgress(Math.round((data.currentBytes || 0) /
                                  data.total * 100));
          } else if (typeof data?.progress === "number") {
            onProgress(Math.round(data.progress));
          }
        } catch (e) {}
      });
    return this._engine;
  },

  async shutdown() {
    try {
      await this._engine?.terminate?.();
    } catch (e) {}
    this._engine = null;
    try {
      await this._chatEngine?.terminate?.();
    } catch (e) {}
    this._chatEngine = null;
  },

  // ------------------------------------------------------- trả lời tại chỗ

  chatModel() {
    const id = this.pref(this.CHAT_MODEL_PREF, this.CHAT_MODELS[0].id);
    return this.CHAT_MODELS.find(m => m.id === id) || this.CHAT_MODELS[0];
  },

  chatReady() {
    return this.pref(this.CHAT_ENABLED_PREF, false);
  },

  /** Leave the machine enough cores to stay usable while the model runs. */
  threads(win) {
    const cores = this.capability(win).cores || 2;
    return Math.max(1, Math.min(4, cores - 1));
  },

  async chatEngine(onProgress) {
    if (this._chatEngine) {
      return this._chatEngine;
    }
    const { createEngine } = ChromeUtils.importESModule(
      "chrome://global/content/ml/EngineProcess.sys.mjs");
    const model = this.chatModel();
    this._chatEngine = await createEngine(
      {
        taskName: "text-generation",
        featureId: "hmail-local-chat",
        modelId: model.id,
        modelRevision: "main",
        dtype: model.dtype,
        timeoutMS: -1,
        numThreads: this.threads(),
      },
      data => {
        if (!onProgress) {
          return;
        }
        try {
          if (data?.total) {
            onProgress(Math.round((data.currentBytes || 0) / data.total * 100));
          } else if (typeof data?.progress === "number") {
            onProgress(Math.round(data.progress));
          }
        } catch (e) {}
      });
    return this._chatEngine;
  },

  /**
   * Answer a conversation on this machine. `turns` uses the same shape the
   * rest of the assistant speaks: [{role, text}].
   */
  async generate(turns, { maxTokens = 512 } = {}) {
    if (!this.chatReady()) {
      throw Object.assign(new Error("AI trên máy chưa được bật"),
                          { code: "local_off" });
    }
    const engine = await this.chatEngine();
    const messages = turns.map(t => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: String(t.text || ""),
    }));
    const out = await engine.run({
      args: [messages],
      options: {
        max_new_tokens: maxTokens,
        do_sample: false,
        return_full_text: false,
      },
    });
    return this.answerText(out);
  },

  /** The runtime returns a few different shapes depending on the pipeline. */
  answerText(out) {
    const pick = value => {
      if (typeof value === "string") {
        return value;
      }
      if (Array.isArray(value)) {
        return pick(value[value.length - 1]);
      }
      if (value && typeof value === "object") {
        if (typeof value.generated_text === "string") {
          return value.generated_text;
        }
        if (Array.isArray(value.generated_text)) {
          const last = value.generated_text[value.generated_text.length - 1];
          return typeof last === "string" ? last : (last?.content || "");
        }
        if (typeof value.content === "string") {
          return value.content;
        }
      }
      return "";
    };
    return pick(out).trim();
  },

  /** One vector for one piece of text. */
  async embed(text) {
    const engine = await this.engine();
    const out = await engine.run({
      args: [String(text).slice(0, 4000)],
      options: { pooling: "mean", normalize: true },
    });
    return this.flatten(out);
  },

  /** Vectors for a batch — much faster than one call per message. */
  async embedMany(texts) {
    const engine = await this.engine();
    const out = await engine.run({
      args: [texts.map(t => String(t).slice(0, 4000))],
      options: { pooling: "mean", normalize: true, max_length: 256 },
    });
    let rows = out;
    if (Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) &&
        rows[0].length !== this.model().dim) {
      rows = rows[0];
    }
    return rows.map(r => this.flatten(r));
  },

  /** The runtime returns tensors nested a level or two deep; unwrap them. */
  flatten(value) {
    let v = value;
    while (Array.isArray(v) && v.length === 1 && Array.isArray(v[0])) {
      v = v[0];
    }
    return Float32Array.from(v);
  },

  // ------------------------------------------------------------ kho vector

  async db() {
    if (this._db) {
      return this._db;
    }
    const { Sqlite } = ChromeUtils.importESModule(
      "resource://gre/modules/Sqlite.sys.mjs");
    const file = PathUtils.join(PathUtils.profileDir, this.DB_FILE);
    const conn = await Sqlite.openConnection({ path: file });
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS vectors (
        folder   TEXT NOT NULL,
        msgkey   INTEGER NOT NULL,
        messageid TEXT,
        subject  TEXT,
        author   TEXT,
        date     INTEGER,
        dim      INTEGER NOT NULL,
        vec      BLOB NOT NULL,
        PRIMARY KEY (folder, msgkey)
      )`);
    await conn.execute(
      "CREATE INDEX IF NOT EXISTS vectors_date ON vectors(date)");
    this._db = conn;
    return conn;
  },

  async closeDb() {
    try {
      await this._db?.close();
    } catch (e) {}
    this._db = null;
  },

  /** Float32Array <-> BLOB, so a 384-vector costs 1.5 KB and no parsing. */
  toBlob(vec) {
    return new Uint8Array(vec.buffer.slice(0));
  },

  fromBlob(blob) {
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    return new Float32Array(bytes.buffer, bytes.byteOffset,
                            bytes.byteLength / 4);
  },

  async count() {
    try {
      const conn = await this.db();
      const rows = await conn.execute("SELECT COUNT(*) AS n FROM vectors");
      return rows[0].getResultByName("n");
    } catch (e) {
      return 0;
    }
  },

  async clear() {
    try {
      const conn = await this.db();
      await conn.execute("DELETE FROM vectors");
    } catch (e) {}
  },

  // ------------------------------------------------------------- lập chỉ mục

  /** What of a message we turn into a vector. */
  async textOf(hdr) {
    const subject = hdr.mime2DecodedSubject || "";
    const author = hdr.mime2DecodedAuthor || "";
    let body = "";
    try {
      body = await hMailAI.messageText(hdr);
    } catch (e) {}
    return `${subject}\n${author}\n${String(body).slice(0, 3000)}`.trim();
  },

  /**
   * Index a folder in batches. `onStep(done, total)` drives the progress
   * line; the caller can stop by returning false from it.
   */
  async indexFolder(win, folder, onStep) {
    const conn = await this.db();
    const headers = [];
    try {
      for (const hdr of folder.messages) {
        headers.push(hdr);
      }
    } catch (e) {}

    const done = new Set();
    try {
      const rows = await conn.execute(
        "SELECT msgkey FROM vectors WHERE folder = :f",
        { f: folder.URI });
      for (const row of rows) {
        done.add(row.getResultByName("msgkey"));
      }
    } catch (e) {}

    const todo = headers.filter(h => !done.has(h.messageKey));
    const BATCH = 8;
    let processed = 0;

    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH);
      let texts;
      try {
        texts = await Promise.all(slice.map(h => this.textOf(h)));
      } catch (e) {
        continue;
      }
      let vectors;
      try {
        vectors = await this.embedMany(texts);
      } catch (e) {
        throw new Error("không tạo được vector: " + (e.message || e));
      }

      for (let j = 0; j < slice.length; j++) {
        const hdr = slice[j];
        const vec = vectors[j];
        if (!vec || !vec.length) {
          continue;
        }
        try {
          await conn.execute(
            `INSERT OR REPLACE INTO vectors
               (folder, msgkey, messageid, subject, author, date, dim, vec)
             VALUES (:folder, :key, :mid, :subject, :author, :date, :dim,
                     :vec)`,
            {
              folder: folder.URI,
              key: hdr.messageKey,
              mid: hdr.messageId || "",
              subject: hdr.mime2DecodedSubject || "",
              author: hdr.mime2DecodedAuthor || "",
              date: hdr.dateInSeconds || 0,
              dim: vec.length,
              vec: this.toBlob(vec),
            });
        } catch (e) {}
      }

      processed += slice.length;
      if (onStep && onStep(processed, todo.length) === false) {
        break;
      }
      // Let the interface breathe between batches.
      await new Promise(r => win.setTimeout(r, 0));
    }
    return { indexed: processed, skipped: headers.length - todo.length };
  },

  // -------------------------------------------------------------- tìm kiếm

  /** Both vectors are normalised, so the dot product is the cosine. */
  similarity(a, b) {
    let sum = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  },

  /** Messages closest in meaning to a query, best first. */
  async search(query, limit = 25) {
    const wanted = await this.embed(query);
    const conn = await this.db();
    const rows = await conn.execute(
      "SELECT folder, msgkey, subject, author, date, vec FROM vectors");

    const scored = [];
    for (const row of rows) {
      const vec = this.fromBlob(row.getResultByName("vec"));
      scored.push({
        folder: row.getResultByName("folder"),
        msgkey: row.getResultByName("msgkey"),
        subject: row.getResultByName("subject"),
        author: row.getResultByName("author"),
        date: row.getResultByName("date"),
        score: this.similarity(wanted, vec),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  },

  /** Messages closest in meaning to one you are reading. */
  async similarTo(hdr, limit = 10) {
    const vec = await this.embed(await this.textOf(hdr));
    const conn = await this.db();
    const rows = await conn.execute(
      "SELECT folder, msgkey, subject, author, date, vec FROM vectors");

    const scored = [];
    for (const row of rows) {
      const key = row.getResultByName("msgkey");
      const folder = row.getResultByName("folder");
      if (folder === hdr.folder?.URI && key === hdr.messageKey) {
        continue;
      }
      scored.push({
        folder,
        msgkey: key,
        subject: row.getResultByName("subject"),
        author: row.getResultByName("author"),
        date: row.getResultByName("date"),
        score: this.similarity(vec, this.fromBlob(row.getResultByName("vec"))),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  },

  /** Open one of the results in the 3-pane. */
  reveal(win, result) {
    try {
      const folder = MailServices.folderLookup.getFolderForURL(result.folder);
      const hdr = folder?.GetMessageHeader(result.msgkey);
      if (!hdr) {
        return false;
      }
      const tabmail = win.document.getElementById("tabmail");
      tabmail.openTab("mailMessageTab",
                      { messageURI: folder.getUriForMsg(hdr) });
      return true;
    } catch (e) {
      return false;
    }
  },
};
