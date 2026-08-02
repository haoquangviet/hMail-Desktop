/* hMail Desktop — đọc hiểu thư ngay trên máy
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Everything here runs locally: no network call, no cost, no message leaving
 * the machine. It answers the two questions worth asking before reading a
 * message — what is this about, and can I trust it — and it answers them in
 * the time it takes to open the message.
 *
 * The trust half matters most on money. Invoice fraud does not arrive looking
 * like spam: it arrives as a reply inside a real conversation, from an address
 * one letter off the real one, asking for a payment to a new account. So the
 * checks look at exactly that: who is new to this thread, whether the sending
 * domain merely resembles one you know, what the authentication headers say,
 * and whether the message is about a payment at all.
 *
 * Nothing here decides anything for the user. It reports what it found, with
 * the reason, and leaves the judgement to them.
 */

"use strict";

var hMailInsight = {
  /** Money words. A hit alone means nothing; combined with a warning it does. */
  MONEY_WORDS: [
    "hóa đơn", "hoá đơn", "thanh toán", "chuyển khoản", "chuyển tiền",
    "số tài khoản", "tài khoản ngân hàng", "công nợ", "báo giá", "tạm ứng",
    "invoice", "payment", "remittance", "wire transfer", "bank details",
    "bank account", "account number", "swift", "iban", "beneficiary",
    "purchase order", "quotation", "outstanding balance", "past due",
  ],

  /** Phrases that turn a payment mail into the classic redirection attempt. */
  MONEY_RED_FLAGS: [
    "thay đổi tài khoản", "đổi số tài khoản", "tài khoản mới",
    "cập nhật thông tin thanh toán", "gấp", "khẩn", "ngay hôm nay",
    "changed our bank", "new bank account", "updated bank details",
    "change of account", "as soon as possible", "urgent", "asap",
    "kindly process", "confidential",
  ],

  /**
   * Bounce messages say what went wrong in the language of mail servers:
   * "554 5.7.1", "552 5.3.4", "Diagnostic-Code: smtp; ...". This turns that
   * into an answer to the two questions the sender actually has — why did it
   * not arrive, and what do I do now.
   *
   * Order matters: the first rule that matches wins, so the specific ones
   * come before the general ones. `text` is the diagnostic line lowercased,
   * which is what carries the reason when a server sends no enhanced code.
   */
  BOUNCE_RULES: [
    {
      test: (e, b, t) => e === "5.1.1" || e === "5.1.10" ||
        /user unknown|no such user|recipient not found|does not exist|unknown recipient|invalid recipient|address rejected/.test(t),
      kind: "permanent",
      title: "Địa chỉ người nhận không tồn tại",
      why: "Máy chủ bên nhận trả lời rằng hộp thư này không có trên hệ thống của họ.",
      todo: "Kiểm tra lại chính tả địa chỉ. Nếu đúng, có thể người đó đã nghỉ việc hoặc hộp thư đã bị xoá — hỏi lại bằng kênh khác.",
    },
    {
      test: e => e === "5.1.2" || e === "5.4.4",
      kind: "permanent",
      title: "Không tìm thấy máy chủ thư của tên miền người nhận",
      why: "Tên miền trong địa chỉ không có bản ghi máy chủ thư, hoặc tên miền viết sai.",
      todo: "Kiểm tra phần sau dấu @. Nếu tên miền đúng thì hệ thống thư của họ đang có sự cố.",
    },
    {
      test: (e, b, t) => e === "5.2.2" ||
        /mailbox full|quota exceeded|over quota|hộp thư đầy/.test(t),
      kind: "permanent",
      title: "Hộp thư người nhận đã đầy",
      why: "Người nhận đã dùng hết dung lượng được cấp nên không nhận thêm được thư.",
      todo: "Báo cho họ dọn bớt hộp thư, rồi gửi lại.",
    },
    {
      test: (e, b, t) => ["5.3.4", "5.2.3"].includes(e) || b === 552 ||
        b === 523 || /message too (large|big)|size exceeds|exceeds size limit|quá dung lượng/.test(t),
      kind: "permanent",
      title: "Thư vượt quá dung lượng cho phép",
      why: "Thư (thường là do tệp đính kèm) lớn hơn giới hạn của máy chủ gửi hoặc máy chủ nhận. Nhiều nơi chỉ cho phép 10–25 MB, và đính kèm bị phình thêm khoảng một phần ba khi mã hoá.",
      todo: "Nén tệp lại, hoặc tải lên nơi lưu trữ rồi gửi liên kết thay vì đính kèm.",
    },
    {
      test: (e, b, t) => e === "5.5.3" ||
        /too many recipients|quá nhiều người nhận/.test(t),
      kind: "permanent",
      title: "Quá nhiều người nhận trong một thư",
      why: "Máy chủ giới hạn số địa chỉ cho mỗi thư để chống phát tán thư rác.",
      todo: "Chia thành nhiều đợt gửi ít người hơn — tính năng Trộn thư của hMail gửi riêng từng người nên không vướng giới hạn này.",
    },
    {
      test: (e, b, t) =>
        /too many parts|too many mime|nesting|too many attachments|line too long|message too long|header too large|too many headers/.test(t),
      kind: "permanent",
      title: "Cấu trúc thư vượt giới hạn của máy chủ",
      why: "Thư có quá nhiều phần, quá nhiều tệp đính kèm, dòng quá dài hoặc phần đầu thư quá lớn so với mức máy chủ chấp nhận.",
      todo: "Gửi lại dưới dạng đơn giản hơn: bớt tệp đính kèm, bỏ nội dung trích dẫn dài, tránh dán ảnh trực tiếp vào thân thư.",
    },
    {
      test: (e, b, t) => /bad ip|blacklist|blocked using|listed (at|on|in)|spamhaus|rbl|dnsbl|poor reputation|bad reputation/.test(t),
      kind: "permanent",
      title: "Địa chỉ IP máy chủ gửi đang bị chặn",
      why: "Bên nhận từ chối vì IP của máy chủ gửi nằm trong danh sách đen, hoặc uy tín gửi thư đang thấp.",
      todo: "Đây là việc của quản trị hệ thống thư phía gửi, không phải lỗi của bạn. Báo cho họ để yêu cầu gỡ khỏi danh sách đen.",
    },
    {
      test: (e, b, t) => ["5.7.23", "5.7.24", "5.7.25", "5.7.26"].includes(e) ||
        /spf|dkim|dmarc|sender policy|not authorized to send|unauthenticated/.test(t),
      kind: "permanent",
      title: "Bên nhận không chấp nhận vì xác thực người gửi không đạt",
      why: "SPF, DKIM hoặc DMARC của tên miền gửi không hợp lệ với bên nhận, nên họ coi thư là mạo danh.",
      todo: "Báo quản trị hệ thống kiểm tra lại bản ghi SPF/DKIM/DMARC của tên miền gửi.",
    },
    {
      test: (e, b, t) => e === "5.7.13" || e === "5.7.0" ||
        /relay(ing)? denied|relay access denied|not permitted|sender denied|authentication required/.test(t),
      kind: "permanent",
      title: "Không được phép gửi qua máy chủ này",
      why: "Máy chủ từ chối chuyển tiếp thư từ người gửi này — thường do chưa đăng nhập SMTP hoặc tài khoản không có quyền gửi ra ngoài.",
      todo: "Kiểm tra cài đặt máy chủ gửi (SMTP) trong tài khoản: đúng máy chủ, đúng cổng, và có bật xác thực.",
    },
    {
      test: (e, b, t) => e === "5.7.1" || b === 554 ||
        /rejected|not allowed|policy|refused|blocked|từ chối/.test(t),
      kind: "permanent",
      title: "Bên nhận chủ động từ chối thư",
      why: "Máy chủ bên nhận từ chối theo chính sách của họ — có thể do nội dung bị coi là thư rác, do người nhận chặn người gửi, hoặc do quy định nội bộ.",
      todo: "Thử liên hệ người nhận bằng kênh khác và nhờ họ đưa địa chỉ của bạn vào danh sách cho phép.",
    },
    {
      test: (e, b, t) => /spam|bulk mail|content rejected|virus|malware/.test(t),
      kind: "permanent",
      title: "Thư bị coi là thư rác hoặc chứa nội dung nguy hiểm",
      why: "Bộ lọc bên nhận đánh giá nội dung hoặc tệp đính kèm là không an toàn.",
      todo: "Bỏ tệp đính kèm dạng chạy được, viết lại nội dung tự nhiên hơn, tránh nhiều liên kết rút gọn.",
    },
    {
      test: (e, b, t) => /greylist|try again later|deferred|temporarily/.test(t) ||
        (e || "").startsWith("4"),
      kind: "temporary",
      title: "Tạm thời chưa gửi được, hệ thống sẽ tự thử lại",
      why: "Bên nhận đang bận, đang hoãn tạm thời (greylisting), hoặc gặp trục trặc ngắn hạn.",
      todo: "Không cần làm gì. Máy chủ sẽ tự gửi lại trong vài giờ; nếu vài ngày vẫn không được, bạn sẽ nhận thêm một thư báo lỗi vĩnh viễn.",
    },
    {
      test: (e, b, t) => /loop|too many hops/.test(t),
      kind: "permanent",
      title: "Thư bị lặp vòng giữa các máy chủ",
      why: "Cấu hình chuyển tiếp thư ở đâu đó tạo thành vòng lặp, thư đi qua quá nhiều chặng.",
      todo: "Báo quản trị hệ thống kiểm tra quy tắc chuyển tiếp của hộp thư liên quan.",
    },
  ],

  RISKY_ATTACHMENTS:
    /\.(exe|scr|com|pif|bat|cmd|js|jse|vbs|vbe|wsf|hta|msi|lnk|iso|img|jar|ps1)$/i,

  STOPWORDS: new Set([
    "và", "là", "của", "có", "cho", "các", "được", "trong", "với", "này",
    "đó", "một", "những", "để", "khi", "từ", "đã", "sẽ", "không", "nếu",
    "the", "and", "for", "you", "your", "that", "this", "with", "have",
    "from", "are", "was", "will", "can", "our", "has", "but", "not", "all",
  ]),

  // --------------------------------------------------------------- nguồn

  // ------------------------------------------------------------- cảnh báo

  init(win) {
    try {
      this.dismissed = new Set();
      let last = null;
      // The message pane rebuilds its notification area while a message
      // loads, which throws our bar away, so the tick both analyses new
      // messages and puts the bar back whenever it has gone missing.
      win.setInterval(() => {
        const hdr = this.selected(win);
        const key = hdr ? `${hdr.folder?.URI}#${hdr.messageKey}` : null;
        if (key !== last) {
          last = key;
          this.showBanner(win, hdr).catch(() => {});
          return;
        }
        if (key && this.cache?.key === key &&
            this.cache.result.level !== "ok" &&
            !this.dismissed.has(key)) {
          const doc = this.messageDocument(win);
          if (doc && !doc.getElementById("hmail-warning")) {
            this.paint(win, doc, this.cache.result, key);
          }
        }
      }, 800);
    } catch (e) {
      Cu.reportError("hMail insight init failed: " + e);
    }
  },

  selected(win) {
    try {
      const standalone = win.document.getElementById("messageBrowser");
      if (standalone && !win.document.getElementById("tabmail")) {
        return standalone.contentWindow?.gMessage || null;
      }
      return win.document.getElementById("tabmail")?.currentAbout3Pane
        ?.gDBView?.hdrForFirstSelectedMessage || null;
    } catch (e) {
      return null;
    }
  },

  messageDocument(win) {
    try {
      const tabmail = win.document.getElementById("tabmail");
      if (!tabmail) {
        return win.document.getElementById("messageBrowser")
          ?.contentDocument || null;
      }
      return tabmail.currentAbout3Pane?.messageBrowser?.contentDocument || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * A bar above the message, next to Thunderbird's own notices. Only shown
   * when there is something to say — an ordinary message gets nothing, so the
   * bar keeps its meaning.
   */
  async showBanner(win, hdr) {
    const doc = this.messageDocument(win);
    if (!doc) {
      return;
    }
    doc.getElementById("hmail-warning")?.remove();
    if (!hdr) {
      return;
    }

    const key = `${hdr.folder?.URI}#${hdr.messageKey}`;
    const result = await this.analyze(hdr);
    this.cache = { key, result };
    if (result.level === "ok" || this.dismissed?.has(key)) {
      return;
    }
    this.paint(win, doc, result, key);
  },

  paint(win, doc, result, key) {
    doc.getElementById("hmail-warning")?.remove();
    const host = doc.getElementById("mail-notification-top") ||
                 doc.body?.firstElementChild;
    if (!host) {
      return;
    }

    const el = (tag, cls, text) => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (cls) {
        node.className = cls;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    };

    const bar = el("div", `hmail-warning ${result.level}`);
    bar.id = "hmail-warning";

    // A bounce gets the bar to itself: the sender wants to know why their
    // message came back, not a list of header observations.
    if (result.bounce) {
      const b = result.bounce;
      const head = el("div", "hmail-warning-head");
      head.append(el("span", "hmail-warning-title",
        b.temporary ? `Thư chưa gửi được — ${b.title}`
                    : `Thư không gửi được — ${b.title}`));
      const close = el("button", "hmail-warning-close", "✕");
      close.title = "Ẩn cảnh báo";
      close.addEventListener("click", () => {
        this.dismissed?.add(key);
        bar.remove();
      });
      head.appendChild(close);
      bar.appendChild(head);

      const list = el("ul", "hmail-warning-list");
      if (b.recipient) {
        list.appendChild(el("li", "hmail-warning-item",
                            `Không tới được: ${b.recipient}`));
      }
      list.appendChild(el("li", "hmail-warning-item", b.why));
      list.appendChild(el("li", "hmail-warning-item", `Nên làm: ${b.todo}`));
      bar.appendChild(list);
      host.insertBefore(bar, host.firstChild);
      return;
    }

    const serious = result.findings.filter(f => f.level === "danger");
    const shown = (serious.length ? serious : result.findings).slice(0, 3);
    const title = result.level === "danger"
      ? (result.money ? "Cẩn thận: thư về tiền bạc có dấu hiệu bất thường"
                      : "Cẩn thận với thư này")
      : "Có vài điểm nên để ý ở thư này";

    const head = el("div", "hmail-warning-head");
    head.append(el("span", "hmail-warning-title", title));
    const close = el("button", "hmail-warning-close", "✕");
    close.title = "Ẩn cảnh báo";
    close.addEventListener("click", () => {
      this.dismissed?.add(key);
      bar.remove();
    });
    head.appendChild(close);
    bar.appendChild(head);

    const list = el("ul", "hmail-warning-list");
    for (const finding of shown) {
      list.appendChild(el("li", `hmail-warning-item ${finding.level}`,
                          finding.text));
    }
    bar.appendChild(list);

    host.insertBefore(bar, host.firstChild);
  },

  /** Raw RFC 5322 text of a message. */
  raw(hdr) {
    return new Promise((resolve, reject) => {
      try {
        const uri = hdr.folder.getUriForMsg(hdr);
        const service = MailServices.messageServiceFromURI(uri);
        const chunks = [];
        const listener = {
          QueryInterface: ChromeUtils.generateQI([
            "nsIStreamListener", "nsIRequestObserver",
          ]),
          onStartRequest() {},
          onDataAvailable(request, stream, offset, count) {
            const binary = Cc["@mozilla.org/binaryinputstream;1"]
              .createInstance(Ci.nsIBinaryInputStream);
            binary.setInputStream(stream);
            chunks.push(binary.readBytes(count));
          },
          onStopRequest(request, status) {
            Components.isSuccessCode(status)
              ? resolve(chunks.join(""))
              : reject(new Error("không đọc được thư"));
          },
        };
        service.streamMessage(uri, listener, null, null, false, "", false);
      } catch (e) {
        reject(e);
      }
    });
  },

  /** Header block as a map; repeated headers keep every value. */
  headers(raw) {
    const end = raw.search(/\r?\n\r?\n/);
    const block = (end === -1 ? raw : raw.slice(0, end))
      .replace(/\r?\n[ \t]+/g, " ");
    const map = new Map();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at < 1) {
        continue;
      }
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      map.has(name) ? map.get(name).push(value) : map.set(name, [value]);
    }
    return map;
  },

  first(headers, name) {
    return headers.get(name)?.[0] || "";
  },

  address(value) {
    const angled = /<([^>]+)>/.exec(value || "");
    const raw = angled ? angled[1] : String(value || "");
    return raw.trim().toLowerCase().replace(/^["']|["']$/g, "");
  },

  domain(addressOrValue) {
    const at = this.address(addressOrValue).split("@")[1];
    return at ? at.replace(/[>,;\s]+$/, "") : "";
  },

  displayName(value) {
    const m = /^\s*"?([^"<]*?)"?\s*</.exec(value || "");
    return (m ? m[1] : "").trim();
  },

  /** Every address in a header that may hold several. */
  addresses(value) {
    return String(value || "")
      .split(/,(?![^<]*>)/)
      .map(part => this.address(part))
      .filter(a => a.includes("@"));
  },

  // ------------------------------------------------------------- so sánh

  /** Edit distance, capped — only small differences are interesting. */
  distance(a, b) {
    if (Math.abs(a.length - b.length) > 3) {
      return 99;
    }
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = prev[j];
        prev[j] = Math.min(
          prev[j] + 1,
          prev[j - 1] + 1,
          last + (a[i - 1] === b[j - 1] ? 0 : 1));
        last = current;
      }
    }
    return prev[b.length];
  },

  /** Domains the user deals with: their own identities plus the address book. */
  knownDomains() {
    if (this._known && Date.now() - this._knownAt < 300000) {
      return this._known;
    }
    const domains = new Map();
    const add = (domain, source) => {
      if (domain && !domains.has(domain)) {
        domains.set(domain, source);
      }
    };
    try {
      for (const identity of MailServices.accounts.allIdentities) {
        add(this.domain(identity.email), "tài khoản của bạn");
      }
    } catch (e) {}
    try {
      for (const book of MailServices.ab.directories) {
        for (const card of book.childCards) {
          add(this.domain(card.primaryEmail), "danh bạ");
        }
      }
    } catch (e) {}
    this._known = domains;
    this._knownAt = Date.now();
    return domains;
  },

  /**
   * Addresses that already took part in this conversation, and how many
   * messages there were before this one.
   */
  threadHistory(hdr) {
    const seen = new Set();
    let count = 0;
    try {
      const db = hdr.folder.msgDatabase;
      const thread = db.getThreadContainingMsgHdr(hdr);
      if (!thread) {
        return { seen, count };
      }
      for (let i = 0; i < thread.numChildren; i++) {
        const other = thread.getChildHdrAt(i);
        if (!other || other.messageKey === hdr.messageKey) {
          continue;
        }
        if (other.dateInSeconds > hdr.dateInSeconds) {
          continue;
        }
        count++;
        for (const value of [other.author, other.recipients, other.ccList]) {
          for (const address of this.addresses(value)) {
            seen.add(address);
          }
        }
      }
    } catch (e) {}
    return { seen, count };
  },

  // ------------------------------------------------------------ phân tích

  /**
   * Look at one message. Returns findings and a plain summary; never throws.
   */
  async analyze(hdr) {
    const out = {
      level: "ok",
      findings: [],
      summary: [],
      facts: {},
      money: false,
    };
    const note = (level, text) => {
      out.findings.push({ level, text });
      if (level === "danger" ||
          (level === "warn" && out.level !== "danger")) {
        out.level = level === "danger" ? "danger" : "warn";
      }
    };

    let raw = "";
    try {
      raw = await this.raw(hdr);
    } catch (e) {
      return out;
    }
    const headers = this.headers(raw);
    const body = this.plainBody(raw);
    const text = `${hdr.mime2DecodedSubject || ""}\n${body}`.toLowerCase();

    // --- ai gửi ---------------------------------------------------------
    const fromRaw = this.first(headers, "from") || hdr.author || "";
    const from = this.address(fromRaw);
    const fromDomain = this.domain(fromRaw);
    const shown = this.displayName(fromRaw);

    // A display name that contains a different address is the oldest trick
    // there is: the client shows the name, the reply goes elsewhere.
    const shownAddress = /[\w.+-]+@[\w.-]+\.\w+/.exec(shown)?.[0]
      ?.toLowerCase();
    if (shownAddress && shownAddress !== from) {
      note("danger",
        `Tên hiển thị ghi "${shownAddress}" nhưng thư thật sự gửi từ ` +
        `${from}.`);
    }

    const replyTo = this.address(this.first(headers, "reply-to"));
    if (replyTo && this.domain(replyTo) &&
        this.domain(replyTo) !== fromDomain) {
      note("warn",
        `Trả lời thư này sẽ đi tới ${replyTo} (khác tên miền người gửi ` +
        `${fromDomain}).`);
    }

    // --- tên miền nhìn giống ---------------------------------------------
    if (fromDomain) {
      const known = this.knownDomains();
      if (!known.has(fromDomain)) {
        for (const [domain, source] of known) {
          if (domain !== fromDomain && this.distance(domain, fromDomain) <= 2) {
            note("danger",
              `Tên miền ${fromDomain} trông rất giống ${domain} ` +
              `(${source}) nhưng không phải cùng một tên miền.`);
            break;
          }
        }
      }
    }

    // --- xác thực ---------------------------------------------------------
    const auth = (headers.get("authentication-results") || []).join(" ")
      .toLowerCase();
    const spfHeader = this.first(headers, "received-spf").toLowerCase();
    const check = (name, pattern) => {
      const m = pattern.exec(auth);
      return m ? m[1] : "";
    };
    const dkim = check("dkim", /dkim=(\w+)/);
    const spf = check("spf", /spf=(\w+)/) ||
      (/^\s*(pass|fail|softfail|neutral|none)/.exec(spfHeader)?.[1] || "");
    const dmarc = check("dmarc", /dmarc=(\w+)/);

    out.facts.auth = { dkim, spf, dmarc };
    for (const [label, value] of [["DKIM", dkim], ["SPF", spf],
                                  ["DMARC", dmarc]]) {
      if (/^(fail|softfail|permerror|temperror)$/.test(value)) {
        note(label === "DMARC" ? "danger" : "warn",
          `${label} không đạt (${value}) — thư có thể bị mạo danh người gửi.`);
      }
    }
    if (!auth && !spfHeader) {
      note("info", "Thư không có kết quả kiểm tra xác thực (SPF/DKIM/DMARC).");
    }

    // --- cảnh báo do máy chủ gắn sẵn --------------------------------------
    const spamFlag = this.first(headers, "x-spam-flag").toLowerCase();
    if (spamFlag.startsWith("yes")) {
      note("warn", "Máy chủ đã đánh dấu thư này là thư rác.");
    }
    const spamStatus = this.first(headers, "x-spam-status");
    const score = /score=([-\d.]+)/i.exec(spamStatus)?.[1];
    if (score && parseFloat(score) >= 5) {
      note("warn", `Điểm lọc thư rác của máy chủ khá cao (${score}).`);
    }
    for (const name of ["x-external-sender", "x-ms-exchange-organization-" +
                        "authas", "x-hmail-warning"]) {
      const value = this.first(headers, name);
      if (/external|cảnh báo/i.test(value)) {
        note("info", `Máy chủ ghi chú: ${value.slice(0, 120)}`);
      }
    }

    // --- người lạ trong chuỗi thư -----------------------------------------
    const history = this.threadHistory(hdr);
    if (history.count > 0) {
      const mine = new Set();
      try {
        for (const identity of MailServices.accounts.allIdentities) {
          mine.add(this.address(identity.email));
        }
      } catch (e) {}

      if (from && !history.seen.has(from) && !mine.has(from)) {
        note("danger",
          `${from} chưa từng xuất hiện trong ${history.count} thư trước của ` +
          `chuỗi này — hãy kiểm tra kỹ trước khi trả lời.`);
      }
      const newcomers = [];
      for (const value of [this.first(headers, "to"),
                           this.first(headers, "cc")]) {
        for (const address of this.addresses(value)) {
          if (!history.seen.has(address) && !mine.has(address) &&
              address !== from) {
            newcomers.push(address);
          }
        }
      }
      if (newcomers.length) {
        note("warn",
          `Người nhận mới được thêm vào chuỗi thư: ` +
          `${newcomers.slice(0, 4).join(", ")}` +
          `${newcomers.length > 4 ? "…" : ""}.`);
      }
    }

    // --- tiền bạc ---------------------------------------------------------
    const moneyHits = this.MONEY_WORDS.filter(w => text.includes(w));
    const redFlags = this.MONEY_RED_FLAGS.filter(w => text.includes(w));
    const accountNumbers = (body.match(/\b\d[\d\s.-]{8,20}\d\b/g) || [])
      .map(s => s.trim()).slice(0, 3);
    const iban = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.exec(body)?.[0];

    out.money = moneyHits.length > 0;
    if (out.money) {
      out.facts.money = { words: moneyHits.slice(0, 5), accountNumbers, iban };
      const severe = out.findings.some(f => f.level === "danger");
      note(severe ? "danger" : "info",
        "Thư này nói về thanh toán hoặc tài khoản ngân hàng" +
        (accountNumbers.length || iban
          ? ` và có nêu số tài khoản (${iban || accountNumbers[0]})`
          : "") + ".");
      if (redFlags.length) {
        note("danger",
          `Có dấu hiệu điển hình của lừa đảo chuyển tiền: ` +
          `"${redFlags.slice(0, 3).join('", "')}". Hãy gọi điện xác nhận ` +
          `với người gửi bằng số điện thoại bạn đã biết, đừng dùng số ghi ` +
          `trong thư.`);
      }
    }

    // --- liên kết và tệp đính kèm -----------------------------------------
    for (const link of this.suspiciousLinks(raw)) {
      note("warn", link);
    }
    const attachments = (raw.match(/filename="?([^"\r\n;]+)"?/gi) || [])
      .map(s => s.replace(/^filename="?/i, "").replace(/"$/, "").trim());
    for (const name of attachments) {
      if (this.RISKY_ATTACHMENTS.test(name)) {
        note("danger", `Tệp đính kèm "${name}" có thể chạy được mã — ` +
                       `chỉ mở khi bạn chắc chắn đã yêu cầu tệp này.`);
      }
    }

    // --- thư bị trả về ----------------------------------------------------
    // Checked last so the security findings above are already in place, and
    // reported as information rather than danger: a bounce is a fact about
    // your own message, not a threat.
    const bounce = this.bounce(headers, body, hdr);
    if (bounce) {
      out.bounce = bounce;
      out.facts.bounce = bounce;
      note("info", `Thư trả về: ${bounce.title}` +
        (bounce.recipient ? ` (${bounce.recipient})` : ""));
    }

    out.summary = this.summarize(hdr, body);
    out.facts.dates = this.dates(body);
    out.facts.amounts = this.amounts(body);
    return out;
  },

  // --------------------------------------------------------- thư trả về

  /**
   * Is this a bounce, and if so what happened?
   *
   * The tidy case is a delivery status notification (RFC 3464): a
   * multipart/report with Final-Recipient, Action, Status and
   * Diagnostic-Code fields. Plenty of servers send prose instead, so the
   * codes and the address are also dug out of the body text.
   */
  bounce(headers, body, hdr) {
    const from = this.address(this.first(headers, "from") || hdr?.author || "");
    const contentType = this.first(headers, "content-type").toLowerCase();
    const subject = String(hdr?.mime2DecodedSubject || "");

    const looksLikeBounce =
      /report-type=delivery-status|multipart\/report/.test(contentType) ||
      /^(mailer-daemon|postmaster|no-?reply)@/i.test(from) ||
      /delivery (status notification|failure|has failed)|undeliver|returned mail|failure notice|thư không gửi được|không thể gửi/i
        .test(subject);
    if (!looksLikeBounce) {
      return null;
    }

    const field = name => {
      const m = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im").exec(body);
      return m ? m[1].trim() : "";
    };

    // Who it was for. rfc822;user@host in a DSN, or the prose form.
    let recipient = field("Final-Recipient") || field("Original-Recipient");
    recipient = recipient.replace(/^[^;]*;\s*/, "").trim();
    if (!recipient) {
      const m = /^To:\s*([^\s<>]+@[^\s<>]+)/im.exec(body) ||
        /addressed to[^\n]*?([\w.+-]+@[\w.-]+\.\w+)/i.exec(body);
      recipient = m ? m[1] : "";
    }
    recipient = recipient.replace(/[<>]/g, "");

    const diagnostic = field("Diagnostic-Code")
      .replace(/^smtp\s*;\s*/i, "").trim();
    const statusField = field("Status");
    const action = field("Action").toLowerCase();

    // Codes, wherever they appear: the DSN fields first, then the body.
    const enhancedMatch = /\b([245]\.\d{1,3}\.\d{1,3})\b/
      .exec(`${statusField} ${diagnostic} ${body}`);
    const basicMatch = /\b([245]\d\d)[\s-]/.exec(`${diagnostic} ${body}`);
    const enhanced = enhancedMatch ? enhancedMatch[1] : "";
    const basic = basicMatch ? parseInt(basicMatch[1], 10) : 0;

    // The server's own words, which is what the rules read.
    const serverSaid = diagnostic ||
      (/The server returned:\s*\n*\s*(.+)/i.exec(body)?.[1] || "").trim() ||
      (/Reason:\s*(.+)/i.exec(body)?.[1] || "").trim();
    const haystack = `${serverSaid} ${statusField} ${body.slice(0, 4000)}`
      .toLowerCase();

    if (!enhanced && !basic && !serverSaid) {
      return null;
    }

    const rule = this.BOUNCE_RULES.find(r => {
      try {
        return r.test(enhanced, basic, haystack);
      } catch (e) {
        return false;
      }
    });

    const temporary = action.startsWith("delay") ||
      enhanced.startsWith("4") || (basic >= 400 && basic < 500);

    return {
      recipient,
      enhanced,
      basic,
      serverSaid: serverSaid.slice(0, 300),
      temporary: rule ? rule.kind === "temporary" : temporary,
      title: rule ? rule.title
        : (temporary ? "Tạm thời chưa gửi được"
                     : "Thư không gửi được tới người nhận"),
      why: rule ? rule.why
        : "Máy chủ bên nhận từ chối nhưng không nói rõ lý do theo cách hMail " +
          "hiểu được. Nội dung nguyên văn của máy chủ nằm bên dưới.",
      todo: rule ? rule.todo
        : "Đọc dòng nguyên văn của máy chủ, hoặc chuyển tiếp thư báo lỗi này " +
          "cho quản trị hệ thống thư.",
    };
  },

  /** Text body, HTML stripped, good enough for reading and matching. */
  plainBody(raw) {
    let body = raw.slice(raw.search(/\r?\n\r?\n/) + 2);
    if (/Content-Transfer-Encoding:\s*base64/i.test(raw)) {
      // Decode the first base64 part; enough for the analysis.
      const part = /\r?\n\r?\n([A-Za-z0-9+/=\r\n]{200,})/.exec(body);
      if (part) {
        try {
          body = atob(part[1].replace(/\s+/g, ""));
        } catch (e) {}
      }
    }
    if (/=[0-9A-F]{2}/.test(body)) {
      body = body.replace(/=\r?\n/g, "").replace(
        /=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    try {
      body = decodeURIComponent(escape(body));
    } catch (e) {}
    return body
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },

  suspiciousLinks(raw) {
    const notes = [];
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
    let m;
    let checked = 0;
    while ((m = anchor.exec(raw)) !== null && checked < 40) {
      checked++;
      const href = m[1];
      const label = m[2].replace(/<[^>]+>/g, "").trim();
      let host = "";
      try {
        host = new URL(href).hostname.toLowerCase();
      } catch (e) {
        continue;
      }
      if (/^xn--/.test(host) || host.split(".").some(p => p.startsWith("xn--"))) {
        notes.push(`Liên kết dùng tên miền mã hoá quốc tế (${host}) — ` +
                   `kiểu tên miền hay bị dùng để giả mạo.`);
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        notes.push(`Liên kết trỏ thẳng tới địa chỉ IP ${host} thay vì tên ` +
                   `miền.`);
      }
      const labelHost = /(?:https?:\/\/)?([\w.-]+\.\w{2,})/.exec(label)?.[1]
        ?.toLowerCase();
      if (labelHost && !host.endsWith(labelHost) &&
          !labelHost.endsWith(host)) {
        notes.push(`Liên kết hiển thị "${labelHost}" nhưng thật sự dẫn tới ` +
                   `${host}.`);
      }
      if (notes.length >= 3) {
        break;
      }
    }
    return notes;
  },

  // -------------------------------------------------------------- tóm tắt

  /**
   * Extractive summary: score sentences by how many of the message's own
   * frequent words they carry, keep the best few in their original order.
   * Crude compared with a model, but instant, free and never invents.
   */
  summarize(hdr, body) {
    // Strip what is not the message: quoted replies, separator rules, the
    // banner mail servers prepend to outside mail, boilerplate footers, and
    // the signature after "--".
    const clean = body
      .split(/\n/)
      .filter(line => !/^\s*[>|]/.test(line))
      .filter(line => !/^[\s\-_=*.~#]{6,}$/.test(line))
      .filter(line => !/cảnh báo|caution|external sender|thư từ bên ngoài|this email originated/i
                        .test(line))
      .join("\n")
      .split(/\n--\s*\n/)[0]
      .replace(/^\s*(from|to|sent|subject|kính gửi|dear)\b.*$/gim, "")
      .replace(/\b(unsubscribe|hủy đăng ký|privacy policy|điều khoản)\b[\s\S]{0,200}$/i,
               "");

    const sentences = clean
      .split(/(?<=[.!?…])\s+|\n{2,}/)
      .map(s => s.replace(/\s+/g, " ").trim())
      .filter(s => s.length >= 30 && s.length <= 400);
    if (!sentences.length) {
      return [];
    }

    const counts = new Map();
    for (const word of clean.toLowerCase().match(/[\p{L}\d]{3,}/gu) || []) {
      if (this.STOPWORDS.has(word)) {
        continue;
      }
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    const scored = sentences.map((text, index) => {
      let score = 0;
      for (const word of text.toLowerCase().match(/[\p{L}\d]{3,}/gu) || []) {
        score += counts.get(word) || 0;
      }
      // Openings carry the point more often than closings do.
      score = score / Math.sqrt(text.length) * (index < 3 ? 1.3 : 1);
      return { text, index, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .sort((a, b) => a.index - b.index)
      .map(s => s.text);
  },

  dates(body) {
    const found = new Set();
    const patterns = [
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
      /\b\d{1,2}\s*(?:tháng|thg)\s*\d{1,2}(?:\s*,?\s*\d{4})?/gi,
      /\b(?:hạn|deadline|trước ngày|due)\s*:?\s*[^\n.,;]{3,30}/gi,
    ];
    for (const pattern of patterns) {
      for (const m of body.match(pattern) || []) {
        found.add(m.trim());
      }
    }
    return [...found].slice(0, 5);
  },

  amounts(body) {
    const found = new Set();
    const patterns = [
      /\b\d[\d.,]{2,}\s*(?:vnđ|vnd|đồng|đ)\b/gi,
      /(?:usd|eur|jpy|\$|€|¥)\s?\d[\d.,]{2,}/gi,
      /\b\d[\d.,]{2,}\s*(?:usd|eur|jpy)\b/gi,
    ];
    for (const pattern of patterns) {
      for (const m of body.match(pattern) || []) {
        found.add(m.trim());
      }
    }
    return [...found].slice(0, 5);
  },
};
