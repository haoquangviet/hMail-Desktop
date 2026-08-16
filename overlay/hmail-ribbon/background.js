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
      // "Thu nhỏ vào khay" của Thunderbird làm cửa sổ biến mất khỏi thanh
      // tác vụ — ai bật (hay bật nhầm) mà không biết sẽ tưởng app mất.
      win.addEventListener("sizemodechange", () => this.onSizeMode(win));
      this.syncTray(win);
      Services.prefs.addObserver(this.PREF, () => this.syncTray(win));
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

  /**
   * The tray icon lives in a helper process of its own (hmailtray.exe): the
   * platform's icon is built in C++ and has no menu to attach to. It only
   * makes sense while hMail keeps running behind a closed window, so it
   * comes and goes with that setting.
   */
  syncTray(win) {
    try {
      if (Services.appinfo.OS !== "WINNT") {
        return;
      }
      // MỘT icon khay duy nhất: helper của hMail là icon thường trực có
      // menu chuột phải; icon "thư mới" của Thunderbird đứng cạnh thành
      // hai icon cho một ứng dụng. Bật chế độ nền thì tắt icon kia; tắt
      // chế độ nền thì trả về mặc định.
      try {
        if (this.enabled()) {
          Services.prefs.setBoolPref("mail.biff.show_tray_icon", false);
        } else if (Services.prefs.prefHasUserValue(
                     "mail.biff.show_tray_icon")) {
          Services.prefs.clearUserPref("mail.biff.show_tray_icon");
        }
      } catch (e) {}
      if (!this.enabled()) {
        return; // The helper exits by itself when hMail does.
      }
      if (this.trayStarted) {
        return;
      }
      const exe = Services.dirsvc.get("GreD", Ci.nsIFile).clone();
      exe.append("hmailtray.exe");
      const app = Services.dirsvc.get("XREExeF", Ci.nsIFile);
      if (!exe.exists() || !app.exists()) {
        return;
      }
      // Subprocess rather than nsIProcess: it takes the argument list as
      // data instead of building a command line, so a program directory
      // with a space in it cannot split "--app=" in half.
      const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs");
      this.trayStarted = true;
      Subprocess.call({
        command: exe.path,
        arguments: [`--pid=${Services.appinfo.processID}`,
                    `--app=${app.path}`,
                    // A development or portable run uses a profile that is
                    // not the default one; without passing it on, the tray's
                    // second launch would open a different mailbox.
                    `--profile=${Services.dirsvc.get("ProfD", Ci.nsIFile).path}`],
        stderr: "pipe",
      }).then(proc => {
        try {
          Services.prefs.setCharPref("hmail.tray.status",
                                     "spawned pid=" + proc.pid);
        } catch (e) {}
        // Helper chết (crash, exit sớm) thì biết đường mà thử lại — và để
        // lại exit code cho người gỡ lỗi thay vì im lặng không icon.
        proc.wait().then(({ exitCode }) => {
          this.trayStarted = false;
          try {
            Services.prefs.setCharPref("hmail.tray.status",
                                       "exited code=" + exitCode);
          } catch (e) {}
          if (this.enabled()) {
            win.setTimeout(() => this.syncTray(win), 30000);
          }
        });
      }).catch(e => {
        this.trayStarted = false;
        try {
          Services.prefs.setCharPref("hmail.tray.status", "spawn-failed: " + e);
        } catch (e2) {}
        Cu.reportError("hMail tray helper did not start: " + e);
      });
    } catch (e) {
      Cu.reportError("hMail tray helper failed: " + e);
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

  /**
   * Cửa sổ vừa bị thu nhỏ trong lúc "mail.minimizeToTray" đang bật: nó sẽ
   * biến khỏi thanh tác vụ, chỉ còn biểu tượng nhỏ ở khay cạnh đồng hồ.
   * Nói rõ MỘT LẦN — người bật nhầm sẽ biết app không hề mất và tắt ở đâu.
   */
  onSizeMode(win) {
    try {
      if (win.windowState !== win.STATE_MINIMIZED) {
        return;
      }
      let toTray = false;
      try {
        toTray = Services.prefs.getBoolPref("mail.minimizeToTray");
      } catch (e) {}
      if (!toTray) {
        return;
      }
      let shown = false;
      try {
        shown = Services.prefs.getBoolPref("hmail.tray.noticeShown");
      } catch (e) {}
      if (shown) {
        return;
      }
      Services.prefs.setBoolPref("hmail.tray.noticeShown", true);
      this.toast(win,
        "hMail được thu vào khay hệ thống (biểu tượng cạnh đồng hồ) vì " +
        "tuỳ chọn \"thu nhỏ vào khay\" đang bật. Nhấp biểu tượng ở khay " +
        "để mở lại; muốn thu nhỏ nằm trên thanh tác vụ như thường thì tắt " +
        "tuỳ chọn này trong Cài đặt ▸ Hệ thống tích hợp.");
    } catch (e) {}
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

    this.toast(win,
      "hMail vẫn đang chạy để nhận thư mới. Mở lại từ thanh tác " +
      "vụ, thoát hẳn bằng Ctrl+Q, hoặc tắt chế độ này trong Cài " +
      "đặt ▸ Hệ thống tích hợp.");
  },

  /** Thông báo hệ thống, rơi về hộp thoại khi máy tắt notification. */
  toast(win, text) {
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

  // ------------------------------------------------- khởi động cùng máy
  // Ghi vào HKCU\...\CurrentVersion\Run — theo từng người dùng, không cần
  // quyền admin, và hiện đàng hoàng trong Task Manager ▸ Startup apps để
  // người dùng tắt được từ phía Windows.

  AUTOSTART_KEY: "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  AUTOSTART_NAME: "hMail Desktop",

  autostartEnabled() {
    try {
      const key = Cc["@mozilla.org/windows-registry-key;1"]
        .createInstance(Ci.nsIWindowsRegKey);
      key.open(key.ROOT_KEY_CURRENT_USER, this.AUTOSTART_KEY, key.ACCESS_READ);
      const has = key.hasValue(this.AUTOSTART_NAME);
      key.close();
      return has;
    } catch (e) {
      return false;
    }
  },

  setAutostart(enabled) {
    try {
      const key = Cc["@mozilla.org/windows-registry-key;1"]
        .createInstance(Ci.nsIWindowsRegKey);
      key.open(key.ROOT_KEY_CURRENT_USER, this.AUTOSTART_KEY,
               key.ACCESS_READ | key.ACCESS_WRITE);
      if (enabled) {
        const app = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
        key.writeStringValue(this.AUTOSTART_NAME, `"${app}"`);
      } else if (key.hasValue(this.AUTOSTART_NAME)) {
        key.removeValue(this.AUTOSTART_NAME);
      }
      key.close();
      return true;
    } catch (e) {
      Cu.reportError("hMail autostart failed: " + e);
      return false;
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

      // Khởi động cùng Windows — cặp tự nhiên với chế độ chạy nền: máy
      // bật lên là thư bắt đầu về.
      if (Services.appinfo.OS === "WINNT") {
        const startRow = doc.createElementNS(XUL, "hbox");
        startRow.id = "hmail-autostart-row";
        startRow.setAttribute("align", "start");
        const startBox = doc.createElementNS(XUL, "checkbox");
        startBox.setAttribute("label",
          "Khởi động hMail cùng Windows khi bật máy");
        startBox.checked = this.autostartEnabled();
        startBox.addEventListener("command", () => {
          if (!this.setAutostart(startBox.checked)) {
            startBox.checked = this.autostartEnabled();
          }
        });
        startRow.appendChild(startBox);
        row.parentNode?.insertBefore(startRow, row.nextSibling);
      }
    } catch (e) {
      Cu.reportError("hMail background prefs failed: " + e);
    }
  },
};
