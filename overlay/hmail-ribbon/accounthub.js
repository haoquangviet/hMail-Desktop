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
  SKIP_AFTER_MS: 6000,

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
      this.fillUsernames(win);
      this.offerSkip(win);
    } catch (e) {}
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
    const spinner = this.find(win,
      "#syncingAccountsSubheader, .account-hub-sync, #syncAccountsForm");
    const dialog = this.find(win, "#accountHubDialog") ||
                   win.document.getElementById("accountHub");
    if (!spinner || !dialog || spinner.hidden) {
      this.since = 0;
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

  /** Close the hub and hand the discovery to hMail's own CalDAV setup. */
  finish(win) {
    try {
      const close = this.find(win, "#closeButton, .close-button, [dialog-close]");
      if (close) {
        close.click();
      } else {
        win.document.getElementById("accountHub")?.close?.();
      }
    } catch (e) {}
    try {
      win.setTimeout(() => win.hMailDav?.setupAll(win, { quiet: true }), 1500);
    } catch (e) {}
  },
};
