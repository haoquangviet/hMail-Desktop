/* hMail Desktop — Outlook-style ribbon
 * MIT License, Copyright (c) 2026 HQV Software
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
            { id: "ai-panel", label: "hMail\nAI", icon: "ai", size: "large",
              fn: win => win.hMailAI.toggle(win) },
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
        {
          // Migrating from Outlook is the first thing a new user does, so it
          // sits on the Home tab rather than buried in a menu.
          label: "Chuyển từ Outlook",
          buttons: [
            { id: "import-outlook", label: "Nhập từ\nOutlook", icon: "import",
              size: "large", fn: openImport("app") },
            { id: "import-contacts", label: "Nhập danh bạ", icon: "contact",
              fn: openImport("addressBook") },
            { id: "import-calendar", label: "Nhập lịch", icon: "calendar",
              fn: openImport("calendar") },
            { id: "export-data", label: "Xuất dữ liệu", icon: "outbox",
              fn: openImport("export") },
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
            { id: "get-all", label: "Gửi/Nhận\nTất cả", icon: "sync", size: "large",
              cmd: "cmd_getNewMessages" },
            { id: "get-folder", label: "Nhận thư\nmục này", icon: "inbox", size: "large",
              cmd: "cmd_getMsgsForAuthAccounts" },
            { id: "send-unsent", label: "Gửi thư\nchờ gửi", icon: "outbox", size: "large",
              fn: win => win.SendUnsentMessages() },
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
          label: "Thư mục",
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
            { id: "a-new-contact", label: "Liên hệ\nmới", icon: "contact", size: "large",
              cmd: "cmd_createContact" },
            { id: "a-new-list", label: "Danh sách\nmới", icon: "list", size: "large",
              cmd: "cmd_createList" },
            { id: "a-new-book", label: "Sổ địa chỉ\nmới", icon: "book", size: "large",
              cmd: "cmd_createAddressBook" },
          ],
        },
        {
          label: "Tác vụ",
          buttons: [
            { id: "a-compose", label: "Viết thư", icon: "new-mail",
              cmd: "cmd_compose" },
            { id: "a-delete", label: "Xóa", icon: "trash",
              cmd: "cmd_delete" },
            { id: "a-print", label: "In", icon: "list",
              cmd: "cmd_print" },
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
            { id: "h-github", label: "Trang\nGitHub", icon: "extention", size: "large",
              fn: win => win.openLinkExternally("https://github.com/haoquangviet/hMail-Desktop") },
          ],
        },
        {
          label: "Cài đặt",
          buttons: [
            { id: "h-settings", label: "Tùy chọn", icon: "settings",
              fn: win => win.openPreferencesTab() },
            { id: "h-addons", label: "Tiện ích", icon: "extention",
              fn: win => win.openAddonsMgr("addons://list/extension") },
          ],
        },
      ],
    },
  ],

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
          items.appendChild(b);
        }

        const groupLabel = el("div", "hmail-ribbon-group-label");
        groupLabel.textContent = group.label;
        groupEl.append(items, groupLabel);
        pane.appendChild(groupEl);
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
      if (term) {
        this.search(win, term);
      }
    });
    tabStrip.appendChild(search);

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
      pane.appendChild(overflow);
    }

    const groups = [...pane.querySelectorAll(".hmail-ribbon-group")];
    for (const g of groups) {
      g.hidden = false;
    }
    overflow.hidden = true;

    // Trim from the end until the row fits; the first group is always kept.
    for (let i = groups.length - 1; i >= 1; i--) {
      if (pane.scrollWidth <= pane.clientWidth + 1) {
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

  run(win, btn) {
    try {
      if (btn.cmd) {
        win.goDoCommand(btn.cmd);
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
        const controller = win.top.document.commandDispatcher
          .getControllerForCommand(b.dataset.cmd);
        enabled = !!controller && controller.isCommandEnabled(b.dataset.cmd);
      } catch (e) {
        enabled = true; // never disable a button just because probing failed
      }
      b.toggleAttribute("disabled", !enabled);
    }
  },
};
