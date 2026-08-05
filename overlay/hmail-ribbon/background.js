/* hMail Desktop — tiếp tục chạy khi đóng cửa sổ
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Closing the window quits Thunderbird, which means no new mail, no reminders
 * and no notifications until the program is started again. Outlook does not
 * work that way, so hMail can keep running instead — but only when asked to.
 *
 * Off by default, and switched from Cài đặt ▸ Hệ thống tích hợp, beside
 * Thunderbird's own tray option. A mail client that refuses to close when
 * told to, with the switch nowhere in sight, is not a convenience: it is a
 * program the user has to end from Task Manager.
 *
 * The window is minimised rather than hidden outright. A hidden window can
 * only be brought back by whatever put it away — minimised, it stays one
 * click away on the taskbar.
 */

"use strict";

var hMailBackground = {
  PREF: "hmail.background.enabled",
  NOTICE_PREF: "hmail.background.noticeShown",

  init(win) {
    try {
      if (win.document.documentElement.getAttribute("windowtype") !==
          "mail:3pane") {
        return;
      }
      win.addEventListener("close", event => this.onClose(win, event), true);
    } catch (e) {
      Cu.reportError("hMail background init failed: " + e);
    }
  },

  enabled() {
    try {
      return Services.prefs.getBoolPref(this.PREF);
    } catch (e) {
      return false;
    }
  },

  onClose(win, event) {
    try {
      if (!this.enabled()) {
        return;
      }
      // A real quit closes every window too; that must go through.
      if (Services.startup.shuttingDown) {
        return;
      }
      // Closing one of several windows is just closing a window.
      let others = 0;
      for (const other of Services.wm.getEnumerator("mail:3pane")) {
        if (other !== win) {
          others++;
        }
      }
      if (others) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      win.minimize();
      this.notice(win);
    } catch (e) {
      Cu.reportError("hMail background close failed: " + e);
    }
  },

  /** Said once, the first time it happens, so nobody thinks hMail hung. */
  notice(win) {
    let shown = false;
    try {
      shown = Services.prefs.getBoolPref(this.NOTICE_PREF);
    } catch (e) {}
    if (shown) {
      return;
    }
    try {
      Services.prefs.setBoolPref(this.NOTICE_PREF, true);
    } catch (e) {}

    const text = "hMail vẫn đang chạy để nhận thư mới. Mở lại từ thanh tác " +
                 "vụ, thoát hẳn bằng Ctrl+Q, hoặc tắt chế độ này trong Cài " +
                 "đặt ▸ Hệ thống tích hợp.";
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"]
        .getService(Ci.nsIAlertsService);
      const alert = Cc["@mozilla.org/alert-notification;1"]
        .createInstance(Ci.nsIAlertNotification);
      alert.init("hmail-background", "", "hMail Desktop", text, false, "");
      alerts.showAlert(alert, null);
    } catch (e) {
      // No alerts service (or the user turned notifications off): say it in
      // the window instead of saying nothing.
      try {
        Services.prompt.alert(win, "hMail Desktop", text);
      } catch (e2) {}
    }
  },

  /**
   * The switch, in Cài đặt ▸ Hệ thống tích hợp, directly under
   * Thunderbird's "minimise to tray" so the two read as a pair.
   */
  renderPrefs(doc) {
    try {
      if (doc.getElementById("hmail-background-row")) {
        return;
      }
      const tray = doc.querySelector('checkbox[preference="mail.minimizeToTray"]');
      const anchor = tray?.closest("hbox") ||
                     doc.getElementById("searchIntegrationContainer");
      if (!anchor) {
        return;
      }
      const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
      const row = doc.createElementNS(XUL, "hbox");
      row.id = "hmail-background-row";
      row.setAttribute("align", "start");

      const box = doc.createElementNS(XUL, "checkbox");
      box.setAttribute("label",
        "Đóng cửa sổ thì thu nhỏ, hMail vẫn chạy để nhận thư mới " +
        "(thoát hẳn bằng Ctrl+Q)");
      box.checked = this.enabled();
      box.addEventListener("command", () => {
        try {
          Services.prefs.setBoolPref(this.PREF, box.checked);
        } catch (e) {}
      });

      row.appendChild(box);
      anchor.parentNode?.insertBefore(row, anchor.nextSibling);
    } catch (e) {
      Cu.reportError("hMail background prefs failed: " + e);
    }
  },
};
