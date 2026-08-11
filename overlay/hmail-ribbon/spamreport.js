/* hMail Desktop — spam report & quarantine
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Talks to the HQV spam-report backend so a user can report spam and manage
 * the mail the filter is holding for their address.
 *
 * Injected into every mail:3pane window by hmail.cfg, like the ribbon and the
 * sidebar, because only chrome can put a button on the ribbon and dock a panel.
 *
 * Authentication follows the backend's own model, which has no password: the
 * client registers an address to obtain a bearer token, then proves ownership
 * of that address with a six-digit code the server mails to it. Reporting spam
 * needs only the token; releasing held mail needs the verification, since that
 * puts mail back into an inbox. The token is a long-lived credential granting
 * read access to held mail, so it lives in Thunderbird's login manager rather
 * than in a plain-text pref file.
 */

"use strict";

var hMailSpam = {
  PANEL_ID: "hmail-spam-panel",
  REALM: "hMail Spam Report",

  // ---------------------------------------------------------------- config

  serverUrl() {
    let url = "https://spam-report.hqv.biz";
    try {
      url = Services.prefs.getCharPref("hmail.spam.serverUrl");
    } catch (e) {}
    return url.replace(/\/+$/, "");
  },

  sinceDays() {
    try {
      return Services.prefs.getIntPref("hmail.spam.sinceDays");
    } catch (e) {
      return 14;
    }
  },

  clientLabel() {
    let host = "hMail Desktop";
    try {
      host = `hMail Desktop: ${Cc["@mozilla.org/network/dns-service;1"]
        .getService(Ci.nsIDNSService).myHostName}`;
    } catch (e) {}
    return host;
  },

  // ------------------------------------------------------------- accounts

  /** Every distinct identity address in the profile, lowercased. */
  identities() {
    const seen = new Map();
    for (const identity of MailServices.accounts.allIdentities) {
      const email = (identity.email || "").trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.set(email, identity);
      }
    }
    return [...seen.keys()];
  },

  /** The address that owns the folder currently on screen, if any. */
  currentIdentity(win) {
    try {
      const about3Pane = win.document.getElementById("tabmail")?.currentAbout3Pane;
      const folder = about3Pane?.gFolder;
      if (folder) {
        const server = folder.server;
        const account = MailServices.accounts.findAccountForServer(server);
        const email = account?.defaultIdentity?.email;
        if (email) {
          return email.trim().toLowerCase();
        }
      }
    } catch (e) {}
    return this.identities()[0] || "";
  },

  // ---------------------------------------------------------- credentials

  Creds: {
    _info(email, token) {
      const login = Cc["@mozilla.org/login-manager/loginInfo;1"]
        .createInstance(Ci.nsILoginInfo);
      login.init(hMailSpam.serverUrl(), null, hMailSpam.REALM,
                 email, token, "", "");
      return login;
    },

    get(email) {
      try {
        const logins = Services.logins.findLogins(
          hMailSpam.serverUrl(), null, hMailSpam.REALM);
        const hit = logins.find(l => l.username === email);
        return hit ? hit.password : null;
      } catch (e) {
        return null;
      }
    },

    // addLogin became async in Thunderbird 128; addLoginAsync is the only
    // form that exists here.
    async set(email, token) {
      const info = this._info(email, token);
      const logins = Services.logins.findLogins(
        hMailSpam.serverUrl(), null, hMailSpam.REALM);
      const old = logins.find(l => l.username === email);
      if (old) {
        Services.logins.modifyLogin(old, info);
      } else {
        await Services.logins.addLoginAsync(info);
      }
    },

    clear(email) {
      try {
        const logins = Services.logins.findLogins(
          hMailSpam.serverUrl(), null, hMailSpam.REALM);
        for (const l of logins) {
          if (l.username === email) {
            Services.logins.removeLogin(l);
          }
        }
      } catch (e) {}
    },
  },

  // ---------------------------------------------------------------- api

  async request(email, method, path, { query, json, raw, headers, auth = true } = {}) {
    const url = this.serverUrl() + path +
      (query ? "?" + new URLSearchParams(query).toString() : "");
    const head = Object.assign({}, headers);
    if (auth) {
      const token = this.Creds.get(email);
      if (!token) {
        throw Object.assign(new Error("chưa đăng nhập"), { code: "no_token" });
      }
      head.Authorization = `Bearer ${token}`;
    }
    if (json) {
      head["Content-Type"] = "application/json";
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: head,
        body: json ? JSON.stringify(json) : raw,
      });
    } catch (e) {
      throw Object.assign(new Error("không kết nối được máy chủ"),
                          { code: "network" });
    }

    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {}

    if (!res.ok) {
      throw Object.assign(
        new Error(body?.message || body?.error || `HTTP ${res.status}`),
        { status: res.status, code: body?.error });
    }
    return body;
  },

  Api: {
    register: (email) => hMailSpam.request(email, "POST", "/api/v1/clients/register", {
      auth: false,
      json: { email, client_label: hMailSpam.clientLabel() },
    }),
    verifyRequest: (email) =>
      hMailSpam.request(email, "POST", "/api/v1/clients/verify/request"),
    verifyConfirm: (email, code) =>
      hMailSpam.request(email, "POST", "/api/v1/clients/verify/confirm", { json: { code } }),
    list: (email, query) =>
      hMailSpam.request(email, "GET", "/api/v1/quarantine/list", { query }),
    preview: (email, id) =>
      hMailSpam.request(email, "GET", "/api/v1/quarantine/preview", { query: { id } }),
    release: (email, id) =>
      hMailSpam.request(email, "POST", "/api/v1/quarantine/release", { json: { id } }),
    whitelist: (email) =>
      hMailSpam.request(email, "GET", "/api/v1/whitelist"),
    // type ("email"|"domain") là tuỳ chọn — máy chủ tự đoán qua dấu @.
    whitelistAdd: (email, value, type) =>
      hMailSpam.request(email, "POST", "/api/v1/whitelist",
                        { json: type ? { value, type } : { value } }),
    whitelistRemove: (email, id) =>
      hMailSpam.request(email, "DELETE",
                        "/api/v1/whitelist/" + encodeURIComponent(id)),
    report: (email, base64) =>
      hMailSpam.request(email, "POST", "/api/v1/spam/report", {
        raw: base64,
        headers: {
          "Content-Type": "text/plain",
          "Content-Transfer-Encoding": "base64",
          // The backend only accepts plugin|watcher|cli and nulls anything
          // else, which would lose attribution.
          "X-Client-Source": "plugin",
          "X-Client-Hostname": hMailSpam.clientLabel(),
        },
      }),
  },

  // -------------------------------------------------------------- report

  /** Raw RFC 5322 bytes of a message, as the server needs them. */
  rawMessage(hdr) {
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

  selectedMessage(win) {
    try {
      const tabmail = win.document.getElementById("tabmail");
      // A message opened in its own TAB has no row selected in the 3-pane's
      // gDBView — about:message knows what it is showing in either tab mode
      // (same reasoning as hMailAI.selectedMessage).
      const aboutMessage = tabmail?.currentAboutMessage;
      if (aboutMessage?.gMessage) {
        return aboutMessage.gMessage;
      }
      return tabmail?.currentAbout3Pane?.gDBView?.hdrForFirstSelectedMessage
        || null;
    } catch (e) {
      return null;
    }
  },

  async reportSelected(win) {
    const hdr = this.selectedMessage(win);
    if (!hdr) {
      Services.prompt.alert(win, "Báo cáo thư rác",
        "Hãy chọn một thư trong danh sách trước khi báo cáo.");
      return;
    }

    // Reporting trains the filter and moves the message to Junk. Both are
    // awkward to undo, so confirm first — with enough detail that the user
    // can tell they picked the message they meant.
    let confirmFirst = true;
    try {
      confirmFirst = Services.prefs.getBoolPref("hmail.spam.confirmBeforeReport");
    } catch (e) {}
    if (confirmFirst) {
      const subject = hdr.mime2DecodedSubject || "(không tiêu đề)";
      const sender = hdr.mime2DecodedAuthor || "(không rõ người gửi)";
      const check = { value: false };
      const ok = Services.prompt.confirmCheck(
        win,
        "Báo cáo thư rác",
        `Báo cáo thư này là thư rác và chuyển vào Thư rác?\n\n` +
          `Từ: ${sender}\nTiêu đề: ${subject}`,
        "Không hỏi lại",
        check
      );
      if (!ok) {
        return;
      }
      if (check.value) {
        Services.prefs.setBoolPref("hmail.spam.confirmBeforeReport", false);
      }
    }
    // Attribute the report to the account the message actually lives in.
    let email = "";
    try {
      const account = MailServices.accounts.findAccountForServer(hdr.folder.server);
      email = (account?.defaultIdentity?.email || "").trim().toLowerCase();
    } catch (e) {}
    if (!email) {
      email = this.currentIdentity(win);
    }
    if (!this.Creds.get(email)) {
      Services.prompt.alert(win, "Báo cáo thư rác",
        `Chưa đăng nhập cho địa chỉ ${email}.\n\n` +
        "Thẻ “Thư bị giữ” sẽ mở ra để bạn đăng nhập.");
      this.openTab(win);
      return;
    }

    try {
      this.notify(win, "Đang gửi báo cáo…");
      const raw = await this.rawMessage(hdr);
      // Base64 keeps the raw message past filtering proxies that reject
      // message/rfc822 bodies.
      const b64 = win.btoa(raw);
      const res = await this.Api.report(email, b64);
      if (res?.status === "duplicate") {
        this.notify(win, "Thư này đã được báo cáo trước đó.");
      } else {
        this.notify(win, "Đã gửi báo cáo spam.");
      }
      try {
        win.goDoCommand("cmd_markAsJunk");
      } catch (e) {}
    } catch (e) {
      this.notify(win, "Không gửi được báo cáo: " + this.explain(e));
    }
  },

  // ------------------------------------------------------------ messages

  explain(e) {
    switch (e?.code) {
      case "no_token":
        return "chưa đăng nhập";
      case "network":
        return "không kết nối được máy chủ";
      case "email_not_verified":
        return "địa chỉ chưa được xác thực";
      case "step_up_required":
        return "cần nhập lại mã xác thực";
      case "invalid_or_missing_token":
        return "phiên đăng nhập đã hết hạn";
      case "domain_not_allowed":
        return "tên miền này chưa được bật dịch vụ";
      case "register_rate_limited":
      case "verify_rate_limited":
      case "rate_limited":
        return "thao tác quá nhanh, thử lại sau ít phút";
      case "pmg_unreachable":
      case "pmg_release_failed":
        return "máy chủ lọc thư tạm thời không phản hồi";
      case "not_your_message":
        return "thư này không thuộc địa chỉ của bạn";
      case "invalid_email":
        return "địa chỉ email không hợp lệ";
      case "invalid_domain":
        return "tên miền không hợp lệ";
      case "invalid_type":
        return "loại mục tin cậy không hợp lệ";
      case "cannot_whitelist_self":
        return "không thể đưa chính địa chỉ của mình vào danh sách tin cậy";
      case "whitelist_full":
        return "danh sách tin cậy đã đầy (tối đa 500 mục)";
      default:
        return e?.message || "lỗi không xác định";
    }
  },

  notify(win, text) {
    const status = win.document.getElementById("hmail-spam-status");
    if (status) {
      status.textContent = text;
    }
    try {
      win.document.getElementById("statusText")?.setAttribute("value", text);
    } catch (e) {}
  },

  /** Toggle the panel's busy state: progress bar on, controls inert. */
  setBusy(win, busy) {
    const panel = win.document.getElementById(this.PANEL_ID);
    if (panel) {
      panel.classList.toggle("busy", !!busy);
    }
  },

  /** Placeholder rows so the list keeps its shape while loading. */
  showSkeleton(win, count = 4) {
    const doc = win.document;
    const list = doc.getElementById("hmail-spam-list");
    if (!list) {
      return;
    }
    list.textContent = "";
    for (let i = 0; i < count; i++) {
      const row = this.el(doc, "div", "hmail-spam-skeleton");
      row.append(
        this.el(doc, "span"),
        this.el(doc, "span"),
        this.el(doc, "span")
      );
      list.appendChild(row);
    }
  },

  // ---------------------------------------------------------------- init

  init(win) {
    try {
      let enabled = true;
      try {
        enabled = Services.prefs.getBoolPref("hmail.spam.enabled");
      } catch (e) {}
      this.enabled = enabled;
      if (!enabled) {
        return;
      }
      this.registerTabType(win);
      this.watchJunk(win);
    } catch (e) {
      Cu.reportError("hMail spam report init failed: " + e);
    }
  },

  // ------------------------------------------------------------- own tab
  // The quarantine view is an administrative tool, like Settings, so it opens
  // as its own tab rather than sharing the assistant's sidebar.

  TAB_MODE: "hmailQuarantine",

  registerTabType(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail || tabmail.tabModes?.[this.TAB_MODE]) {
      return;
    }
    const self = this;
    tabmail.registerTabType({
      name: self.TAB_MODE,
      perTabPanel: "vbox",
      modes: {
        [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 },
      },
      openTab(tab) {
        tab.title = "Thư bị giữ";
        tab.panel.classList.add("hmail-spam-tab");
        const panel = self.buildPanel(win);
        tab.panel.appendChild(panel);
        win.setTimeout(() => self.refresh(win), 0);
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "Thư bị giữ";
      },
      persistTab() {
        return null;
      },
      restoreTab(tabmailToRestore) {
        tabmailToRestore.openTab(self.TAB_MODE, {});
      },
      supportsCommand() {
        return false;
      },
    });
  },

  openTab(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this.registerTabType(win);

    // maxTabs: 1 means a second call returns the existing tab rather than
    // opening another; either way we have to bring it to the front ourselves.
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      this.refresh(win);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
    const opened = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (opened) {
      tabmail.switchToTab(opened);
    }
  },

  /** Kept for the ribbon button, which now opens the tab. */
  togglePanel(win) {
    this.openTab(win);
  },

  // ------------------------------------------------- junk → report bridge

  /**
   * Thunderbird's junk marking is local to the profile; the filter upstream
   * only learns about spam if it is told. Mirror every junk marking to the
   * service so one action trains both.
   */
  /**
   * Where junk goes on this account: the folder flagged Junk, or one named
   * like it. Returns null when the account has none.
   */
  junkFolder(server) {
    try {
      const flagged = server.rootFolder.getFolderWithFlags(
        Ci.nsMsgFolderFlags.Junk);
      if (flagged) {
        return flagged;
      }
      for (const folder of server.rootFolder.descendants) {
        if (/^(spam|junk|thư rác|email rác)$/i.test(folder.name)) {
          return folder;
        }
      }
    } catch (e) {}
    return null;
  },

  /**
   * Marking a message as junk in Thunderbird only sets a flag; whether it
   * moves anywhere is a per-account setting most people never find. Ask once
   * per account, then do it every time.
   */
  ensureJunkMove(win, hdr) {
    let server;
    try {
      server = hdr.folder.server;
    } catch (e) {
      return;
    }

    let asked = [];
    try {
      asked = JSON.parse(
        Services.prefs.getCharPref("hmail.spam.junkActionAsked", "[]"));
    } catch (e) {}

    const configured = (() => {
      try {
        return server.getBoolValue("moveOnSpam");
      } catch (e) {
        return false;
      }
    })();

    if (!configured && !asked.includes(server.key)) {
      const target = this.junkFolder(server);
      const where = target ? `"${target.prettyName}"` : '"Thư rác"';
      const move = Services.prompt.confirm(win, "Thư rác",
        `Bạn muốn hMail tự chuyển thư bị đánh dấu là thư rác vào thư mục ` +
        `${where} của tài khoản ${server.prettyName} không?\n\n` +
        `Nếu chọn Không, thư chỉ được đánh dấu và vẫn nằm nguyên chỗ cũ.`);

      asked.push(server.key);
      try {
        Services.prefs.setCharPref("hmail.spam.junkActionAsked",
                                   JSON.stringify(asked));
      } catch (e) {}

      if (!move) {
        return;
      }
      try {
        server.setBoolValue("moveOnSpam", true);
        // 0 = the account's own junk folder.
        server.setIntValue("moveTargetMode", 0);
        server.spamSettings.initialize(server);
      } catch (e) {
        Cu.reportError("hMail junk settings failed: " + e);
      }
    } else if (!configured) {
      return;
    }

    this.moveToJunk(win, hdr);
  },

  moveToJunk(win, hdr) {
    try {
      const server = hdr.folder.server;
      const target = this.junkFolder(server);
      if (!target || target.URI === hdr.folder.URI) {
        return;
      }
      MailServices.copy.copyMessages(
        hdr.folder, [hdr], target, true, null, null, false);
    } catch (e) {
      Cu.reportError("hMail junk move failed: " + e);
    }
  },

  watchJunk(win) {
    if (this._junkListener) {
      return;
    }
    const self = this;
    this._junkListener = {
      msgsJunkStatusChanged(messages) {
        try {
          let auto = true;
          try {
            auto = Services.prefs.getBoolPref("hmail.spam.reportOnJunk");
          } catch (e) {}
          if (!auto) {
            return;
          }
          for (const hdr of messages) {
            // Only report a message being marked as junk, not one cleared.
            const score = hdr.getStringProperty("junkscore");
            if (score !== "100") {
              continue;
            }
            // Marking junk should also put the message where junk belongs.
            // Deferred: this runs inside a folder notification, and a dialog
            // must not open in the middle of one.
            win.setTimeout(() => self.ensureJunkMove(win, hdr), 0);
            self.autoReport(win, hdr);
          }
        } catch (e) {
          Cu.reportError("hMail junk bridge failed: " + e);
        }
      },
    };
    try {
      MailServices.mfn.addListener(
        this._junkListener,
        Ci.nsIMsgFolderNotificationService.msgsJunkStatusChanged
      );
      win.addEventListener("unload", () => {
        try {
          MailServices.mfn.removeListener(this._junkListener);
        } catch (e) {}
        this._junkListener = null;
      }, { once: true });
    } catch (e) {
      Cu.reportError("hMail junk listener registration failed: " + e);
    }
  },

  /** Quietly submit a message that the user just marked as junk. */
  async autoReport(win, hdr) {
    try {
      const key = hdr.messageId || `${hdr.folder?.URI}#${hdr.messageKey}`;
      this._reported = this._reported || new Set();
      if (this._reported.has(key)) {
        return;
      }
      this._reported.add(key);

      let email = "";
      try {
        const account = MailServices.accounts.findAccountForServer(hdr.folder.server);
        email = (account?.defaultIdentity?.email || "").trim().toLowerCase();
      } catch (e) {}
      if (!email || !this.Creds.get(email)) {
        // Not signed in for this account: stay silent rather than nagging on
        // every junk click.
        return;
      }

      const raw = await this.rawMessage(hdr);
      await this.Api.report(email, win.btoa(raw));
      this.notify(win, "Đã báo cáo thư rác lên máy chủ lọc.");
    } catch (e) {
      Cu.reportError("hMail auto spam report failed: " + e);
    }
  },

  // ------------------------------------------------ tự lấy mã xác thực
  // Mã 6 số được dịch vụ gửi tới CHÍNH hộp thư mà hMail đang quản — vậy
  // app tự canh thư đến, móc mã và xác nhận hộ; người dùng chỉ việc nhìn.

  verifyWatcher: null,

  stopVerifyWatch() {
    if (this.verifyWatcher) {
      try {
        MailServices.mfn.removeListener(this.verifyWatcher);
      } catch (e) {}
      this.verifyWatcher = null;
    }
  },

  /** Thư này có dáng thư gửi mã của dịch vụ lọc cho đúng địa chỉ không? */
  looksLikeVerifyMail(hdr, email) {
    try {
      const account = MailServices.accounts
        .findAccountForServer(hdr.folder.server);
      const owner = (account?.defaultIdentity?.email || "")
        .trim().toLowerCase();
      if (owner !== email) {
        return false;
      }
      // Chỉ thư mới trong 15 phút — mã cũ hết giá trị, đỡ vớ nhầm.
      if (Date.now() / 1000 - hdr.dateInSeconds > 15 * 60) {
        return false;
      }
      const hay = ((hdr.mime2DecodedAuthor || "") + " " +
                   (hdr.mime2DecodedSubject || "")).toLowerCase();
      let base = "";
      try {
        base = new URL(this.serverUrl()).hostname.toLowerCase()
          .split(".").slice(-2).join(".");
      } catch (e) {}
      // Chặt chẽ: đúng miền dịch vụ, hoặc từ khoá đặc thù của thư gửi mã
      // — KHÔNG dùng chữ "spam" trần, hộp thư báo cáo spam toàn thư như thế.
      return (base && hay.includes(base)) ||
        /verif|x[áa]c th[ựu]c|m[ãa] x[áa]c|spam-report|quarantine/.test(hay);
    } catch (e) {
      return false;
    }
  },

  /** Mã 6 số trong thư: tiêu đề trước, rồi thân (kể cả phần base64). */
  async codeFromMessage(hdr) {
    const inText = text => {
      const m = /(?:^|\D)(\d{6})(?:\D|$)/.exec(text || "");
      return m ? m[1] : "";
    };
    let code = inText(hdr.mime2DecodedSubject);
    if (code) {
      return code;
    }
    try {
      const raw = await this.rawMessage(hdr);
      const cut = raw.search(/\r?\n\r?\n/);
      const body = cut >= 0 ? raw.slice(cut) : raw;
      code = inText(body);
      if (code) {
        return code;
      }
      // Thân mã hoá base64: giải từng khối rồi tìm tiếp.
      for (const block of body.match(/(?:[A-Za-z0-9+/]{40,}=*\s*){2,}/g) ||
                          []) {
        try {
          code = inText(atob(block.replace(/\s+/g, "")));
          if (code) {
            return code;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return "";
  },

  watchVerifyCode(win, email, apply) {
    this.stopVerifyWatch();
    const self = this;
    let done = false;
    const tryMessage = async hdr => {
      if (done || !self.looksLikeVerifyMail(hdr, email)) {
        return;
      }
      const code = await self.codeFromMessage(hdr);
      if (!done && code) {
        done = true;
        self.stopVerifyWatch();
        apply(code);
      }
    };

    // Thư có thể ĐÃ tới trước khi màn này mở: soi các thư mới nhất trong
    // Hộp thư đến và Thư rác của đúng tài khoản.
    try {
      for (const account of MailServices.accounts.accounts) {
        const owner = (account.defaultIdentity?.email || "")
          .trim().toLowerCase();
        if (owner !== email) {
          continue;
        }
        const root = account.incomingServer?.rootFolder;
        if (!root) {
          continue;
        }
        for (const flag of [Ci.nsMsgFolderFlags.Inbox,
                            Ci.nsMsgFolderFlags.Junk]) {
          const folder = root.getFolderWithFlags(flag);
          if (!folder) {
            continue;
          }
          const db = folder.msgDatabase;
          if (db.reverseEnumerateMessages) {
            // Đi từ thư mới nhất, lùi quá 15 phút là dừng.
            let checked = 0;
            for (const hdr of db.reverseEnumerateMessages()) {
              if (++checked > 80 ||
                  Date.now() / 1000 - hdr.dateInSeconds > 15 * 60) {
                break;
              }
              tryMessage(hdr);
            }
          } else if (folder.getTotalMessages(false) <= 2000) {
            // Không có enumerator ngược: chỉ dám quét xuôi hộp thư nhỏ.
            for (const hdr of folder.messages) {
              if (Date.now() / 1000 - hdr.dateInSeconds <= 15 * 60) {
                tryMessage(hdr);
              }
            }
          }
        }
      }
    } catch (e) {}

    // Và canh thư sắp tới trong 3 phút.
    this.verifyWatcher = {
      msgAdded(hdr) {
        tryMessage(hdr);
      },
    };
    try {
      MailServices.mfn.addListener(this.verifyWatcher,
        Ci.nsIMsgFolderNotificationService.msgAdded);
    } catch (e) {
      this.verifyWatcher = null;
    }
    win.setTimeout(() => {
      if (!done) {
        self.stopVerifyWatch();
      }
    }, 3 * 60 * 1000);
  },

  // ------------------------------------------------------------------ UI

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

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const root = el("div", "hmail-spam");
    root.id = this.PANEL_ID;

    // Account bar --------------------------------------------------------
    const bar = el("div", "hmail-spam-bar");
    const select = el("select", "hmail-spam-account");
    select.id = "hmail-spam-account";
    for (const email of this.identities()) {
      const opt = el("option", null, email);
      opt.value = email;
      select.appendChild(opt);
    }
    select.value = this.currentIdentity(win);
    select.addEventListener("change", () => {
      this._page = 1;
      this.refresh(win);
    });
    bar.appendChild(select);
    root.appendChild(bar);

    // Toolbar ------------------------------------------------------------
    const tools = el("div", "hmail-spam-tools");

    const refreshBtn = el("button", "hmail-spam-btn", "Làm mới");
    refreshBtn.addEventListener("click", () => this.refresh(win));

    const range = el("select", "hmail-spam-range");
    range.id = "hmail-spam-range";
    for (const days of [7, 14, 30, 60]) {
      const opt = el("option", null, `${days} ngày`);
      opt.value = String(days);
      range.appendChild(opt);
    }
    range.value = String(this.sinceDays());
    range.addEventListener("change", () => {
      Services.prefs.setIntPref("hmail.spam.sinceDays", parseInt(range.value, 10));
      this._page = 1;
      this.refresh(win);
    });

    // Lọc theo trạng thái — áp lên trang đang xem, không tốn lượt gọi
    // máy chủ (qlist bị giới hạn 20 lần/phút).
    const filter = el("select", "hmail-spam-range");
    filter.id = "hmail-spam-filter";
    for (const [v, label] of [["", "Tất cả trạng thái"],
                              ["quarantined", "Đang giữ"],
                              ["delivered", "Đã nhận"],
                              ["rejected", "Bị từ chối"],
                              ["bounced", "Trả lại"],
                              ["deferred", "Hoãn"]]) {
      const opt = el("option", null, label);
      opt.value = v;
      filter.appendChild(opt);
    }
    filter.addEventListener("change", () => this.renderCached(win));

    const search = el("input", "hmail-spam-search");
    search.id = "hmail-spam-search";
    search.type = "search";
    search.placeholder = "Tìm người gửi / tiêu đề…";
    // The server rate-limits search to 10/min, so wait for a pause in typing.
    let timer = null;
    search.addEventListener("input", () => {
      win.clearTimeout(timer);
      this._page = 1;
      timer = win.setTimeout(() => this.refresh(win), 500);
    });

    const wlBtn = el("button", "hmail-spam-btn", "Người gửi tin cậy");
    wlBtn.title = "Danh sách địa chỉ / tên miền không bao giờ bị giữ thư";
    wlBtn.addEventListener("click", () => this.showWhitelist(win));

    tools.append(refreshBtn, range, filter, search, wlBtn);
    root.appendChild(tools);

    const progress = el("div", "hmail-spam-progress");
    progress.id = "hmail-spam-progress";
    root.appendChild(progress);

    const status = el("div", "hmail-spam-status", "");
    status.id = "hmail-spam-status";
    root.appendChild(status);

    const list = el("div", "hmail-spam-list");
    list.id = "hmail-spam-list";
    root.appendChild(list);

    // Thanh phân trang — máy chủ trả total nên biết chính xác còn bao nhiêu.
    const pager = el("div", "hmail-spam-pager");
    pager.id = "hmail-spam-pager";
    const prev = el("button", "hmail-spam-btn", "‹ Trước");
    prev.id = "hmail-spam-prev";
    prev.addEventListener("click", () => {
      if (this._page > 1) {
        this._page--;
        this.refresh(win);
      }
    });
    const info = el("span", "hmail-spam-page-info", "");
    info.id = "hmail-spam-page-info";
    const next = el("button", "hmail-spam-btn", "Sau ›");
    next.id = "hmail-spam-next";
    next.addEventListener("click", () => {
      this._page++;
      this.refresh(win);
    });
    pager.append(prev, info, next);
    pager.hidden = true;
    root.appendChild(pager);

    return root;
  },

  PER_PAGE: 50,
  _page: 1,

  /** Cập nhật thanh phân trang theo phản hồi mới nhất; null = giấu đi. */
  setPager(win, data) {
    const doc = win.document;
    const pager = doc.getElementById("hmail-spam-pager");
    if (!pager) {
      return;
    }
    if (!data) {
      pager.hidden = true;
      return;
    }
    const total = data.total ?? (data.items || []).length;
    const perPage = data.per_page || this.PER_PAGE;
    const pages = Math.max(1, Math.ceil(total / perPage));
    this._page = Math.min(this._page, pages);
    doc.getElementById("hmail-spam-page-info").textContent =
      `Trang ${this._page}/${pages} · ${total} thư`;
    doc.getElementById("hmail-spam-prev").disabled = this._page <= 1;
    doc.getElementById("hmail-spam-next").disabled = this._page >= pages;
    pager.hidden = pages <= 1;
  },

  /** Vẽ lại danh sách từ dữ liệu đã tải (đổi bộ lọc không gọi lại máy chủ). */
  renderCached(win) {
    if (this._lastRender) {
      this.renderList(win, this._lastRender.email, this._lastRender.data);
    }
  },

  /** Sign-in / verification form, shown in place of the list. */
  showAuth(win, email, stage) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    if (!list) {
      return;
    }
    list.textContent = "";
    this.setPager(win, null);

    if (stage === "register") {
      list.appendChild(el("p", "hmail-spam-note",
        `Đăng nhập để xem thư đang bị giữ của ${email}.`));
      const go = el("button", "hmail-spam-btn primary", "Đăng nhập");
      go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Đang đăng nhập…";
        this.setBusy(win, true);
        this.notify(win, "Đang đăng ký…");
        try {
          const res = await this.Api.register(email);
          await this.Creds.set(email, res.token);
          this.notify(win, "Đã đăng ký. Đang gửi mã xác thực…");
          await this.Api.verifyRequest(email);
          this.setBusy(win, false);
          this.showAuth(win, email, "verify");
        } catch (e) {
          this.setBusy(win, false);
          go.disabled = false;
          go.textContent = "Đăng nhập";
          this.notify(win, "Không đăng nhập được: " + this.explain(e));
        }
      });
      list.appendChild(go);
      return;
    }

    // stage === "verify"
    list.appendChild(el("p", "hmail-spam-note",
      `Mã 6 số vừa được gửi tới ${email} — hMail đang canh hộp thư để tự ` +
      "điền và xác nhận giúp bạn. Thư về chậm thì nhập tay cũng được."));
    const code = el("input", "hmail-spam-code");
    code.type = "text";
    code.inputMode = "numeric";
    code.maxLength = 6;
    code.placeholder = "123456";
    const confirm = el("button", "hmail-spam-btn primary", "Xác nhận");
    const submit = async () => {
      const value = code.value.trim();
      if (!/^\d{6}$/.test(value)) {
        this.notify(win, "Mã phải gồm 6 chữ số.");
        return;
      }
      confirm.disabled = true;
      confirm.textContent = "Đang xác thực…";
      this.setBusy(win, true);
      this.notify(win, "Đang xác thực…");
      try {
        await this.Api.verifyConfirm(email, value);
        this.stopVerifyWatch();
        this.setBusy(win, false);
        this.notify(win, "Đã xác thực.");
        this.refresh(win);
      } catch (e) {
        this.setBusy(win, false);
        confirm.disabled = false;
        confirm.textContent = "Xác nhận";
        this.notify(win, "Xác thực thất bại: " + this.explain(e));
      }
    };
    confirm.addEventListener("click", submit);
    code.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        submit();
      }
    });

    const resend = el("button", "hmail-spam-btn", "Gửi lại mã");
    resend.addEventListener("click", async () => {
      try {
        await this.Api.verifyRequest(email);
        this.notify(win, "Đã gửi lại mã.");
      } catch (e) {
        this.notify(win, "Không gửi được mã: " + this.explain(e));
      }
    });

    list.append(code, confirm, resend);
    code.focus();

    // Tự canh hộp thư: thư chứa mã về là điền và xác nhận luôn.
    this.watchVerifyCode(win, email, found => {
      if (!doc.contains(code) || code.value.trim().length === 6) {
        return;
      }
      code.value = found;
      this.notify(win, "Đã tự lấy mã từ hộp thư — đang xác nhận…");
      submit();
    });
  },

  async refresh(win) {
    const doc = win.document;
    const select = doc.getElementById("hmail-spam-account");
    const list = doc.getElementById("hmail-spam-list");
    if (!select || !list) {
      return;
    }
    const email = select.value;
    if (!email) {
      this.notify(win, "Chưa có tài khoản thư nào.");
      return;
    }
    if (!this.Creds.get(email)) {
      this.showAuth(win, email, "register");
      return;
    }

    const search = doc.getElementById("hmail-spam-search");
    const query = {
      since_days: this.sinceDays(),
      page: this._page,
      per_page: this.PER_PAGE,
    };
    const q = (search?.value || "").trim();
    if (q.length >= 2) {
      query.q = q;
    }

    this.notify(win, "Đang tải danh sách…");
    this.setBusy(win, true);
    this.showSkeleton(win);
    let data;
    try {
      data = await this.Api.list(email, query);
    } catch (e) {
      this.setBusy(win, false);
      if (e.code === "email_not_verified") {
        try {
          await this.Api.verifyRequest(email);
        } catch (e2) {}
        this.showAuth(win, email, "verify");
        this.notify(win, "Địa chỉ chưa xác thực — đã gửi mã.");
        return;
      }
      if (e.code === "invalid_or_missing_token") {
        this.Creds.clear(email);
        this.showAuth(win, email, "register");
        this.notify(win, "Phiên đã hết hạn, hãy đăng nhập lại.");
        return;
      }
      this.notify(win, "Không tải được danh sách: " + this.explain(e));
      const list = doc.getElementById("hmail-spam-list");
      if (list) {
        list.textContent = "";
        const retry = this.el(doc, "button", "hmail-spam-btn", "Thử lại");
        retry.addEventListener("click", () => this.refresh(win));
        list.appendChild(retry);
      }
      return;
    }

    this.setBusy(win, false);
    this._lastRender = { email, data };
    this.renderList(win, email, data);
  },

  renderList(win, email, data) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    list.textContent = "";
    this.setPager(win, data);

    const all = data?.items || [];
    const want = doc.getElementById("hmail-spam-filter")?.value || "";
    const items = want ? all.filter(i => (i.status || "other") === want)
                       : all;
    const total = data?.total ?? all.length;
    this.notify(win,
      (want ? `${items.length}/${all.length} thư trong trang` :
              `${total} thư`) +
      ` · ${data?.since_days || "?"} ngày`);

    if (!items.length) {
      list.appendChild(el("p", "hmail-spam-note",
        want ? "Trang này không có thư ở trạng thái đã lọc."
             : "Không có thư nào bị giữ."));
      return;
    }

    for (const item of items) {
      const row = el("div", "hmail-spam-row");
      row.dataset.status = item.status || "other";

      // Bố cục phẳng: khối thông tin bên trái, cụm nút gọn bên phải.
      const main = el("div", "hmail-spam-row-main");
      const head = el("div", "hmail-spam-row-head");
      head.append(
        el("span", "hmail-spam-from", item.from || item.envelope_sender || "?"),
        el("span", "hmail-spam-time",
           new Date((item.time || 0) * 1000).toLocaleString())
      );
      const subject = el("div", "hmail-spam-subject",
        item.subject || "(không tiêu đề)");
      const meta = el("div", "hmail-spam-meta",
        `${item.receiver || ""} · ${Math.round((item.bytes || 0) / 1024)} KB` +
        (item.spamlevel != null ? ` · điểm ${item.spamlevel}` : "") +
        ` · ${this.statusLabel(item.status)}`);
      main.append(head, subject, meta);

      const actions = el("div", "hmail-spam-actions");
      const view = el("button", "hmail-spam-btn", "Xem");
      view.addEventListener("click", () => this.preview(win, email, item, row));
      actions.appendChild(view);

      // Only genuinely held mail can be released; tracker rows have no body.
      if (item.status === "quarantined") {
        const release = el("button", "hmail-spam-btn primary", "Nhận thư");
        release.addEventListener("click", () => this.release(win, email, item, row));
        actions.appendChild(release);
      }

      // Người gửi hợp pháp bị giữ oan: một nút đưa thẳng vào danh sách
      // tin cậy để lần sau không bị giữ nữa.
      if (this.senderAddress(item)) {
        const trust = el("button", "hmail-spam-btn", "Tin cậy");
        trust.title = "Đưa người gửi vào danh sách tin cậy — thư sau " +
                      "không bị giữ nữa";
        trust.addEventListener("click", () =>
          this.trustSender(win, email, item, row));
        actions.appendChild(trust);
      }

      row.append(main, actions);
      list.appendChild(row);
    }
  },

  statusLabel(status) {
    switch (status) {
      case "quarantined": return "đang giữ";
      case "delivered": return "đã nhận";
      case "rejected": return "bị từ chối";
      case "bounced": return "trả lại";
      case "deferred": return "hoãn";
      default: return status || "khác";
    }
  },

  async preview(win, email, item, row) {
    this.notify(win, "Đang tải nội dung…");
    this.setBusy(win, true);
    this.showSkeleton(win, 6);
    let data;
    try {
      data = await this.Api.preview(email, item.id);
    } catch (e) {
      this.setBusy(win, false);
      this.notify(win, "Không xem được: " + this.explain(e));
      this.refresh(win);
      return;
    }
    this.setBusy(win, false);
    this.notify(win, "");
    this.showPreview(win, email, data, item, row);
  },

  showPreview(win, email, data, item, row) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    if (!list) {
      return;
    }
    list.textContent = "";
    this.setPager(win, null);

    // Thanh trên cùng: quay lại + hành động ngay tại chỗ, khỏi lộn về
    // danh sách chỉ để bấm Nhận thư.
    const top = el("div", "hmail-spam-actions");
    const back = el("button", "hmail-spam-btn", "← Quay lại");
    back.addEventListener("click", () => this.refresh(win));
    top.appendChild(back);
    if (item?.status === "quarantined") {
      const release = el("button", "hmail-spam-btn primary", "Nhận thư");
      release.addEventListener("click", async () => {
        release.disabled = true;
        release.textContent = "Đang nhận…";
        try {
          await this.Api.release(email, item.id);
          this.notify(win, "Đã chuyển thư vào hộp thư của bạn.");
          item.status = "delivered";
          if (row) {
            row.dataset.status = "delivered";
          }
          release.remove();
        } catch (e) {
          release.disabled = false;
          release.textContent = "Nhận thư";
          this.notify(win, "Không nhận được thư: " + this.explain(e));
        }
      });
      top.appendChild(release);
    }
    if (item && this.senderAddress(item)) {
      const trust = el("button", "hmail-spam-btn", "Tin cậy");
      trust.addEventListener("click", () =>
        this.trustSender(win, email, item, row || top));
      top.appendChild(trust);
    }
    list.appendChild(top);

    // Khối định danh cỡ lớn: giả mạo lộ ra ở đây — địa chỉ THẬT được in
    // đậm để đối chiếu với tên hiển thị hoa mỹ.
    if (item) {
      item._headers = data.headers || "";
    }
    const idBox = el("div", "hmail-spam-idbox");
    idBox.appendChild(el("div", "hmail-spam-preview-subject",
      data.subject || "(không tiêu đề)"));
    const from = this.parseAddr(data.from);
    const fromRow = el("div", "hmail-spam-idrow");
    fromRow.appendChild(el("span", "hmail-spam-idlabel", "Từ:"));
    if (from.name) {
      fromRow.appendChild(el("span", "hmail-spam-idname", from.name));
    }
    fromRow.appendChild(el("span", "hmail-spam-addr",
      from.addr ? `<${from.addr}>` : (data.from || "?")));
    idBox.appendChild(fromRow);
    const toRow = el("div", "hmail-spam-idrow");
    toRow.appendChild(el("span", "hmail-spam-idlabel", "Đến:"));
    toRow.appendChild(el("span", "hmail-spam-addr", data.receiver || "?"));
    idBox.appendChild(toRow);
    if (data.spamlevel != null) {
      idBox.appendChild(el("div", "hmail-spam-meta",
        `Điểm spam: ${data.spamlevel}`));
    }
    // Soi dấu hiệu trên dữ liệu PREVIEW — đầy đủ nhất (headers, điểm spam
    // chính xác) — chứ không phải bản tóm tắt của dòng danh sách.
    for (const sign of this.spoofSigns({
      from: data.from || item?.from,
      spamlevel: data.spamlevel ?? item?.spamlevel,
      _headers: data.headers || "",
    })) {
      idBox.appendChild(el("div", "hmail-spam-warn", "⚠ Cảnh giác: " + sign));
    }
    if (data.headers) {
      const toggle = el("button", "hmail-spam-btn",
        "Xem phần đầu thư (headers)");
      const pre = el("pre", "hmail-spam-headers", data.headers);
      pre.hidden = true;
      toggle.addEventListener("click", () => {
        pre.hidden = !pre.hidden;
        toggle.textContent = pre.hidden
          ? "Xem phần đầu thư (headers)" : "Ẩn phần đầu thư";
      });
      idBox.append(toggle, pre);
    }
    list.appendChild(idBox);

    const body = String(data.body || "");
    if (!body.trim()) {
      list.appendChild(el("p", "hmail-spam-note",
        "Thư không có phần nội dung hiển thị được — chỉ có phần đầu thư " +
        "ở trên. Bấm Nhận thư nếu muốn đọc trọn vẹn trong hộp thư."));
      return;
    }

    // The body is attacker-controlled. Render it in a content browser with a
    // restrictive sandbox rather than in this chrome document, and never as
    // markup we parse ourselves.
    const frame = doc.createXULElement("browser");
    frame.setAttribute("type", "content");
    frame.setAttribute("nodefaultsrc", "true");
    frame.setAttribute("maychangeremoteness", "true");
    frame.setAttribute("messagemanagergroup", "single-site");
    frame.setAttribute("flex", "1");
    frame.className = "hmail-spam-preview";
    list.appendChild(frame);

    const html = data.body_is_html
      ? body
      : `<pre style="white-space:pre-wrap;font:13px sans-serif">${
          body.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
        }</pre>`;
    const page =
      '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">" +
      `<body>${html}</body>`;

    win.setTimeout(() => {
      try {
        // data: URI cấp cao nhất bị Gecko CHẶN khi principal kích hoạt là
        // content/null (security.data_uri.block_toplevel_data_uri_navigations)
        // — chính là lý do khung xem trước từng trắng trơn. Load bằng system
        // principal thì được phép; document đích vẫn mang origin mồ côi của
        // data: URI, cộng CSP default-src 'none' + máy chủ đã khử script.
        frame.fixupAndLoadURIString(
          "data:text/html;charset=utf-8," + encodeURIComponent(page),
          {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
      } catch (e) {
        Cu.reportError("hMail spam preview failed: " + e);
      }
    }, 0);
  },

  async release(win, email, item, row) {
    this.notify(win, "Đang nhận thư…");
    this.setBusy(win, true);
    const button = row.querySelector(".hmail-spam-actions .primary");
    if (button) {
      button.disabled = true;
      button.textContent = "Đang nhận…";
    }
    try {
      await this.Api.release(email, item.id);
      this.setBusy(win, false);
      this.notify(win, "Đã chuyển thư vào hộp thư của bạn.");
      row.dataset.status = "delivered";
      button?.remove();
      return;
    } catch (e) {
      this.setBusy(win, false);
      if (button) {
        button.disabled = false;
        button.textContent = "Nhận thư";
      }
      if (e.code === "step_up_required") {
        try {
          await this.Api.verifyRequest(email);
        } catch (e2) {}
        this.showAuth(win, email, "verify");
        this.notify(win, "Cần xác thực lại — đã gửi mã.");
        return;
      }
      this.notify(win, "Không nhận được thư: " + this.explain(e));
    }
  },

  // ------------------------------------------------- người gửi tin cậy
  // Backend giữ danh sách whitelist theo từng người dùng: mục "email" được
  // đẩy xuống máy chủ lọc (hết bị giữ), mục "domain" thi hành phía dịch vụ.
  // Thêm mục tin cậy cũng tự gỡ các mục blacklist xung đột — whitelist thắng.

  /** Tách "Tên hiển thị <địa chỉ>" thành hai phần. */
  parseAddr(value) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/
      .exec(String(value || ""));
    if (m) {
      return { name: m[1].trim(), addr: m[2].toLowerCase() };
    }
    const bare = String(value || "").trim();
    return /@/.test(bare) ? { name: "", addr: bare.toLowerCase() }
                          : { name: bare, addr: "" };
  },

  /**
   * Các dấu hiệu giả mạo của một thư bị giữ — dùng cho cảnh báo ở màn xem
   * chi tiết và hộp xác nhận Tin cậy. Trả về mảng câu tiếng Việt.
   */
  spoofSigns(item) {
    const signs = [];
    const { name, addr } = this.parseAddr(
      item?.from || item?.envelope_sender || "");
    const domain = addr.split("@")[1] || "";
    // Tên hiển thị nhắc tới một tên miền KHÁC địa chỉ thật — chiêu phổ
    // biến nhất: 'Google Meet | congty.com <ke-gian@mien-la.com>'.
    const mentioned = (name.toLowerCase()
      .match(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/g) || [])
      .filter(d => domain && d !== domain &&
                   !domain.endsWith("." + d) && !d.endsWith("." + domain));
    if (mentioned.length) {
      signs.push(`tên hiển thị nhắc tới "${mentioned[0]}" nhưng địa chỉ ` +
                 `thật là "${domain}" — chiêu giả mạo phổ biến`);
    }
    const rt = /^reply-to:\s*(.+)$/im.exec(String(item?._headers || ""));
    if (rt) {
      const replyTo = this.parseAddr(rt[1]).addr;
      if (replyTo && addr && replyTo !== addr) {
        signs.push(`địa chỉ nhận trả lời (Reply-To) là "${replyTo}", ` +
                   "khác người gửi — thư trả lời sẽ đi nơi khác");
      }
    }
    if ((item?.spamlevel ?? 0) >= 5) {
      signs.push(`máy lọc chấm điểm spam cao (${item.spamlevel})`);
    }
    return signs;
  },

  /** Rút địa chỉ người gửi trần từ một dòng thư bị giữ ("Tên <a@b>" → a@b). */
  senderAddress(item) {
    const raw = String(item?.from || item?.envelope_sender || "");
    const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
    const bare = angled ? angled[1] : raw.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare) ? bare.toLowerCase() : "";
  },

  async trustSender(win, email, item, row) {
    const sender = this.senderAddress(item);
    if (!sender) {
      return;
    }
    const canRelease = item.status === "quarantined" &&
      !!row?.querySelector?.(".hmail-spam-actions .primary");
    // Tin cậy là mở cổng vĩnh viễn — bắt người dùng nhìn thấy dấu hiệu
    // giả mạo (nếu có) TRƯỚC khi gật đầu.
    const signs = this.spoofSigns(item);
    let message = `Đưa ${sender} vào danh sách tin cậy?\n\n` +
      "Thư từ địa chỉ này sẽ KHÔNG BAO GIỜ bị giữ lại nữa.";
    if (signs.length) {
      message += "\n\n⚠ CẢNH GIÁC — thư này có dấu hiệu giả mạo:\n" +
        signs.map(s => "• " + s).join("\n") +
        "\n\nChỉ tin cậy khi bạn chắc chắn người gửi là thật.";
    } else {
      message += "\n\nChỉ tin cậy khi bạn chắc chắn đây là người gửi an toàn.";
    }
    const check = { value: canRelease && !signs.length };
    let ok;
    if (canRelease) {
      ok = Services.prompt.confirmCheck(win, "Người gửi tin cậy", message,
        "Đồng thời nhận thư này về hộp thư", check);
    } else {
      ok = Services.prompt.confirm(win, "Người gửi tin cậy", message);
    }
    if (!ok) {
      return;
    }
    this.notify(win, "Đang thêm vào danh sách tin cậy…");
    this.setBusy(win, true);
    try {
      const res = await this.Api.whitelistAdd(email, sender);
      this.setBusy(win, false);
      let text = `Đã tin cậy ${sender}.`;
      if (res?.removed_blacklist?.length) {
        text += ` Đã gỡ ${res.removed_blacklist.length} mục chặn xung đột.`;
      }
      if (res?.pmg_status === "failed") {
        text += " (Chưa đồng bộ được máy chủ lọc — thêm lại để thử lại.)";
      }
      this.notify(win, text);
    } catch (e) {
      this.setBusy(win, false);
      if (e.code === "email_not_verified" || e.code === "step_up_required") {
        try {
          await this.Api.verifyRequest(email);
        } catch (e2) {}
        this.showAuth(win, email, "verify");
        this.notify(win, "Cần xác thực — đã gửi mã.");
        return;
      }
      this.notify(win, "Không thêm được: " + this.explain(e));
      return;
    }
    if (canRelease && check.value) {
      await this.release(win, email, item, row);
    }
  },

  async showWhitelist(win) {
    const doc = win.document;
    const select = doc.getElementById("hmail-spam-account");
    const email = select?.value;
    if (!email) {
      this.notify(win, "Chưa có tài khoản thư nào.");
      return;
    }
    if (!this.Creds.get(email)) {
      this.showAuth(win, email, "register");
      return;
    }
    this.notify(win, "Đang tải danh sách tin cậy…");
    this.setBusy(win, true);
    this.showSkeleton(win);
    let data;
    try {
      data = await this.Api.whitelist(email);
    } catch (e) {
      this.setBusy(win, false);
      if (e.code === "email_not_verified") {
        try {
          await this.Api.verifyRequest(email);
        } catch (e2) {}
        this.showAuth(win, email, "verify");
        this.notify(win, "Địa chỉ chưa xác thực — đã gửi mã.");
        return;
      }
      if (e.code === "invalid_or_missing_token") {
        this.Creds.clear(email);
        this.showAuth(win, email, "register");
        this.notify(win, "Phiên đã hết hạn, hãy đăng nhập lại.");
        return;
      }
      // Không để khung xương đứng trơ: báo rõ và cho đường quay lại.
      const list = doc.getElementById("hmail-spam-list");
      if (list) {
        list.textContent = "";
        list.appendChild(this.el(doc, "p", "hmail-spam-note",
          e.status === 404
            ? "Máy chủ lọc chưa bật tính năng người gửi tin cậy — chờ " +
              "bản cập nhật phía máy chủ rồi thử lại."
            : "Không tải được danh sách: " + this.explain(e)));
        const retry = this.el(doc, "button", "hmail-spam-btn", "Thử lại");
        retry.addEventListener("click", () => this.showWhitelist(win));
        const back = this.el(doc, "button", "hmail-spam-btn", "← Thư bị giữ");
        back.addEventListener("click", () => this.refresh(win));
        list.append(retry, back);
      }
      this.notify(win, "Không tải được danh sách: " + this.explain(e));
      return;
    }
    this.setBusy(win, false);
    this.renderWhitelist(win, email, data);
  },

  renderWhitelist(win, email, data) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    if (!list) {
      return;
    }
    list.textContent = "";
    this.setPager(win, null);

    const back = el("button", "hmail-spam-btn", "← Thư bị giữ");
    back.addEventListener("click", () => this.refresh(win));
    list.appendChild(back);

    list.appendChild(el("p", "hmail-spam-note",
      "Thư từ người gửi tin cậy không bao giờ bị giữ lại. Nhập một địa chỉ " +
      "(doitac@congty.com) hoặc cả tên miền (congty.com) rồi bấm Thêm."));

    // Hàng thêm mục mới -------------------------------------------------
    const addRow = el("div", "hmail-spam-wl-add");
    const input = el("input", "hmail-spam-search");
    input.type = "text";
    input.placeholder = "doitac@congty.com hoặc congty.com";
    const addBtn = el("button", "hmail-spam-btn primary", "Thêm");
    const submit = async () => {
      const value = input.value.trim().toLowerCase();
      if (!value) {
        return;
      }
      const isEmail = value.includes("@");
      if (!isEmail && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
        this.notify(win,
          "Hãy nhập một địa chỉ email hoặc tên miền hợp lệ.");
        return;
      }
      addBtn.disabled = true;
      addBtn.textContent = "Đang thêm…";
      this.setBusy(win, true);
      try {
        const res = await this.Api.whitelistAdd(email, value);
        this.setBusy(win, false);
        let text = `Đã tin cậy ${value}.`;
        if (res?.removed_blacklist?.length) {
          text += ` Đã gỡ ${res.removed_blacklist.length} mục chặn xung đột.`;
        }
        this.notify(win, text);
        this.showWhitelist(win);
      } catch (e) {
        this.setBusy(win, false);
        addBtn.disabled = false;
        addBtn.textContent = "Thêm";
        if (e.code === "email_not_verified" ||
            e.code === "step_up_required") {
          try {
            await this.Api.verifyRequest(email);
          } catch (e2) {}
          this.showAuth(win, email, "verify");
          this.notify(win, "Cần xác thực — đã gửi mã.");
          return;
        }
        this.notify(win, "Không thêm được: " + this.explain(e));
      }
    };
    addBtn.addEventListener("click", submit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        submit();
      }
    });
    addRow.append(input, addBtn);
    list.appendChild(addRow);

    const items = data?.items || [];
    this.notify(win, `${items.length} người gửi tin cậy`);
    if (!items.length) {
      list.appendChild(el("p", "hmail-spam-note",
        "Chưa có mục nào. Bạn cũng có thể bấm “Tin cậy” ngay trên một thư " +
        "trong danh sách Thư bị giữ."));
      return;
    }

    for (const item of items) {
      const row = el("div", "hmail-spam-row");
      row.dataset.id = item.id;
      const main = el("div", "hmail-spam-row-main");
      const head = el("div", "hmail-spam-row-head");
      head.append(
        el("span", "hmail-spam-from", item.value),
        el("span", "hmail-spam-time", item.created_at
          ? new Date(item.created_at * 1000).toLocaleDateString() : "")
      );
      const meta = el("div", "hmail-spam-meta",
        (item.type === "domain" ? "Cả tên miền" : "Địa chỉ email") +
        " · " + this.wlStatusLabel(item.pmg_status));
      main.append(head, meta);

      const actions = el("div", "hmail-spam-actions");
      const remove = el("button", "hmail-spam-btn", "Xoá");
      remove.addEventListener("click", async () => {
        if (!Services.prompt.confirm(win, "Người gửi tin cậy",
              `Bỏ ${item.value} khỏi danh sách tin cậy?\n\n` +
              "Thư từ nguồn này có thể bị giữ lại như bình thường.")) {
          return;
        }
        remove.disabled = true;
        remove.textContent = "Đang xoá…";
        try {
          await this.Api.whitelistRemove(email, item.id);
          row.remove();
          this.notify(win, `Đã bỏ ${item.value} khỏi danh sách tin cậy.`);
        } catch (e) {
          remove.disabled = false;
          remove.textContent = "Xoá";
          this.notify(win, "Không xoá được: " + this.explain(e));
        }
      });
      actions.appendChild(remove);

      row.append(main, actions);
      list.appendChild(row);
    }
  },

  wlStatusLabel(status) {
    switch (status) {
      case "sent":
        return "đã đồng bộ máy chủ lọc";
      case "local":
        return "áp dụng phía dịch vụ";
      case "failed":
        return "chưa đồng bộ được — thêm lại để thử lại";
      default:
        return status || "";
    }
  },
};

// ---------------------------------------------------------------------------
// Đầu dò layout (pref hmail.debug.layout = "run"): đo chiều cao thật của
// từng tầng quanh danh sách thư — tìm tầng nào tràn khỏi cửa sổ làm thanh
// cuộn bị cắt mất đáy. Kết quả JSON ghi ngược vào pref.
(function hMailLayoutProbe() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.layout", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.layout", text.slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(() => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const doc = win.document;
      const out = { win: [win.innerWidth, win.innerHeight] };
      const box = (key, el) => {
        if (el) {
          const r = el.getBoundingClientRect();
          out[key] = [Math.round(r.top), Math.round(r.bottom),
                      Math.round(r.height)];
        }
      };
      const tabmail = doc.getElementById("tabmail");
      box("tabmail", tabmail);
      box("ribbon", doc.querySelector(".hmail-ribbon, #hmail-ribbon"));
      box("statusbar", doc.getElementById("status-bar"));
      box("mailbox", doc.getElementById("messengerBox"));
      const a3 = tabmail?.currentAbout3Pane;
      if (a3) {
        out.a3win = [a3.innerWidth, a3.innerHeight];
        const ad = a3.document;
        box("a3-threadPane", ad.getElementById("threadPane"));
        box("a3-threadTree", ad.getElementById("threadTree"));
        box("a3-treeParent", ad.getElementById("threadTree")?.parentElement);
        box("a3-messagePane", ad.getElementById("messagePane"));
        box("a3-body", ad.body);
      }
      report("ok: " + JSON.stringify(out));
    } catch (e) {
      report("err: " + e);
    }
  }, 15000);
})();

// ---------------------------------------------------------------------------
// Tự kiểm luồng thư bị giữ + người gửi tin cậy (pref hmail.debug.spamtest =
// "run", serverUrl đã trỏ vào mock): mở tab thật, đi hết đăng nhập → xác
// thực → danh sách (có nút Tin cậy) → whitelist thêm/xoá qua đúng các nút
// người dùng bấm. Kết quả ghi ngược vào pref; cấu hình mock được dọn sạch
// khi xong dù đậu hay rớt.
(function hMailSpamSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.spamtest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.spamtest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.spamtest", text.slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  const steps = [];
  setTimeout(async () => {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const doc = win.document;
    const waitFor = (test, timeout = 20000) =>
      new Promise((resolve, reject) => {
        const t0 = win.performance.now();
        const poll = () => {
          let hit = null;
          try {
            hit = test();
          } catch (e) {}
          if (hit) {
            resolve(hit);
            return;
          }
          if (win.performance.now() - t0 > timeout) {
            reject(new Error("timeout @ " + steps[steps.length - 1]));
            return;
          }
          win.setTimeout(poll, 300);
        };
        poll();
      });
    const button = text => [...doc.querySelectorAll(
      "#hmail-spam-panel button")].find(b => b.textContent === text);
    let email = "";
    try {
      steps.push("open-tab");
      hMailSpam.openTab(win);
      email = doc.getElementById("hmail-spam-account")?.value || "";

      steps.push("dang-nhap");
      (await waitFor(() => button("Đăng nhập"))).click();
      steps.push("xac-thuc");
      const code = await waitFor(() => doc.querySelector(".hmail-spam-code"));
      code.value = "123456";
      // Bộ tự lấy mã có thể đã xác nhận xong trước khi kịp bấm — nút
      // không còn thì coi như đã qua bước này.
      button("Xác nhận")?.click();

      steps.push("danh-sach");
      await waitFor(() => button("Nhận thư"));
      if (!button("Tin cậy")) {
        throw new Error("dòng thư bị giữ không có nút Tin cậy");
      }

      steps.push("phan-trang");
      await waitFor(() => !doc.getElementById("hmail-spam-pager").hidden);
      doc.getElementById("hmail-spam-next").click();
      await waitFor(() => doc.getElementById("hmail-spam-page-info")
        .textContent.startsWith("Trang 2/"));
      doc.getElementById("hmail-spam-prev").click();
      await waitFor(() => doc.getElementById("hmail-spam-page-info")
        .textContent.startsWith("Trang 1/"));

      steps.push("loc-trang-thai");
      const filter = doc.getElementById("hmail-spam-filter");
      filter.value = "delivered";
      filter.dispatchEvent(new win.Event("change"));
      await waitFor(() => {
        const rows = [...doc.querySelectorAll(
          "#hmail-spam-list .hmail-spam-row")];
        return rows.length &&
          rows.every(r => r.dataset.status === "delivered");
      });
      filter.value = "";
      filter.dispatchEvent(new win.Event("change"));
      await waitFor(() => button("Nhận thư"));

      steps.push("xem-truoc");
      button("Xem").click();
      await waitFor(() => {
        const frame = doc.querySelector(".hmail-spam-preview");
        return frame?.currentURI?.spec?.startsWith("data:text/html") &&
          doc.querySelector(".hmail-spam-preview-subject") &&
          // Mock trả thư giả mạo (tên miền lệch + Reply-To lệch + điểm 7):
          // phải hiện ít nhất 2 cảnh báo và nút xem headers.
          doc.querySelectorAll(".hmail-spam-warn").length >= 2 &&
          [...doc.querySelectorAll("button")]
            .some(b => b.textContent.includes("headers"));
      });
      steps.push("quay-lai");
      button("← Quay lại").click();
      await waitFor(() => button("Nhận thư"));

      steps.push("mo-whitelist");
      button("Người gửi tin cậy").click();
      steps.push("them-muc");
      const input = await waitFor(
        () => doc.querySelector(".hmail-spam-wl-add input"));
      input.value = "vendor.com";
      button("Thêm").click();
      steps.push("thay-muc-moi");
      const entry = await waitFor(() =>
        [...doc.querySelectorAll("#hmail-spam-list .hmail-spam-from")]
          .find(s => s.textContent === "vendor.com"));

      steps.push("xoa-muc");
      const id = entry.closest(".hmail-spam-row").dataset.id;
      await hMailSpam.Api.whitelistRemove(email, id);
      hMailSpam.showWhitelist(win);
      await waitFor(() =>
        ![...doc.querySelectorAll("#hmail-spam-list .hmail-spam-from")]
          .some(s => s.textContent === "vendor.com") &&
        doc.querySelector(".hmail-spam-wl-add"));

      report("ok: " + steps.join(" > "));
    } catch (e) {
      report("err: " + (e.message || e) + " (đã qua: " + steps.join(" > ") + ")");
    } finally {
      // Trả cấu hình về máy chủ thật, xoá token của mock.
      try {
        hMailSpam.Creds.clear(email);
      } catch (e) {}
      try {
        Services.prefs.clearUserPref("hmail.spam.serverUrl");
        Services.prefs.savePrefFile(null);
      } catch (e) {}
    }
  }, 12000);
})();
