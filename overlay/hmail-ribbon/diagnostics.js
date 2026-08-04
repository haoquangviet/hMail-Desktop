/* hMail Desktop — Gỡ lỗi kết nối
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * "Không nhận được thư" has a dozen causes and the application reports one
 * sentence about all of them. This walks the same path a mail connection
 * takes — the machine is online, DNS answers, the port accepts a connection,
 * TLS completes, the server greets us, authentication is offered — and says
 * which step failed and what that means, in words the person reading it can
 * act on or paste into a support request.
 *
 * Every probe is read-only and uses the account settings already stored: it
 * opens a socket, reads the greeting, asks the server what it supports, and
 * hangs up. No password is sent and nothing is changed.
 */

"use strict";

var hMailDiag = {
  TAB_MODE: "hmailDiagnostics",
  TIMEOUT_MS: 8000,

  init(win) {
    try {
      this.registerTabType(win);
    } catch (e) {
      Cu.reportError("hMail diagnostics init failed: " + e);
    }
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

  // -------------------------------------------------------------- the tab

  registerTabType(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail || tabmail.tabModes?.[this.TAB_MODE]) {
      return;
    }
    const self = this;
    tabmail.registerTabType({
      name: self.TAB_MODE,
      perTabPanel: "vbox",
      modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
      openTab(tab) {
        tab.title = "Gỡ lỗi kết nối";
        tab.panel.classList.add("hmail-import-tab");
        tab.panel.appendChild(self.buildPanel(win));
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "Gỡ lỗi kết nối";
      },
      persistTab() {
        return null;
      },
      restoreTab(t) {
        t.openTab(self.TAB_MODE, {});
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
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
    const opened = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (opened) {
      tabmail.switchToTab(opened);
    }
  },

  // ----------------------------------------------------------------- view

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const root = el("div", "hmail-import hmail-ai");
    root.id = "hmail-diag-panel";

    root.appendChild(el("div", "hmail-import-title", "Gỡ lỗi kết nối"));
    root.appendChild(el("div", "hmail-ai-hint",
      "hMail thử đi lại đúng đường mà thư đi: máy có mạng chưa, tên máy chủ " +
      "có tra được không, cổng có mở không, mã hóa có bắt tay được không, " +
      "máy chủ trả lời ra sao. Các bước chỉ đọc, không gửi mật khẩu và " +
      "không thay đổi gì trong tài khoản."));

    const actions = el("div", "hmail-ai-actions");
    const run = el("button", "hmail-ai-btn primary", "Bắt đầu kiểm tra");
    run.id = "hmail-diag-run";
    run.addEventListener("click", () => {
      this.runAll(win).catch(e =>
        this.status(win, "Lỗi khi kiểm tra: " + (e.message || e)));
    });
    const copy = el("button", "hmail-ai-btn", "Chép báo cáo");
    copy.id = "hmail-diag-copy";
    copy.addEventListener("click", () => this.copyReport(win));
    actions.append(run, copy);
    root.appendChild(actions);

    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-diag-status";
    root.appendChild(status);

    const out = el("div", "hmail-diag-results");
    out.id = "hmail-diag-results";
    root.appendChild(out);

    return root;
  },

  status(win, text) {
    const node = win.document.getElementById("hmail-diag-status");
    if (node) {
      node.textContent = text;
    }
  },

  section(win, title) {
    const doc = win.document;
    const box = doc.getElementById("hmail-diag-results");
    const head = this.el(doc, "div", "hmail-import-title2", title);
    box.appendChild(head);
    return box;
  },

  /**
   * One line of the report.
   * @param {"ok"|"warn"|"fail"|"info"} state
   */
  line(win, label, state, detail) {
    const doc = win.document;
    const box = doc.getElementById("hmail-diag-results");
    const row = this.el(doc, "div", `hmail-diag-row hmail-diag-${state}`);
    const mark = { ok: "✓", warn: "!", fail: "✕", info: "•" }[state] || "•";
    row.appendChild(this.el(doc, "span", "hmail-diag-mark", mark));
    const body = this.el(doc, "div", "hmail-diag-body");
    body.appendChild(this.el(doc, "div", "hmail-diag-label", label));
    if (detail) {
      body.appendChild(this.el(doc, "div", "hmail-diag-detail", detail));
    }
    row.appendChild(body);
    box.appendChild(row);
    this.report.push(`${mark} ${label}${detail ? "\n    " + detail : ""}`);
    return row;
  },

  // ---------------------------------------------------------------- probes

  /** DNS lookup, so a name that does not resolve is named as such. */
  resolve(host) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      setTimeout(() => finish({ ok: false, error: "quá thời gian chờ" }),
                 this.TIMEOUT_MS);
      try {
        const dns = Cc["@mozilla.org/network/dns-service;1"]
          .getService(Ci.nsIDNSService);
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
          onLookupComplete(request, record, status) {
            if (!Components.isSuccessCode(status) || !record) {
              finish({ ok: false, error: "không tra được tên miền" });
              return;
            }
            const addrs = [];
            try {
              record.QueryInterface(Ci.nsIDNSAddrRecord);
              while (record.hasMore() && addrs.length < 4) {
                addrs.push(record.getNextAddrAsString());
              }
            } catch (e) {}
            finish({ ok: true, addresses: addrs });
          },
        };
        dns.asyncResolve(host, Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT, 0, null,
                         listener, Services.tm.mainThread, {});
      } catch (e) {
        finish({ ok: false, error: String(e.message || e) });
      }
    });
  },

  /**
   * Open the port, optionally with TLS, and read the server's greeting.
   * `socketType` is "" (plain), "starttls" (plain now, TLS later) or "ssl".
   */
  probePort(host, port, socketType) {
    return new Promise(resolve => {
      let done = false;
      let transport = null;
      const finish = value => {
        if (done) {
          return;
        }
        done = true;
        try {
          transport?.close(Cr.NS_OK);
        } catch (e) {}
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: "hết thời gian chờ" }),
        this.TIMEOUT_MS);

      try {
        const sts = Cc["@mozilla.org/network/socket-transport-service;1"]
          .getService(Ci.nsISocketTransportService);
        const types = socketType === "ssl" ? ["ssl"]
                    : socketType === "starttls" ? ["starttls"]
                    : [];
        transport = sts.createTransport(types, host, port, null, null);
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT,
                             Math.ceil(this.TIMEOUT_MS / 1000));
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE,
                             Math.ceil(this.TIMEOUT_MS / 1000));

        const started = Date.now();
        const input = transport.openInputStream(0, 0, 0);
        // Opening the output stream is what makes the connection happen for
        // a plain socket; without it nothing is sent and nothing arrives.
        transport.openOutputStream(
          Ci.nsITransport.OPEN_BLOCKING | Ci.nsITransport.OPEN_UNBUFFERED,
          0, 0);

        const scriptable = Cc["@mozilla.org/scriptableinputstream;1"]
          .createInstance(Ci.nsIScriptableInputStream);
        scriptable.init(input);

        const pump = Cc["@mozilla.org/network/input-stream-pump;1"]
          .createInstance(Ci.nsIInputStreamPump);
        pump.init(input, 0, 0, false, Services.tm.mainThread);

        let greeting = "";
        pump.asyncRead({
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
          onStartRequest() {},
          onDataAvailable(request, stream, offset, count) {
            try {
              greeting += scriptable.read(count);
            } catch (e) {}
            if (greeting.includes("\n") || greeting.length > 512) {
              clearTimeout(timer);
              finish({
                ok: true,
                ms: Date.now() - started,
                greeting: greeting.split(/\r?\n/)[0].slice(0, 300),
              });
            }
          },
          onStopRequest(request, statusCode) {
            clearTimeout(timer);
            if (greeting) {
              finish({
                ok: true,
                ms: Date.now() - started,
                greeting: greeting.split(/\r?\n/)[0].slice(0, 300),
              });
              return;
            }
            finish({ ok: false, error: this._parent.socketError(statusCode) });
          },
          _parent: this,
        }, null);
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, error: String(e.message || e) });
      }
    });
  },

  /**
   * A web server says nothing until it is asked, so the plain socket probe
   * would sit there until it timed out. Send a real request instead.
   */
  async probeHttps(url) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    try {
      await fetch(url, { method: "HEAD", cache: "no-store",
                         signal: controller.signal });
      return { ok: true, ms: Date.now() - started };
    } catch (e) {
      return {
        ok: false,
        error: e.name === "AbortError" ? "hết thời gian chờ"
                                       : String(e.message || e),
      };
    } finally {
      clearTimeout(timer);
    }
  },

  /** Turn a Gecko status code into something a person can act on. */
  socketError(code) {
    const known = {
      0x804b000c: "máy chủ từ chối kết nối — cổng đóng hoặc dịch vụ không chạy",
      0x804b000e: "hết thời gian chờ — thường do tường lửa chặn im lặng",
      0x804b001e: "không tra được tên máy chủ (DNS)",
      0x805a1ff3: "lỗi chứng thư TLS — chứng thư không hợp lệ hoặc sai tên miền",
      0x80004004: "kết nối bị hủy",
    };
    const hex = (code >>> 0);
    return known[hex] || ("mã lỗi 0x" + hex.toString(16));
  },

  /** Accounts to test, with the ports their settings name. */
  targets() {
    const list = [];
    for (const server of MailServices.accounts.allServers) {
      if (!["imap", "pop3"].includes(server.type)) {
        continue;
      }
      list.push({
        kind: server.type.toUpperCase(),
        name: server.prettyName || server.username,
        host: server.hostName,
        port: server.port,
        socketType: server.socketType,
      });
    }
    for (const outgoing of MailServices.outgoingServer.servers) {
      try {
        // The generic outgoing-server interface carries no host; SMTP servers
        // keep theirs on nsISmtpServer.
        const smtp = outgoing.QueryInterface(Ci.nsISmtpServer);
        list.push({
          kind: "SMTP",
          name: outgoing.description || smtp.hostname,
          host: smtp.hostname,
          port: smtp.port,
          socketType: smtp.socketType,
        });
      } catch (e) {}
    }
    return list;
  },

  socketName(socketType) {
    switch (socketType) {
      case Ci.nsMsgSocketType.SSL:
        return { label: "SSL/TLS", mode: "ssl" };
      case Ci.nsMsgSocketType.alwaysSTARTTLS:
      case Ci.nsMsgSocketType.trySTARTTLS:
        return { label: "STARTTLS", mode: "starttls" };
      default:
        return { label: "không mã hóa", mode: "" };
    }
  },

  // ------------------------------------------------------------------ run

  async runAll(win) {
    const doc = win.document;
    doc.getElementById("hmail-diag-results").textContent = "";
    doc.getElementById("hmail-diag-run").disabled = true;
    this.report = [];
    const stamp = new Date().toLocaleString("vi-VN");
    this.report.push(`hMail Desktop — báo cáo gỡ lỗi kết nối, ${stamp}`);

    try {
      // 1. The machine ------------------------------------------------------
      this.section(win, "Máy của bạn");
      const offline = Services.io.offline;
      this.line(win, offline ? "hMail đang ở chế độ ngoại tuyến"
                             : "hMail đang ở chế độ trực tuyến",
        offline ? "fail" : "ok",
        offline ? "Bật lại ở Gửi/Nhận ▸ Chế độ ngoại tuyến, nếu không thư " +
                  "sẽ không đi và về." : null);

      let linkUp = true;
      try {
        linkUp = Cc["@mozilla.org/network/network-link-service;1"]
          .getService(Ci.nsINetworkLinkService).isLinkUp;
      } catch (e) {}
      this.line(win, linkUp ? "Máy có kết nối mạng" : "Máy không thấy mạng",
        linkUp ? "ok" : "fail",
        linkUp ? null : "Kiểm tra Wi-Fi hoặc dây mạng trước khi xem tiếp.");

      const proxyType = Services.prefs.getIntPref("network.proxy.type", 5);
      if (proxyType === 1) {
        this.line(win, "Đang dùng proxy do bạn cấu hình tay", "warn",
          "Nếu thư không đi được, thử tắt proxy trong Cài đặt ▸ Chung ▸ " +
          "Cấu hình proxy.");
      } else {
        this.line(win, "Không dùng proxy thủ công", "info",
          proxyType === 0 ? "Kết nối thẳng." : "Theo cấu hình hệ thống.");
      }

      // 2. Reaching the internet at all -------------------------------------
      this.section(win, "Ra được Internet");
      const pub = await this.resolve("one.one.one.one");
      this.line(win, pub.ok ? "Máy tra được tên miền công cộng (DNS hoạt động)"
                            : "Không tra được tên miền công cộng",
        pub.ok ? "ok" : "fail",
        pub.ok ? pub.addresses.join(", ")
               : "DNS hỏng thì mọi kết nối đều hỏng — kiểm tra router, VPN " +
                 "hoặc máy chủ DNS.");
      const web = await this.probeHttps("https://one.one.one.one/");
      this.line(win, web.ok ? "Kết nối HTTPS ra ngoài bình thường"
                            : "Không kết nối được ra ngoài qua HTTPS",
        web.ok ? "ok" : "warn",
        web.ok ? `phản hồi trong ${web.ms} ms`
               : web.error + " — có thể do tường lửa hoặc phần mềm diệt virus.");

      // 3. Each account ------------------------------------------------------
      const targets = this.targets();
      if (!targets.length) {
        this.section(win, "Máy chủ thư");
        this.line(win, "Chưa có tài khoản thư nào để kiểm tra", "info",
          "Thêm tài khoản ở Gửi/Nhận ▸ Tài khoản mới.");
      }

      const seen = new Set();
      for (const t of targets) {
        this.section(win, `${t.kind} — ${t.name}`);
        this.status(win, `Đang kiểm tra ${t.host}:${t.port}…`);

        if (!t.host) {
          this.line(win, "Tài khoản chưa có tên máy chủ", "fail");
          continue;
        }

        // DNS, once per host.
        const dnsKey = "dns:" + t.host;
        if (!seen.has(dnsKey)) {
          seen.add(dnsKey);
          const dns = await this.resolve(t.host);
          this.line(win,
            dns.ok ? `Tên máy chủ ${t.host} tra được`
                   : `Không tra được tên máy chủ ${t.host}`,
            dns.ok ? "ok" : "fail",
            dns.ok ? dns.addresses.join(", ")
                   : "Kiểm tra lại chính tả tên máy chủ trong cài đặt tài " +
                     "khoản, hoặc hỏi nhà cung cấp dịch vụ thư.");
          if (!dns.ok) {
            continue;
          }
        }

        const sock = this.socketName(t.socketType);
        const res = await this.probePort(t.host, t.port, sock.mode);
        if (res.ok) {
          this.line(win,
            `Cổng ${t.port} (${sock.label}) mở và máy chủ đã trả lời`, "ok",
            `${res.ms} ms — ${res.greeting || "không có lời chào"}`);

          const greet = (res.greeting || "").toUpperCase();
          if (t.kind !== "SMTP" && greet && !/OK|\+OK|READY/.test(greet)) {
            this.line(win, "Lời chào của máy chủ khác thường", "warn",
              "Có thể cổng này là dịch vụ khác, hoặc máy chủ đang chặn máy " +
              "của bạn.");
          }
          if (sock.mode === "" ) {
            this.line(win, "Kết nối này không mã hóa", "warn",
              "Mật khẩu và nội dung thư đi ở dạng đọc được. Nếu máy chủ hỗ " +
              "trợ, hãy đổi sang SSL/TLS trong cài đặt tài khoản.");
          }
        } else {
          this.line(win, `Không kết nối được tới cổng ${t.port} ` +
                         `(${sock.label})`, "fail", res.error);
          // A blocked port is usually a firewall, not a wrong setting: say so
          // only when the standard alternative is worth trying.
          const alt = { 143: 993, 110: 995, 25: 587, 587: 465 }[t.port];
          if (alt) {
            const probe = await this.probePort(t.host, alt,
              alt === 993 || alt === 995 || alt === 465 ? "ssl" : "starttls");
            this.line(win,
              probe.ok ? `Nhưng cổng ${alt} của cùng máy chủ lại mở`
                       : `Cổng thay thế ${alt} cũng không vào được`,
              probe.ok ? "warn" : "info",
              probe.ok ? "Thử đổi cổng trong cài đặt tài khoản sang " + alt +
                         " — nhiều nhà mạng chặn cổng thư không mã hóa."
                       : null);
          }
        }
      }

      this.status(win, "Đã kiểm tra xong. Bấm “Chép báo cáo” để gửi cho bộ " +
                       "phận hỗ trợ nếu cần.");
    } finally {
      doc.getElementById("hmail-diag-run").disabled = false;
    }
  },

  copyReport(win) {
    const text = (this.report || []).join("\n");
    if (!text) {
      this.status(win, "Chưa có gì để chép — hãy bấm Bắt đầu kiểm tra.");
      return;
    }
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper).copyString(text);
      this.status(win, "Đã chép báo cáo vào bộ nhớ tạm.");
    } catch (e) {
      this.status(win, "Không chép được: " + (e.message || e));
    }
  },
};
