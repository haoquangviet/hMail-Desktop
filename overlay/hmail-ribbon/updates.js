/* hMail Desktop — kiểm tra cập nhật
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Mozilla's updater is removed from this build, so its "Check for updates"
 * button reports that updates are disabled by an administrator — true, but
 * useless. hMail publishes its own releases, so it does its own check: the
 * GitHub Releases feed of the source repository, compared against the
 * version this build was stamped with.
 *
 * Nothing is installed automatically. The check reads one JSON document and,
 * if there is a newer release carrying a build for this machine, offers the
 * installer itself — the release page lists both platforms, and picking the
 * wrong file is a mistake worth not offering.
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

  /** The installer in a release that belongs to the machine we run on. */
  assetFor(assets) {
    const mac = Services.appinfo.OS === "Darwin";
    const wanted = mac ? /\.dmg$/i : /\.exe$/i;
    for (const asset of assets) {
      if (wanted.test(String(asset.name || ""))) {
        return String(asset.browser_download_url || "");
      }
    }
    return "";
  },

  /**
   * @param {boolean} manual  Asked for by the user, so say something either
   *   way. The automatic check stays quiet when there is nothing new.
   */
  async check(win, manual = false) {
    const current = this.version();
    let latest = "";
    let download = "";

    try {
      const res = await fetch(this.API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      latest = String(body.tag_name || "").replace(/^v/, "");
      // A release that carries no build for this machine is not an update
      // anyone here can install: the Windows and macOS artefacts are made on
      // different machines and one can be published minutes before the other.
      // Better to stay quiet than to send someone to a page with nothing on
      // it for them.
      download = this.assetFor(body.assets || []);
      if (!download) {
        latest = "";
      }
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
          `Bạn đang dùng phiên bản ${current}. Chưa có bản cài mới cho ` +
          "hệ điều hành này trên trang phát hành.");
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
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;
    const choice = Services.prompt.confirmEx(
      win, "hMail Desktop",
      `Đã có phiên bản ${latest}.\n` +
      `Bạn đang dùng ${current}.\n\n` +
      "Tải bản cài đặt mới ngay bây giờ?",
      flags, "Tải về ngay", "Để sau", "Mở trang tải", null, {});

    if (choice === 0 && download) {
      this.downloadAndInstall(win, download, latest);
    } else if (choice === 2 || (choice === 0 && !download)) {
      this.openPage(win, download);
    }
  },

  /**
   * Pull the installer straight into the Downloads folder and offer to run
   * it. Opening the release page in a browser was one more app, one more
   * click, and one more chance to pick the other platform's file.
   */
  async downloadAndInstall(win, url, version) {
    const busy = typeof hMailBusy !== "undefined" ? hMailBusy : win.hMailBusy;
    try {
      const { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs");
      const dir = await Downloads.getPreferredDownloadsDirectory();
      const leaf = decodeURIComponent(
        String(url).split("/").pop() || `hMailDesktop-${version}`);
      const file = Cc["@mozilla.org/file/local;1"]
        .createInstance(Ci.nsIFile);
      file.initWithPath(PathUtils.join(dir, leaf));
      if (file.exists()) {
        // Keep whatever is already there; this picks "…(1).exe" instead.
        file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);
      }

      try {
        busy?.start("hmail-update",
          `Đang tải hMail Desktop ${version}`,
          "Bộ cài đang tải sẽ bị hỏng dở.");
      } catch (e) {}
      const download = await Downloads.createDownload({
        source: url,
        target: file.path,
      });
      download.onchange = () => {
        try {
          if (download.hasProgress) {
            busy?.update("hmail-update", `${download.progress}%`);
          }
        } catch (e) {}
      };
      await download.start();
      try {
        busy?.end("hmail-update");
      } catch (e) {}

      const mac = Services.appinfo.OS === "Darwin";
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
      const run = Services.prompt.confirmEx(
        win, "hMail Desktop",
        `Đã tải xong bản ${version} vào:\n${file.path}\n\n` +
        (mac ? "Mở tệp cài đặt ngay?"
             : "Chạy bộ cài ngay? hMail sẽ tự đóng để cập nhật."),
        flags, mac ? "Mở tệp cài đặt" : "Cài ngay", "Để sau",
        null, null, {});
      if (run === 0) {
        file.launch();
      }
    } catch (e) {
      try {
        busy?.end("hmail-update");
      } catch (e2) {}
      Services.prompt.alert(win, "hMail Desktop",
        "Không tải được bộ cài: " + (e.message || e) +
        "\n\nBạn có thể tải thủ công tại:\n" + this.PAGE);
    }
  },
  // ------------------------------------------------- trang Cài đặt

  /**
   * Replace Thunderbird's update box on the Settings page.
   *
   * Mozilla's updater was removed from this build — an hMail install must not
   * be replaced by a Thunderbird one — so the policy engine reports "updates
   * are disabled by your administrator", which is true and useless. hMail
   * publishes its releases on a public repository, so the box says which
   * version is installed and offers to look for a newer one there.
   */
  renderPrefs(doc) {
    try {
      const box = doc.getElementById("updateBox") ||
                  doc.getElementById("updateApp");
      if (!box || doc.getElementById("hmail-update-box")) {
        return;
      }
      // Everything Thunderbird put in the box refers to a mechanism that is
      // not in this build.
      for (const id of ["updateDeck", "updateBox", "updateAllowDescription",
                        "updateSettingsContainer", "updateRadioGroup",
                        "showUpdateHistory"]) {
        const node = doc.getElementById(id);
        if (node && node !== box) {
          node.hidden = true;
        }
      }
      for (const node of box.children) {
        node.hidden = true;
      }

      const NS = "http://www.w3.org/1999/xhtml";
      const el = (tag, cls, text) => {
        const n = doc.createElementNS(NS, tag);
        if (cls) {
          n.className = cls;
        }
        if (text !== undefined) {
          n.textContent = text;
        }
        return n;
      };

      const wrap = el("div", "hmail-update-box");
      wrap.id = "hmail-update-box";

      const line = el("div", "hmail-update-line",
                      `Phiên bản đang dùng: hMail Desktop ${this.version()}`);
      wrap.appendChild(line);

      const status = el("div", "hmail-update-status", "");
      status.id = "hmail-update-status";

      const row = el("div", "hmail-update-actions");
      const check = el("button", "hmail-update-button", "Kiểm tra cập nhật");
      check.addEventListener("click", () => {
        check.disabled = true;
        status.textContent = "Đang hỏi trang phát hành…";
        this.latest().then(info => {
          if (!info) {
            status.textContent =
              "Không kết nối được tới trang phát hành. Bạn có thể mở trực " +
              "tiếp bằng nút bên cạnh.";
          } else if (Services.vc.compare(info.version, this.version()) <= 0) {
            status.textContent =
              `Bạn đang dùng phiên bản mới nhất (${this.version()}).`;
          } else if (!info.download) {
            status.textContent =
              `Đã có phiên bản ${info.version} nhưng chưa có bản cài cho hệ ` +
              "điều hành này.";
          } else {
            status.textContent =
              `Đã có phiên bản ${info.version}. Bấm nút bên cạnh để tải ` +
              "bản cài đặt.";
            open.textContent = `Tải hMail Desktop ${info.version}`;
            open.dataset.hmailDownload = info.download;
            open.dataset.hmailVersion = info.version;
          }
        }).finally(() => {
          check.disabled = false;
        });
      });

      const open = el("button", "hmail-update-button", "Mở trang tải");
      open.addEventListener("click", () => {
        // With a known installer URL the button downloads it directly;
        // the release page is only for when the check has not run.
        if (open.dataset.hmailDownload) {
          this.downloadAndInstall(doc.defaultView,
            open.dataset.hmailDownload, open.dataset.hmailVersion || "");
        } else {
          this.openPage(doc.defaultView);
        }
      });

      row.append(check, open);
      wrap.append(row, status);

      const note = el("div", "hmail-update-note",
        "hMail không dùng cơ chế cập nhật của Mozilla — bộ cập nhật đó đã " +
        "được gỡ khỏi bản dựng này để một bản cài hMail không bao giờ bị " +
        "thay bằng Thunderbird. Bản phát hành của hMail nằm công khai trên " +
        "kho mã nguồn, kèm mã băm để bạn đối chiếu.");
      wrap.appendChild(note);

      box.appendChild(wrap);
    } catch (e) {
      Cu.reportError("hMail update prefs failed: " + e);
    }
  },

  /** The newest published release, or null if the repository cannot be read. */
  async latest() {
    try {
      const res = await fetch(this.API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        return null;
      }
      const body = await res.json();
      const version = String(body.tag_name || "").replace(/^v/, "");
      const download = this.assetFor(body.assets || []);
      return version ? { version, download } : null;
    } catch (e) {
      return null;
    }
  },

  openPage(win, url) {
    const target = url || this.PAGE;
    try {
      win.openLinkExternally(target);
    } catch (e) {
      Cc["@mozilla.org/uriloader/external-protocol-service;1"]
        .getService(Ci.nsIExternalProtocolService)
        .loadURI(Services.io.newURI(target));
    }
  },
};
