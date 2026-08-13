/* hMail Desktop — sửa hai chỗ vướng trong Trung tâm tài khoản
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Two things go wrong for a Vietnamese business mailbox, and both are about
 * assumptions that were true fifteen years ago.
 *
 * The username. When autoconfiguration fails — which it does for every mail
 * server that is not one of the big providers — the manual form leaves the
 * username as the local part alone, "quyet". Almost every mail server now in
 * use, cPanel and Plesk and Zimbra and hMailServer among them, wants the
 * whole address. The user has to notice the difference and type the domain
 * back in, and when the login then fails they blame the password.
 *
 * The calendar step. The hub goes looking for CalDAV and CardDAV and spins
 * until it gives up, which on a server that answers slowly is a long time to
 * watch a circle. hMail does that discovery itself, properly, from davsync.js
 * — so the step is worth offering a way past rather than a way through.
 *
 * The hub lives in messenger.xhtml, which is this window, so both fixes are
 * ordinary DOM work.
 */

"use strict";

var hMailAccountHub = {
  SKIP_AFTER_MS: 4000,

  init(win) {
    try {
      const doc = win.document;
      const host = doc.getElementById("accountHub") || doc.body ||
                   doc.documentElement;
      if (!host) {
        return;
      }
      this.win = win;
      const observer = new win.MutationObserver(() => this.tick(win));
      observer.observe(host, { childList: true, subtree: true });
      // Some of the hub is rendered before the observer is attached.
      win.setInterval(() => this.tick(win), 1200);
    } catch (e) {
      Cu.reportError("hMail account hub init failed: " + e);
    }
  },

  tick(win) {
    try {
      // Tick này sống cả đời cửa sổ, còn roots() đi querySelectorAll toàn
      // cây shadow của hub — hộp thoại đang ĐÓNG thì không làm gì hết.
      const hub = win.document.getElementById("accountHub");
      if (!hub || (!hub.open && !hub.hasAttribute("open"))) {
        return;
      }
      this.nameTab(win);
      this.rebrand(win);
      this.offerImport(win);
      this.offerAccountOptions(win);
      this.fillUsernames(win);
      this.offerSkip(win);
    } catch (e) {}
  },

  /**
   * Hub báo "Cấu hình được tìm thấy trong Mozilla ISPDB" — người dùng hMail
   * không cần biết ISPDB là gì và không nên thấy thương hiệu khác. Thay mọi
   * text node nhắc tới ISPDB bằng câu tiếng người.
   */
  rebrand(win) {
    for (const root of this.roots(win)) {
      const walker = win.document.createTreeWalker(
        root, win.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/ISPDB/i.test(node.nodeValue || "")) {
          node.nodeValue = "Đã tự tìm thấy cấu hình máy chủ phù hợp";
        }
      }
    }
  },

  /**
   * A first run opens the hub over a tab with no title at all, so the strip
   * shows an empty button and nobody can tell what it is.
   */
  nameTab(win) {
    try {
      const tabmail = win.document.getElementById("tabmail");
      const tab = tabmail?.selectedTab;
      const isSetup = win.document.getElementById("accountHub") ||
                      win.document.getElementById("continueButton");
      if (isSetup && tab && !String(tab.title || "").trim()) {
        tab.title = "Thiết lập tài khoản";
        tabmail.setTabTitle?.(tab);
      }
    } catch (e) {}
  },

  /**
   * Someone arriving from Outlook or another client wants their old mail,
   * not a blank mailbox — but neither setup screen offers the migration.
   * This puts it beside the account fields, where it is looked for.
   *
   * Two screens exist and which one appears depends on the platform and the
   * account-hub pref: the hub (a grid of choices) and the classic wizard
   * (name/address/password with a button row). Both get the entry.
   */
  offerImport(win) {
    const doc = win.document;
    const NS = "http://www.w3.org/1999/xhtml";
    const openImport = closeFirst => {
      if (closeFirst) {
        this.finish(win, { sync: false });
      }
      win.setTimeout(() => {
        try {
          win.hMailImport?.openTab(win);
        } catch (e) {}
      }, 300);
    };

    // --- the account hub -------------------------------------------------
    const grid = this.find(win, ".hub-body-grid");
    if (grid && !grid.querySelector("#hmail-hub-import")) {
      const button = doc.createElementNS(NS, "button");
      button.id = "hmail-hub-import";
      button.className = "button button-account";
      button.textContent = "Chuyển & Nhập dữ liệu";
      button.title = "Mang thư, danh bạ và lịch từ Outlook hoặc ứng dụng " +
                     "thư khác sang hMail";
      button.addEventListener("click", () => openImport(true));
      grid.append(button);
    }

    // --- the classic wizard ----------------------------------------------
    const cancel = doc.getElementById("cancelButton");
    if (cancel && !doc.getElementById("hmail-setup-import")) {
      const link = doc.createElementNS(NS, "button");
      link.id = "hmail-setup-import";
      link.className = "btn-link";
      link.textContent = "Chuyển & Nhập dữ liệu từ ứng dụng khác";
      link.title = "Đọc thẳng tệp .pst của Outlook, hoặc nhập hồ sơ thư, " +
                   "danh bạ và lịch";
      link.addEventListener("click", e => {
        e.preventDefault();
        openImport(false);
      });
      cancel.parentNode?.insertBefore(link, cancel);
    }
  },

  /** Every open shadow root under the hub, because the hub is built of them. */
  roots(win) {
    const out = [];
    const walk = root => {
      out.push(root);
      for (const node of root.querySelectorAll("*")) {
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
      }
    };
    const hub = win.document.getElementById("accountHub");
    if (hub) {
      walk(hub);
    }
    return out;
  },

  find(win, selector) {
    for (const root of this.roots(win)) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  },

  /** Phần tử lá đang hiển thị có chữ khớp mẫu — xuyên mọi shadow root. */
  findByText(win, pattern) {
    for (const root of this.roots(win)) {
      for (const node of root.querySelectorAll("*")) {
        if (!node.childElementCount && !node.hidden &&
            pattern.test(node.textContent || "")) {
          return node;
        }
      }
    }
    return null;
  },

  findAll(win, selector) {
    const out = [];
    for (const root of this.roots(win)) {
      out.push(...root.querySelectorAll(selector));
    }
    return out;
  },

  // ------------------------------------------------------------- username

  /**
   * Put the whole address in the username box when it holds only the local
   * part, and only while the user has not typed there themselves.
   */
  fillUsernames(win) {
    const emailField = this.find(win, "#email, input[type='email']");
    const email = String(emailField?.value || "").trim();
    if (!email.includes("@")) {
      return;
    }
    for (const field of this.findAll(win,
           "#incomingUsername, #outgoingUsername, input[name*='sername']")) {
      if (field.dataset.hmailFilled === email) {
        continue;
      }
      const value = String(field.value || "").trim();
      // Empty, or the local part on its own — the two states autoconfig
      // leaves behind. Anything else is the user's own typing.
      if (value && value !== email.split("@")[0]) {
        continue;
      }
      field.value = email;
      field.dataset.hmailFilled = email;
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
      field.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
  },

  // --------------------------------------------------------------- skip

  /**
   * The sync step gets a way out once it has been spinning long enough to be
   * a wait rather than a moment. hMail sets calendars and address books up
   * itself when the account is ready, so nothing is lost by walking past.
   */
  offerSkip(win) {
    let spinner = this.find(win,
      "#syncingAccountsSubheader, .account-hub-sync, #syncAccountsForm, " +
      "#emailSyncAccountsForm, account-hub-email-sync, " +
      "[id*='ync'] .loading-container, .account-hub-view[name*='ync']");
    // Markup của hub đổi theo từng đời Thunderbird — selector trượt là
    // spinner quay vô hạn không lối thoát. Nhận diện theo CHÍNH DÒNG CHỮ
    // đang hiện thì đời nào cũng bắt được.
    if (!spinner) {
      spinner = this.findByText(win,
        /đang khám phá|đồng bộ h[oó]a lịch|discovering address|syncing (calendar|address)/i);
    }
    const dialog = this.find(win, "#accountHubDialog") ||
                   win.document.getElementById("accountHub");
    if (!spinner || !dialog || spinner.hidden) {
      this.since = 0;
      this._autoSkipped = false;
      win.document.getElementById("hmail-hub-skip")?.remove();
      return;
    }
    if (!this.since) {
      this.since = win.performance.now();
      return;
    }
    if (win.performance.now() - this.since < this.SKIP_AFTER_MS) {
      return;
    }
    // Kẹt quá lâu thì tự thoát hẳn: tài khoản đã tạo xong từ trước bước
    // này, phần lịch/danh bạ hMail tự lo — giữ người dùng đứng nhìn
    // spinner thêm nữa không mua được gì.
    if (win.performance.now() - this.since > 45000) {
      if (!this._autoSkipped) {
        this._autoSkipped = true;
        this.finish(win);
      }
      return;
    }
    if (win.document.getElementById("hmail-hub-skip")) {
      return;
    }

    const doc = win.document;
    const NS = "http://www.w3.org/1999/xhtml";
    const wrap = doc.createElementNS(NS, "div");
    wrap.id = "hmail-hub-skip";
    wrap.className = "hmail-hub-skip";

    const note = doc.createElementNS(NS, "div");
    note.className = "hmail-hub-skip-note";
    note.textContent =
      "Máy chủ đang trả lời chậm. Bạn có thể bỏ qua bước này — hMail tự dò " +
      "lịch và sổ địa chỉ sau khi tài khoản sẵn sàng, và báo lại khi xong.";

    const button = doc.createElementNS(NS, "button");
    button.className = "button secondary-button footer-button";
    button.textContent = "Bỏ qua bước này";
    button.addEventListener("click", () => {
      wrap.remove();
      this.finish(win);
    });

    wrap.append(note, button);
    spinner.parentNode?.insertBefore(wrap, spinner.nextSibling);
  },

  /**
   * The hub finishes on a page of "explore these options" links — encryption
   * and signatures. What a new account actually needs first is the settings
   * that decide how much of the mailbox lands on this machine: how far back
   * to keep messages (IMAP) or when to remove them from the server (POP3).
   * Those live in the account manager and nobody finds them by accident, so
   * the finish page points at them, named for the account that was just made.
   */
  offerAccountOptions(win) {
    const doc = win.document;
    if (doc.getElementById("hmail-hub-account-options")) {
      return;
    }
    // The success page is the one carrying those links.
    const anchor = this.find(win,
      "#emailSyncAccountsForm ~ *, .account-hub-success a, " +
      "a[href*='e2e'], #hubEncryptionLink, #hubSignatureLink");
    const list = anchor?.parentNode;
    if (!list) {
      return;
    }

    const server = this.newestServer();
    if (!server) {
      return;
    }
    const pop = server.type === "pop3";

    const NS = "http://www.w3.org/1999/xhtml";
    const wrap = doc.createElementNS(NS, "div");
    wrap.id = "hmail-hub-account-options";

    const add = (label, page) => {
      const link = doc.createElementNS(NS, "a");
      link.href = "#";
      link.textContent = label;
      link.className = "hmail-hub-option-link";
      link.addEventListener("click", e => {
        e.preventDefault();
        this.finish(win, { sync: false });
        win.setTimeout(() => {
          try {
            win.MsgAccountManager(page, server);
          } catch (err) {
            Cu.reportError("hMail hub options failed: " + err);
          }
        }, 300);
      });
      wrap.appendChild(link);
    };

    add(pop ? "Dung lượng đĩa (giữ thư bao lâu, khi nào xoá trên máy chủ)"
            : "Đồng bộ hoá & lưu trữ (tải thư về máy, giữ bao nhiêu ngày)",
        "am-offline.xhtml");
    add("Cài đặt máy chủ (cổng, mã hoá, kiểm tra thư mới)",
        "am-server.xhtml");
    add("Soạn thảo & địa chỉ, chữ ký, thư rác…", "am-main.xhtml");

    list.appendChild(wrap);
  },

  /** The account made last — the one the hub has just finished setting up. */
  newestServer() {
    let newest = null;
    try {
      for (const server of MailServices.accounts.allServers) {
        if (!["imap", "pop3"].includes(server.type)) {
          continue;
        }
        // Server keys are handed out in order, so the highest number is the
        // one that was created most recently.
        const n = parseInt(String(server.key).replace(/\D/g, ""), 10) || 0;
        const best = newest
          ? parseInt(String(newest.key).replace(/\D/g, ""), 10) || 0
          : -1;
        if (n > best) {
          newest = server;
        }
      }
    } catch (e) {}
    return newest;
  },

  /** Close the hub and hand the discovery to hMail's own CalDAV setup. */
  finish(win, { sync = true } = {}) {
    try {
      const close = this.find(win,
        "#closeButton, .close-button, [dialog-close], " +
        "#accountHubDialogClose, button[class*='close']");
      if (close) {
        close.click();
      } else {
        win.document.getElementById("accountHub")?.close?.();
      }
    } catch (e) {}
    if (!sync) {
      return;
    }
    try {
      win.setTimeout(() => win.hMailDav?.setupAll(win, { quiet: true }), 1500);
    } catch (e) {}
  },
};
