/* hMail Desktop — hành động theo kết luận của bộ lọc máy chủ
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * The mail server has already run a filter over every message: it writes what
 * it concluded into the headers — a class ("spam", "virus"), a score, and
 * often a recommended action. That work was thrown away, and the message
 * landed in the inbox like any other.
 *
 * This applies the user's own decision to that verdict as messages arrive.
 * "Reject" is deliberately not offered: the message is already downloaded, so
 * refusing it is no longer possible — what is left is where to put it.
 *
 * Nothing runs until the user chooses an action. The default for every class
 * is "do nothing", because a filter that moves mail without being asked is
 * how people lose invoices.
 */

"use strict";

var hMailServerFilter = {
  TAB_MODE: "hmailServerFilter",
  PREF: "hmail.serverfilter.rules",

  /** The verdicts hMail can act on, in the order they are shown. */
  CLASSES: [
    {
      id: "virus",
      label: "Máy chủ xếp là mã độc",
      note: "Bộ lọc nhận ra virus, mã độc hoặc trang lừa đảo trong thư.",
      suggested: "junk",
    },
    {
      id: "spam",
      label: "Máy chủ xếp là thư rác",
      note: "X-Spam-Flag: YES, điểm lọc cao, hoặc lớp phân loại là spam.",
      suggested: "junk",
    },
    {
      id: "reject",
      label: 'Máy chủ đề nghị "reject" hoặc "drop"',
      note: "Máy chủ sẽ từ chối thư này nếu được phép, nhưng vẫn chuyển về " +
            "hộp thư của bạn theo cấu hình hiện tại.",
      suggested: "junk",
    },
    {
      id: "authfail",
      label: "Xác thực người gửi không đạt",
      note: "SPF hoặc DMARC trả về fail — thư có thể mạo danh tên miền người gửi.",
      suggested: "none",
    },
  ],

  ACTIONS: [
    { id: "none", label: "Không làm gì (chỉ cảnh báo)" },
    { id: "junk", label: "Đánh dấu thư rác và chuyển vào thư mục rác" },
    { id: "read", label: "Đánh dấu đã đọc, để nguyên chỗ" },
    { id: "move", label: "Chuyển vào một thư mục do tôi chọn" },
    { id: "delete", label: "Chuyển vào Thùng rác" },
  ],

  // ------------------------------------------------------------------ setup

  init(win) {
    try {
      this.registerTabType(win);
      if (this.listening) {
        return;
      }
      this.listening = true;
      MailServices.mfn.addListener(this, MailServices.mfn.msgAdded);
    } catch (e) {
      Cu.reportError("hMail server filter init failed: " + e);
    }
  },

  rules() {
    try {
      return JSON.parse(Services.prefs.getStringPref(this.PREF, "{}")) || {};
    } catch (e) {
      return {};
    }
  },

  save(rules) {
    try {
      Services.prefs.setStringPref(this.PREF, JSON.stringify(rules));
    } catch (e) {}
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

  // ------------------------------------------------------------- new mail

  /** nsIMsgFolderListener */
  msgAdded(hdr) {
    try {
      const rules = this.rules();
      if (!Object.values(rules).some(r => r && r.action &&
                                          r.action !== "none")) {
        return;
      }
      // Only incoming mail in a real inbox: drafts, sent and the junk folder
      // itself have no business being re-sorted.
      const folder = hdr.folder;
      if (!folder || !folder.getFlag(Ci.nsMsgFolderFlags.Inbox)) {
        return;
      }
      this.judge(hdr, rules).catch(e =>
        Cu.reportError("hMail server filter: " + e));
    } catch (e) {}
  },

  async judge(hdr, rules) {
    if (typeof hMailInsight === "undefined") {
      return;
    }
    const raw = await hMailInsight.raw(hdr);
    const headers = hMailInsight.headers(raw);
    const verdict = hMailInsight.serverVerdict(headers);
    const auth = hMailInsight.authResults(headers);

    // Most specific first: a message classed as a virus should not be handled
    // by the milder spam rule just because it also scored high.
    const hits = [];
    if (verdict.virus) {
      hits.push("virus");
    }
    if (verdict.spam) {
      hits.push("spam");
    }
    if (/reject|drop|discard|quarantine/.test(verdict.action || "")) {
      hits.push("reject");
    }
    if (auth.spf === "fail" || auth.dmarc === "fail") {
      hits.push("authfail");
    }

    for (const id of hits) {
      const rule = rules[id];
      if (rule?.action && rule.action !== "none") {
        this.apply(hdr, rule, id);
        return;
      }
    }
  },

  apply(hdr, rule, id) {
    const folder = hdr.folder;
    try {
      switch (rule.action) {
        case "read":
          folder.markMessagesRead([hdr], true);
          break;

        case "junk":
          hdr.setStringProperty("junkscore", "100");
          hdr.setStringProperty("junkscoreorigin", "filter");
          folder.markMessagesRead([hdr], !!rule.markRead);
          this.moveTo(hdr, this.folderWithFlag(folder, Ci.nsMsgFolderFlags.Junk));
          break;

        case "delete":
          this.moveTo(hdr, this.folderWithFlag(folder,
                                               Ci.nsMsgFolderFlags.Trash));
          break;

        case "move":
          if (rule.target) {
            this.moveTo(hdr, MailServices.folderLookup.getFolderForURL(
              rule.target));
          }
          break;
      }
      this.log(`${id} → ${rule.action}: ${hdr.mime2DecodedSubject}`);
    } catch (e) {
      Cu.reportError("hMail server filter apply failed: " + e);
    }
  },

  folderWithFlag(from, flag) {
    try {
      return from.server.rootFolder.getFolderWithFlags(flag);
    } catch (e) {
      return null;
    }
  },

  moveTo(hdr, target) {
    if (!target || target.URI === hdr.folder.URI) {
      return;
    }
    MailServices.copy.copyMessages(
      hdr.folder, [hdr], target, true, null, null, false);
  },

  log(text) {
    try {
      Services.console.logStringMessage("hMail server filter: " + text);
    } catch (e) {}
  },

  // ------------------------------------------------------------------- tab

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
        tab.title = "Lọc theo máy chủ";
        tab.panel.classList.add("hmail-import-tab");
        tab.panel.appendChild(self.buildPanel(win));
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "Lọc theo máy chủ";
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
  },

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const rules = this.rules();

    const root = el("div", "hmail-import hmail-ai");
    root.appendChild(el("div", "hmail-import-title",
                        "Xử lý thư theo kết luận của máy chủ"));
    root.appendChild(el("div", "hmail-ai-hint",
      "Máy chủ thư đã lọc từng thư trước khi giao cho bạn và ghi kết luận " +
      "vào phần đầu thư. hMail đọc lại kết luận đó và làm theo lựa chọn của " +
      "bạn. Thư đã nằm trong hộp thư rồi nên không còn cách nào từ chối nó " +
      "nữa — việc còn lại chỉ là cất vào đâu."));

    const folders = this.writableFolders();

    for (const cls of this.CLASSES) {
      const rule = rules[cls.id] || {};
      const box = el("div", "hmail-filter-rule");
      box.appendChild(el("div", "hmail-filter-name", cls.label));
      box.appendChild(el("div", "hmail-ai-hint", cls.note));

      const row = el("div", "hmail-ai-row");
      const pick = el("select", "hmail-ai-field");
      for (const action of this.ACTIONS) {
        const opt = el("option", null, action.label);
        opt.value = action.id;
        pick.appendChild(opt);
      }
      pick.value = rule.action || "none";

      const target = el("select", "hmail-ai-field");
      for (const folder of folders) {
        const opt = el("option", null, folder.label);
        opt.value = folder.uri;
        target.appendChild(opt);
      }
      if (rule.target) {
        target.value = rule.target;
      }
      target.hidden = pick.value !== "move";

      const store = () => {
        const all = this.rules();
        all[cls.id] = { action: pick.value, target: target.value };
        this.save(all);
        target.hidden = pick.value !== "move";
      };
      pick.addEventListener("change", store);
      target.addEventListener("change", store);

      row.append(pick, target);
      box.appendChild(row);
      root.appendChild(box);
    }

    root.appendChild(el("div", "hmail-ai-hint",
      "Lựa chọn có hiệu lực với thư đến từ lúc này. Thư đã nằm trong hộp " +
      "thư không bị đụng tới."));
    return root;
  },

  writableFolders() {
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
        list.push({ uri: "", label: `【${server.prettyName}】` });
        for (const child of server.rootFolder.subFolders) {
          walk(child, 1);
        }
      } catch (e) {}
    }
    return list;
  },
};
