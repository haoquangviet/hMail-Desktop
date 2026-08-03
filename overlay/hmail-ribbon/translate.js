/* hMail Desktop — dịch thư ngay trong nội dung thư
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * A translation shown in a side panel is a translation you read twice: once
 * to find your place in the original, once to read the sentence. The point of
 * translating a message is to read the message, so the translation replaces
 * the body where the body is, and a bar at the top says which version is on
 * screen and offers the other one.
 *
 * Translations are kept. Asking a paid model to translate the same message
 * again because the reader scrolled away and came back is a waste of their
 * money, so the result is stored per message and per language and reused
 * until they press "Dịch lại".
 */

"use strict";

var hMailTranslate = {
  STORE: "hmail-translations.json",
  BAR_ID: "hmail-translate-bar",
  MAX_ENTRIES: 400,

  LANGUAGES: [
    { id: "vi", label: "Tiếng Việt" },
    { id: "en", label: "Tiếng Anh" },
    { id: "zh", label: "Tiếng Trung" },
    { id: "ja", label: "Tiếng Nhật" },
    { id: "ko", label: "Tiếng Hàn" },
  ],

  cache: null,
  originals: new Map(),

  init(win) {
    this.load();
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

  language(id) {
    return this.LANGUAGES.find(l => l.id === id) || this.LANGUAGES[0];
  },

  key(hdr, lang) {
    return `${hdr.folder?.URI}#${hdr.messageKey}|${lang}`;
  },

  // ------------------------------------------------------------------ store

  file() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(this.STORE);
    return f.path;
  },

  load() {
    if (this.cache) {
      return;
    }
    this.cache = {};
    IOUtils.readJSON(this.file()).then(data => {
      if (data && typeof data === "object") {
        this.cache = data;
      }
    }).catch(() => {});
  },

  remember(key, text) {
    this.cache[key] = { text, at: Date.now() };
    // Oldest first, so a long-running profile does not grow without limit.
    const keys = Object.keys(this.cache);
    if (keys.length > this.MAX_ENTRIES) {
      keys.sort((a, b) => (this.cache[a].at || 0) - (this.cache[b].at || 0))
        .slice(0, keys.length - this.MAX_ENTRIES)
        .forEach(k => delete this.cache[k]);
    }
    try {
      IOUtils.writeJSON(this.file(), this.cache).catch(() => {});
    } catch (e) {}
  },

  // ------------------------------------------------------------- the body

  /** The document the message body is rendered into. */
  bodyDocument(win) {
    try {
      const doc = hMailInsight.messageDocument(win);
      return doc?.getElementById("messagepane")?.contentDocument || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Swap the body for the translation, keeping the original so it can come
   * back. Paragraph breaks in the model's answer become paragraphs; nothing
   * else of the original layout survives, and saying so is better than
   * pretending a translated table is still a table.
   */
  show(win, text) {
    const doc = this.bodyDocument(win);
    if (!doc?.body) {
      return false;
    }
    if (!this.originals.has(doc)) {
      this.originals.set(doc, doc.body.innerHTML);
    }
    const wrap = doc.createElement("div");
    wrap.setAttribute("data-hmail-translation", "1");
    wrap.style.cssText =
      "white-space: pre-wrap; line-height: 1.55; padding: 4px 2px;";
    wrap.textContent = text;
    doc.body.textContent = "";
    doc.body.appendChild(wrap);
    return true;
  },

  restore(win) {
    const doc = this.bodyDocument(win);
    if (!doc?.body || !this.originals.has(doc)) {
      return;
    }
    doc.body.innerHTML = this.originals.get(doc);
    this.originals.delete(doc);
  },

  // -------------------------------------------------------------- the bar

  bar(win, state, lang) {
    const doc = hMailInsight.messageDocument(win);
    if (!doc) {
      return null;
    }
    doc.getElementById(this.BAR_ID)?.remove();
    const host = doc.getElementById("mail-notification-top") ||
                 doc.body?.firstElementChild;
    if (!host) {
      return null;
    }

    const el = (t, c, x) => this.el(doc, t, c, x);
    const bar = el("div", "hmail-translate-bar");
    bar.id = this.BAR_ID;

    const label = el("span", "hmail-translate-label", state);
    const actions = el("div", "hmail-translate-actions");
    bar.append(label, actions);
    host.insertBefore(bar, host.firstChild);
    return { bar, label, actions, el };
  },

  status(win, text) {
    const label = hMailInsight.messageDocument(win)
      ?.getElementById(this.BAR_ID)?.querySelector(".hmail-translate-label");
    if (label) {
      label.textContent = text;
    }
  },

  // ------------------------------------------------------------------- run

  /**
   * Translate the open message, or show the stored translation if there is
   * one. `again` forces a fresh call even when one is stored.
   */
  async run(win, langId, { again = false } = {}) {
    const hdr = hMailInsight.selected(win);
    if (!hdr) {
      return;
    }
    const lang = this.language(langId);
    const key = this.key(hdr, lang.id);
    this.load();

    const parts = this.bar(win, `Đang dịch sang ${lang.label}…`, lang);
    if (!parts) {
      return;
    }

    let text = again ? "" : this.cache[key]?.text;
    const cached = !!text;

    if (!text) {
      try {
        const source = await hMailAI.messageText(hdr);
        text = await hMailAI.ask([{
          role: "user",
          text: `Dịch toàn bộ email sau sang ${lang.label}. Giữ nguyên bố ` +
                "cục dòng và đoạn, giữ nguyên số liệu, tên riêng, địa chỉ " +
                "email và mã đơn hàng. Chỉ trả về bản dịch, không thêm lời " +
                "dẫn.\n\n---\n" + source,
        }]);
        this.remember(key, text);
      } catch (e) {
        this.status(win, "Không dịch được: " + hMailAI.explain(e));
        return;
      }
    }

    if (!this.show(win, text)) {
      this.status(win, "Không thay được nội dung thư.");
      return;
    }
    this.paintBar(win, lang, cached);
  },

  paintBar(win, lang, cached) {
    const parts = this.bar(win,
      `Đang xem bản dịch ${lang.label}` +
      (cached ? " (đã lưu từ lần trước)" : ""), lang);
    if (!parts) {
      return;
    }
    const { actions, el } = parts;

    const add = (text, fn) => {
      const b = el("button", "hmail-translate-action", text);
      b.addEventListener("click", fn);
      actions.appendChild(b);
    };

    add("Xem bản gốc", () => {
      this.restore(win);
      this.offerBar(win, lang.id);
    });
    add("Dịch lại", () => {
      this.restore(win);
      this.run(win, lang.id, { again: true });
    });
  },

  /** After going back to the original, offer the translation again. */
  offerBar(win, langId) {
    const lang = this.language(langId);
    const parts = this.bar(win, "Đang xem bản gốc", lang);
    if (!parts) {
      return;
    }
    const b = this.el(hMailInsight.messageDocument(win), "button",
                      "hmail-translate-action", `Xem bản dịch ${lang.label}`);
    b.addEventListener("click", () => this.run(win, lang.id));
    parts.actions.appendChild(b);
  },

  /** Clear the bar when a different message is opened. */
  reset(win) {
    try {
      hMailInsight.messageDocument(win)?.getElementById(this.BAR_ID)?.remove();
      this.originals.clear();
    } catch (e) {}
  },
};
