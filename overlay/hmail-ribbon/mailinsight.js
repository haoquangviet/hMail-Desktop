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
      todo: "Chia thành nhiều đợt gửi ít người hơn — tính năng Gửi hàng loạt của hMail gửi riêng từng người nên không vướng giới hạn này.",
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
      test: (e, b, t) =>
        /proper dns|dns entries|no dns|reverse dns|ptr record|rdns|host not found|unable to resolve|cannot resolve/.test(t),
      kind: "permanent",
      title: "Bên nhận từ chối vì cấu hình DNS không đạt",
      why: "Máy chủ bên nhận đòi tên miền gửi phải có bản ghi DNS đầy đủ — thường là tên miền ngược (PTR) khớp với IP máy chủ gửi. Đây là quy định của bên nhận, không phải lỗi nội dung thư.",
      todo: "Việc này thuộc về quản trị hệ thống thư phía gửi: nhờ họ khai báo bản ghi PTR cho IP máy chủ gửi và kiểm tra lại SPF. Nếu tên miền người nhận vừa mới đăng ký, cũng nên soát lại chính tả phần sau dấu @.",
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
      // hdrForFirstSelectedMessage asks the tree for range 0 and throws when
      // there is no selection — "Try a real range index next time." Called
      // from three polling loops, that filled the console with an exception
      // several times a second and buried every real error under it.
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

    // One message, one warning. The assistant panel shows this same analysis
    // in full ("Đọc nhanh tại chỗ"); painting the bar as well gave the reader
    // two notices about one message that each said a different part of it.
    if (win.document.getElementById("hmail-ai-insight")) {
      return;
    }

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

    const actions = this.actions(win, doc, el, result, bar, key);
    if (actions) {
      bar.appendChild(actions);
    }

    host.insertBefore(bar, host.firstChild);
  },

  /**
   * A warning that only says what is wrong leaves the reader to go and find
   * the command themselves. Each warning carries the buttons for what one
   * would actually do about it, and no more than that — a row of eight
   * buttons is as useless as none.
   */
  actions(win, doc, el, result, bar, key) {
    const hdr = this.selected(win);
    if (!hdr) {
      return null;
    }
    const row = el("div", "hmail-warning-actions");
    // Two groups on one line: what to do with the message, then where to look
    // into it. Five loose buttons wrapping over two rows read as five equal
    // choices, which they are not.
    const decide = el("div", "hmail-warning-group");
    const inspect = el("div", "hmail-warning-group");
    row.append(decide, inspect);

    const add = (label, title, fn, group = decide) => {
      const b = el("button", "hmail-warning-action", label);
      if (title) {
        b.title = title;
      }
      b.addEventListener("click", () => {
        try {
          fn();
        } catch (e) {
          Cu.reportError("hMail warning action failed: " + e);
        }
      });
      group.appendChild(b);
    };

    const verdict = result.facts?.verdict || {};
    const junked = hdr.getStringProperty("junkscore") === "100";

    if (verdict.spam || verdict.virus || result.level === "danger") {
      if (!junked) {
        add("Chuyển vào Thư rác",
            "Đánh dấu thư rác và chuyển vào thư mục rác của tài khoản này",
            () => {
              this.junk(hdr, true);
              bar.remove();
            });
      }
      // The server calling it spam is a claim, not a verdict. Disagreeing has
      // to be one click away whether or not hMail has filed it yet, otherwise
      // a false positive is easier to live with than to correct.
      add("Không phải thư rác",
          "Bỏ đánh dấu thư rác và dạy bộ lọc rằng thư này bình thường",
          () => {
            this.junk(hdr, false);
            bar.remove();
          });
    }

    // A lookalike domain or a failed check is about the sender, not the
    // message: the useful move is to stop hearing from them.
    if (result.level === "danger" || result.money) {
      add("Chặn người gửi",
          "Thêm địa chỉ này vào bộ lọc để thư sau tự vào Thùng rác",
          () => this.blockSender(win, hdr));
    }

    if (result.bounce || verdict.action || verdict.spam || verdict.virus) {
      add("Lọc theo máy chủ",
          "Chọn hMail phải làm gì với thư mà máy chủ đã đánh dấu",
          () => win.hMailServerFilter?.openTab(win), inspect);
    }

    add("Đầu thư", "Mở toàn bộ phần đầu thư để tự kiểm tra",
        () => this.showSource(win, hdr), inspect);

    // open(), not toggle(): the assistant is usually already on screen when
    // the warning is read, and toggling shut it — so the button appeared to
    // do nothing until it was pressed a second time.
    add("Trợ lý", "Mở bảng trợ lý cho thư này",
        () => win.hMailAI?.open(win), inspect);

    if (!decide.children.length) {
      decide.remove();
    }
    return row.children.length ? row : null;
  },

  junk(hdr, isJunk) {
    hdr.setStringProperty("junkscore", isJunk ? "100" : "0");
    hdr.setStringProperty("junkscoreorigin", "user");
    if (!isJunk) {
      return;
    }
    try {
      const junkFolder =
        hdr.folder.server.rootFolder.getFolderWithFlags(
          Ci.nsMsgFolderFlags.Junk);
      if (junkFolder && junkFolder.URI !== hdr.folder.URI) {
        MailServices.copy.copyMessages(
          hdr.folder, [hdr], junkFolder, true, null, null, false);
      }
    } catch (e) {
      Cu.reportError("hMail: không chuyển được vào thư rác: " + e);
    }
  },

  /** Open the filter editor with the sender filled in, rather than guessing. */
  blockSender(win, hdr) {
    try {
      const address = this.address(hdr.mime2DecodedAuthor || hdr.author || "");
      const server = hdr.folder.server;
      win.MsgFilters(address, server);
    } catch (e) {
      Cu.reportError("hMail: không mở được bộ lọc: " + e);
    }
  },

  showSource(win, hdr) {
    try {
      win.MsgViewPageSource?.() ||
        win.goDoCommand?.("cmd_viewPageSource");
    } catch (e) {
      try {
        const uri = hdr.folder.getUriForMsg(hdr);
        win.openDialog("chrome://messenger/content/viewSource.xhtml",
                       "_blank", "all,dialog=no", { URL: uri });
      } catch (e2) {}
    }
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
    const { dkim, spf, dmarc, raw: auth, spfHeader } = this.authResults(headers);

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
    const verdict = this.serverVerdict(headers);
    out.facts.verdict = verdict;
    if (verdict.virus) {
      note("danger",
        "Bộ lọc của máy chủ xếp thư này vào loại chứa mã độc" +
        (verdict.evidence ? ` (${verdict.evidence})` : "") +
        ". Đừng mở tệp đính kèm hay bấm liên kết trong thư.");
    } else if (verdict.spam) {
      note("warn", "Máy chủ đã đánh dấu thư này là thư rác.");
    }
    if (verdict.action && verdict.action !== "accept") {
      note(verdict.virus ? "danger" : "warn",
        `Máy chủ đề nghị xử lý thư này ở mức "${verdict.action}" — ` +
        "thư vẫn được chuyển về hộp thư của bạn nên bạn tự quyết định.");
    }
    if (verdict.iprev === "fail") {
      note("warn", "Máy chủ gửi không có tên miền ngược hợp lệ (iprev=fail) " +
                   "— dấu hiệu thường thấy ở nguồn phát tán thư rác.");
    }
    if (verdict.senderWarning) {
      note("warn", `Máy chủ cảnh báo về người gửi: ` +
                   verdict.senderWarning.slice(0, 160));
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

    // Wrapped on purpose: these are the "what is this about" half. If one of
    // them throws on an odd message, the warnings above must still reach the
    // user — a silent analysis is worse than an incomplete one.
    try {
      out.summary = this.summarize(hdr, body);
      out.facts.dates = this.dates(body);
      out.facts.amounts = this.amounts(body);
      out.contact = this.contact(headers, body, hdr);
    } catch (e) {
      Cu.reportError("hMail insight: đọc nội dung thất bại: " + e);
    }
    return out;
  },

  /**
   * SPF, DKIM and DMARC as the receiving server reported them. Split out so
   * anything else that needs the verdict — the sender avatars, for one — can
   * read it without repeating the parsing.
   */
  authResults(headers) {
    const raw = (headers.get("authentication-results") || []).join(" ")
      .toLowerCase();
    const spfHeader = this.first(headers, "received-spf").toLowerCase();
    const check = pattern => pattern.exec(raw)?.[1] || "";
    return {
      raw,
      spfHeader,
      dkim: check(/dkim=(\w+)/),
      spf: check(/spf=(\w+)/) ||
        (/^\s*(pass|fail|softfail|neutral|none)/.exec(spfHeader)?.[1] || ""),
      dmarc: check(/dmarc=(\w+)/),
    };
  },

  /**
   * What the receiving server's own filter concluded. Every filter writes its
   * verdict into headers of its own naming, and a message that arrives with
   * "X-Spampanel-Class: virus" and "X-Recommended-Action: reject" has already
   * been judged — hMail should say so rather than start from scratch.
   *
   * The recommended action is reported, not obeyed: the message is already in
   * the mailbox, so "reject" is advice about what the server would have done,
   * not something left to do.
   */
  serverVerdict(headers) {
    const value = name => this.first(headers, name).trim();
    const cls = (value("x-spampanel-class") || value("x-spam-class") ||
                 value("x-cm-analysis") || "").toLowerCase();
    const flag = value("x-spam-flag").toLowerCase();
    const status = value("x-spam-status");
    const level = value("x-spam-level");
    const auth = this.authResults(headers);

    const score = parseFloat(
      /score=([-\d.]+)/i.exec(status)?.[1] ||
      /^\s*[-\d.]+/.exec(value("x-spam-score"))?.[0] || "NaN");

    return {
      class: cls,
      virus: /virus|malware|phish/.test(cls) ||
             /^yes/.test(value("x-virus-flag").toLowerCase()),
      spam: /spam|bulk/.test(cls) || flag.startsWith("yes") ||
            /^yes/i.test(status) || (level.match(/\*/g) || []).length >= 5 ||
            (Number.isFinite(score) && score >= 5),
      score: Number.isFinite(score) ? score : null,
      action: (value("x-recommended-action") ||
               value("x-spam-action")).toLowerCase(),
      evidence: value("x-spampanel-evidence") || value("x-virus-name"),
      iprev: /iprev=(\w+)/.exec(auth.raw)?.[1] || "",
      senderWarning: value("x-sender-warning"),
    };
  },

  // ----------------------------------------------------------- liên hệ

  /**
   * Who wrote this, and how would you reach them again?
   *
   * Everything worth keeping is normally in the sign-off: a company name, an
   * office address, a phone number, a website. Reading it here means the
   * details can go into the address book without anyone retyping them, and
   * without the message leaving the machine.
   */
  contact(headers, body, hdr) {
    const from = this.first(headers, "from") || String(hdr?.author || "");
    const email = this.address(from);
    if (!email) {
      return null;
    }

    // The display name. Thunderbird's decoded copy comes first: the raw
    // header carries it as an RFC 2047 encoded word — "=?UTF-8?Q?Quy=E1..."
    // — which is not a name anybody wants filed in their address book.
    let name = String(hdr?.mime2DecodedAuthor || "")
      .replace(/<[^>]*>/g, "").replace(/^"|"$/g, "").trim();
    if (!name || name.includes("@")) {
      name = this.decodeWords(from)
        .replace(/<[^>]*>/g, "").replace(/^"|"$/g, "").trim();
    }
    if (name.includes("@")) {
      name = "";
    }

    // The signature is the tail of the message, before any quoted reply.
    const unquoted = body
      .split(/^\s*(?:On .{0,80}wrote:|-----\s*Original Message|Vào .{0,60}đã viết:)/mi)[0];
    const tail = unquoted.slice(-1600);

    const phones = [];
    const phonePattern =
      /(?:tel|phone|mob(?:ile)?|hotline|đt|điện thoại|fax|zalo)\s*[:.]?\s*((?:\+?\d[\d\s().-]{7,20}\d))/gi;
    let m;
    while ((m = phonePattern.exec(tail)) !== null && phones.length < 4) {
      const value = m[1].replace(/[\s.-]+/g, " ").trim();
      if (!phones.includes(value)) {
        phones.push(value);
      }
    }
    // A bare +84 number in the sign-off counts even without a label.
    if (!phones.length) {
      const bare = /\+84[\d\s().-]{7,16}\d/.exec(tail);
      if (bare) {
        phones.push(bare[0].replace(/[\s.-]+/g, " ").trim());
      }
    }

    const site = (/(?:website|web|site)\s*[:.]?\s*((?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+){1,3}(?:\/\S*)?)/i
      .exec(tail)?.[1] ||
      /\b(www\.[\w-]+(?:\.[\w-]+){1,3})\b/i.exec(tail)?.[1] || "").trim();

    // "Commercial office: Address: Room 701…" — the label often comes twice,
    // so strip any that survived into the value.
    const address = (
      /(?:địa chỉ|dia chi|address|office|văn phòng)\s*[:.]?\s*([^\n]{10,140})/i
        .exec(tail)?.[1] || "")
      .replace(/^(?:địa chỉ|dia chi|address|office|văn phòng)\s*[:.]?\s*/i, "")
      .replace(/[,;\s]+$/, "")
      .trim();

    // The company: an explicit line if there is one, otherwise a line in the
    // sign-off carrying a company suffix.
    let org = (this.first(headers, "organization") || "").trim();
    if (!org) {
      org = (/^[^\n]{0,80}\b(?:CO\.,?\s*LTD|CO\.,\s*LTD|COMPANY LIMITED|CORPORATION|JSC|CÔNG TY|LLC|INC\.?|GROUP)\b[^\n]{0,40}/im
        .exec(tail)?.[0] || "")
        .replace(/^(?:a\s+member\s+of|thành viên của|trực thuộc)\s+/i, "")
        .trim();
    }

    const title = (/(?:chức vụ|title|position|dept|phòng ban)\s*[:.]?\s*([^\n]{3,60})/i
      .exec(tail)?.[1] || "").trim();

    // Nothing beyond the address itself is not worth offering to save.
    if (!name && !org && !phones.length && !site && !address) {
      return null;
    }
    return { name, email, org, title, phones, site, address };
  },

  /**
   * RFC 2047 encoded words, as they appear in raw headers:
   *   =?UTF-8?Q?Quy=E1=BA=BFt_Tr=E1=BA=A7n?=
   *   =?UTF-8?B?UXV54bq/dCBUcuG6p24=?=
   */
  decodeWords(text) {
    if (!text || !text.includes("=?")) {
      return text;
    }
    return text.replace(
      /=\?([\w.-]+)\?([BbQq])\?([^?]*)\?=/g,
      (match, charset, encoding, data) => {
        try {
          let bytes;
          if (encoding.toUpperCase() === "B") {
            bytes = atob(data);
          } else {
            bytes = data.replace(/_/g, " ").replace(
              /=([0-9A-F]{2})/gi,
              (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
          }
          return this.decodeBytes(bytes, charset);
        } catch (e) {
          return match;
        }
      }).replace(/\?=\s+=\?/g, "");
  },

  /** Is this address already filed somewhere? */
  knownContact(email) {
    try {
      return !!MailServices.ab.cardForEmailAddress(email);
    } catch (e) {
      return false;
    }
  },

  /** Personal address books the user can actually write to. */
  addressBooks() {
    const books = [];
    for (const book of MailServices.ab.directories) {
      if (!book.readOnly && !book.isRemote) {
        books.push(book);
      }
    }
    return books;
  },

  /**
   * Put the contact in the book. Returns the message to show the user; never
   * throws, because this runs from a click handler in a panel.
   */
  saveContact(contact, bookUri) {
    try {
      const books = this.addressBooks();
      const book = books.find(b => b.URI === bookUri) || books[0];
      if (!book) {
        return "Không có sổ địa chỉ nào ghi được.";
      }
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"]
        .createInstance(Ci.nsIAbCard);
      card.primaryEmail = contact.email;
      card.displayName = contact.name || contact.org || contact.email;

      // Split "Nguyen Van A" the way the address book expects, but only when
      // there is a space to split on.
      const parts = (contact.name || "").split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        card.firstName = parts.slice(0, -1).join(" ");
        card.lastName = parts[parts.length - 1];
      } else if (parts.length === 1) {
        card.firstName = parts[0];
      }

      if (contact.org) {
        card.setProperty("Company", contact.org);
      }
      if (contact.title) {
        card.setProperty("JobTitle", contact.title);
      }
      if (contact.site) {
        card.setProperty("WebPage1", contact.site);
      }
      if (contact.address) {
        card.setProperty("WorkAddress", contact.address);
      }
      if (contact.phones[0]) {
        card.setProperty("WorkPhone", contact.phones[0]);
      }
      if (contact.phones[1]) {
        card.setProperty("CellularNumber", contact.phones[1]);
      }
      card.setProperty("Notes",
        `Lưu từ hMail, trích từ thư của ${contact.email}.`);

      book.addCard(card);
      return `Đã lưu vào "${book.dirName}".`;
    } catch (e) {
      return "Không lưu được: " + (e.message || e);
    }
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

    // "no-reply@" is how half the newsletters in the world are sent, so it
    // cannot stand on its own here — a Vietnam Airlines statement was being
    // announced as "Thư không gửi được".
    const looksLikeBounce =
      /report-type=delivery-status|multipart\/report/.test(contentType) ||
      /^(mailer-daemon|postmaster)@/i.test(from) ||
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
      // Exchange writes the failure in prose rather than as DSN fields:
      //
      //   The following recipient(s) cannot be reached:
      //       'accounting@example.vn' on 8/3/2026 11:09 AM
      //           Server error: '550 proper dns entries.'
      //
      // Reading "To:" first would report the address the bounce was sent
      // *to* — the sender's own — as the one that could not be reached.
      const m =
        /cannot be reached[^\n]*\n\s*['"<]?([\w.+-]+@[\w.-]+\.\w+)/i.exec(body) ||
        /(?:không tới được|không gửi được (?:đến|tới))[^\n]*?([\w.+-]+@[\w.-]+\.\w+)/i.exec(body) ||
        /addressed to[^\n]*?([\w.+-]+@[\w.-]+\.\w+)/i.exec(body) ||
        /^To:\s*([^\s<>]+@[^\s<>]+)/im.exec(body);
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
      // Exchange again: "Server error: '550 proper dns entries.'"
      (/Server error:\s*['"]?([^'"\n]+)/i.exec(body)?.[1] || "").trim() ||
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

  /**
   * Turn a raw message into readable text.
   *
   * raw() hands us bytes, one per JavaScript character, so the body has to be
   * decoded with the charset the message declares. Guessing UTF-8 for
   * everything and shrugging off the failure — which is what this used to do —
   * left Vietnamese mail as "Cá»¢NH B" the moment a single byte anywhere in
   * the message was not valid UTF-8.
   */
  plainBody(raw) {
    const part = this.textPart(raw);
    let body = part.body;

    if (/base64/i.test(part.encoding)) {
      try {
        body = atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
      } catch (e) {}
    } else if (/quoted-printable/i.test(part.encoding) ||
               /=[0-9A-F]{2}/.test(body)) {
      body = body.replace(/=\r?\n/g, "").replace(
        /=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    return this.stripHtml(this.decodeBytes(body, part.charset));
  },

  /**
   * The part worth reading: text/plain if the message has one, otherwise the
   * HTML. Falls back to everything after the headers for a message that is
   * not MIME at all.
   */
  textPart(raw) {
    const headerEnd = raw.search(/\r?\n\r?\n/);
    const top = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
    const rest = raw.slice(headerEnd + 2);
    const charsetOf = block =>
      (/charset\s*=\s*"?([\w.:-]+)"?/i.exec(block)?.[1] || "").trim();
    const encodingOf = block =>
      (/Content-Transfer-Encoding\s*:\s*([\w-]+)/i.exec(block)?.[1] || "").trim();

    const boundary = /boundary\s*=\s*"?([^"\r\n;]+)"?/i.exec(top)?.[1];
    if (!boundary) {
      return { body: rest, charset: charsetOf(top), encoding: encodingOf(top) };
    }

    // Split on the boundary and keep the best text part. Nested multiparts
    // carry their own boundary, but their leaf parts show up in this split
    // too, which is good enough for reading.
    const parts = raw.split(new RegExp(
      `--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n`));
    let html = null;
    for (const chunk of parts.slice(1)) {
      const end = chunk.search(/\r?\n\r?\n/);
      if (end === -1) {
        continue;
      }
      const head = chunk.slice(0, end);
      const value = {
        body: chunk.slice(end + 2),
        charset: charsetOf(head),
        encoding: encodingOf(head),
      };
      if (/Content-Type\s*:\s*text\/plain/i.test(head)) {
        return value;
      }
      if (!html && /Content-Type\s*:\s*text\/html/i.test(head)) {
        html = value;
      }
    }
    return html || { body: rest, charset: charsetOf(top),
                     encoding: encodingOf(top) };
  },

  /** Byte string -> text, honouring the declared charset. */
  decodeBytes(body, charset) {
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) {
      bytes[i] = body.charCodeAt(i) & 0xff;
    }
    for (const label of [charset, "utf-8", "windows-1258", "windows-1252"]) {
      if (!label) {
        continue;
      }
      try {
        // Not fatal: one bad byte in a long message should cost that byte,
        // not the whole text.
        return new TextDecoder(label).decode(bytes);
      } catch (e) {}
    }
    return body;
  },

  /** Markup out, entities in. */
  stripHtml(text) {
    return this.decodeEntities(text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/tr)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },

  ENTITIES: {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“", acute: "´", grave: "`", tilde: "~",
    circ: "ˆ", cedil: "¸", uml: "¨", middot: "·", bull: "•",
    copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥",
  },

  /**
   * Named and numeric entities alike. Vietnamese mail written in a web editor
   * arrives full of them — "CẢNH B&Aacute;O" instead of "CẢNH BÁO" — so the
   * parser does the work: hand-keeping a table of the several hundred HTML
   * names is exactly the kind of list that is always missing the one entity
   * in front of you. The short table below is only the fallback.
   */
  decodeEntities(text) {
    if (!text.includes("&")) {
      return text;
    }
    try {
      const doc = new DOMParser().parseFromString(
        `<!doctype html><body>${text.replace(/</g, "&lt;")}`, "text/html");
      const decoded = doc.body?.textContent;
      if (decoded) {
        return decoded;
      }
    } catch (e) {}

    return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi,
      (match, name) => {
        if (name[0] === "#") {
          const code = name[1] === "x" || name[1] === "X"
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code) : match;
        }
        return this.ENTITIES[name.toLowerCase()] ?? match;
      });
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
      // A deadline phrase only counts when a number follows it. Without that,
      // "due to wrong declaration" was being reported as a date.
      /\b(?:hạn(?:\s*chót)?|deadline|trước ngày|due\s*(?:date|by|on))\s*:?\s*[^\n.,;]{0,12}\d[^\n.,;]{0,18}/gi,
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
