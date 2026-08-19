/* hMail Desktop — theo dõi thư đã gửi
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * "Thư của tôi tới nơi chưa, họ đọc chưa?" — câu hỏi thường ngày mà thư
 * điện tử vốn không trả lời được. Máy chủ thư HQV nhận một header do người
 * gửi đặt (X-HMail-Track: <ref>, máy chủ gỡ khỏi bản thư đi) và ghi lại
 * đường đi của thư mang mã ấy; theo thư chỉ có X-HMail-Internal-Id vô nghĩa
 * với người ngoài, máy này lần ngược ra mã trong nhật ký;
 * kết quả tra bằng một URL công khai: GET https://mail.<miền>/t/ref/<ref>.
 *
 * Ba nguyên tắc:
 *   - Mã theo dõi là chuỗi ngẫu nhiên an toàn (crypto.randomUUID, 32 ký
 *     tự ≈128 bit): ai không có mã thì không tra được thư của người khác,
 *     mà máy chủ cũng không cần biết ai đang hỏi.
 *   - Chỉ bật khi người dùng chọn — nút "Trạng thái thư" trên ribbon soạn
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

  /**
   * Danh sách địa chỉ email trong một trường người nhận, đã giải mã
   * encoded-word. Tên hiển thị tiếng Việt đi qua SMTP thành
   * "=?UTF-8?B?…?= <ai@do.com>" — lưu nguyên chuỗi đó vào nhật ký thì bảng
   * theo dõi hiện ra một dãy ký tự vô nghĩa, và dò lại mã theo người nhận
   * cũng trượt.
   */
  emailsOf(value) {
    try {
      return MailServices.headerParser
        .parseEncodedHeader(String(value || ""), "UTF-8")
        .map(a => String(a.email || "").toLowerCase())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  },

  /**
   * Chữ trong header đã giải mã: tiêu đề tiếng Việt đi qua SMTP thành
   * "=?UTF-8?B?S2nhu4NtIHRyYSB0aMawIA==?=", lưu và hiện nguyên như vậy thì
   * bảng theo dõi toàn ký tự lạ.
   */
  decodeText(value) {
    const text = String(value || "");
    if (!/=\?/.test(text)) {
      return text;
    }
    try {
      return MailServices.mimeConverter.decodeMimeHeader(
        text, "UTF-8", false, true) || text;
    } catch (e) {
      return text;
    }
  },

  /** Chuỗi người nhận đọc được cho người dùng ("Quyết Trần <a@b.com>"). */
  prettyAddresses(value) {
    try {
      const list = MailServices.headerParser
        .parseEncodedHeader(String(value || ""), "UTF-8")
        .map(a => a.name ? `${a.name} <${a.email}>` : a.email)
        .filter(Boolean);
      return list.length ? list.join(", ") : String(value || "");
    } catch (e) {
      return String(value || "");
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
  async fetchStatus(entry, withEvents = false) {
    const base = entry.base || "";
    if (!base || !entry.ref) {
      return null;
    }
    const query = withEvents ? "" : "?events=0";
    for (const path of [`/t/ref/${entry.ref}`, `/t/s/${entry.ref}`]) {
      try {
        const res = await fetch(`${base}${path}${query}`, {
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
          : "Trạng thái thư: biết thư đã tới chưa, đã mở chưa (máy chủ sẽ " +
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
    // Chỉ id nội bộ đi theo thư — xem newLocalId().
    const localId = this.newLocalId(win);
    fields.setHeader("X-HMail-Internal-Id", localId);
    const who = this.accountOf(win);
    const base = this.baseFor(who?.server);
    this.remember({
      ref,
      localId,
      at: Date.now(),
      subject: this.decodeText(fields.subject),
      to: this.prettyAddresses(fields.to),
      toEmails: this.emailsOf(fields.to),
      cc: this.prettyAddresses(fields.cc),
      from: String(who?.identity?.email || ""),
      base,
    }).catch(() => {});
  },

  /**
   * Id nội bộ đi kèm thư gửi đi.
   *
   * KHÔNG bao giờ gửi mã theo dõi (ref) trong thư: API tra trạng thái không
   * cần đăng nhập, ai đọc được header là đọc được toàn bộ dữ liệu theo dõi
   * của mình — máy chủ gỡ X-HMail-Track khỏi bản thư đi đúng vì lý do đó.
   * Thứ đi theo thư chỉ là chuỗi ngẫu nhiên vô nghĩa với người ngoài; ref
   * nằm trong nhật ký trên máy và ghép lại bằng id này. Nhờ vậy bản thư ở
   * ĐÂU cũng hiện được trạng thái: hộp Đã gửi, Hộp thư đến, Lưu trữ, thư
   * mục tự sắp — miễn là máy này có nhật ký.
   */
  newLocalId(win) {
    try {
      const bytes = new Uint8Array(9);
      win.crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  },

  // --------------------------------------------------- dấu tích trạng thái

  /**
   * Ba mức, đọc như ứng dụng nhắn tin: một tích = máy chủ đã nhận thư để
   * gửi đi; hai tích = đã giao tới máy chủ người nhận; hai tích xanh = người
   * nhận đã mở. SVG nhúng thẳng (data:) vì cột của Thunderbird cần một URL
   * ảnh, còn file trong hồ sơ thì about:3pane không đọc được.
   */
  icon(kind) {
    const grey = "#8a8a8f";
    const blue = "#0F6CBD";
    const one = c => `<path d="M3 8.6l3.2 3.2L13 5" fill="none" stroke="${c}" ` +
                     `stroke-width="2" stroke-linecap="round" ` +
                     `stroke-linejoin="round"/>`;
    const two = c => one(c) +
      `<path d="M7.8 11.8L9 13l4.8-6.4" fill="none" stroke="${c}" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const red = "#D93025";
    const cross = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" ` +
                  `stroke="${red}" stroke-width="2" ` +
                  `stroke-linecap="round"/>`;
    const body = kind === "failed" ? cross
      : kind === "opened" ? two(blue)
      : kind === "delivered" ? two(grey) : one(grey);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" ` +
                `height="16" viewBox="0 0 16 16">${body}</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  },

  /**
   * Máy chủ trả về trạng thái giao THEO TỪNG NGƯỜI NHẬN:
   *   { recipient, status, status_detail: "250 OK …", dsn_code,
   *     queued_at, sent_at, delivered_at }
   * cùng một delivery_status gộp. "sent" ở đây nghĩa là máy chủ người nhận
   * đã nhận thư (trả 250) — với người dùng đó là "đã tới nơi"; còn
   * "pending/queued" mới là mới rời máy mình.
   */
  DELIVERY_LABELS: {
    pending: ["Đã gửi", "Đã rời máy chủ của bạn, đang chuyển đi", "sent"],
    queued: ["Đã gửi", "Đang chờ gửi", "sent"],
    sent: ["Đã tới nơi", "Máy chủ người nhận đã nhận thư", "delivered"],
    relayed: ["Đã tới nơi", "Đã chuyển tới máy chủ người nhận", "delivered"],
    delivered: ["Đã tới nơi", "Đã vào hộp thư người nhận", "delivered"],
    deferred: ["Đang thử lại", "Máy chủ người nhận hoãn — sẽ thử lại", "sent"],
    bounced: ["Bị trả lại", "Thư bị trả lại", "sent"],
    failed: ["Gửi hỏng", "Gửi thất bại", "sent"],
    rejected: ["Bị từ chối", "Máy chủ người nhận từ chối thư", "sent"],
  },

  deliveryOf(status) {
    const state = String(status?.delivery_status || "").toLowerCase();
    const hit = this.DELIVERY_LABELS[state];
    if (hit) {
      return { short: hit[0], text: hit[1], level: hit[2] };
    }
    // Không có trạng thái gộp thì suy từ các dòng giao của từng người nhận.
    const rows = status?.delivery || [];
    if (rows.some(r => /sent|deliver|relay/i.test(String(r.status || "")))) {
      return { short: "Đã tới nơi", text: "Máy chủ người nhận đã nhận thư",
               level: "delivered" };
    }
    return { short: "Đã gửi", text: "Đã nhận vào máy chủ", level: "sent" };
  },

  ICON_TITLES: {
    sent: "Đã gửi đi, chờ máy chủ người nhận",
    delivered: "Máy chủ người nhận đã nhận thư",
    opened: "Người nhận đã mở thư",
    failed: "Thư không tới được người nhận",
  },

  /**
   * Trạng thái của một thư ĐỒNG BỘ — cột danh sách hỏi hàng nghìn dòng nên
   * không được đọc thư hay gọi mạng: chỉ tra nhật ký đã nạp sẵn trong bộ
   * nhớ, đối chiếu tiêu đề + người nhận + giờ gửi.
   */
  entryFor(hdr) {
    const list = this._cache;
    if (!list || !list.length || !hdr) {
      return null;
    }
    try {
      const id = String(hdr.messageId || "");
      if (id) {
        const byId = list.find(e => e.messageId === id);
        if (byId) {
          return byId;
        }
      }
      const subject = this.decodeText(hdr.mime2DecodedSubject || hdr.subject)
        .trim().toLowerCase();
      if (!subject) {
        return null;
      }
      const at = (hdr.dateInSeconds || 0) * 1000;
      let best = null;
      let bestGap = Infinity;
      for (const entry of list) {
        if (this.decodeText(entry.subject).trim().toLowerCase() !== subject) {
          continue;
        }
        const gap = Math.abs((entry.at || 0) - at);
        if (gap < bestGap) {
          bestGap = gap;
          best = entry;
        }
      }
      return best && bestGap < 2 * 24 * 3600 * 1000 ? best : null;
    } catch (e) {
      return null;
    }
  },

  /** Mức tích cho một thư, "" nếu thư không được theo dõi. */
  iconFor(hdr) {
    const entry = this.entryFor(hdr);
    return entry ? (entry.state || "sent") : "";
  },

  textFor(hdr) {
    const entry = this.entryFor(hdr);
    return entry ? (this.ICON_TITLES[entry.state || "sent"] || "") : "";
  },

  COLUMN_ID: "hmailTrackCol",

  /** Cột "Theo dõi" trong danh sách thư (about:3pane của cửa sổ này). */
  addColumn(win) {
    try {
      const { ThreadPaneColumns } = ChromeUtils.importESModule(
        "chrome://messenger/content/ThreadPaneColumns.mjs");
      this._columns = ThreadPaneColumns;
      if (ThreadPaneColumns.getCustomColumns()
            .some(c => c.id === this.COLUMN_ID)) {
        return;
      }
      ThreadPaneColumns.addCustomColumn(this.COLUMN_ID, {
        name: "Trạng thái",
        icon: true,
        iconHeaderUrl: this.icon("delivered"),
        iconCellDefinitions: [
          { id: "sent", url: this.icon("sent"),
            title: this.ICON_TITLES.sent, alt: "Đã gửi" },
          { id: "delivered", url: this.icon("delivered"),
            title: this.ICON_TITLES.delivered, alt: "Đã giao" },
          { id: "opened", url: this.icon("opened"),
            title: this.ICON_TITLES.opened, alt: "Đã mở" },
          { id: "failed", url: this.icon("failed"),
            title: this.ICON_TITLES.failed, alt: "Không gửi được" },
        ],
        iconCallback: hdr => this.iconFor(hdr),
        textCallback: hdr => this.textFor(hdr),
      });
    } catch (e) {
      Cu.reportError("hMail tracking column failed: " + e);
    }
  },

  refreshColumn() {
    try {
      this._columns?.refreshCustomColumn(this.COLUMN_ID);
    } catch (e) {}
  },

  /**
   * Hỏi máy chủ trạng thái các thư đang theo dõi và ghi vào nhật ký, để cột
   * danh sách (chạy đồng bộ) có cái mà hiện. Chỉ hỏi thư trong 14 ngày và
   * chưa biết là đã mở — thư đã mở thì không đổi nữa.
   */
  async refreshStates(win, limit = 12) {
    const list = await this.load();
    const now = Date.now();
    const due = list
      .filter(e => e.ref && (now - (e.at || 0)) < 14 * 24 * 3600 * 1000)
      .filter(e => e.state !== "opened")
      .filter(e => (now - (e.checkedAt || 0)) > 4 * 60 * 1000)
      .slice(-limit);
    if (!due.length) {
      return 0;
    }
    let changed = 0;
    for (const entry of due) {
      try {
        const status = await this.fetchStatus(entry);
        entry.checkedAt = Date.now();
        if (!status || status.unknown) {
          continue;
        }
        const msg = status.message || {};
        const opened = status.opened || Number(msg.opens || 0) > 0;
        const delivered = this.deliveryOf(status).level === "delivered";
        const broken = /bounce|fail|reject/i
          .test(String(status.delivery_status || ""));
        const state = broken ? "failed"
          : opened ? "opened" : delivered ? "delivered" : "sent";
        if (state !== entry.state) {
          changed++;
        }
        entry.state = state;
        entry.opens = Number(msg.opens || 0);
      } catch (e) {}
    }
    await this.save(list);
    if (changed) {
      this.refreshColumn();
    }
    return changed;
  },

  // ------------------------------------- thanh trạng thái trên thư đã gửi

  /**
   * Thư đang xem có được theo dõi không?
   *
   * Máy chủ ĐỔI header khi xử lý: mình gửi đi "X-HMail-Track: <mã>", bản
   * lưu lại trong hộp Đã gửi (và bản người nhận thấy) mang
   * "X-HMail-Track: opens,clicks" — tức là danh sách thứ máy chủ đã bật,
   * KHÔNG còn mã. Vậy nên: header chỉ dùng để biết "thư này có theo dõi";
   * còn mã để hỏi trạng thái thì lấy từ nhật ký trên máy (hmail-tracking.json).
   *
   * Trả { header, ref, applied }.
   */
  async trackInfo(hdr) {
    const out = { header: "", ref: "", applied: "" };
    if (typeof hMailInsight === "undefined" || !hdr) {
      return out;
    }
    try {
      const raw = await hMailInsight.raw(hdr, 64 * 1024);
      const headers = hMailInsight.headers(raw);
      out.header = hMailInsight.first(headers, "x-hmail-track").trim();
      out.localId = hMailInsight.first(headers, "x-hmail-internal-id").trim();
      if (out.localId) {
        out.header = out.header || out.localId;
      }
    } catch (e) {
      return out;
    }
    if (!out.header) {
      return out;
    }
    if (/^[A-Za-z0-9_-]{16,64}$/.test(out.header)) {
      out.ref = out.header;
    } else {
      out.applied = out.header;
    }
    if (!out.ref && out.localId) {
      const list = await this.load();
      out.ref = list.find(e => e.localId === out.localId)?.ref || "";
      if (out.ref) {
        out.mine = true;
      }
    }
    if (!out.ref) {
      out.ref = await this.refFromLog(hdr);
    }
    return out;
  },

  /** Giữ lại tên cũ cho phần tự kiểm và mã gọi ngoài. */
  async refOf(hdr) {
    return (await this.trackInfo(hdr)).ref;
  },

  /**
   * Dò mã trong nhật ký theo tiêu đề + người nhận + thời điểm gửi. Thư gửi
   * hàng loạt cùng tiêu đề thì lấy bản gần giờ gửi nhất.
   */
  async refFromLog(hdr) {
    try {
      // Message-ID là khoá chắc nhất: đã gặp thư này một lần thì lần sau
      // khỏi đoán theo tiêu đề nữa.
      const id = String(hdr.messageId || "");
      if (id) {
        const byId = (await this.load()).find(e => e.messageId === id);
        if (byId) {
          return byId.ref;
        }
      }
      const subject = this.decodeText(hdr.mime2DecodedSubject || hdr.subject)
        .trim().toLowerCase();
      const rcpt = String(hdr.recipients || "").toLowerCase();
      const at = (hdr.dateInSeconds || 0) * 1000;
      const entries = await this.load();
      let best = null;
      let bestGap = Infinity;
      for (const entry of entries) {
        const entrySubject = this.decodeText(entry.subject).trim().toLowerCase();
        if (entrySubject !== subject) {
          continue;
        }
        const want = (entry.toEmails && entry.toEmails.length)
          ? entry.toEmails : this.emailsOf(entry.to);
        const have = this.emailsOf(rcpt);
        if (want.length && have.length &&
            !want.some(a => have.includes(a))) {
          continue;
        }
        const gap = Math.abs((entry.at || 0) - at);
        if (gap < bestGap) {
          bestGap = gap;
          best = entry;
        }
      }
      // Cùng tiêu đề mà cách nhau quá 2 ngày thì coi như thư khác.
      if (!best || bestGap >= 2 * 24 * 3600 * 1000) {
        return "";
      }
      // Ghi Message-ID lại để lần sau tra thẳng.
      if (id && !best.messageId) {
        best.messageId = id;
        this.save(await this.load()).catch(() => {});
      }
      return best.ref;
    } catch (e) {
      return "";
    }
  },

  /**
   * Watcher cho cửa sổ 3-pane.
   *
   * Header của about:message được DỰNG LẠI mỗi lần nạp thư, nên vẽ một lần
   * là mất: mỗi nhịp phải kiểm tra huy hiệu còn đó không và gắn lại (cùng
   * cách hMailAI.addHeaderButton làm). Trạng thái đã hỏi được thì nhớ theo
   * thư, không hỏi lại máy chủ mỗi nhịp.
   */
  initReader(win) {
    if (win._hmailTrackReader) {
      return;
    }
    win._hmailTrackReader = true;
    this.addColumn(win);
    // Nạp nhật ký để cột danh sách (chạy đồng bộ) có dữ liệu ngay.
    this.load().then(() => this.refreshColumn()).catch(() => {});
    let last = null;
    let shown = null;
    win.setInterval(async () => {
      try {
        if (win.performance.now() < 8000 ||
            typeof hMailInsight === "undefined") {
          return;
        }
        const hdr = hMailInsight.selected(win);
        const key = hdr ? `${hdr.folder?.URI}#${hdr.messageKey}` : null;
        if (key !== last) {
          last = key;
          shown = null;
          const doc = hMailInsight.messageDocument(win);
          doc?.getElementById("hmail-track-bar")?.remove();
          doc?.getElementById("hmail-track-badge")?.remove();
          if (hdr) {
            shown = await this.statusFor(win, hdr);
            // Người dùng có thể đã chuyển thư khác trong lúc chờ mạng.
            if (last !== key) {
              return;
            }
          }
        }
        if (shown) {
          this.paintStatus(win, shown);
        }
      } catch (e) {}
    }, 1500);
    // Trạng thái cho cột danh sách: hỏi máy chủ định kỳ, thưa thôi.
    win.setTimeout(() => this.refreshStates(win).catch(() => {}), 20000);
    win.setInterval(() => this.refreshStates(win).catch(() => {}),
                    5 * 60 * 1000);
  },

  /** Thư nằm trong hộp Đã gửi (hoặc do chính mình gửi) chứ? */
  isSent(hdr) {
    try {
      const folder = hdr.folder;
      if (folder?.getFlag?.(Ci.nsMsgFolderFlags.SentMail) ||
          folder?.flags & Ci.nsMsgFolderFlags.SentMail) {
        return true;
      }
      const from = String(hdr.author || "").toLowerCase();
      for (const id of MailServices.accounts.allIdentities) {
        const mail = String(id.email || "").toLowerCase();
        if (mail && from.includes(mail)) {
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  /** Thư này được theo dõi thế nào? Trả về mô tả để vẽ, hoặc null. */
  async statusFor(win, hdr) {
    const info = await this.trackInfo(hdr);
    const mine = this.isSent(hdr) || info.mine;
    // Thư MÌNH gửi, tìm ra mã bằng bất cứ đường nào (header còn mã, id nội
    // bộ, hay nhật ký khớp Message-ID) thì hiện trạng thái — bản thư nằm ở
    // hộp Đã gửi, Hộp thư đến hay thư mục nào cũng vậy.
    let ref = info.ref;
    if (!ref && mine) {
      await this.load();
      ref = this.entryFor(hdr)?.ref || "";
    }
    if (!ref) {
      // Không có mã: chỉ còn ý nghĩa "thư người khác gửi có gắn theo dõi".
      if (info.header && !mine) {
        return { kind: "incoming",
                 text: "Người gửi có gắn mã theo dõi — họ biết được bạn đã " +
                       "mở thư" + (/click/i.test(info.applied || info.header)
                                    ? " và bấm liên kết nào." : "."),
                 tone: "warn" };
      }
      if (info.header && mine) {
        return { kind: "sent", icon: "sent", short: "Có theo dõi",
                 text: "Có theo dõi, nhưng máy này không giữ mã nên không " +
                       "tra được trạng thái",
                 tone: "unknown" };
      }
      return null;
    }
    const base = this.baseFor(hdr.folder?.server);
    await this.adopt(hdr, ref, base);
    const status = await this.fetchStatus({ ref, base }, true);
    const seen = this.describe(status);
    const msg = status?.message || {};
    const opened = status?.opened || Number(msg.opens || 0) > 0;
    const delivery = this.deliveryOf(status);
    const delivered = delivery.level === "delivered";
    const broken = seen.tone === "fail";
    // Nhật ký cũng cập nhật theo, để cột danh sách khớp với thư đang mở.
    this.rememberState(ref, broken ? "failed"
                            : opened ? "opened"
                            : delivered ? "delivered" : "sent",
                       Number(msg.opens || 0));
    const opens = Number(msg.opens || 0);
    // Hiện CẢ HAI mức: giao tới đâu rồi, và đã mở chưa.
    const short = delivery.short +
      (opened ? (opens > 1 ? ` · Đã mở ${opens} lần` : " · Đã mở") : "");
    return { kind: "sent", ref, status,
             icon: broken ? "failed"
                   : opened ? "opened"
                   : delivered ? "delivered" : "sent",
             short, text: seen.text, tone: seen.tone };
  },

  /**
   * Thư mang mã theo dõi nhưng chưa có trong nhật ký (gửi từ webmail, điện
   * thoại, hay máy khác) thì nhận vào nhật ký khi người dùng mở nó — từ đó
   * danh sách thư có dấu tích mà không phải đọc lại header.
   */
  async adopt(hdr, ref, base) {
    try {
      const list = await this.load();
      const id = String(hdr.messageId || "");
      const found = list.find(e => e.ref === ref ||
                                   (id && e.messageId === id));
      if (found) {
        if (id && !found.messageId) {
          found.messageId = id;
          await this.save(list);
        }
        return;
      }
      list.push({
        ref, base, messageId: id,
        at: (hdr.dateInSeconds || 0) * 1000 || Date.now(),
        subject: this.decodeText(hdr.mime2DecodedSubject || hdr.subject),
        to: this.prettyAddresses(hdr.mime2DecodedRecipients || ""),
        toEmails: this.emailsOf(hdr.mime2DecodedRecipients || ""),
        cc: "",
        from: this.prettyAddresses(hdr.mime2DecodedAuthor || ""),
        adopted: true,
      });
      await this.save(list);
      this.refreshColumn();
    } catch (e) {}
  },

  /** Ghi mức trạng thái vào nhật ký (cột danh sách đọc từ đây). */
  rememberState(ref, state, opens) {
    this.load().then(list => {
      const entry = list.find(e => e.ref === ref);
      if (!entry || (entry.state === state && entry.opens === opens)) {
        return;
      }
      entry.state = state;
      entry.opens = opens;
      entry.checkedAt = Date.now();
      this.save(list).then(() => this.refreshColumn());
    }).catch(() => {});
  },

  /**
   * Dòng thời gian của một mã theo dõi thành các dòng chữ: ai nhận được,
   * lúc nào mở, mở bằng máy gì. Dùng chung cho tooltip của huy hiệu và thẻ
   * chi tiết trong panel hMail AI.
   */
  timelineLines(status, limit = 20) {
    const lines = [];
    // Người nhận cùng miền với người gửi thì thư không đi đâu cả: máy chủ
    // của mình giao thẳng vào hộp thư nội bộ. Gọi đó là "máy chủ người
    // nhận" là sai — chính nó là máy chủ gửi.
    const sender = String(status?.message?.sender || "").toLowerCase();
    const homeDomain = sender.includes("@") ? sender.split("@")[1] : "";
    const isLocal = who => {
      const at = String(who || "").toLowerCase().split("@")[1] || "";
      return !!homeDomain && at === homeDomain;
    };
    const ROW = { sent: "máy chủ người nhận đã nhận",
                  delivered: "đã vào hộp thư", relayed: "đã chuyển tiếp",
                  queued: "đang chờ gửi", pending: "đang chuyển đi",
                  deferred: "bị hoãn, sẽ thử lại", bounced: "bị trả lại",
                  failed: "gửi thất bại", rejected: "bị từ chối" };
    for (const d of status?.delivery || []) {
      const state = String(d.status || d.state || "").toLowerCase();
      const when = d.delivered_at || d.sent_at || d.queued_at ||
                   d.at || d.time || d.updated_at;
      // Mã trả lời của máy chủ người nhận ("250 OK …") cắt ngắn: đủ để
      // người kỹ thuật đối chiếu, không tràn dòng.
      const detail = String(d.status_detail || d.dsn_code || "").slice(0, 40);
      const who = d.recipient || d.rcpt || d.to || "?";
      const label = /sent|deliver|relay/.test(state) && isLocal(who)
        ? "đã vào hộp thư trên máy chủ của bạn (giao nội bộ)"
        : (ROW[state] || state || "");
      lines.push(`${who}: ${label}` +
        (when ? ` — ${new Date(when).toLocaleString("vi-VN")}` : "") +
        (detail ? ` [${detail}]` : ""));
    }
    const events = [...(status?.events || [])].reverse();
    for (const ev of events) {
      const name = ev.event || ev.type || "";
      const kind = { open: "Mở thư", click: "Bấm liên kết" }[name] ||
                   name || "Sự kiện";
      const who = [ev.ip, this.device(ev.user_agent)].filter(Boolean).join(" · ");
      lines.push(`${kind}` + (ev.url ? ` → ${ev.url}` : "") +
        (ev.at ? ` — ${new Date(ev.at).toLocaleString("vi-VN")}` : "") +
        (who ? ` (${who})` : "") +
        (ev.is_bot ? " — máy quét tự động" : "") +
        (ev.is_proxy ? " — qua máy chủ trung gian" : ""));
    }
    return lines.slice(0, limit);
  },

  /**
   * Chi tiết đầy đủ trong panel hMail AI: người dùng đang đọc thư, muốn
   * biết "ai đã mở, lúc nào" mà không phải rời khung thư sang tab khác.
   */
  showDetail(win, shown) {
    try {
      if (typeof hMailAI === "undefined" || !win.hMailSidebar) {
        this.openTab(win);
        return;
      }
      hMailAI.open(win);
      const doc = win.document;
      const log = doc.getElementById("hmail-ai-log");
      if (!log) {
        this.openTab(win);
        return;
      }
      doc.getElementById("hmail-track-detail")?.remove();
      const el = (t, c, x) => this.el(doc, t, c, x);
      const card = el("div", "hmail-ai-insight ok hmail-track-detail");
      card.id = "hmail-track-detail";
      card.appendChild(el("div", "hmail-ai-insight-head",
                          "Trạng thái thư này"));
      card.appendChild(el("div", "hmail-track-detail-state", shown.text));
      const lines = this.timelineLines(shown.status);
      if (lines.length) {
        const list = el("div", "hmail-track-detail-list");
        for (const line of lines) {
          list.appendChild(el("div", "hmail-track-line", line));
        }
        card.appendChild(list);
      } else {
        card.appendChild(el("div", "hmail-track-line",
          "Máy chủ chưa ghi nhận sự kiện nào cho thư này."));
      }
      const open = el("button", "hmail-ai-btn", "Mở bảng Trạng thái thư");
      open.type = "button";
      open.addEventListener("click", () => this.openTab(win));
      card.appendChild(open);
      log.insertBefore(card, log.firstChild);
    } catch (e) {
      Cu.reportError("hMail tracking detail failed: " + e);
    }
  },

  /** Vẽ (hoặc gắn lại) chỉ báo trạng thái cho thư đang mở. */
  paintStatus(win, shown) {
    try {
      const doc = hMailInsight.messageDocument(win);
      if (!doc) {
        return;
      }
      if (shown.kind === "incoming") {
        if (!doc.getElementById("hmail-track-bar")) {
          this.paintBar(win, "", shown);
        }
        return;
      }
      if (doc.getElementById("hmail-track-badge")) {
        return;
      }
      // Chỗ của nó là mép PHẢI của dòng người gửi, tức ngay phía trên giờ
      // gửi. Hàng đó là #headerSenderToolbarContainer và nó xếp
      // flex-direction: row-reverse (class header-row-reverse) — con ĐẦU
      // TIÊN nằm ngoài cùng bên phải, nên chèn vào đầu chứ không append.
      const row = doc.getElementById("headerSenderToolbarContainer") ||
                  doc.getElementById("expandedfromRow") ||
                  doc.getElementById("header-view-toolbar");
      if (!row) {
        return;
      }
      const badge = doc.createElement("button");
      badge.id = "hmail-track-badge";
      badge.className = "hmail-track-badge";
      badge.type = "button";
      const img = doc.createElement("img");
      img.src = this.icon(shown.icon || "sent");
      img.alt = "";
      badge.append(img,
                   this.el(doc, "span", "hmail-track-badge-text",
                           shown.short || shown.text));
      const lines = this.timelineLines(shown.status, 8);
      badge.title =
        `${this.ICON_TITLES[shown.icon] || ""}\n${shown.text}` +
        (lines.length ? "\n\n" + lines.join("\n") : "") +
        "\n\nBấm để xem chi tiết trong hMail AI";
      badge.addEventListener("click", () => this.showDetail(win, shown));
      if (row.id === "headerSenderToolbarContainer") {
        row.insertBefore(badge, row.firstChild);
      } else {
        row.appendChild(badge);
      }
    } catch (e) {}
  },

  paintBar(win, ref, info, status = null) {
    try {
      const doc = hMailInsight.messageDocument(win);
      const host = doc?.getElementById("mail-notification-top") ||
                   doc?.body?.firstElementChild;
      if (!host) {
        return;
      }
      doc.getElementById("hmail-track-bar")?.remove();
      const el = (t, c, x) => this.el(doc, t, c, x);
      const bar = el("div", "hmail-track-bar");
      bar.id = "hmail-track-bar";
      bar.dataset.tone = info.tone || "unknown";
      bar.append(el("span", "hmail-track-bar-title", "Thư có theo dõi:"),
                 el("span", "hmail-track-bar-text", info.text));
      // Chi tiết từng người nhận, khi máy chủ đã có dữ liệu giao.
      const rows = (status?.delivery || []).slice(0, 6);
      if (rows.length) {
        const details = el("details", "hmail-track-bar-details");
        details.appendChild(el("summary", null,
                               `Chi tiết ${rows.length} người nhận`));
        for (const d of rows) {
          const who = d.recipient || d.rcpt || d.to || "?";
          const st = d.status || d.state || "";
          const when = d.at || d.time || d.updated_at || "";
          details.appendChild(el("div", "hmail-track-bar-row",
            `${who}: ${st}` +
            (when ? ` (${new Date(when).toLocaleString("vi-VN")})` : "")));
        }
        bar.appendChild(details);
      }
      if (info.tone !== "warn") {
        const open = el("button", "hmail-track-bar-link", "Mở bảng theo dõi");
        open.type = "button";
        open.addEventListener("click", () => this.openTab(win));
        bar.appendChild(open);
      }
      host.parentNode?.insertBefore(bar, host);
    } catch (e) {}
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
          tab.title = "Trạng thái thư";
          tab.panel.classList.add("hmail-import-tab");
          tab.panel.appendChild(self.buildPanel(win));
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Trạng thái thư";
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
    const delivery = this.deliveryOf(status);
    const tones = { delivered: "ok", sent: "sent" };
    let text = delivery.text;
    let tone = /bounce|fail|reject/.test(state) ? "fail"
      : /pending|queued|deferred/.test(state) ? "wait"
      : (tones[delivery.level] || "unknown");
    // Bao nhiêu người nhận đã nhận được: con số đáng tin hơn một chữ gộp.
    const rows = status.delivery || [];
    const ok = rows.filter(r =>
      /sent|deliver|relay/i.test(String(r.status || ""))).length;
    const sender = String(msg.sender || "").toLowerCase();
    const home = sender.includes("@") ? sender.split("@")[1] : "";
    const outside = rows.filter(r => {
      const at = String(r.recipient || r.rcpt || r.to || "")
        .toLowerCase().split("@")[1] || "";
      return !home || at !== home;
    }).length;
    if (rows.length) {
      text += ` (${ok}/${rows.length} người nhận)`;
      // Không có ai ngoài miền của mình thì đừng nói "máy chủ người nhận".
      if (!outside && /máy chủ người nhận/i.test(text)) {
        text = text.replace("Máy chủ người nhận đã nhận thư",
                            "Đã vào hộp thư trên máy chủ của bạn");
      }
    }
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

  /** Rút gọn user-agent thành tên thiết bị/trình duyệt cho người thường đọc. */
  device(ua) {
    const t = String(ua || "");
    if (!t) {
      return "";
    }
    const os = /Android/i.test(t) ? "Android"
      : /iPhone|iPad|iOS/i.test(t) ? "iPhone/iPad"
      : /Mac OS X|Macintosh/i.test(t) ? "macOS"
      : /Windows/i.test(t) ? "Windows"
      : /Linux/i.test(t) ? "Linux" : "";
    const app = /GoogleImageProxy|Googlebot/i.test(t) ? "Gmail"
      : /YahooMailProxy/i.test(t) ? "Yahoo Mail"
      : /Outlook|Microsoft/i.test(t) ? "Outlook"
      : /Thunderbird/i.test(t) ? "Thunderbird"
      : /Edg\//i.test(t) ? "Edge"
      : /Chrome/i.test(t) ? "Chrome"
      : /Safari/i.test(t) ? "Safari"
      : /Firefox/i.test(t) ? "Firefox" : "";
    return [os, app].filter(Boolean).join(" ") || "thiết bị lạ";
  },

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const root = el("div", "hmail-import hmail-track");
    root.appendChild(el("div", "hmail-import-title", "Trạng thái thư đã gửi"));
    root.appendChild(el("div", "hmail-import-note",
      "Những thư bạn gửi khi bật nút \"Trạng thái thư\" trong cửa sổ soạn " +
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
          "Chưa có thư nào được theo dõi. Khi soạn thư, bấm \"Trạng " +
          "thái thư\" trên thanh lệnh trước khi gửi."));
        return;
      }
      for (const entry of entries) {
        const row = el("div", "hmail-spam-row");
        const main = el("div", "hmail-spam-row-main");
        const head = el("div", "hmail-spam-row-head");
        head.append(
          el("span", "hmail-spam-from",
             this.decodeText(entry.subject) || "(không tiêu đề)"),
          el("span", "hmail-spam-time",
             new Date(entry.at || 0).toLocaleString("vi-VN")));
        main.append(head,
          el("div", "hmail-spam-subject",
             "Tới: " + (this.prettyAddresses(entry.to) || "?")),
          el("div", "hmail-spam-meta",
             "Từ " + (entry.from || "?") + " · mã " + entry.ref));
        const state = el("span", "hmail-spam-state");
        state.textContent = "…";
        row.append(main, state);
        list.appendChild(row);
        if (fetchStatus) {
          this.fetchStatus(entry, true).then(status => {
            const info = this.describe(status);
            state.textContent = info.text;
            state.dataset.status = info.tone === "ok" ? "delivered"
              : info.tone === "fail" ? "rejected"
              : info.tone === "wait" ? "deferred" : "other";
            // Dòng thời gian: giao tới từng người nhận, rồi lượt mở/bấm.
            const lines = [];
            for (const d of status?.delivery || []) {
              lines.push(`${d.recipient || d.rcpt || d.to || "?"}: ` +
                `${d.status || d.state || ""}` +
                (d.at || d.time
                  ? ` — ${new Date(d.at || d.time).toLocaleString("vi-VN")}`
                  : ""));
            }
            // Máy chủ đặt tên trường là "event" (open/click).
            for (const ev of status?.events || []) {
              const name = ev.event || ev.type || "";
              const kind = { open: "Mở thư", click: "Bấm liên kết" }[name] ||
                           name || "Sự kiện";
              const who = [ev.ip, this.device(ev.user_agent)]
                .filter(Boolean).join(" · ");
              lines.push(`${kind}` + (ev.url ? ` → ${ev.url}` : "") +
                (ev.at ? ` — ${new Date(ev.at).toLocaleString("vi-VN")}` : "") +
                (who ? ` (${who})` : "") +
                (ev.is_bot ? " — máy quét tự động, không phải người mở" : "") +
                (ev.is_proxy ? " — qua máy chủ trung gian (Gmail, Outlook)"
                             : ""));
            }
            lines.reverse();
            if (lines.length) {
              const det = el("details", "hmail-track-details");
              det.appendChild(el("summary", null,
                                 `Dòng thời gian (${lines.length})`));
              for (const line of lines) {
                det.appendChild(el("div", "hmail-track-line", line));
              }
              main.appendChild(det);
            }
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
      if (Services.prompt.confirm(win, "Trạng thái thư",
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
      fields.setHeader("X-HMail-Internal-Id", hMailTrack.newLocalId(win));
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

// ---------------------------------------------------------------------------
// Tự kiểm phần HIỂN THỊ (pref hmail.debug.trackbartest = "run"): tìm thư đã
// gửi có header X-HMail-Track trong hộp Đã gửi, chạy đúng đường mà thanh
// trạng thái dùng (refOf → fetchStatus → describe) rồi ghi kết quả ra pref.
// Không đụng UI, không gửi thư — chỉ kiểm logic đọc và diễn giải.
(function () {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.trackbartest", "");
  } catch (e) {}
  if (mode !== "run" && mode !== "sent") {
    return;
  }
  const sentOnly = mode === "sent";
  Services.prefs.setCharPref("hmail.debug.trackbartest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.trackbartest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const lines = [];
    try {
      let found = null;
      for (const acc of MailServices.accounts.accounts) {
        const root = acc.incomingServer?.rootFolder;
        if (!root) {
          continue;
        }
        for (const folder of root.descendants) {
          // Cả hộp Đã gửi lẫn Hộp thư đến: thư tự gửi cho mình cũng là
          // "thư mình gửi" theo isSent(), và đó là ca kiểm nhanh nhất.
          const wanted = sentOnly
            ? Ci.nsMsgFolderFlags.SentMail
            : (Ci.nsMsgFolderFlags.SentMail | Ci.nsMsgFolderFlags.Inbox);
          if (!(folder.flags & wanted)) {
            continue;
          }
          const hdrs = [...folder.messages]
            .sort((a, b) => (b.dateInSeconds || 0) - (a.dateInSeconds || 0));
          for (const hdr of hdrs.slice(0, 60)) {
            const info = await hMailTrack.trackInfo(hdr);
            if (!info.header) {
              continue;
            }
            // Ưu tiên thư tra được mã (có trong nhật ký) để kiểm cả đường
            // hỏi máy chủ, không dừng ở thư đầu tiên chỉ có header.
            if (info.ref || !found) {
              found = { hdr, ref: info.ref, info, folder };
            }
            if (info.ref) {
              break;
            }
          }
          if (found?.ref) {
            break;
          }
        }
        if (found?.ref) {
          break;
        }
      }
      if (!found) {
        report("err: khong tim thay thu da gui co X-HMail-Track");
        return;
      }
      lines.push("watcher=" + !!win._hmailTrackReader);
      lines.push("folder=" + found.folder.prettyName);
      try {
        const raw = await hMailInsight.raw(found.hdr, 64 * 1024);
        lines.push("rawBytes=" + raw.length);
      } catch (e) {
        lines.push("rawErr=" + (e.message || e));
      }
      lines.push("header=" + found.info.header + " applied=" +
                 found.info.applied + " ref=" + (found.ref || "(khong co)"));
      lines.push("subject=" + (found.hdr.mime2DecodedSubject || ""));
      if (!found.ref) {
        report("khong tra duoc ma | " + lines.join(" | "));
        return;
      }
      lines.push("isSent=" + hMailTrack.isSent(found.hdr));
      const base = hMailTrack.baseFor(found.folder.server);
      lines.push("base=" + base);
      const status = await hMailTrack.fetchStatus({ ref: found.ref, base },
                                                  true);
      const info = hMailTrack.describe(status);
      lines.push("tone=" + info.tone);
      lines.push("text=" + info.text);
      lines.push("events=" + (status?.events || []).length +
                 " delivery=" + (status?.delivery || []).length);
      const ev = (status?.events || [])[0];
      if (ev) {
        lines.push("ev0=" + (ev.event || ev.type) + " " +
                   hMailTrack.device(ev.user_agent));
      }
      // Cột danh sách: đăng ký được chưa, và tra đồng bộ ra mức nào.
      try {
        hMailTrack.addColumn(win);
        const { ThreadPaneColumns } = ChromeUtils.importESModule(
          "chrome://messenger/content/ThreadPaneColumns.mjs");
        lines.push("column=" + ThreadPaneColumns.getCustomColumns()
          .some(c => c.id === hMailTrack.COLUMN_ID));
        lines.push("iconTruoc=" + (hMailTrack.iconFor(found.hdr) || "(khong)"));
      } catch (e) {
        lines.push("column err: " + (e.message || e));
      }
      // Huy hiệu trong header thư: mở THẬT thư trong hộp Đã gửi ra tab,
      // đợi header dựng xong rồi mới soi — đúng thứ người dùng nhìn thấy.
      try {
        const { MailUtils } = ChromeUtils.importESModule(
          "resource:///modules/MailUtils.sys.mjs");
        MailUtils.displayMessage(found.hdr);
        await new Promise(r => win.setTimeout(r, 4000));
      } catch (e) {
        lines.push("mo thu err: " + (e.message || e));
      }
      try {
        const shown = await hMailTrack.statusFor(win, found.hdr);
        lines.push("shown=" + (shown ? shown.icon + "/" + shown.tone : "null"));
        hMailTrack.paintStatus(win, shown);
        const doc = hMailInsight.messageDocument(win);
        lines.push("badge=" + (doc?.getElementById("hmail-track-badge")
                                ? "da gan"
                                : (doc ? "chua gan" : "khong co document thu")));
        // Sau khi mở thư: nhật ký đã nhận thư này chưa, cột ra dấu gì.
        await hMailTrack.refreshStates(win);
        lines.push("iconSau=" + (hMailTrack.iconFor(found.hdr) || "(khong)"));
        lines.push("textSau=" + (hMailTrack.textFor(found.hdr) || ""));
        const log = await hMailTrack.load();
        lines.push("nhatKy=" + log.length + " adopted=" +
                   log.filter(e => e.adopted).length);
        // Nhãn hiện trên huy hiệu + đóng tab tự kiểm lại như cũ.
        const badge = doc?.getElementById("hmail-track-badge");
        if (badge) {
          lines.push("nhan=" + badge.getAttribute("label"));
        }
        try {
          const tabmail = win.document.getElementById("tabmail");
          const tab = tabmail?.currentTabInfo;
          if (tab && tab.mode?.name === "mailMessageTab") {
            tabmail.closeTab(tab);
          }
        } catch (e) {}
      } catch (e) {
        lines.push("badge err: " + (e.message || e));
      }
      report(lines.join(" | "));
    } catch (e) {
      report("err: " + (e.message || e) + " | " + lines.join(" | "));
    }
  }, 12000);
})();
