/* hMail Desktop — Lịch, Danh bạ và Tác vụ trên máy chủ
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Thunderbird can talk CalDAV and CardDAV, but only after someone types the
 * server address, the user name and the password again — three times, once per
 * collection. Mail accounts already know all three, and the server publishes
 * where its calendars and address books live, so hMail asks the server and
 * sets everything up itself.
 *
 * Discovery follows RFC 6764: /.well-known/caldav and /.well-known/carddav
 * lead to the user's principal, the principal names its home collections, and
 * the home lists what is in it. Nothing here is specific to one provider.
 *
 * Tasks need no separate work: a CalDAV calendar carries VTODO alongside
 * VEVENT, so the Tasks view fills in as soon as a calendar is registered.
 */

"use strict";

var hMailDav = {
  /** Accounts already set up, so a second run is quiet and cheap. */
  DONE_PREF: "hmail.dav.configured",
  AUTO_PREF: "hmail.dav.autoSetup",

  init(win) {
    try {
      if (!this.pref(this.AUTO_PREF, true)) {
        return;
      }
      // Wait for the accounts and the calendar service to be up.
      win.setTimeout(() => {
        this.setupAll(win, { quiet: true }).catch(e =>
          Cu.reportError("hMail DAV auto-setup failed: " + e));
      }, 8000);
    } catch (e) {
      Cu.reportError("hMail DAV init failed: " + e);
    }
  },

  pref(name, fallback) {
    try {
      return typeof fallback === "boolean"
        ? Services.prefs.getBoolPref(name)
        : Services.prefs.getCharPref(name);
    } catch (e) {
      return fallback;
    }
  },

  doneSet() {
    try {
      return new Set(JSON.parse(this.pref(this.DONE_PREF, "[]")));
    } catch (e) {
      return new Set();
    }
  },

  markDone(key) {
    const done = this.doneSet();
    done.add(key);
    try {
      Services.prefs.setCharPref(this.DONE_PREF,
                                 JSON.stringify([...done]));
    } catch (e) {}
  },

  // ------------------------------------------------------------- discovery

  auth(username, password) {
    return "Basic " + btoa(unescape(encodeURIComponent(
      `${username}:${password}`)));
  },

  /** One PROPFIND, parsed. Returns the XML document or null. */
  async propfind(url, depth, props, username, password) {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
      'xmlns:card="urn:ietf:params:xml:ns:carddav">' +
      `<d:prop>${props}</d:prop></d:propfind>`;
    let res;
    try {
      res = await fetch(url, {
        method: "PROPFIND",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: String(depth),
          Authorization: this.auth(username, password),
        },
        body,
      });
    } catch (e) {
      return null;
    }
    if (!res.ok) {
      return null;
    }
    try {
      return new DOMParser().parseFromString(await res.text(), "text/xml");
    } catch (e) {
      return null;
    }
  },

  /** Absolute URL for an href that may be a path. */
  resolve(base, href) {
    try {
      return new URL(href, base).href;
    } catch (e) {
      return null;
    }
  },

  /**
   * Walk RFC 6764 from a base address to the home collection.
   * `kind` is "caldav" or "carddav".
   */
  async findHome(base, kind, username, password) {
    const wellKnown = `${base.replace(/\/+$/, "")}/.well-known/${kind}`;
    const candidates = [wellKnown, `${base.replace(/\/+$/, "")}/dav/`, base];

    for (const start of candidates) {
      const doc = await this.propfind(
        start, 0, "<d:current-user-principal/>", username, password);
      const href = doc?.querySelector(
        "current-user-principal > href")?.textContent?.trim();
      if (!href) {
        continue;
      }
      const principal = this.resolve(start, href);
      const homeProp = kind === "caldav"
        ? "<c:calendar-home-set/>" : "<card:addressbook-home-set/>";
      const homeDoc = await this.propfind(
        principal, 0, homeProp, username, password);
      const homeHref = homeDoc?.querySelector(
        (kind === "caldav" ? "calendar-home-set" : "addressbook-home-set") +
        " > href")?.textContent?.trim();
      if (homeHref) {
        return this.resolve(principal, homeHref);
      }
    }
    return null;
  },

  /**
   * Collections inside a home. Scheduling inboxes and outboxes are the
   * server's own machinery, not something to show as a calendar.
   */
  async collections(home, kind, username, password) {
    const doc = await this.propfind(
      home, 1, "<d:resourcetype/><d:displayname/>", username, password);
    if (!doc) {
      return [];
    }
    const wanted = kind === "caldav" ? "calendar" : "addressbook";
    const found = [];
    for (const response of doc.querySelectorAll("response")) {
      const type = response.querySelector("resourcetype");
      if (!type || !type.querySelector(wanted)) {
        continue;
      }
      if (type.querySelector("schedule-inbox, schedule-outbox")) {
        continue;
      }
      const href = response.querySelector("href")?.textContent?.trim();
      if (!href) {
        continue;
      }
      const url = this.resolve(home, href);
      if (!url || url.replace(/\/+$/, "") === home.replace(/\/+$/, "")) {
        continue;
      }
      const name = response.querySelector("displayname")?.textContent?.trim();
      found.push({ url, name: name || decodeURIComponent(
        url.replace(/\/+$/, "").split("/").pop()) });
    }
    return found;
  },

  /** The realm the server asks for, so the saved password actually matches. */
  async realmOf(url) {
    try {
      const res = await fetch(url, { method: "OPTIONS" });
      const header = res.headers.get("WWW-Authenticate") || "";
      const m = /realm="([^"]*)"/i.exec(header);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  },

  // ------------------------------------------------------------ registering

  async addCalendars(found, username, password, label) {
    const { cal } = ChromeUtils.importESModule(
      "resource:///modules/calendar/calUtils.sys.mjs");
    let added = 0;

    for (const item of found) {
      const uri = Services.io.newURI(item.url);
      const already = cal.manager.getCalendars().some(
        c => c.uri && c.uri.spec.replace(/\/+$/, "") ===
             uri.spec.replace(/\/+$/, ""));
      if (already) {
        continue;
      }

      const realm = await this.realmOf(item.url);
      try {
        cal.auth.passwordManagerSave(username, password, uri.prePath, realm);
      } catch (e) {}

      const calendar = cal.manager.createCalendar("caldav", uri);
      calendar.name = found.length > 1 ? `${item.name} (${label})` : label;
      calendar.setProperty("username", username);
      // Without the cache the calendar is read straight off the network on
      // every view, which is slow and fails outright when offline.
      calendar.setProperty("cache.enabled", true);
      cal.manager.registerCalendar(calendar);
      added++;
    }
    return added;
  },

  async addAddressBooks(base, username, password) {
    const { CardDAVUtils } = ChromeUtils.importESModule(
      "resource:///modules/CardDAVUtils.sys.mjs");
    let added = 0;
    let books = [];
    try {
      books = await CardDAVUtils.detectAddressBooks(
        username, password, base, false);
    } catch (e) {
      return 0;
    }

    const existing = new Set();
    for (const book of MailServices.ab.directories) {
      try {
        const url = book.getStringValue("carddav.url", "");
        if (url) {
          existing.add(url.replace(/\/+$/, ""));
        }
      } catch (e) {}
    }

    for (const book of books) {
      if (existing.has(String(book.url).replace(/\/+$/, ""))) {
        continue;
      }
      try {
        await book.create();
        added++;
      } catch (e) {
        Cu.reportError("hMail DAV address book failed: " + e);
      }
    }
    return added;
  },

  // ----------------------------------------------------------------- entry

  /** Every mail account that has a password stored. */
  accounts() {
    const list = [];
    for (const server of MailServices.accounts.allServers) {
      if (!["imap", "pop3"].includes(server.type)) {
        continue;
      }
      list.push(server);
    }
    return list;
  },

  /**
   * The web address to start from. The mail host is the best guess — it is
   * where the DAV service usually lives — with the address domain as backup.
   */
  bases(server) {
    const out = [`https://${server.hostName}`];
    const at = String(server.username || "").split("@")[1];
    if (at && !out.includes(`https://${at}`)) {
      out.push(`https://${at}`);
      out.push(`https://mail.${at}`);
    }
    return out;
  },

  async setupServer(server) {
    const username = server.username;
    const password = server.password;
    if (!username || !password) {
      return { skipped: "chưa có mật khẩu được lưu" };
    }

    const label = server.prettyName || username;
    let calendars = 0;
    let books = 0;

    for (const base of this.bases(server)) {
      const calHome = await this.findHome(base, "caldav", username, password);
      if (calHome) {
        const found = await this.collections(
          calHome, "caldav", username, password);
        calendars += await this.addCalendars(found, username, password, label);
      }

      const cardHome = await this.findHome(
        base, "carddav", username, password);
      if (cardHome) {
        books += await this.addAddressBooks(base, username, password);
      }

      if (calHome || cardHome) {
        return { calendars, books, base };
      }
    }
    return { calendars, books, none: true };
  },

  async setupAll(win, { quiet = false } = {}) {
    const done = this.doneSet();
    const lines = [];
    let total = 0;

    for (const server of this.accounts()) {
      if (quiet && done.has(server.key)) {
        continue;
      }
      let result;
      try {
        result = await this.setupServer(server);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      const name = server.prettyName || server.username;

      if (result.error) {
        lines.push(`${name}: lỗi — ${result.error}`);
        continue;
      }
      if (result.skipped) {
        lines.push(`${name}: bỏ qua — ${result.skipped}`);
        continue;
      }
      if (result.none) {
        lines.push(`${name}: máy chủ không công bố CalDAV/CardDAV`);
        this.markDone(server.key);
        continue;
      }

      total += result.calendars + result.books;
      this.markDone(server.key);
      lines.push(`${name}: thêm ${result.calendars} lịch, ` +
                 `${result.books} sổ địa chỉ`);
    }

    if (!quiet) {
      Services.prompt.alert(win, "Đồng bộ Lịch & Danh bạ",
        lines.length ? lines.join("\n")
                     : "Không có tài khoản thư nào để thiết lập.");
    } else if (total) {
      Services.prompt.alert(win, "hMail Desktop",
        "Đã thiết lập lịch và danh bạ trên máy chủ:\n\n" +
        lines.join("\n") +
        "\n\nTác vụ dùng chung với lịch nên cũng đã sẵn sàng.");
    }
    return lines;
  },
};
