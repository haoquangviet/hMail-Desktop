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
      // Release vừa tạo thì asset còn đang tải lên (state "starting") —
      // URL lúc đó tải về là 404. Chỉ nhận asset đã lên xong.
      if (asset?.state && asset.state !== "uploaded") {
        continue;
      }
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
  async downloadAndInstall(win, url, version, onStatus = null) {
    const busy = typeof hMailBusy !== "undefined" ? hMailBusy : win.hMailBusy;
    try {
      onStatus?.(`Đang chuẩn bị tải bản ${version}…`);
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
            onStatus?.(`Đang tải bản ${version}… ${download.progress}%`);
          }
        } catch (e) {}
      };
      await download.start();
      try {
        busy?.end("hmail-update");
      } catch (e) {}
      onStatus?.(`Đã tải xong bộ cài bản ${version}.`);

      const mac = Services.appinfo.OS === "Darwin";
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
      const run = Services.prompt.confirmEx(
        win, "hMail Desktop",
        `Đã tải xong bản ${version} vào:\n${file.path}\n\n` +
        (mac ? "Mở tệp cài đặt ngay?\n\nLƯU Ý: trong cửa sổ hiện ra, hãy " +
               "KÉO hMail Desktop vào thư mục Applications và chọn " +
               "Replace. Bấm \"Mở hiện có\" sẽ chỉ mở lại bản cũ."
             : "Chạy bộ cài ngay? hMail sẽ tự đóng để cập nhật."),
        flags, mac ? "Mở tệp cài đặt" : "Cài ngay", "Để sau",
        null, null, {});
      if (run === 0) {
        file.launch();
      }
      // Người dùng bấm "Để sau" vẫn còn đường quay lại: trả đường dẫn để
      // nơi gọi giữ nút "Chạy bộ cài" — tải xong mà không thấy gì tiếp
      // theo là người dùng tưởng tải hỏng.
      return file.path;
    } catch (e) {
      try {
        busy?.end("hmail-update");
      } catch (e2) {}
      onStatus?.("Không tải được: " + (e.message || e));
      Services.prompt.alert(win, "hMail Desktop",
        "Không tải được bộ cài: " + (e.message || e) +
        "\n\nBản phát hành có thể vừa đăng và tệp còn đang được tải lên — " +
        "thử lại sau vài phút, hoặc tải thủ công tại:\n" + this.PAGE);
      return null;
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
      open.addEventListener("click", async () => {
        // Đã tải xong từ trước: nút giờ là "Chạy bộ cài".
        if (open.dataset.hmailRun) {
          try {
            const file = Cc["@mozilla.org/file/local;1"]
              .createInstance(Ci.nsIFile);
            file.initWithPath(open.dataset.hmailRun);
            if (file.exists()) {
              file.launch();
              return;
            }
          } catch (e) {}
          delete open.dataset.hmailRun;
        }
        // With a known installer URL the button downloads it directly;
        // the release page is only for when the check has not run.
        if (open.dataset.hmailDownload) {
          // Tiến trình phải hiện NGAY TẠI dòng trạng thái cạnh nút — tải
          // 70–200 MB mà im lặng là người dùng tưởng chưa tải được.
          open.disabled = true;
          const version = open.dataset.hmailVersion || "";
          const path = await this.downloadAndInstall(doc.defaultView,
            open.dataset.hmailDownload, version,
            text => { status.textContent = text; });
          open.disabled = false;
          if (path) {
            delete open.dataset.hmailDownload;
            open.dataset.hmailRun = path;
            open.textContent = `Chạy bộ cài ${version}`;
            status.textContent = `Đã tải xong bộ cài vào: ${path}. ` +
              "Bấm \"Chạy bộ cài\" khi sẵn sàng — hMail sẽ tự đóng để " +
              "cập nhật.";
          }
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

      // ------------------------------------------------- thư mục dữ liệu
      if (Services.appinfo.OS === "WINNT") {
        const dataWrap = el("div", "hmail-update-box");
        dataWrap.id = "hmail-data-box";
        const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
        dataWrap.appendChild(el("div", "hmail-update-line",
          `Thư mục dữ liệu (thư, lịch, danh bạ, cấu hình): ${profile}`));

        const dataStatus = el("div", "hmail-update-status", "");
        const dataRow = el("div", "hmail-update-actions");
        const move = el("button", "hmail-update-button",
                        "Di chuyển dữ liệu…");
        move.addEventListener("click", () => this.openMoveTab());
        dataRow.appendChild(move);
        dataWrap.append(dataRow, dataStatus);

        dataWrap.appendChild(el("div", "hmail-update-note",
          "Hộp thư lớn dần theo thời gian. Nút này chuyển toàn bộ dữ liệu " +
          "sang ổ đĩa hoặc thư mục khác: hMail sẽ thoát, chuyển xong tự mở " +
          "lại. Bản cài đặt và cập nhật sau này tự nhận nơi đã chuyển."));
        box.appendChild(dataWrap);
      }

      box.appendChild(wrap);
    } catch (e) {
      Cu.reportError("hMail update prefs failed: " + e);
    }
  },

  // ------------------------------------------------ tab Di chuyển dữ liệu

  MOVE_TAB: "hmailMoveData",

  /**
   * A move deserves a full page, not a bare folder picker: what will happen,
   * what must be true of the destination, how long it can take, and an
   * explicit agreement — then hMail quits and hmailmovedata.exe (a small
   * window with a progress bar) does the move and starts hMail again.
   */
  openMoveTab() {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const tabmail = win?.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    if (!tabmail.tabModes?.[this.MOVE_TAB]) {
      const self = this;
      tabmail.registerTabType({
        name: self.MOVE_TAB,
        perTabPanel: "vbox",
        modes: { [self.MOVE_TAB]: { type: self.MOVE_TAB, maxTabs: 1 } },
        openTab(tab) {
          tab.title = "Di chuyển dữ liệu";
          tab.panel.classList.add("hmail-import-tab");
          tab.panel.appendChild(self.buildMovePanel(win));
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Di chuyển dữ liệu";
        },
        persistTab() {
          return null;
        },
      });
    }
    tabmail.openTab(this.MOVE_TAB, {});
  },

  buildMovePanel(win) {
    const doc = win.document;
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (t, c, x) => {
      const n = doc.createElementNS(NS, t);
      if (c) {
        n.className = c;
      }
      if (x !== undefined) {
        n.textContent = x;
      }
      return n;
    };

    const root = el("div", "hmail-import hmail-ai");
    root.appendChild(el("div", "hmail-import-title",
                        "Di chuyển thư mục dữ liệu"));

    const current = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    root.appendChild(el("div", "hmail-import-note",
      "Toàn bộ thư, lịch, danh bạ, tài khoản và cấu hình của bạn đang nằm tại:"));
    root.appendChild(el("div", "hmail-move-path", current));

    const warn = el("ul", "hmail-move-warnings");
    for (const w of [
      "hMail sẽ TỰ THOÁT khi bắt đầu và tự mở lại khi chuyển xong.",
      "Thư mục đích phải trống hoặc chưa tồn tại.",
      "Chuyển trong cùng ổ đĩa gần như tức thời. Chuyển sang ổ khác sẽ " +
        "copy toàn bộ — hộp thư nhiều gigabyte có thể mất nhiều phút; cửa " +
        "sổ tiến trình sẽ hiển thị đến đâu.",
      "Đừng tắt máy trong lúc chuyển. Nếu lỗi giữa chừng, dữ liệu gốc vẫn " +
        "còn nguyên ở chỗ cũ và bạn có thể thử lại.",
      "Bản cài đặt và cập nhật sau này tự nhận nơi mới — không phải cấu " +
        "hình lại gì.",
    ]) {
      warn.appendChild(el("li", null, w));
    }
    root.appendChild(warn);

    const picked = { path: "" };
    const start = el("button", "hmail-ai-btn primary", "Lưu và bắt đầu");
    start.disabled = true;

    const pickRow = el("div", "hmail-move-row");
    const pickBtn = el("button", "hmail-ai-btn", "Chọn thư mục đích…");
    const pickLabel = el("span", "hmail-move-picked", "(chưa chọn)");
    const agree = el("input");
    agree.type = "checkbox";
    const refresh = () => {
      start.disabled = !(agree.checked && picked.path);
    };
    pickBtn.addEventListener("click", () => {
      const fp = Cc["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, "Chọn nơi lưu dữ liệu mới",
              Ci.nsIFilePicker.modeGetFolder);
      fp.open(rv => {
        if (rv === Ci.nsIFilePicker.returnOK) {
          picked.path = fp.file.path;
          pickLabel.textContent = picked.path;
          refresh();
        }
      });
    });
    pickRow.append(pickBtn, pickLabel);
    root.appendChild(pickRow);

    const agreeRow = el("label", "hmail-move-agree");
    agree.addEventListener("change", refresh);
    agreeRow.append(agree, el("span", null,
      " Tôi đã đọc kỹ các lưu ý trên và muốn di chuyển dữ liệu."));
    root.appendChild(agreeRow);

    const status = el("div", "hmail-import-note", "");
    start.addEventListener("click", () =>
      this.startMove(current, picked.path, status));
    root.append(start, status);
    return root;
  },

  startMove(profile, target, status) {
    try {
      if (!target || target === profile) {
        status.textContent = "Nơi mới trùng nơi cũ.";
        return;
      }
      const exe = Services.dirsvc.get("GreD", Ci.nsIFile);
      exe.append("hmailmovedata.exe");
      if (!exe.exists()) {
        status.textContent =
          "Thiếu hmailmovedata.exe trong thư mục cài đặt.";
        return;
      }
      const app = Services.dirsvc.get("XREExeF", Ci.nsIFile);
      const proc = Cc["@mozilla.org/process/util;1"]
        .createInstance(Ci.nsIProcess);
      proc.init(exe);
      proc.run(false,
        ["-profile", profile, "-target", target, "-app", app.path], 6);
      Services.startup.quit(Services.startup.eAttemptQuit);
    } catch (e) {
      status.textContent = "Không khởi động được: " + (e.message || e);
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

// ---------------------------------------------------------------------------
// Tự kiểm đường cập nhật (pref hmail.debug.updatetest = "run"): hỏi API
// phát hành, chọn asset cho hệ điều hành này rồi TẢI THẬT về thư mục tạm —
// đúng bộ máy Downloads mà nút cập nhật dùng. Kết quả ghi ngược vào pref.
(function hMailUpdateSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.updatetest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.updatetest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.updatetest", text.slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    try {
      const t0 = Date.now();
      const info = await hMailUpdate.latest();
      if (!info) {
        report("err: latest() tra null — API phat hanh khong doc duoc");
        return;
      }
      if (!info.download) {
        report("err: khong thay asset cho HDH nay (ban " + info.version + ")");
        return;
      }
      const { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs");
      const target = PathUtils.join(
        PathUtils.tempDir, "hmail-updatetest.bin");
      const download = await Downloads.createDownload({
        source: info.download, target });
      await download.start();
      const size = (await IOUtils.stat(target)).size;
      await IOUtils.remove(target);
      report("ok: ban " + info.version + " tai duoc " +
             Math.round(size / 1024 / 1024) + " MB trong " +
             Math.round((Date.now() - t0) / 1000) + "s tu " +
             String(info.download).split("/")[2]);
    } catch (e) {
      report("err: " + (e.message || e) + " :: " + (e.name || ""));
    }
  }, 15000);
})();
