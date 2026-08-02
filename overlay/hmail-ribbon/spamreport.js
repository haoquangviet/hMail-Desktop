/* hMail Desktop — spam report & quarantine
 * MIT License, Copyright (c) 2026 HQV Software
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
        const account = MailServices.accounts.FindAccountForServer(server);
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
      const about3Pane = win.document.getElementById("tabmail")?.currentAbout3Pane;
      return about3Pane?.gDBView?.hdrForFirstSelectedMessage || null;
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
      const account = MailServices.accounts.FindAccountForServer(hdr.folder.server);
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
        const account = MailServices.accounts.FindAccountForServer(hdr.folder.server);
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
    select.addEventListener("change", () => this.refresh(win));
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
      this.refresh(win);
    });

    const search = el("input", "hmail-spam-search");
    search.id = "hmail-spam-search";
    search.type = "search";
    search.placeholder = "Tìm người gửi / tiêu đề…";
    // The server rate-limits search to 10/min, so wait for a pause in typing.
    let timer = null;
    search.addEventListener("input", () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => this.refresh(win), 500);
    });

    tools.append(refreshBtn, range, search);
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

    return root;
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
      `Nhập mã 6 số vừa được gửi tới ${email}. Mã nằm trong hộp thư của bạn.`));
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
      page: 1,
      per_page: 100,
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
    this.renderList(win, email, data);
  },

  renderList(win, email, data) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    list.textContent = "";

    const items = data?.items || [];
    this.notify(win, `${items.length} thư (${data?.since_days || "?"} ngày)`);

    if (!items.length) {
      list.appendChild(el("p", "hmail-spam-note", "Không có thư nào bị giữ."));
      return;
    }

    for (const item of items) {
      const row = el("div", "hmail-spam-row");
      row.dataset.status = item.status || "other";

      const head = el("div", "hmail-spam-row-head");
      head.append(
        el("span", "hmail-spam-from", item.from || item.envelope_sender || "?"),
        el("span", "hmail-spam-time",
           new Date((item.time || 0) * 1000).toLocaleString())
      );

      const subject = el("div", "hmail-spam-subject", item.subject || "(không tiêu đề)");
      const meta = el("div", "hmail-spam-meta",
        `${item.receiver || ""} · ${Math.round((item.bytes || 0) / 1024)} KB` +
        (item.spamlevel != null ? ` · điểm ${item.spamlevel}` : "") +
        ` · ${this.statusLabel(item.status)}`);

      const actions = el("div", "hmail-spam-actions");
      const view = el("button", "hmail-spam-btn", "Xem");
      view.addEventListener("click", () => this.preview(win, email, item));
      actions.appendChild(view);

      // Only genuinely held mail can be released; tracker rows have no body.
      if (item.status === "quarantined") {
        const release = el("button", "hmail-spam-btn primary", "Nhận thư");
        release.addEventListener("click", () => this.release(win, email, item, row));
        actions.appendChild(release);
      }

      row.append(head, subject, meta, actions);
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

  async preview(win, email, item) {
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
    this.showPreview(win, data);
  },

  showPreview(win, data) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const list = doc.getElementById("hmail-spam-list");
    if (!list) {
      return;
    }
    list.textContent = "";

    const back = el("button", "hmail-spam-btn", "← Quay lại");
    back.addEventListener("click", () => this.refresh(win));
    list.appendChild(back);

    list.appendChild(el("div", "hmail-spam-subject", data.subject || "(không tiêu đề)"));
    list.appendChild(el("div", "hmail-spam-meta",
      `Từ: ${data.from || "?"}\nĐến: ${data.receiver || "?"}`));

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

    const body = String(data.body || "");
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
        frame.fixupAndLoadURIString(
          "data:text/html;charset=utf-8," + encodeURIComponent(page),
          {
            triggeringPrincipal:
              Services.scriptSecurityManager.createNullPrincipal({}),
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
};
