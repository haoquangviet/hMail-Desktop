/* hMail Desktop — nhập dữ liệu từ Outlook
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Thunderbird's own importer can read an Outlook profile, but not the .pst
 * file people are actually given when they leave a company or change laptop.
 * This reads the .pst directly (see pstreader.js) and copies the messages into
 * real hMail folders, keeping the folder tree and the read/unread state.
 *
 * The import only ever adds: the .pst is opened read-only and never written
 * to, and messages land in a new folder tree of their own so nothing existing
 * is touched.
 */

"use strict";

var hMailImport = {
  TAB_MODE: "hmailImport",

  init(win) {
    try {
      this.registerTabType(win);
    } catch (e) {
      Cu.reportError("hMail import init failed: " + e);
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
      modes: {
        [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 },
      },
      openTab(tab) {
        tab.title = "Nhập từ Outlook";
        tab.panel.classList.add("hmail-import-tab");
        tab.panel.appendChild(self.buildPanel(win));
      },
      closeTab() {
        // Closing the tab does not stop the import. A .pst with tens of
        // thousands of messages takes long enough that nobody should have to
        // sit and watch it, so the job runs on and reports from a small chip
        // in the corner instead.
        self.panelGone = true;
        self.showChip(win);
      },
      saveTabState() {},
      showTab(tab) {
        tab.title = "Nhập từ Outlook";
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
    this.panelGone = false;
    this.hideChip(win);
    // A job that kept running while the tab was shut picks its status line
    // back up where the chip left it.
    if (this.state) {
      win.setTimeout(() => {
        this.notify(win, this.state.text, this.state.ratio);
        if (this.running) {
          win.document.getElementById("hmail-import-stop").hidden = false;
          win.document.getElementById("hmail-import-start").hidden = true;
        }
      }, 0);
    }
  },

  // ----------------------------------------------------------------- view

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const root = el("div", "hmail-import hmail-ai");
    root.id = "hmail-import-panel";

    root.appendChild(el("div", "hmail-import-title", "Nhập dữ liệu từ Outlook"));
    root.appendChild(el("div", "hmail-ai-hint",
      "Chọn tệp dữ liệu Outlook (.pst hoặc .ost). hMail chỉ đọc tệp, không " +
      "sửa gì trong đó, và thư được đưa vào một nhánh thư mục mới nên dữ " +
      "liệu sẵn có không bị đụng tới."));

    // Source ---------------------------------------------------------------
    const pick = el("div", "hmail-ai-row");
    const path = el("input", "hmail-ai-field");
    path.id = "hmail-import-path";
    path.placeholder = "Chưa chọn tệp";
    path.readOnly = true;
    const browse = el("button", "hmail-ai-btn", "Chọn tệp…");
    browse.addEventListener("click", () => this.browse(win));
    pick.append(path, browse);
    root.appendChild(pick);

    const found = el("div", "hmail-import-found");
    found.id = "hmail-import-found";
    root.appendChild(found);

    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-import-status";
    root.appendChild(status);

    // A line of text alone left the import looking frozen on a large .pst,
    // where a single folder can run for minutes. The bar gives the progress a
    // shape: striped while we are reading the file and cannot know the total,
    // filling once we do.
    const progress = el("div", "hmail-import-progress");
    progress.id = "hmail-import-progress";
    progress.hidden = true;
    const bar = el("div", "hmail-import-bar");
    bar.id = "hmail-import-bar";
    progress.appendChild(bar);
    root.appendChild(progress);

    const tree = el("div", "hmail-import-tree");
    tree.id = "hmail-import-tree";
    root.appendChild(tree);

    // Destination ----------------------------------------------------------
    const destRow = el("div", "hmail-ai-row");
    destRow.id = "hmail-import-dest-row";
    destRow.hidden = true;
    destRow.appendChild(el("span", "hmail-ai-label", "Đưa vào"));
    const dest = el("select", "hmail-ai-field");
    dest.id = "hmail-import-dest";
    for (const server of this.destinations()) {
      const opt = el("option", null, server.prettyName);
      opt.value = server.key;
      dest.appendChild(opt);
    }
    destRow.appendChild(dest);
    root.appendChild(destRow);

    // --- single files -----------------------------------------------------
    // A .pst is what you get from an old laptop; a handful of .eml or .msg
    // files is what you get from a colleague, and hMail could read neither.
    root.appendChild(el("div", "hmail-import-title2", "Tệp thư rời"));
    root.appendChild(el("div", "hmail-ai-hint",
      "Chọn một hoặc nhiều tệp .eml hoặc .msg. Tệp .eml là thư thô, đọc " +
      "thẳng được. Tệp .msg là định dạng riêng của Outlook — hMail dựng lại " +
      "thư từ nó, giữ phần đầu thư gốc, nội dung và tệp đính kèm."));

    const fileRow = el("div", "hmail-ai-row");
    const pickFiles = el("button", "hmail-ai-btn", "Chọn tệp .eml / .msg…");
    pickFiles.addEventListener("click", () => this.browseFiles(win));
    const fileDest = el("select", "hmail-ai-field");
    fileDest.id = "hmail-import-file-dest";
    for (const folder of this.fileTargets()) {
      const opt = el("option", null, folder.label);
      opt.value = folder.uri;
      fileDest.appendChild(opt);
    }
    fileRow.append(pickFiles, fileDest);
    root.appendChild(fileRow);

    const fileStatus = el("div", "hmail-ai-status", "");
    fileStatus.id = "hmail-import-file-status";
    root.appendChild(fileStatus);

    const actions = el("div", "hmail-ai-actions");
    const start = el("button", "hmail-ai-btn primary", "Bắt đầu nhập");
    start.id = "hmail-import-start";
    start.hidden = true;
    start.addEventListener("click", () => this.start(win));
    const stop = el("button", "hmail-ai-btn", "Dừng");
    stop.id = "hmail-import-stop";
    stop.hidden = true;
    stop.addEventListener("click", () => {
      this.cancelled = true;
      this.notify(win, "Đang dừng…", "busy");
    });
    actions.append(start, stop);
    root.appendChild(actions);

    win.setTimeout(() => this.suggest(win), 200);
    return root;
  },

  /**
   * @param {number|null} ratio 0..1 to fill the bar, "busy" while the total
   *   is unknown, null to put the bar away.
   */
  notify(win, text, ratio = null) {
    const doc = win.document;
    this.state = { text, ratio };
    if (this.running) {
      hMailBusy.update("import-pst", text);
    }
    if (this.panelGone) {
      this.showChip(win);
      return;
    }
    const status = doc.getElementById("hmail-import-status");
    if (status) {
      status.textContent = text;
    }
    const progress = doc.getElementById("hmail-import-progress");
    const bar = doc.getElementById("hmail-import-bar");
    if (!progress || !bar) {
      return;
    }
    if (ratio === null) {
      progress.hidden = true;
      return;
    }
    progress.hidden = false;
    if (ratio === "busy") {
      progress.classList.add("busy");
      bar.style.width = "";
    } else {
      progress.classList.remove("busy");
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    }
  },

  // ------------------------------------------------------- background chip

  /**
   * While the tab is closed the import still needs somewhere to speak from.
   * A chip in the bottom corner of the main window carries the same text as
   * the tab's status line, plus a way back to the tab and a way to stop.
   */
  showChip(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    let chip = doc.getElementById("hmail-import-chip");
    if (!chip) {
      chip = el("div", "hmail-import-chip");
      chip.id = "hmail-import-chip";

      const text = el("span", "hmail-import-chip-text", "");
      text.id = "hmail-import-chip-text";
      text.title = "Mở lại trang nhập dữ liệu";
      text.addEventListener("click", () => this.openTab(win));

      const stop = el("button", "hmail-import-chip-btn", "✕");
      stop.id = "hmail-import-chip-stop";
      stop.title = "Dừng nhập";
      stop.addEventListener("click", () => {
        if (this.running) {
          this.cancelled = true;
        } else {
          this.hideChip(win);
        }
      });

      chip.append(text, stop);
      (doc.body || doc.documentElement).appendChild(chip);
    }
    const label = doc.getElementById("hmail-import-chip-text");
    if (label) {
      label.textContent = this.state?.text || "Đang nhập…";
    }
    const stop = doc.getElementById("hmail-import-chip-stop");
    if (stop) {
      stop.title = this.running ? "Dừng nhập" : "Đóng";
    }
    chip.classList.toggle("done", !this.running);
  },

  hideChip(win) {
    win.document.getElementById("hmail-import-chip")?.remove();
  },

  // ------------------------------------------------------ tệp thư rời

  /** Folders a single message can be filed into. */
  fileTargets() {
    const list = [];
    const walk = (folder, depth) => {
      try {
        if (folder.canFileMessages) {
          list.push({
            uri: folder.URI,
            label: `${"— ".repeat(depth)}${folder.prettyName}`,
          });
        }
        for (const child of folder.subFolders) {
          walk(child, depth + 1);
        }
      } catch (e) {}
    };
    for (const server of MailServices.accounts.allServers) {
      try {
        for (const child of server.rootFolder.subFolders) {
          walk(child, 0);
        }
      } catch (e) {}
    }
    return list;
  },

  browseFiles(win) {
    const picker = Cc["@mozilla.org/filepicker;1"]
      .createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Chọn tệp thư",
                Ci.nsIFilePicker.modeOpenMultiple);
    picker.appendFilter("Tệp thư (*.eml, *.msg)", "*.eml; *.msg");
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    picker.open(result => {
      if (result !== Ci.nsIFilePicker.returnOK) {
        return;
      }
      const paths = [];
      for (const file of picker.files) {
        paths.push(file.QueryInterface(Ci.nsIFile).path);
      }
      this.importFiles(win, paths).catch(e =>
        this.sayFiles(win, "Lỗi: " + (e.message || e)));
    });
  },

  sayFiles(win, text) {
    const node = win.document.getElementById("hmail-import-file-status");
    if (node) {
      node.textContent = text;
    }
  },

  async importFiles(win, paths) {
    const uri = win.document.getElementById("hmail-import-file-dest")?.value;
    const target = uri
      ? MailServices.folderLookup.getFolderForURL(uri) : null;
    if (!target) {
      this.sayFiles(win, "Hãy chọn thư mục để đưa thư vào.");
      return;
    }

    let done = 0;
    let failed = 0;
    for (const path of paths) {
      this.sayFiles(win,
        `Đang nhập ${done + 1}/${paths.length}: ` +
        path.replace(/\\/g, "/").split("/").pop());
      try {
        const rfc822 = /\.msg$/i.test(path)
          ? hMailMsg.toRfc822(await hMailMsg.read(path))
          : await hMailMsg.readEml(path);
        await this.addMessage(target, rfc822, false);
        done++;
      } catch (e) {
        failed++;
        Cu.reportError(`hMail: không nhập được ${path}: ${e}`);
      }
      await new Promise(r => win.setTimeout(r, 0));
    }
    this.sayFiles(win,
      `Xong. Nhập ${done} thư vào "${target.prettyName}"` +
      (failed ? `, ${failed} tệp không đọc được.` : "."));
  },

  destinations() {
    const list = [];
    try {
      const local = MailServices.accounts.localFoldersServer;
      if (local) {
        list.push(local);
      }
    } catch (e) {}
    for (const server of MailServices.accounts.allServers) {
      if (server.type === "imap" || server.type === "pop3") {
        list.push(server);
      }
    }
    return list;
  },

  /** Outlook keeps its data files in a couple of well-known places. */
  async suggest(win) {
    const doc = win.document;
    const box = doc.getElementById("hmail-import-found");
    if (!box) {
      return;
    }
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const roots = [
      `${home}\\Documents\\Outlook Files`,
      `${home}\\Documents\\Các tệp Outlook`,
      `${home}\\OneDrive\\Documents\\Outlook Files`,
      `${home}\\OneDrive\\Documents\\Các tệp Outlook`,
    ];

    const hits = [];
    for (const dir of roots) {
      let names = [];
      try {
        names = await IOUtils.getChildren(dir);
      } catch (e) {
        continue;
      }
      for (const file of names) {
        if (!/\.(pst|ost)$/i.test(file)) {
          continue;
        }
        let size = 0;
        try {
          size = (await IOUtils.stat(file)).size;
        } catch (e) {}
        hits.push({ file, size });
      }
    }
    if (!hits.length) {
      return;
    }

    box.textContent = "";
    box.appendChild(this.el(doc, "div", "hmail-ai-label",
      "Tệp Outlook tìm thấy trên máy này:"));
    for (const hit of hits) {
      const mb = Math.max(1, Math.round(hit.size / 1048576));
      const item = this.el(doc, "button", "hmail-compose-ai-choice",
        `${hit.file.split("\\").pop()} — ${mb} MB`);
      item.addEventListener("click", () => this.load(win, hit.file));
      box.appendChild(item);
    }
  },

  browse(win) {
    const picker = Cc["@mozilla.org/filepicker;1"]
      .createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Chọn tệp dữ liệu Outlook",
                Ci.nsIFilePicker.modeOpen);
    picker.appendFilter("Tệp Outlook (*.pst, *.ost)", "*.pst; *.ost");
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    picker.open(result => {
      if (result === Ci.nsIFilePicker.returnOK && picker.file) {
        this.load(win, picker.file.path);
      }
    });
  },

  // ------------------------------------------------------------- reading

  async load(win, path) {
    const doc = win.document;
    doc.getElementById("hmail-import-path").value = path;
    this.notify(win, "Đang đọc tệp…", "busy");
    doc.getElementById("hmail-import-tree").textContent = "";

    try {
      if (this.handle) {
        hMailPst.close(this.handle);
        this.handle = null;
      }
      this.handle = await hMailPst.open(path);
      this.tree = hMailPst.folders(this.handle);
      this.showTree(win);
      const total = this.countAll(this.tree);
      this.notify(win, `Đọc được ${total.toLocaleString("vi-VN")} thư trong ` +
                       `${this.countFolders(this.tree)} thư mục.`);
      doc.getElementById("hmail-import-dest-row").hidden = false;
      doc.getElementById("hmail-import-start").hidden = false;
    } catch (e) {
      this.notify(win, "Không đọc được tệp: " + (e.message || e));
    }
  },

  countAll(nodes) {
    return nodes.reduce(
      (sum, n) => sum + (n.messageCount || 0) + this.countAll(n.children || []),
      0);
  },

  countFolders(nodes) {
    return nodes.reduce(
      (sum, n) => sum + 1 + this.countFolders(n.children || []), 0);
  },

  showTree(win) {
    const doc = win.document;
    const box = doc.getElementById("hmail-import-tree");
    box.textContent = "";

    const render = (nodes, depth) => {
      for (const node of nodes) {
        const row = this.el(doc, "label", "hmail-import-row");
        row.style.paddingInlineStart = `${depth * 18}px`;
        const box2 = this.el(doc, "input");
        box2.type = "checkbox";
        box2.checked = (node.messageCount || 0) > 0;
        box2.dataset.path = node.path;
        row.append(box2,
          this.el(doc, "span", "hmail-import-name", node.name),
          this.el(doc, "span", "hmail-import-count",
                  node.messageCount ? `${node.messageCount}` : ""));
        box.appendChild(row);
        render(node.children || [], depth + 1);
      }
    };
    render(this.tree, 0);
  },

  selected(win) {
    const doc = win.document;
    const chosen = new Set();
    for (const box of doc.querySelectorAll(
           "#hmail-import-tree input[type=checkbox]")) {
      if (box.checked) {
        chosen.add(box.dataset.path);
      }
    }
    const flat = [];
    const walk = nodes => {
      for (const node of nodes) {
        if (chosen.has(node.path) && node.messageCount) {
          flat.push(node);
        }
        walk(node.children || []);
      }
    };
    walk(this.tree);
    return flat;
  },

  // ------------------------------------------------------------ importing

  /** Create a subfolder and wait for it, since creation is asynchronous. */
  ensureFolder(parent, name) {
    const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Thư mục";
    let existing = null;
    try {
      existing = parent.getChildNamed(safe);
    } catch (e) {}
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const listener = {
        folderAdded(folder) {
          if (folder.parent && folder.parent.URI === parent.URI &&
              folder.name === safe) {
            MailServices.mfn.removeListener(listener);
            resolve(folder);
          }
        },
      };
      MailServices.mfn.addListener(
        listener, Ci.nsIMsgFolderNotificationService.folderAdded);
      try {
        parent.createSubfolder(safe, null);
      } catch (e) {
        MailServices.mfn.removeListener(listener);
        reject(e);
      }
      setTimeout(() => {
        try {
          MailServices.mfn.removeListener(listener);
        } catch (e) {}
        let late = null;
        try {
          late = parent.getChildNamed(safe);
        } catch (e) {}
        late ? resolve(late)
             : reject(new Error(`không tạo được thư mục "${safe}"`));
      }, 15000);
    });
  },

  /** Message-IDs already filed in a folder. */
  existingIds(folder) {
    const ids = new Set();
    try {
      for (const hdr of folder.msgDatabase.enumerateMessages()) {
        if (hdr.messageId) {
          ids.add(hdr.messageId);
        }
      }
    } catch (e) {}
    return ids;
  },

  /** The Message-ID of a raw message, without parsing the whole thing. */
  messageId(rfc822) {
    const head = rfc822.slice(0, 8192);
    const m = new RegExp("^Message-ID:([^\\r\\n]+)", "im").exec(head);
    // The database stores the id without its angle brackets, so this has to
    // strip them too or nothing would ever match and every run would import
    // the whole file again.
    return m ? m[1].replace(/[<>]/g, "").trim() : "";
  },

  /**
   * Put one message in a folder.
   *
   * A local folder is written to directly. nsIMsgLocalMailFolder.addMessage
   * appends to the store and returns the header, with no temporary file, no
   * round trip through the copy service and no per-message notification —
   * the same call the feed reader uses. Through copyFileMessage the import
   * managed about one message a second, which for a .pst of a hundred
   * thousand messages is thirty hours; this is faster by a wide margin.
   *
   * IMAP and anything else still goes the long way, because for those the
   * copy service is doing real work: talking to a server.
   */
  async addMessage(folder, rfc822, isRead) {
    try {
      const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
      // addMessage wants bytes, one per character, not a UTF-16 string.
      const hdr = local.addMessage(unescape(encodeURIComponent(rfc822)));
      if (isRead && hdr) {
        hdr.orFlags(Ci.nsMsgMessageFlags.Read);
      }
      return;
    } catch (e) {
      // Not a local folder, or the store refused it: fall through.
    }
    return this.addMessageSlowly(folder, rfc822, isRead);
  },

  async addMessageSlowly(folder, rfc822, isRead) {
    const tmp = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tmp.append(`hmail-import-${Math.floor(Date.now() % 1e9)}-` +
               `${this._seq = (this._seq || 0) + 1}.eml`);
    await IOUtils.writeUTF8(tmp.path, rfc822);

    try {
      await new Promise((resolve, reject) => {
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
          onStartCopy() {},
          onProgress() {},
          setMessageKey() {},
          getMessageId() {
            return "";
          },
          onStopCopy(status) {
            Components.isSuccessCode(status)
              ? resolve()
              : reject(new Error("mã lỗi " + status));
          },
        };
        MailServices.copy.copyFileMessage(
          tmp, folder, null, false,
          isRead ? Ci.nsMsgMessageFlags.Read : 0,
          "", listener, null);
      });
    } finally {
      try {
        await IOUtils.remove(tmp.path);
      } catch (e) {}
    }
  },

  /**
   * Path segments to create, without the store's own top node. That node is
   * shared by every folder in the file, so it is only in the way.
   */
  relativePath(path) {
    const parts = String(path).split("/").filter(Boolean);
    if (!this._rootSegment) {
      const firsts = new Set();
      const walk = nodes => {
        for (const node of nodes) {
          const head = String(node.path).split("/").filter(Boolean)[0];
          if (head) {
            firsts.add(head);
          }
          walk(node.children || []);
        }
      };
      walk(this.tree || []);
      this._rootSegment = firsts.size === 1 ? [...firsts][0] : null;
    }
    if (this._rootSegment && parts[0] === this._rootSegment &&
        parts.length > 1) {
      parts.shift();
    }
    return parts;
  },

  async start(win) {
    const doc = win.document;
    const folders = this.selected(win);
    if (!folders.length) {
      this.notify(win, "Hãy chọn ít nhất một thư mục.");
      return;
    }

    const serverKey = doc.getElementById("hmail-import-dest").value;
    const server = MailServices.accounts.getIncomingServer(serverKey);
    if (!server) {
      this.notify(win, "Không tìm thấy nơi nhận.");
      return;
    }

    this.cancelled = false;
    doc.getElementById("hmail-import-start").hidden = true;
    doc.getElementById("hmail-import-stop").hidden = false;

    const label = doc.getElementById("hmail-import-path").value
      .split("\\").pop().replace(/\.(pst|ost)$/i, "");
    const total = folders.reduce((s, f) => s + (f.messageCount || 0), 0);
    let done = 0;
    let failed = 0;
    let lastTick = 0;
    this.running = true;
    hMailBusy.start("import-pst", "Nhập thư từ Outlook",
                    "Số thư đã nhập vẫn giữ nguyên; lần chạy sau sẽ bỏ qua chúng.");
    hMailBusy.onStop("import-pst", () => {
      this.cancelled = true;
    });

    this.notify(win, "Đang chuẩn bị thư mục…", total ? 0 : "busy");

    try {
      const root = await this.ensureFolder(server.rootFolder,
                                           `Outlook — ${label}`);

      for (const node of folders) {
        if (this.cancelled) {
          break;
        }
        // Mirror the tree: a/b/c becomes nested folders under the root. The
        // .pst's own top node ("Top of Outlook data file") is dropped — it is
        // an artefact of the file format, not a folder anyone made.
        let target = root;
        for (const part of this.relativePath(node.path)) {
          target = await this.ensureFolder(target, part);
        }

        // What is already in this folder, so a second run picks up where the
        // first one stopped instead of importing everything twice. A .pst of
        // a hundred thousand messages takes hours, and hours is long enough
        // that the run will be interrupted at least once.
        const already = this.existingIds(target);
        let skipped = 0;

        // Tells the folder a batch is arriving, so it stops announcing every
        // single message to the rest of the application while it runs.
        try {
          target.gettingNewMessages = true;
        } catch (e) {}

        try {
        for await (const message of hMailPst.messages(this.handle,
                                                      node.path)) {
          if (this.cancelled) {
            break;
          }
          const id = this.messageId(message.rfc822);
          if (id && already.has(id)) {
            skipped++;
            done++;
            continue;
          }
          try {
            await this.addMessage(target, message.rfc822, message.isRead);
            if (id) {
              already.add(id);
            }
          } catch (e) {
            failed++;
          }
          done++;
          // Update on a clock rather than a message count: ten messages can
          // be a blink or half a minute depending on what is in them, and a
          // status line that only moves every tenth one reads as stuck.
          const now = win.performance.now();
          if (now - lastTick > 150 || done === total) {
            lastTick = now;
            const pct = total ? Math.round((done / total) * 100) : 0;
            this.notify(win,
              `Đang nhập ${node.name}: ${done.toLocaleString("vi-VN")}/` +
              `${total.toLocaleString("vi-VN")} thư (${pct}%)` +
              (skipped ? ` — bỏ qua ${skipped} thư đã có` : "") +
              (failed ? ` — ${failed} thư lỗi` : ""),
              total ? done / total : "busy");
            // Let the interface breathe between batches.
            await new Promise(r => win.setTimeout(r, 0));
          }
        }
        } finally {
          try {
            target.gettingNewMessages = false;
          } catch (e) {}
        }
      }

      const errors = (this.handle?.errors || []).length;
      this.notify(win, this.cancelled
        ? `Đã dừng ở ${done.toLocaleString("vi-VN")} thư. Chạy lại sẽ tự bỏ ` +
          `qua những thư đã nhập.`
        : `Xong. Nhập ${(done - failed).toLocaleString("vi-VN")} thư vào ` +
          `"Outlook — ${label}"` +
          (failed || errors
            ? `, bỏ qua ${failed + errors} thư không đọc được.`
            : "."),
        1);
    } catch (e) {
      this.notify(win, "Lỗi khi nhập: " + (e.message || e), null);
    } finally {
      this.running = false;
      hMailBusy.end("import-pst");
      if (this.panelGone) {
        this.showChip(win);
      } else {
        doc.getElementById("hmail-import-stop").hidden = true;
        doc.getElementById("hmail-import-start").hidden = false;
      }
    }
  },
};
