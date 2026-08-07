/* hMail Desktop — Outlook-style ribbon
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Injected into every mail:3pane window by hmail.cfg (autoconfig runs with
 * full chrome privileges, so no add-on is needed and omni.ja stays untouched).
 *
 * The ribbon is a presentation layer only: every button dispatches one of
 * Thunderbird's existing commands through goDoCommand(), the same mechanism
 * the menu bar uses, so behaviour always matches the host application. A
 * button whose command reports itself disabled is greyed out rather than
 * failing on click.
 *
 * Styling lives in the profile's chrome/custom.css (deployed alongside this
 * file), which is why icon URLs here are bare class names.
 */

"use strict";

/** about:import opens as a content tab; #tabId selects the wizard's step. */
function openImport(tabId) {
  return win => win.document.getElementById("tabmail")
    .openTab("contentTab", { url: `about:import#${tabId}` });
}

var hMailRibbon = {
  ID: "hmail-ribbon",
  ACTIVE_TAB_PREF: "hmail.ribbon.activeTab",

  /**
   * Ribbon definition. Each tab holds groups; each group holds buttons.
   *   cmd   - command passed to goDoCommand()
   *   fn    - alternative: a callback receiving the messenger window
   *   size  - "large" marks the command that gets the accent treatment
   *   icon  - maps to a background-image rule in custom.css
   */
  TABS: [
    {
      id: "home",
      label: "Trang đầu",
      contexts: ["mail"],
      groups: [
        {
          label: "Mới",
          buttons: [
            { id: "new-msg", label: "Email\nMới", icon: "new-mail", size: "large",
              cmd: "cmd_newMessage" },
            { id: "new-folder", label: "Thư mục\nMới", icon: "folder", size: "large",
              cmd: "cmd_newFolder" },
          ],
        },
        {
          label: "Xóa",
          buttons: [
            { id: "delete", label: "Xóa", icon: "trash", size: "large",
              cmd: "cmd_delete" },
            { id: "archive", label: "Lưu\ntrữ", icon: "archive", size: "large",
              cmd: "cmd_archive" },
            { id: "junk", label: "Thư\nrác", icon: "junk", size: "large",
              cmd: "cmd_markAsJunk" },
          ],
        },
        {
          label: "Trả lời",
          buttons: [
            { id: "reply", label: "Trả\nlời", icon: "reply", size: "large",
              cmd: "cmd_reply" },
            { id: "reply-all", label: "Trả lời\nTất cả", icon: "reply-all", size: "large",
              cmd: "cmd_replyall" },
            { id: "forward", label: "Chuyển\ntiếp", icon: "forward", size: "large",
              cmd: "cmd_forward" },
          ],
        },
        {
          label: "Thẻ",
          buttons: [
            { id: "mark-read", label: "Đánh dấu đã đọc", icon: "mail-read",
              cmd: "cmd_markAsRead" },
            { id: "mark-unread", label: "Đánh dấu chưa đọc", icon: "mail",
              cmd: "cmd_markAsUnread" },
            { id: "flag", label: "Gắn cờ theo dõi", icon: "flag",
              cmd: "cmd_markAsFlagged" },
          ],
        },
        {
          label: "Tìm",
          buttons: [
            { id: "addressbook", label: "Sổ Địa chỉ", icon: "contact",
              fn: win => win.toAddressBook() },
            { id: "filters", label: "Lọc Email", icon: "filter",
              fn: win => win.MsgFilters() },
            { id: "quick-filter", label: "Lọc nhanh", icon: "search",
              cmd: "cmd_toggleQuickFilterBar" },
          ],
        },
        {
          label: "Trợ lý",
          buttons: [
            // Pinned: the assistant is the one command that must never end up
            // behind the "···" menu, however narrow the window gets.
            { id: "ai-panel", label: "hMail\nAI", icon: "ai", size: "large",
              pin: true, fn: win => win.hMailAI.toggle(win) },
            { id: "local-ai", label: "AI trên máy", icon: "search",
              fn: win => win.hMailLocalAIUI.openTab(win) },
          ],
        },
        {
          label: "Bảo mật",
          buttons: [
            { id: "report-spam", label: "Báo cáo\nSpam", icon: "junk",
              fn: win => win.hMailSpam.reportSelected(win) },
            { id: "quarantine", label: "Thư bị giữ", icon: "inbox",
              fn: win => win.hMailSpam.openTab(win) },
          ],
        },
      ],
    },
    {
      id: "sendreceive",
      label: "Gửi / Nhận",
      contexts: ["mail"],
      groups: [
        {
          label: "Gửi/Nhận",
          buttons: [
            // cmd_getNewMessages fetches the selected folder's account;
            // cmd_getMsgsForAuthAccounts sweeps every account that can log
            // in. The two were the wrong way round, so "Tất cả" fetched one
            // account and "thư mục này" fetched all of them.
            { id: "get-all", label: "Gửi/Nhận\nTất cả", icon: "sync", size: "large",
              cmd: "cmd_getMsgsForAuthAccounts" },
            { id: "get-folder", label: "Nhận thư\nmục này", icon: "inbox", size: "large",
              cmd: "cmd_getNewMessages" },
            { id: "send-unsent", label: "Gửi thư\nchờ gửi", icon: "outbox", size: "large",
              cmd: "cmd_sendUnsentMsgs" },
          ],
        },
        {
          label: "Công cụ",
          buttons: [
            { id: "mail-merge-sr", label: "Gửi hàng\nloạt", icon: "contact",
              size: "large",
              fn: win => win.hMailMerge.openTab(win) },
          ],
        },
        {
          label: "Tài khoản",
          buttons: [
            // Adding a mailbox was reachable only from Settings, three levels
            // in. It is the first thing a new user needs and the thing an
            // existing one comes back for whenever they take on another
            // address, so it belongs on the tab about getting mail.
            { id: "acct-new", label: "Tài khoản\nmới", icon: "new-mail",
              size: "large", fn: win => hMailRibbon.newAccount(win) },
            { id: "acct-settings", label: "Cài đặt tài khoản", icon: "settings",
              fn: win => win.MsgAccountManager(null) },
          ],
        },
        {
          label: "Máy chủ",
          buttons: [
            { id: "offline", label: "Chế độ ngoại tuyến", icon: "more",
              fn: win => win.MailOfflineMgr.toggleOfflineStatus() },
          ],
        },
      ],
    },
    {
      id: "folder",
      label: "Thư mục",
      contexts: ["mail"],
      groups: [
        {
          label: "Tác vụ",
          buttons: [
            { id: "f-new", label: "Thư mục\nmới", icon: "folder", size: "large",
              cmd: "cmd_newFolder" },
            { id: "f-rename", label: "Đổi\ntên", icon: "templates", size: "large",
              cmd: "cmd_renameFolder" },
            { id: "f-delete", label: "Xóa\nthư mục", icon: "trash", size: "large",
              cmd: "cmd_deleteFolder" },
          ],
        },
        {
          label: "Dọn dẹp",
          buttons: [
            { id: "f-compact", label: "Nén thư mục", icon: "drafts",
              cmd: "cmd_compactFolder" },
            { id: "f-empty-trash", label: "Dọn thùng rác", icon: "trash",
              cmd: "cmd_emptyTrash" },
            { id: "f-properties", label: "Thuộc tính", icon: "settings",
              cmd: "cmd_properties" },
          ],
        },
      ],
    },
    {
      id: "view",
      label: "Xem",
      contexts: ["mail"],
      groups: [
        {
          label: "Bố cục",
          buttons: [
            { id: "v-vertical", label: "Dọc", icon: "list", size: "large",
              cmd: "cmd_viewVerticalMailLayout" },
            { id: "v-classic", label: "Cổ\nđiển", icon: "list", size: "large",
              cmd: "cmd_viewClassicMailLayout" },
            { id: "v-wide", label: "Rộng", icon: "list", size: "large",
              cmd: "cmd_viewWideMailLayout" },
          ],
        },
        {
          label: "Danh sách thư",
          buttons: [
            { id: "v-cards", label: "Dạng thẻ", icon: "mail",
              cmd: "cmd_threadPaneViewCards" },
            { id: "v-table", label: "Dạng bảng", icon: "list",
              cmd: "cmd_threadPaneViewTable" },
          ],
        },
        {
          label: "Ngăn",
          buttons: [
            { id: "v-folderpane", label: "Ngăn thư mục", icon: "folder",
              fn: win => {
                const pane = win.document.getElementById("tabmail")
                  ?.currentAbout3Pane?.document?.getElementById("folderPane");
                const splitter = win.document.getElementById("tabmail")
                  ?.currentAbout3Pane?.document?.getElementById("folderPaneSplitter");
                if (splitter) {
                  splitter.toggleAttribute("collapsed");
                } else if (pane) {
                  pane.hidden = !pane.hidden;
                }
              } },
            // Thunderbird's Unified Folders ("smart" folder mode): one
            // Inbox/Sent/Trash tree across every account. The stock UI only
            // offers it from the folder-pane gear menu, which the ribbon
            // replaced — so it gets a first-class toggle here.
            { id: "v-unified", label: "Hộp thư hợp nhất", icon: "folder",
              fn: win => {
                try {
                  const fp = win.document.getElementById("tabmail")
                    ?.currentAbout3Pane?.folderPane;
                  if (!fp) {
                    return;
                  }
                  const active = fp.activeModes;
                  fp.activeModes = active.includes("smart")
                    ? active.filter(m => m !== "smart")
                    : [...active, "smart"];
                } catch (e) {
                  Cu.reportError("hMail unified toggle failed: " + e);
                }
              } },
          ],
        },
      ],
    },
    {
      id: "calendar",
      label: "Lịch",
      contexts: ["calendar", "tasks"],
      groups: [
        {
          label: "Mới",
          buttons: [
            { id: "c-new-event", label: "Sự kiện\nmới", icon: "calendar", size: "large",
              cmd: "calendar_new_event_command" },
            { id: "c-new-task", label: "Công việc\nmới", icon: "tasks", size: "large",
              cmd: "calendar_new_todo_command" },
            { id: "c-new-cal", label: "Lịch\nmới", icon: "folder", size: "large",
              cmd: "calendar_new_calendar_command" },
          ],
        },
        {
          label: "Họp trực tuyến",
          buttons: [
            { id: "c-meet", label: "Họp\nMeet", icon: "calendar-col", size: "large",
              fn: win => win.hMailMeet.createMeet(win) },
            { id: "c-teams", label: "Họp\nTeams", icon: "chat-col", size: "large",
              fn: win => win.hMailMeet.createTeams(win) },
          ],
        },
        {
          label: "Sự kiện",
          buttons: [
            { id: "c-edit", label: "Sửa", icon: "templates",
              cmd: "calendar_modify_event_command" },
            { id: "c-delete", label: "Xóa", icon: "trash",
              cmd: "calendar_delete_event_command" },
            { id: "c-today", label: "Hôm nay", icon: "calendar",
              // goToDate and cal only exist once the calendar tab has loaded.
              fn: win => {
                if (typeof win.goToDate === "function" && win.cal?.dtz?.now) {
                  win.goToDate(win.cal.dtz.now());
                }
              } },
          ],
        },
        {
          label: "Dữ liệu",
          buttons: [
            { id: "c-import", label: "Nhập lịch", icon: "import",
              cmd: "calendar_import_command" },
            { id: "c-export", label: "Xuất lịch", icon: "outbox",
              cmd: "calendar_export_command" },
            { id: "c-props", label: "Thuộc tính lịch", icon: "settings",
              cmd: "calendar_edit_calendar_command" },
          ],
        },
      ],
    },
    {
      id: "contacts",
      label: "Danh bạ",
      contexts: ["addressbook"],
      groups: [
        {
          label: "Mới",
          buttons: [
            // The address book is a page of its own and these are its own
            // functions, not window commands: cmd_createContact never
            // existed anywhere, so that button did nothing at all.
            { id: "a-new-contact", label: "Liên hệ\nmới", icon: "contact", size: "large",
              fn: win => hMailRibbon.inAddressBook(win, ab => ab.createContact()) },
            { id: "a-new-list", label: "Danh sách\nmới", icon: "list", size: "large",
              fn: win => hMailRibbon.inAddressBook(win, ab => ab.createList()) },
            { id: "a-new-book", label: "Sổ địa chỉ\nmới", icon: "book", size: "large",
              fn: win => hMailRibbon.inAddressBook(win, ab => ab.createBook()) },
          ],
        },
        {
          label: "Tác vụ",
          buttons: [
            // The card pane's own buttons, clicked from here: the address
            // book answers these by element id, not through a controller.
            { id: "a-compose", label: "Viết thư", icon: "new-mail",
              fn: win => hMailRibbon.clickInAddressBook(win, "detailsWriteButton") },
            { id: "a-edit", label: "Sửa liên hệ", icon: "templates",
              fn: win => hMailRibbon.clickInAddressBook(win, "editButton") },
            { id: "a-delete", label: "Xóa", icon: "trash",
              fn: win => hMailRibbon.clickInAddressBook(win, "detailsDeleteButton") },
          ],
        },
        {
          label: "Dữ liệu",
          buttons: [
            { id: "a-import", label: "Nhập danh bạ", icon: "import",
              fn: openImport("addressBook") },
            { id: "a-export", label: "Xuất danh bạ", icon: "outbox",
              fn: openImport("export") },
          ],
        },
      ],
    },
    {
      id: "help",
      label: "Trợ giúp",
      contexts: ["mail", "calendar", "tasks", "addressbook"],
      groups: [
        {
          label: "hMail Desktop",
          buttons: [
            { id: "h-about", label: "Giới thiệu\nhMail", icon: "mail", size: "large",
              fn: win => win.openAboutDialog() },
            { id: "h-update", label: "Kiểm tra\ncập nhật", icon: "import",
              size: "large",
              fn: win => win.hMailUpdate.check(win, true) },
            { id: "h-github", label: "Trang\nGitHub", icon: "extention", size: "large",
              fn: win => win.openLinkExternally("https://github.com/haoquangviet/hMail-Desktop") },
          ],
        },
        {
          // Importing and setting up sync are things done once, when moving
          // in — they belong beside the other setup commands, not on the tab
          // used every day.
          label: "Chuyển dữ liệu vào hMail",
          buttons: [
            { id: "import-outlook", label: "Nhập từ\nOutlook", icon: "import",
              size: "large", fn: win => win.hMailImport.openTab(win) },
            { id: "import-other", label: "Nhập hồ sơ khác", icon: "import",
              fn: openImport("app") },
            { id: "import-contacts", label: "Nhập danh bạ", icon: "contact",
              fn: openImport("addressBook") },
            { id: "import-calendar", label: "Nhập lịch", icon: "calendar",
              fn: openImport("calendar") },
            { id: "export-data", label: "Xuất dữ liệu", icon: "outbox",
              fn: openImport("export") },
            { id: "dav-sync", label: "Đồng bộ Lịch & Danh bạ",
              icon: "calendar",
              fn: win => win.hMailDav.setupAll(win, { quiet: false }) },
            { id: "google-sync", label: "Đồng bộ Google", icon: "sync",
              fn: win => win.hMailGSync.setupAll(win, { quiet: false }) },
          ],
        },
        {
          label: "Cài đặt",
          buttons: [
            { id: "h-settings", label: "Tùy chọn", icon: "settings",
              fn: win => win.openPreferencesTab() },
            { id: "h-local-ai", label: "AI trên máy", icon: "ai",
              fn: win => win.hMailLocalAIUI.openTab(win) },
            { id: "h-server-filter", label: "Lọc theo máy chủ", icon: "filter",
              fn: win => win.hMailServerFilter.openTab(win) },
            { id: "h-flow", label: "Tự động hoá AI", icon: "ai",
              fn: win => win.hMailFlowUI.openTab(win) },
            { id: "h-diag", label: "Gỡ lỗi kết nối", icon: "sync",
              fn: win => win.hMailDiag.openTab(win) },
          ],
        },
      ],
    },
  ],

  /**
   * Add a mailbox. Thunderbird 140 has two front ends for this: the newer
   * account hub dialog, behind a preference, and the older setup tab. Try the
   * hub, fall back to the tab — the tab is what the application itself opens
   * on a profile with no accounts, so it is always there.
   */
  newAccount(win) {
    try {
      if (typeof win.openAccountHub === "function") {
        win.openAccountHub("MAIL");
        return;
      }
    } catch (e) {}
    try {
      win.document.getElementById("tabmail")
        .openTab("contentTab", { url: "about:accountsetup" });
    } catch (e) {
      Cu.reportError("hMail: không mở được trang thêm tài khoản: " + e);
    }
  },

  init(win) {
    try {
      const doc = win.document;
      if (doc.getElementById(this.ID)) {
        return;
      }
      const anchor = doc.getElementById("navigation-toolbox") ||
                     doc.getElementById("tabmail-tabs")?.parentNode;
      if (!anchor) {
        return;
      }

      const ribbon = this.build(win, doc);
      anchor.appendChild(ribbon);

      // Refresh enabled/disabled state whenever the selection or folder changes.
      const refresh = () => this.updateState(win, doc);
      win.addEventListener("MsgLoaded", refresh);
      win.addEventListener("folderURIChanged", refresh);
      doc.addEventListener("click", refresh, true);
      win.setTimeout(refresh, 1500);

      // Outlook's ribbon is contextual: it shows the commands of whatever you
      // are looking at, and gets out of the way where none apply.
      const applyContext = () => {
        this.applyContext(win, doc);
        refresh();
        this.updateOverflow(win, doc);
      };
      win.addEventListener("resize", () => this.updateOverflow(win, doc));
      const tabmail = doc.getElementById("tabmail");
      if (tabmail) {
        tabmail.addEventListener("TabSelect", applyContext);
        tabmail.addEventListener("TabOpen", applyContext);
        tabmail.addEventListener("TabClose", applyContext);
      }
      // Those events do not fire for every way a tab can become current
      // (the spaces toolbar and account-setup flows switch tabs without them),
      // so also watch the current tab directly. Reading currentTabInfo is
      // cheap, and the work only happens when the mode actually changed.
      let lastMode = null;
      win.setInterval(() => {
        const mode = tabmail?.currentTabInfo?.mode?.name || "";
        if (mode !== lastMode) {
          lastMode = mode;
          applyContext();
        }
      }, 400);
      win.setTimeout(applyContext, 800);
    } catch (e) {
      Cu.reportError("hMail ribbon init failed: " + e);
    }
  },

  build(win, doc) {
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (tag, cls) => {
      const n = doc.createElementNS(NS, tag);
      if (cls) {
        n.className = cls;
      }
      return n;
    };

    const root = el("div");
    root.id = this.ID;

    const tabStrip = el("div", "hmail-ribbon-tabs");
    const panes = el("div", "hmail-ribbon-panes");

    // Buttons flagged "pin" leave their group and are repeated at the
    // right-hand end of every tab, so the assistant is one click away
    // wherever the user is and however narrow the window gets.
    const pinnedDefs = this.TABS.flatMap(t =>
      t.groups.flatMap(g => g.buttons.filter(b => b.pin)));

    const makeButton = btn => {
      const b = el("button", "hmail-ribbon-button" +
                   (btn.size === "large" ? " large" : " small"));
      b.dataset.icon = btn.icon || "";
      b.dataset.id = btn.id;
      if (btn.cmd) {
        b.dataset.cmd = btn.cmd;
      }

      const icon = el("span", "hmail-ribbon-icon");
      const label = el("span", "hmail-ribbon-label");
      // "\n" in a label is Outlook's two-line big button.
      label.textContent = btn.label.replace(/\n/g, " ");
      label.setAttribute("data-multiline", btn.label.includes("\n"));
      if (btn.label.includes("\n")) {
        label.textContent = "";
        for (const line of btn.label.split("\n")) {
          const s = el("span", "hmail-ribbon-line");
          s.textContent = line;
          label.appendChild(s);
        }
      }
      b.append(icon, label);

      b.addEventListener("command", e => e.stopPropagation());
      b.addEventListener("click", () => this.run(win, btn));
      return b;
    };

    let activeTab = "home";
    try {
      activeTab = Services.prefs.getCharPref(this.ACTIVE_TAB_PREF);
    } catch (e) {}

    for (const tab of this.TABS) {
      const tabButton = el("button", "hmail-ribbon-tab");
      tabButton.textContent = tab.label;
      tabButton.dataset.tab = tab.id;

      const pane = el("div", "hmail-ribbon-pane");
      pane.dataset.tab = tab.id;

      for (const group of tab.groups) {
        const groupEl = el("div", "hmail-ribbon-group");
        const items = el("div", "hmail-ribbon-group-items");

        // Simplified ribbon: one row of icon + label commands, so no column
        // splitting — every button goes straight into the group.

        for (const btn of group.buttons) {
          if (btn.pin) {
            continue;
          }
          items.appendChild(makeButton(btn));
        }

        // A group whose every button was pinned would render as an empty box
        // with a caption under it.
        if (!items.hasChildNodes()) {
          continue;
        }

        const groupLabel = el("div", "hmail-ribbon-group-label");
        groupLabel.textContent = group.label;
        groupEl.append(items, groupLabel);
        pane.appendChild(groupEl);
      }

      if (pinnedDefs.length) {
        const pinned = el("div", "hmail-ribbon-pinned");
        for (const btn of pinnedDefs) {
          pinned.appendChild(makeButton(btn));
        }
        pane.appendChild(pinned);
      }

      tabButton.addEventListener("click", () => this.selectTab(doc, tab.id));
      tabStrip.appendChild(tabButton);
      panes.appendChild(pane);
    }

    // Search lives in the ribbon, because Thunderbird's own toolbar — the only
    // other place it could go — is hidden: the ribbon replaces it entirely.
    const search = el("input", "hmail-ribbon-search");
    search.type = "search";
    search.placeholder = "Tìm kiếm thư…";
    search.addEventListener("keydown", event => {
      if (event.key !== "Enter") {
        return;
      }
      const term = search.value.trim();
      if (!term) {
        return;
      }
      // Shift+Enter asks the on-device model instead, the way Shift changes
      // what Enter means everywhere else in hMail.
      if (event.shiftKey) {
        this.searchMeaning(win, term);
      } else {
        this.search(win, term);
      }
    });
    tabStrip.appendChild(search);

    // Only offered when there is a model to ask.
    const meaning = el("button", "hmail-ribbon-meaning");
    meaning.textContent = "≈";
    meaning.title = "Tìm theo ý nghĩa bằng AI trên máy (Shift+Enter)";
    meaning.hidden = true;
    meaning.addEventListener("click", () => {
      const term = search.value.trim();
      if (term) {
        this.searchMeaning(win, term);
      }
    });
    tabStrip.appendChild(meaning);
    win.setTimeout(() => {
      try {
        meaning.hidden = !win.hMailLocalAI?.enabled();
        search.placeholder = meaning.hidden
          ? "Tìm kiếm thư…"
          : "Tìm kiếm thư… (Shift+Enter: theo ý nghĩa)";
      } catch (e) {}
    }, 1500);

    // Collapse/expand, like Outlook's ribbon chevron.
    const toggle = el("button", "hmail-ribbon-toggle");
    toggle.title = "Thu gọn / mở rộng thanh lệnh";
    toggle.addEventListener("click", () => {
      root.classList.toggle("collapsed");
    });
    tabStrip.appendChild(toggle);

    root.append(tabStrip, panes);
    // Defer selection until the nodes are in the document.
    win.setTimeout(() => this.selectTab(doc, activeTab), 0);
    return root;
  },

  /**
   * Which set of commands applies to the tab currently in front.
   *
   * @returns {"mail"|"calendar"|"tasks"|"addressbook"|"other"}
   */
  currentContext(doc) {
    const mode = doc.getElementById("tabmail")?.currentTabInfo?.mode?.name || "";
    if (mode.startsWith("mail3Pane") || mode.startsWith("mailMessage")) {
      return "mail";
    }
    if (mode === "calendar") {
      return "calendar";
    }
    if (mode === "tasks") {
      return "tasks";
    }
    if (mode.startsWith("addressBook")) {
      return "addressbook";
    }
    // Settings, add-ons manager, web content: nothing here belongs to them.
    return "other";
  },

  applyContext(win, doc) {
    const root = doc.getElementById(this.ID);
    if (!root) {
      return;
    }
    const context = this.currentContext(doc);
    const applicable = this.TABS.filter(t => (t.contexts || []).includes(context));

    // No commands for this kind of tab: hide the ribbon rather than showing
    // mail actions over a settings page.
    root.hidden = applicable.length === 0;
    if (root.hidden) {
      return;
    }

    const ids = new Set(applicable.map(t => t.id));
    for (const t of root.querySelectorAll(".hmail-ribbon-tab")) {
      t.hidden = !ids.has(t.dataset.tab);
    }
    for (const p of root.querySelectorAll(".hmail-ribbon-pane")) {
      if (!ids.has(p.dataset.tab)) {
        p.classList.remove("selected");
      }
    }

    // Keep the current tab if it still applies, otherwise fall back to the
    // first one that does.
    const selected = root.querySelector(".hmail-ribbon-tab.selected:not([hidden])");
    if (!selected) {
      this.selectTab(doc, applicable[0].id, { remember: false });
    }
  },

  /**
   * Narrow windows cannot show every group. Hide the ones that do not fit and
   * offer them from a "…" menu, the way Outlook collapses its ribbon.
   */
  updateOverflow(win, doc) {
    const root = doc.getElementById(this.ID);
    const pane = root?.querySelector(".hmail-ribbon-pane.selected");
    if (!pane) {
      return;
    }

    let overflow = pane.querySelector(".hmail-ribbon-overflow");
    if (!overflow) {
      overflow = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      overflow.className = "hmail-ribbon-overflow";
      overflow.title = "Lệnh khác";
      overflow.textContent = "···";
      overflow.addEventListener("click", () => this.showOverflow(win, doc, pane, overflow));
      // Before the pinned box, so the pinned commands stay flush right.
      pane.insertBefore(overflow, pane.querySelector(".hmail-ribbon-pinned"));
    }

    const groups = [...pane.querySelectorAll(".hmail-ribbon-group")];
    for (const g of groups) {
      g.hidden = false;
    }
    overflow.hidden = true;

    // What actually has to fit: the groups, the "···" button, and the pinned
    // commands, which never move. Measuring scrollWidth is not enough — the
    // pinned box carries an auto margin that eats the slack and hides the
    // overflow from the measurement.
    const pinned = pane.querySelector(".hmail-ribbon-pinned");
    const budget = () =>
      pane.clientWidth - (pinned?.getBoundingClientRect().width || 0) - 40;
    const used = () => groups.reduce(
      (sum, g) => sum + (g.hidden ? 0 : g.getBoundingClientRect().width), 0);

    // Trim from the end until the row fits; the first group is always kept.
    for (let i = groups.length - 1; i >= 1; i--) {
      if (used() <= budget()) {
        break;
      }
      groups[i].hidden = true;
      overflow.hidden = false;
    }
  },

  showOverflow(win, doc, pane, anchor) {
    let popup = doc.getElementById("hmail-ribbon-overflow-popup");
    if (!popup) {
      popup = doc.createXULElement("menupopup");
      popup.id = "hmail-ribbon-overflow-popup";
      (doc.getElementById("mainPopupSet") || doc.documentElement).appendChild(popup);
    }
    while (popup.firstChild) {
      popup.firstChild.remove();
    }

    for (const group of pane.querySelectorAll(".hmail-ribbon-group[hidden]")) {
      if (popup.hasChildNodes()) {
        popup.appendChild(doc.createXULElement("menuseparator"));
      }
      for (const b of group.querySelectorAll(".hmail-ribbon-button")) {
        const item = doc.createXULElement("menuitem");
        item.setAttribute("label", b.textContent.trim());
        if (b.hasAttribute("disabled")) {
          item.setAttribute("disabled", "true");
        }
        item.addEventListener("command", () => b.click());
        popup.appendChild(item);
      }
    }
    popup.openPopup(anchor, "after_end", 0, 0, false, false);
  },

  selectTab(doc, tabId, { remember = true } = {}) {
    const root = doc.getElementById(this.ID);
    if (!root) {
      return;
    }
    for (const t of root.querySelectorAll(".hmail-ribbon-tab")) {
      t.classList.toggle("selected", t.dataset.tab === tabId);
    }
    for (const p of root.querySelectorAll(".hmail-ribbon-pane")) {
      p.classList.toggle("selected", p.dataset.tab === tabId);
    }
    root.classList.remove("collapsed");
    doc.defaultView?.setTimeout(
      () => this.updateOverflow(doc.defaultView, doc), 0);
    if (remember) {
      try {
        Services.prefs.setCharPref(this.ACTIVE_TAB_PREF, tabId);
      } catch (e) {}
    }
  },

  /**
   * Full-text search across all messages, opening the same results tab the
   * stock global search bar uses.
   */
  search(win, term) {
    try {
      const { GlodaMsgSearcher } = ChromeUtils.importESModule(
        "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
      );
      win.document.getElementById("tabmail").openTab("glodaFacet", {
        searcher: new GlodaMsgSearcher(null, term),
      });
    } catch (e) {
      Cu.reportError("hMail ribbon search failed: " + e);
    }
  },

  /**
   * The same box, asked a different question. Keyword search finds the words
   * you typed; the on-device model finds messages that mean what you typed,
   * which is what you want when you remember the gist and not the wording.
   *
   * They are offered side by side rather than merged: a result list that
   * silently mixes "contains these words" with "is about this" cannot be
   * reasoned about, and the two are useful at different moments.
   */
  searchMeaning(win, term) {
    try {
      if (!win.hMailLocalAI?.enabled()) {
        win.hMailLocalAIUI?.openTab(win);
        return;
      }
      win.hMailLocalAIUI.openTab(win);
      win.setTimeout(() => {
        const box = win.document.getElementById("hmail-localai-query");
        if (box) {
          box.value = term;
          win.hMailLocalAIUI.search(win);
        }
      }, 300);
    } catch (e) {
      Cu.reportError("hMail semantic search failed: " + e);
    }
  },

  /**
   * Run a command wherever its controller happens to live.
   *
   * goDoCommand() asks the focused element's dispatcher, and in this version
   * the message list is a document inside a browser of its own: with focus
   * in there, the outer window's controller — the one holding Get Messages,
   * Send Unsent and the rest — is never consulted and the click does nothing
   * at all. So each layer is asked in turn, starting with the focused one so
   * context-sensitive commands still behave as they do from the menus.
   */
  dispatch(win, cmd) {
    const tryController = controller => {
      try {
        if (controller && controller.isCommandEnabled(cmd)) {
          controller.doCommand(cmd);
          return true;
        }
      } catch (e) {}
      return false;
    };
    const fromWindow = w => {
      try {
        return w?.controllers?.getControllerForCommand(cmd) || null;
      } catch (e) {
        return null;
      }
    };

    try {
      if (tryController(
            win.document.commandDispatcher.getControllerForCommand(cmd))) {
        return true;
      }
    } catch (e) {}
    if (tryController(fromWindow(win))) {
      return true;
    }
    const tabmail = win.document.getElementById("tabmail");
    for (const inner of [tabmail?.currentAbout3Pane,
                         tabmail?.currentAboutMessage,
                         tabmail?.currentTabInfo?.browser?.contentWindow]) {
      if (tryController(fromWindow(inner))) {
        return true;
      }
    }
    // Last resort: the original call, so nothing that used to work stops.
    try {
      win.goDoCommand(cmd);
      return true;
    } catch (e) {}
    return false;
  },

  /** The address-book page, when that is the tab in front. */
  addressBookWindow(win) {
    try {
      const inner = win.document.getElementById("tabmail")
        ?.currentTabInfo?.browser?.contentWindow;
      return String(inner?.location?.href || "").startsWith("about:addressbook")
        ? inner : null;
    } catch (e) {
      return null;
    }
  },

  inAddressBook(win, fn) {
    const ab = this.addressBookWindow(win);
    if (!ab) {
      return;
    }
    try {
      fn(ab);
    } catch (e) {
      Cu.reportError("hMail ribbon: address book action failed: " + e);
    }
  },

  clickInAddressBook(win, id) {
    this.inAddressBook(win, ab => {
      const node = ab.document.getElementById(id);
      if (node && !node.disabled && !node.hidden) {
        node.click();
      }
    });
  },

  run(win, btn) {
    try {
      if (btn.cmd) {
        this.dispatch(win, btn.cmd);
        return;
      }
      if (btn.fn) {
        // Real callbacks rather than strings: a chrome window's eval() is not
        // a dependable way to reach messenger globals.
        btn.fn(win);
      }
    } catch (e) {
      Cu.reportError(`hMail ribbon: "${btn.id}" failed: ${e}`);
    }
  },

  updateState(win, doc) {
    const root = doc.getElementById(this.ID);
    if (!root) {
      return;
    }
    for (const b of root.querySelectorAll(".hmail-ribbon-button[data-cmd]")) {
      let enabled = true;
      try {
        const cmd = b.dataset.cmd;
        const tabmail = win.document.getElementById("tabmail");
        const candidates = [];
        try {
          candidates.push(win.top.document.commandDispatcher
            .getControllerForCommand(cmd));
        } catch (e) {}
        for (const w of [win, tabmail?.currentAbout3Pane,
                         tabmail?.currentAboutMessage]) {
          try {
            candidates.push(w?.controllers?.getControllerForCommand(cmd));
          } catch (e) {}
        }
        // Enabled anywhere means the click will land somewhere.
        enabled = candidates.some(c => {
          try {
            return c && c.isCommandEnabled(cmd);
          } catch (e) {
            return false;
          }
        });
      } catch (e) {
        enabled = true; // never disable a button just because probing failed
      }
      b.toggleAttribute("disabled", !enabled);
    }
  },
};
