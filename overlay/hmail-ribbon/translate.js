/* hMail Desktop — dịch thư ngay trong nội dung thư
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
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
    { id: "zh", label: "Tiếng Trung (giản thể)" },
    { id: "zh-TW", label: "Tiếng Trung (phồn thể)" },
    { id: "ja", label: "Tiếng Nhật" },
    { id: "ko", label: "Tiếng Hàn" },
    { id: "fr", label: "Tiếng Pháp" },
    { id: "de", label: "Tiếng Đức" },
    { id: "es", label: "Tiếng Tây Ban Nha" },
    { id: "pt", label: "Tiếng Bồ Đào Nha" },
    { id: "it", label: "Tiếng Ý" },
    { id: "ru", label: "Tiếng Nga" },
    { id: "th", label: "Tiếng Thái" },
    { id: "id", label: "Tiếng Indonesia" },
    { id: "km", label: "Tiếng Khmer" },
  ],

  cache: null,
  originals: new Map(),

  init(win) {
    this.load();
    // The bar lives in the about:message document, which survives from one
    // message to the next — the body is re-rendered per message, the bar is
    // not, so "Đang xem bản dịch" was still up over messages that had never
    // been translated. Watch the displayed message: clear leftovers when it
    // changes, and when the new message has a stored translation, offer it.
    try {
      let last = null;
      win.setInterval(() => {
        try {
          const hdr = hMailInsight.selected(win);
          const now = hdr ? this.msgKey(hdr) : null;
          if (now === last) {
            return;
          }
          last = now;
          this.reset(win);
          if (!hdr) {
            return;
          }
          const lang = this.LANGUAGES.find(
            l => this.cache?.[this.key(hdr, l.id)]);
          if (lang) {
            this.offerBar(win, lang.id);
          }
        } catch (e) {}
      }, 700);
    } catch (e) {}
  },

  msgKey(hdr) {
    return `${hdr.folder?.URI}#${hdr.messageKey}`;
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
   * Every text node under the body that carries readable words, in document
   * order. Translating these in place is what keeps a translated table a
   * table: the markup never leaves the page, the model only ever sees text.
   */
  textNodes(doc) {
    const out = [];
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, {
      acceptNode(node) {
        const tag = node.parentNode?.nodeName?.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") {
          return 2; // reject
        }
        return /\p{L}/u.test(node.nodeValue) ? 1 : 3; // accept : skip
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      out.push(n);
    }
    return out;
  },

  /**
   * The segments translated, same order, same count — or null when the
   * model's answer cannot be trusted node-for-node, in which case the
   * caller falls back to the whole-text translation.
   */
  async translateSegments(nodes, lang) {
    let limit = 12000;
    try {
      limit = Services.prefs.getIntPref("hmail.ai.maxChars");
    } catch (e) {}
    const segs = nodes.map(n => n.nodeValue.trim());
    let total = 0;
    let count = segs.length;
    for (let i = 0; i < segs.length; i++) {
      total += segs[i].length;
      if (total > limit) {
        count = i;
        break;
      }
    }
    if (!count) {
      return null;
    }
    const slice = segs.slice(0, count);
    const reply = await hMailAI.ask([{
      role: "user",
      text: `Dịch các đoạn văn bản sau sang ${lang.label}. Đây là yêu cầu ` +
            `dịch thuật: kết quả phải bằng ${lang.label}, kể cả khi quy ` +
            "tắc chung yêu cầu trả lời bằng tiếng Việt. Trả về đúng MỘT " +
            `mảng JSON gồm ${slice.length} chuỗi, đúng thứ tự, mỗi phần ` +
            "tử là bản dịch của phần tử tương ứng. Giữ nguyên số liệu, " +
            "tên riêng, địa chỉ email và mã đơn hàng. Không thêm gì " +
            "ngoài JSON.\n" + JSON.stringify(slice),
    }]);
    const parsed = this.parseArray(reply);
    if (!parsed || parsed.length !== slice.length) {
      return null;
    }
    // Anything past the size cap keeps its original text.
    return parsed.map(String).concat(segs.slice(count));
  },

  /** The JSON array in the model's answer, fences and prose tolerated. */
  parseArray(reply) {
    try {
      const text = String(reply);
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start === -1 || end <= start) {
        return null;
      }
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  },

  /** Write translations back into the very nodes they came from. */
  applySegments(nodes, segs) {
    nodes.forEach((node, i) => {
      const m = /^(\s*)[\s\S]*?(\s*)$/.exec(node.nodeValue);
      node.nodeValue = (m?.[1] || "") + segs[i] + (m?.[2] || "");
    });
  },

  /**
   * Whole-text fallback: swap the body for the translation as plain text.
   * Only used when the page has no usable text nodes or the per-node answer
   * came back malformed — the in-place path above is the normal one.
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

    const doc = this.bodyDocument(win);
    if (!doc?.body) {
      this.status(win, "Không thay được nội dung thư.");
      return;
    }
    const nodes = this.textNodes(doc);

    let stored = again ? null : this.cache[key]?.text;
    const cached = !!stored;
    // A per-node translation only fits the rendering it was made from; if
    // the node count changed (images now loaded, different sanitizing),
    // translate afresh rather than write text into the wrong places.
    if (Array.isArray(stored) && stored.length !== nodes.length) {
      stored = null;
    }

    if (!stored) {
      try {
        hMailAI.usageContext = { feature: "Dịch → " + lang.label,
                                 subject: hdr.mime2DecodedSubject || "",
                                 scope: { hdr } };
        if (nodes.length) {
          stored = await this.translateSegments(nodes, lang);
        }
        if (!stored) {
          // No text nodes worth translating, or the model would not hold
          // the node-for-node contract: whole-text fallback.
          const source = await hMailAI.messageText(hdr);
          stored = await hMailAI.ask([{
            role: "user",
            text: `Dịch toàn bộ email sau sang ${lang.label}. Đây là yêu ` +
                  `cầu dịch thuật: kết quả phải bằng ${lang.label}, kể cả ` +
                  "khi quy tắc chung yêu cầu trả lời bằng tiếng Việt. Giữ " +
                  "nguyên bố cục dòng và đoạn, giữ nguyên số liệu, tên " +
                  "riêng, địa chỉ email và mã đơn hàng. Chỉ trả về bản " +
                  "dịch, không thêm lời dẫn.\n\n---\n" + source,
          }]);
        }
        this.remember(key, stored);
        // Để lại vết trong hMail AI của thư này: mở panel là biết thư đã
        // được dịch và đọc lại được bản dịch.
        hMailAI.logFeature?.(hdr, `Dịch thư này sang ${lang.label}`,
          Array.isArray(stored) ? stored.join("\n") : stored);
      } catch (e) {
        this.status(win, "Không dịch được: " + hMailAI.explain(e));
        return;
      }
    }

    if (Array.isArray(stored)) {
      if (!this.originals.has(doc)) {
        this.originals.set(doc, doc.body.innerHTML);
      }
      this.applySegments(nodes, stored);
    } else if (!this.show(win, stored)) {
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
