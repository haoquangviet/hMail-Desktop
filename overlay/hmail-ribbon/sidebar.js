/* hMail Desktop — right-hand AI sidebar
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * The bundled assistant opens its chat with browser.windows.create({type:
 * "popup"}), which lands as a floating window. Outlook-style assistants dock
 * to the right of the window instead, and stay available while you work rather
 * than only while a message is open.
 *
 * Rather than patching the add-on's messaging (which would break every time it
 * is rebuilt), this watches for the popup the add-on opens, takes the URL it
 * was going to show, and loads it into a docked panel instead. The page keeps
 * running in the extension's own context, so all of its functionality — the
 * call id it was handed, its access to the selected message — is unaffected.
 */

"use strict";

var hMailSidebar = {
  ID: "hmail-ai-sidebar",
  SPLITTER_ID: "hmail-ai-splitter",
  BROWSER_ID: "hmail-ai-browser",
  WIDTH_PREF: "hmail.sidebar.width",
  OPEN_PREF: "hmail.sidebar.open",

  /** Extension pages that belong in the sidebar rather than a window. */
  DOCKABLE: /moz-extension:\/\/[^/]+\/(api_webchat|pages)\//,

  init(win) {
    try {
      this.build(win);
      this.watchPopups(win);
    } catch (e) {
      Cu.reportError("hMail sidebar init failed: " + e);
    }
  },

  build(win) {
    const doc = win.document;
    if (doc.getElementById(this.ID)) {
      return;
    }
    const tabmail = doc.getElementById("tabmail");
    if (!tabmail || !tabmail.parentNode) {
      return;
    }

    // Plain splitter: the default behaviour resizes the elements either side.
    // "collapse" made dragging past the edge collapse the panel instead of
    // resizing it, and naming resize targets explicitly stopped it entirely.
    const splitter = doc.createXULElement("splitter");
    splitter.id = this.SPLITTER_ID;
    splitter.hidden = true;

    const panel = doc.createXULElement("vbox");
    panel.id = this.ID;
    panel.hidden = true;
    let width = 420;
    try {
      width = Services.prefs.getIntPref(this.WIDTH_PREF);
    } catch (e) {}
    // Both are needed: the attribute is what the splitter drives, the inline
    // style is what stops content from widening the panel.
    panel.setAttribute("width", String(width));
    panel.style.width = `${width}px`;

    // Header: title plus a close button, like Outlook's task panes.
    const header = doc.createXULElement("hbox");
    header.className = "hmail-sidebar-header";
    const title = doc.createXULElement("label");
    title.className = "hmail-sidebar-title";
    title.setAttribute("value", "hMail AI");
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    const close = doc.createXULElement("toolbarbutton");
    close.className = "hmail-sidebar-close";
    close.setAttribute("tooltiptext", "Đóng");
    close.addEventListener("command", () => this.hide(win));
    close.addEventListener("click", () => this.hide(win));
    header.append(title, spacer, close);

    // These attributes mirror the <browser> in Thunderbird's own
    // extensionPopup.xhtml, which is what successfully hosts add-on pages.
    const browser = doc.createXULElement("browser");
    browser.id = this.BROWSER_ID;
    browser.setAttribute("type", "content");
    browser.setAttribute("nodefaultsrc", "true");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("messagemanagergroup", "single-site");
    browser.setAttribute("webextension-view-type", "sidebar");
    browser.setAttribute("context", "browserContext");
    browser.setAttribute("flex", "1");

    panel.append(header, browser);
    tabmail.parentNode.insertBefore(splitter, tabmail.nextSibling);
    tabmail.parentNode.insertBefore(panel, splitter.nextSibling);

    // Remember the width the user drags it to. The splitter writes the width
    // attribute, so mirror it into the inline style and the pref when the drag
    // ends.
    const remember = () => {
      try {
        const w = parseInt(panel.getAttribute("width"), 10) ||
                  Math.round(panel.getBoundingClientRect().width);
        if (w > 100) {
          panel.style.width = `${w}px`;
          Services.prefs.setIntPref(this.WIDTH_PREF, w);
        }
      } catch (e) {}
    };
    splitter.addEventListener("mouseup", remember);
    splitter.addEventListener("command", remember);
    win.addEventListener("mouseup", remember);
  },

  /**
   * Show caller-supplied chrome DOM in the panel instead of a web page. Used
   * by features whose UI must stay privileged — the quarantine list talks to
   * an API with a bearer token that has no business entering a content page.
   */
  showNode(win, node, title) {
    const doc = win.document;
    this.build(win);
    const panel = doc.getElementById(this.ID);
    const splitter = doc.getElementById(this.SPLITTER_ID);
    const browser = doc.getElementById(this.BROWSER_ID);
    if (!panel) {
      return false;
    }
    if (browser) {
      browser.hidden = true;
    }
    for (const old of panel.querySelectorAll(".hmail-sidebar-content")) {
      old.remove();
    }
    node.classList.add("hmail-sidebar-content");
    panel.appendChild(node);
    this.setTitle(doc, title);
    panel.hidden = false;
    splitter.hidden = false;
    try {
      Services.prefs.setBoolPref(this.OPEN_PREF, true);
    } catch (e) {}
    return true;
  },

  setTitle(doc, title) {
    const label = doc.querySelector(`#${this.ID} .hmail-sidebar-title`);
    if (label && title) {
      label.setAttribute("value", title);
    }
  },

  /**
   * Web pages must not run in the parent process.
   *
   * The panel's <browser> is created without a process type, which leaves it
   * non-remote — fine for the extension pages and null-principal documents it
   * has carried so far, but it would put a whole website inside Thunderbird's
   * own process, with the sandbox gone. So the process is chosen from the URL
   * before each load: http(s) goes to a content process, everything else keeps
   * the behaviour it had.
   */
  applyRemoteness(browser, url) {
    const wanted = /^https?:/i.test(url || "") ? "web" : null;
    try {
      if ((browser.remoteType || null) === wanted) {
        return;
      }
      if (browser.frameLoader && browser.changeRemoteness) {
        browser.changeRemoteness({ remoteType: wanted });
        return;
      }
      // Nothing has loaded yet: the attributes still decide.
      if (wanted) {
        browser.setAttribute("remote", "true");
        browser.setAttribute("remoteType", wanted);
      } else {
        browser.removeAttribute("remote");
        browser.removeAttribute("remoteType");
      }
    } catch (e) {
      Cu.reportError("hMail sidebar remoteness switch failed: " + e);
    }
  },

  show(win, url, title) {
    const doc = win.document;
    this.build(win);
    const panel = doc.getElementById(this.ID);
    const splitter = doc.getElementById(this.SPLITTER_ID);
    const browser = doc.getElementById(this.BROWSER_ID);
    if (!panel || !browser) {
      return false;
    }
    for (const old of panel.querySelectorAll(".hmail-sidebar-content")) {
      old.remove();
    }
    browser.hidden = false;
    this.setTitle(doc, title || "hMail AI");
    panel.hidden = false;
    splitter.hidden = false;
    if (url) {
      // Defer to the next tick: a <browser> only accepts a load once the
      // frame loader exists, which is after it has been laid out.
      win.setTimeout(() => {
        try {
          this.applyRemoteness(browser, url);
          // A web page is not something hMail vouches for, so it is not
          // loaded on the system principal either.
          const web = /^https?:/i.test(url);
          browser.fixupAndLoadURIString(url, {
            triggeringPrincipal: web
              ? Services.scriptSecurityManager.createNullPrincipal({})
              : Services.scriptSecurityManager.getSystemPrincipal(),
          });
        } catch (e) {
          Cu.reportError("hMail sidebar load failed: " + e);
        }
      }, 0);
    }
    try {
      Services.prefs.setBoolPref(this.OPEN_PREF, true);
    } catch (e) {}
    return true;
  },

  hide(win) {
    const doc = win.document;
    const panel = doc.getElementById(this.ID);
    const splitter = doc.getElementById(this.SPLITTER_ID);
    if (panel) {
      panel.hidden = true;
    }
    if (splitter) {
      splitter.hidden = true;
    }
    try {
      Services.prefs.setBoolPref(this.OPEN_PREF, false);
    } catch (e) {}
  },

  toggle(win) {
    const panel = win.document.getElementById(this.ID);
    if (panel && !panel.hidden) {
      this.hide(win);
      return;
    }

    // Always open the panel. An earlier version delegated to the add-on's own
    // toolbar button instead, which opens its own anchored popup — so the
    // sidebar never appeared at all.
    this.show(win, this.assistantUrl("popup/mzta-popup.html"), "hMail AI");
  },

  /**
   * Click the assistant's message-display-action button, wherever Thunderbird
   * has put it. Returns true if it was found and clicked.
   */
  clickAssistantAction(win) {
    const id = "hmail-ai_hqvsoftware_com-messageDisplayAction-toolbarbutton";
    const docs = [];
    try {
      const about3Pane = win.document.getElementById("tabmail")?.currentAbout3Pane;
      const messageDoc = about3Pane?.messageBrowser?.contentDocument;
      if (messageDoc) {
        docs.push(messageDoc);
      }
      const tabDoc =
        win.document.getElementById("tabmail")?.currentTabInfo?.browser
          ?.contentDocument;
      if (tabDoc) {
        docs.push(tabDoc);
      }
    } catch (e) {}
    docs.push(win.document);

    for (const doc of docs) {
      const button = doc.getElementById(id) ||
        doc.querySelector("[id*='messageDisplayAction-toolbarbutton']");
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  },

  assistantUrl(path) {
    try {
      const policy = WebExtensionPolicy.getByID("hmail-ai@hqvsoftware.com");
      return policy ? policy.getURL(path) : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Catch the add-on's popup windows and dock them instead.
   */
  watchPopups(win) {
    const observer = {
      observe: (subject, topic) => {
        if (topic !== "domwindowopened") {
          return;
        }
        const popup = subject;
        // Park the window off-screen before it can paint, so docking it does
        // not flash a window at the user. If it turns out not to be dockable
        // it gets moved back.
        let parked = null;
        try {
          parked = { x: popup.screenX, y: popup.screenY };
          popup.moveTo(-32000, -32000);
        } catch (e) {}

        popup.addEventListener("load", () => {
          try {
            this.maybeDock(win, popup, parked);
          } catch (e) {
            Cu.reportError("hMail sidebar dock failed: " + e);
            this.unpark(popup, parked);
          }
        }, { once: true });
      },
    };
    Services.ww.registerNotification(observer);
    win.addEventListener("unload", () => {
      Services.ww.unregisterNotification(observer);
    }, { once: true });
  },

  /** Put a parked window back where it was meant to be. */
  unpark(popup, parked) {
    if (!parked || popup.closed) {
      return;
    }
    try {
      popup.moveTo(parked.x, parked.y);
    } catch (e) {}
  },

  maybeDock(win, popup, parked) {
    // Only extension popup windows are candidates.
    const type = popup.document?.documentElement?.getAttribute("windowtype");
    if (type && type !== "mail:extensionPopup") {
      this.unpark(popup, parked);
      return;
    }

    // At the load event the inner browser is still on about:blank — the real
    // URL arrives a tick or two later — so poll briefly for it rather than
    // reading once and giving up.
    let tries = 0;
    const check = () => {
      if (popup.closed) {
        return;
      }
      const inner = popup.document.querySelector(
        "browser#requestFrame, browser[type='content']"
      );
      const url = inner?.currentURI?.spec || inner?.getAttribute("src") || "";

      if (url && url !== "about:blank") {
        // Dock chat surfaces only; option pages and dialogs stay as windows.
        if (url.includes("/api_webchat/") && this.show(win, url, "hMail AI")) {
          popup.close();
        } else {
          this.unpark(popup, parked);
        }
        return;
      }
      if (++tries < 25) {
        win.setTimeout(check, 200);
      } else {
        this.unpark(popup, parked);
      }
    };
    check();
  },
};
