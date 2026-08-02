/* hMail Desktop — tiếp tục chạy khi đóng cửa sổ
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Closing the window quits Thunderbird, which means no new mail, no reminders
 * and no notifications until the program is started again. Outlook does not
 * work that way and neither should hMail: closing puts it away, quitting is a
 * separate, deliberate act (Tập tin ▸ Thoát, or Ctrl+Q).
 *
 * The window is minimised rather than hidden outright. A hidden window can
 * only be brought back by whatever put it away, and hMail has no tray icon of
 * its own to do that with — minimised, it stays one click away on the taskbar,
 * and Thunderbird's own new-mail tray icon still appears beside the clock.
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
      return true;
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
                 "vụ, hoặc thoát hẳn bằng Tập tin ▸ Thoát (Ctrl+Q).";
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
};
