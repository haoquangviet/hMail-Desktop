/* hMail Desktop — theo dõi thư đã gửi
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * "Thư của tôi tới nơi chưa, họ đọc chưa?" — câu hỏi thường ngày mà thư
 * điện tử vốn không trả lời được. Máy chủ thư HQV nhận một header do người
 * gửi đặt (X-HMail-Track: <ref>) và ghi lại đường đi của thư mang mã ấy;
 * kết quả tra bằng một URL công khai: GET https://mail.<miền>/t/ref/<ref>.
 *
 * Ba nguyên tắc:
 *   - Mã theo dõi là chuỗi ngẫu nhiên an toàn (crypto.randomUUID, 32 ký
 *     tự ≈128 bit): ai không có mã thì không tra được thư của người khác,
 *     mà máy chủ cũng không cần biết ai đang hỏi.
 *   - Chỉ bật khi người dùng chọn — nút "Theo dõi thư" trên ribbon soạn
 *     thư, tắt là thư đi như thường, không header, không dấu vết.
 *   - Nói thật về cách máy chủ đo: khi thư mang mã theo dõi, máy chủ chèn
 *     ảnh đếm lượt mở và viết lại liên kết để đếm lượt bấm (payload trả về
 *     track_opens/track_clicks/injected = true). Đó là theo dõi người
 *     nhận — UI phải nói rõ, không được để người gửi tưởng chỉ là "biết
 *     thư tới nơi chưa".
 */

"use strict";

var hMailTrack = {
  STORE: "hmail-tracking.json",
  PREF_ON: "hmail.track.enabled",
  MAX_ENTRIES: 500,

  // --------------------------------------------------------------- storage

  file() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(this.STORE);
    return f.path;
  },

  async load() {
    if (this._cache) {
      return this._cache;
    }
    try {
      const data = await IOUtils.readJSON(this.file());
      this._cache = Array.isArray(data) ? data : [];
    } catch (e) {
      this._cache = [];
    }
    return this._cache;
  },

  async save(list) {
    this._cache = list.slice(-this.MAX_ENTRIES);
    try {
      await IOUtils.writeJSON(this.file(), this._cache);
    } catch (e) {
      Cu.reportError("hMail tracking: không ghi được nhật ký: " + e);
    }
  },

  async remember(entry) {
    const list = await this.load();
    list.push(entry);
    await this.save(list);
  },

  // ------------------------------------------------------------ máy chủ

  /**
   * Máy chủ tra cứu của một tài khoản: cùng máy chủ thư đã nhận thư đi.
   * Chỉ hộp thư trên máy chủ HQV có dịch vụ này.
   */
  baseFor(server) {
    const host = String(server?.hostName || "").trim();
    return host ? `https://${host}` : "";
  },

  /** Trạng thái của một mã theo dõi; null khi máy chủ chưa biết mã đó. */
  async fetchStatus(entry) {
    const base = entry.base || "";
    if (!base || !entry.ref) {
      return null;
    }
    for (const path of [`/t/ref/${entry.ref}`, `/t/s/${entry.ref}`]) {
      try {
        const res = await fetch(`${base}${path}?events=0`, {
          method: "GET", headers: { Accept: "application/json" },
        });
        if (res.status === 404) {
          return { unknown: true };
        }
        if (!res.ok) {
          continue;
        }
        return await res.json();
      } catch (e) {}
    }
    return null;
  },

  // ------------------------------------------------------- cửa sổ soạn thư

  /** Mã ngẫu nhiên an toàn: 32 ký tự hex từ crypto.randomUUID(). */
  newRef(win) {
    try {
      return win.crypto.randomUUID().replace(/-/g, "");
    } catch (e) {
      // Không có randomUUID (không nên xảy ra) — vẫn phải là CSPRNG.
      const bytes = new Uint8Array(16);
      win.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }
  },

  enabledByDefault() {
    try {
      return Services.prefs.getBoolPref(this.PREF_ON);
    } catch (e) {
      return false;
    }
  },

  initCompose(win) {
    try {
      if (win._hmailTrackInit) {
        return;
      }
      win._hmailTrackInit = true;
      win._hmailTrackOn = this.enabledByDefault();
      // Gắn header ngay trước khi thư rời máy — sau bước này Thunderbird
      // dựng MIME, nên header vào đúng thư thật (kể cả bản lưu Sent).
      win.addEventListener("compose-send-message", () => {
        try {
          this.applyHeader(win);
        } catch (e) {
          Cu.reportError("hMail tracking: không gắn được header: " + e);
        }
      }, true);
    } catch (e) {
      Cu.reportError("hMail tracking init failed: " + e);
    }
  },

  /** Bật/tắt cho cửa sổ soạn thư hiện tại; trả về trạng thái mới. */
  toggle(win) {
    win._hmailTrackOn = !win._hmailTrackOn;
    this.reflect(win);
    return win._hmailTrackOn;
  },

  reflect(win) {
    try {
      const button = win.document.querySelector(
        '.hmail-ribbon-button[data-id="c-track"]');
      if (button) {
        button.toggleAttribute("checked", !!win._hmailTrackOn);
        button.title = win._hmailTrackOn
          ? "Đang theo dõi: máy chủ ghi đường đi của thư, đếm lượt mở và " +
            "lượt bấm liên kết (có chèn ảnh đếm — người nhận bị đo)"
          : "Theo dõi thư: biết thư đã tới chưa, đã mở chưa (máy chủ sẽ " +
            "chèn ảnh đếm lượt mở vào thư)";
      }
    } catch (e) {}
  },

  /** Người gửi (identity đang chọn) và incoming server của tài khoản đó. */
  accountOf(win) {
    try {
      const identity = win.gCurrentIdentity || win.getCurrentIdentity?.();
      if (!identity) {
        return null;
      }
      for (const account of MailServices.accounts.accounts) {
        if (account.identities.some(i => i.key === identity.key)) {
          return { identity, server: account.incomingServer };
        }
      }
      return { identity, server: null };
    } catch (e) {
      return null;
    }
  },

  applyHeader(win) {
    if (!win._hmailTrackOn) {
      return;
    }
    const fields = win.gMsgCompose?.compFields;
    if (!fields?.setHeader) {
      return;
    }
    const ref = this.newRef(win);
    fields.setHeader("X-HMail-Track", ref);
    const who = this.accountOf(win);
    const base = this.baseFor(who?.server);
    this.remember({
      ref,
      at: Date.now(),
      subject: String(fields.subject || ""),
      to: String(fields.to || ""),
      cc: String(fields.cc || ""),
      from: String(who?.identity?.email || ""),
      base,
    }).catch(() => {});
  },

  // ------------------------------------------------------------- tab kết quả

  TAB_MODE: "hmailTracking",

  el(doc, tag, cls, text) {
    const n = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  },

  openTab(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    if (!tabmail.tabModes?.[this.TAB_MODE]) {
      const self = this;
      tabmail.registerTabType({
        name: self.TAB_MODE,
        perTabPanel: "vbox",
        modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
        openTab(tab) {
          tab.title = "Theo dõi thư";
          tab.panel.classList.add("hmail-import-tab");
          tab.panel.appendChild(self.buildPanel(win));
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Theo dõi thư";
        },
        persistTab() {
          return null;
        },
      });
    }
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
  },

  /**
   * Payload thật của máy chủ:
   *   { message: { opens, clicks, first_open_at, recipients, … },
   *     delivery: [...], delivery_status: "pending|delivered|…",
   *     opened: bool }
   * Dịch thành một câu tiếng người + sắc thái để tô màu.
   */
  describe(status) {
    if (!status) {
      return { text: "Không hỏi được máy chủ", tone: "unknown" };
    }
    if (status.unknown) {
      return { text: "Máy chủ chưa ghi nhận mã này", tone: "unknown" };
    }
    const msg = status.message || {};
    const state = String(status.delivery_status || "").toLowerCase();
    const map = {
      delivered: ["Đã tới hộp thư người nhận", "ok"],
      sent: ["Đã gửi đi", "sent"],
      relayed: ["Đã chuyển tới máy chủ người nhận", "sent"],
      pending: ["Đã nhận vào máy chủ, đang chuyển đi", "wait"],
      queued: ["Đang chờ gửi", "wait"],
      deferred: ["Máy chủ người nhận hoãn — sẽ thử lại", "wait"],
      bounced: ["Bị trả lại", "fail"],
      failed: ["Gửi thất bại", "fail"],
      rejected: ["Bị từ chối", "fail"],
    };
    const hit = map[state] || [state ? `Trạng thái: ${state}` : "Đã ghi nhận",
                               "unknown"];
    let text = hit[0];
    let tone = hit[1];
    const opens = Number(msg.opens || 0);
    if (status.opened || opens > 0) {
      const when = msg.first_open_at
        ? new Date(msg.first_open_at).toLocaleString("vi-VN") : "";
      text += ` · đã mở ${opens || 1} lần` + (when ? ` (lần đầu ${when})` : "");
      tone = "ok";
    }
    const clicks = Number(msg.clicks || 0);
    if (clicks > 0) {
      text += ` · bấm liên kết ${clicks} lần`;
    }
    return { text, tone };
  },

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const root = el("div", "hmail-import hmail-track");
    root.appendChild(el("div", "hmail-import-title", "Theo dõi thư đã gửi"));
    root.appendChild(el("div", "hmail-import-note",
      "Những thư bạn gửi khi bật nút \"Theo dõi thư\" trong cửa sổ soạn " +
      "thư. Máy chủ ghi lại đường đi của thư theo một mã ngẫu nhiên, đồng " +
      "thời chèn ảnh đếm lượt mở và viết lại liên kết để đếm lượt bấm — " +
      "nghĩa là người nhận CÓ bị đo. Chỉ dùng khi việc đó là hợp lệ với " +
      "bạn và người nhận; thư không bật nút này đi hoàn toàn bình thường."));

    const bar = el("div", "hmail-aicost-bar");
    const refresh = el("button", "hmail-ai-btn primary", "Cập nhật trạng thái");
    const clear = el("button", "hmail-ai-btn", "Xoá nhật ký");
    bar.append(refresh, clear);
    root.appendChild(bar);

    const list = el("div", "hmail-spam-list");
    root.appendChild(list);

    const render = async (fetchStatus) => {
      const entries = (await this.load()).slice().reverse();
      list.textContent = "";
      if (!entries.length) {
        list.appendChild(el("p", "hmail-spam-note",
          "Chưa có thư nào được theo dõi. Khi soạn thư, bấm \"Theo dõi " +
          "thư\" trên thanh lệnh trước khi gửi."));
        return;
      }
      for (const entry of entries) {
        const row = el("div", "hmail-spam-row");
        const main = el("div", "hmail-spam-row-main");
        const head = el("div", "hmail-spam-row-head");
        head.append(
          el("span", "hmail-spam-from", entry.subject || "(không tiêu đề)"),
          el("span", "hmail-spam-time",
             new Date(entry.at || 0).toLocaleString("vi-VN")));
        main.append(head,
          el("div", "hmail-spam-subject", "Tới: " + (entry.to || "?")),
          el("div", "hmail-spam-meta",
             "Từ " + (entry.from || "?") + " · mã " + entry.ref));
        const state = el("span", "hmail-spam-state");
        state.textContent = "…";
        row.append(main, state);
        list.appendChild(row);
        if (fetchStatus) {
          this.fetchStatus(entry).then(status => {
            const info = this.describe(status);
            state.textContent = info.text;
            state.dataset.status = info.tone === "ok" ? "delivered"
              : info.tone === "fail" ? "rejected"
              : info.tone === "wait" ? "deferred" : "other";
          }).catch(() => {
            state.textContent = "Không hỏi được máy chủ";
          });
        } else {
          state.textContent = "Bấm Cập nhật trạng thái";
        }
      }
    };

    refresh.addEventListener("click", () => render(true));
    clear.addEventListener("click", async () => {
      if (Services.prompt.confirm(win, "Theo dõi thư",
            "Xoá toàn bộ nhật ký theo dõi trên máy này? Máy chủ vẫn giữ dữ " +
            "liệu của nó.")) {
        await this.save([]);
        render(false);
      }
    });
    render(true);
    return root;
  },
};

// ---------------------------------------------------------------------------
// Tự kiểm đầu-cuối (pref hmail.debug.tracktest = "run"): gửi THẬT một thư
// cho chính mình từ tài khoản quyet@haoquangviet.com, kèm header
// X-HMail-Track; chờ máy chủ xử lý rồi tra GET /t/ref/<ref>. Kết quả ghi
// vào pref: ref, HTTP status, JSON máy chủ trả.
(function hMailTrackSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.tracktest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.tracktest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.tracktest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    try {
      const email = "quyet@haoquangviet.com";
      let account = null;
      for (const acc of MailServices.accounts.accounts) {
        if ((acc.defaultIdentity?.email || "").toLowerCase() === email) {
          account = acc;
          break;
        }
      }
      if (!account) {
        report("err: khong tim thay tai khoan " + email);
        return;
      }
      const ref = hMailTrack.newRef(win);
      const identity = account.defaultIdentity;
      const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
        .createInstance(Ci.nsIMsgCompFields);
      fields.from = identity.email;
      fields.to = identity.email;
      fields.subject = "hMail tracking selftest " + ref.slice(0, 8);
      fields.body = "<p>Thu tu kiem tinh nang theo doi thu.</p>";
      fields.setHeader("X-HMail-Track", ref);
      const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
        .createInstance(Ci.nsIMsgComposeParams);
      params.composeFields = fields;
      params.type = Ci.nsIMsgCompType.New;
      params.format = Ci.nsIMsgCompFormat.HTML;
      params.identity = identity;
      const compose = MailServices.compose.initCompose(params);
      const msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"]
        .createInstance(Ci.nsIMsgWindow);
      await compose.sendMsg(Ci.nsIMsgCompDeliverMode.Now, identity,
                            account.key, msgWindow, null);
      // Máy chủ cần vài giây để ghi nhận.
      const base = hMailTrack.baseFor(account.incomingServer);
      let out = "";
      for (const wait of [3000, 5000, 8000, 12000]) {
        await new Promise(r => win.setTimeout(r, wait));
        try {
          const res = await fetch(`${base}/t/ref/${ref}?events=0`);
          const text = (await res.text()).slice(0, 400);
          out = `HTTP ${res.status} ${text}`;
          if (res.ok) {
            break;
          }
        } catch (e) {
          out = "fetch err: " + (e.message || e);
        }
      }
      report("sent ref=" + ref + " | " + out);
    } catch (e) {
      report("err: " + (e.message || e));
    }
  }, 14000);
})();
