/* hMail Desktop — kiểm tra cập nhật
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Mozilla's updater is removed from this build, so its "Check for updates"
 * button reports that updates are disabled by an administrator — true, but
 * useless. hMail publishes its own releases, so it does its own check: the
 * GitHub Releases feed of the source repository, compared against the
 * version this build was stamped with.
 *
 * Nothing is downloaded or installed automatically. The check reads one JSON
 * document and, if there is something newer, offers to open the release page.
 */

"use strict";

var hMailUpdate = {
  API: "https://api.github.com/repos/haoquangviet/hMail-Desktop/releases/latest",
  PAGE: "https://github.com/haoquangviet/hMail-Desktop/releases/latest",
  MENU_ID: "hmail-check-updates",

  init(win) {
    try {
      this.addMenuItem(win);
    } catch (e) {
      Cu.reportError("hMail update menu failed: " + e);
    }
  },

  version() {
    try {
      return Services.prefs.getCharPref("hmail.version");
    } catch (e) {
      return "0.0.0";
    }
  },

  /**
   * Into the Help menu, above the About item, where anyone would look for it.
   */
  addMenuItem(win) {
    const doc = win.document;
    if (doc.getElementById(this.MENU_ID)) {
      return;
    }
    const popup = doc.getElementById("helpMenuPopup") ||
                  doc.getElementById("menu_HelpPopup");
    if (!popup) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = this.MENU_ID;
    item.setAttribute("label", "Kiểm tra cập nhật…");
    item.addEventListener("command", () => this.check(win, true));

    const about = doc.getElementById("aboutName") ||
                  popup.querySelector('[id*="about" i]');
    if (about) {
      popup.insertBefore(item, about);
      popup.insertBefore(doc.createXULElement("menuseparator"), about);
    } else {
      popup.appendChild(item);
    }
  },

  /**
   * @param {boolean} manual  Asked for by the user, so say something either
   *   way. The automatic check stays quiet when there is nothing new.
   */
  async check(win, manual = false) {
    const current = this.version();
    let latest = "";
    let notes = "";

    try {
      const res = await fetch(this.API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      latest = String(body.tag_name || "").replace(/^v/, "");
      notes = String(body.name || "");
    } catch (e) {
      if (manual) {
        Services.prompt.alert(win, "Kiểm tra cập nhật",
          "Không kết nối được tới trang phát hành để kiểm tra.\n\n" +
          "Bạn có thể xem trực tiếp tại:\n" + this.PAGE);
      }
      return;
    }

    try {
      Services.prefs.setIntPref("hmail.update.lastCheck",
                                Math.floor(Date.now() / 1000));
    } catch (e) {}

    if (!latest) {
      if (manual) {
        Services.prompt.alert(win, "Kiểm tra cập nhật",
          "Chưa có bản phát hành nào được công bố.");
      }
      return;
    }

    if (Services.vc.compare(latest, current) <= 0) {
      if (manual) {
        Services.prompt.alert(win, "Kiểm tra cập nhật",
          `Bạn đang dùng phiên bản mới nhất (${current}).`);
      }
      return;
    }

    const flags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
    const choice = Services.prompt.confirmEx(
      win, "hMail Desktop",
      `Đã có phiên bản ${latest}${notes ? ` — ${notes}` : ""}.\n` +
      `Bạn đang dùng ${current}.\n\n` +
      "Mở trang tải bản mới?",
      flags, "Mở trang tải", "Để sau", null, null, {});

    if (choice === 0) {
      try {
        win.openLinkExternally(this.PAGE);
      } catch (e) {
        Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          .getService(Ci.nsIExternalProtocolService)
          .loadURI(Services.io.newURI(this.PAGE));
      }
    }
  },
};
