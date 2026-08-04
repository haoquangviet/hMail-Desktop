/* hMail Desktop — Đồng bộ Lịch và Danh bạ Google
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Google publishes CalDAV and CardDAV like everyone else, but behind OAuth
 * instead of a password, so the generic auto-setup in davsync.js walks past
 * Gmail accounts without finding anything. This module picks those accounts
 * up: it borrows the OAuth machinery the mail side already uses (the issuer
 * "hmail-google-dav" registered in OAuth2Providers carries hMail's own
 * client), asks Google which calendars the user has, and registers each one
 * as an ordinary CalDAV calendar. Thunderbird's CalDAV code then owns the
 * sync — two directions, offline cache, reminders — and the Google address
 * book arrives through the stock CardDAV support the same way.
 *
 * The first run opens Google's consent window once; the refresh token lands
 * in the password manager and every later run is silent.
 */

"use strict";

var hMailGSync = {
  DONE_PREF: "hmail.gsync.configured",
  AUTO_PREF: "hmail.gsync.autoSetup",
  CALDAV_HOST: "apidata.googleusercontent.com",
  CARDDAV_BASE: "https://www.googleapis.com",

  init(win) {
    try {
      if (!this.pref(this.AUTO_PREF, true)) {
        return;
      }
      // After davsync's pass, so the two prompts never stack.
      win.setTimeout(() => {
        this.setupAll(win, { quiet: true }).catch(e =>
          Cu.reportError("hMail GSync auto-setup failed: " + e));
      }, 15000);
    } catch (e) {
      Cu.reportError("hMail GSync init failed: " + e);
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

  // -------------------------------------------------------------- accounts

  isGoogleServer(server) {
    const host = String(server.hostName || "").toLowerCase();
    const user = String(server.username || "").toLowerCase();
    return host.endsWith("gmail.com") || host.endsWith("googlemail.com") ||
           host.endsWith("google.com") ||
           user.endsWith("@gmail.com") || user.endsWith("@googlemail.com");
  },

  /** The address Google knows the account by. */
  emailOf(server) {
    if (String(server.username).includes("@")) {
      return server.username;
    }
    const account = MailServices.accounts.findAccountForServer(server);
    return account?.defaultIdentity?.email || null;
  },

  accounts() {
    const list = [];
    for (const server of MailServices.accounts.allServers) {
      if (!["imap", "pop3"].includes(server.type)) {
        continue;
      }
      if (!this.isGoogleServer(server)) {
        continue;
      }
      const email = this.emailOf(server);
      if (email) {
        list.push({ server, email });
      }
    }
    return list;
  },

  // ----------------------------------------------------------------- oauth

  /**
   * A live access token for the DAV scopes, prompting through Google's
   * consent window when no refresh token is stored yet.
   */
  token(email) {
    const { OAuth2Module } = ChromeUtils.importESModule(
      "resource:///modules/OAuth2Module.sys.mjs");
    const mod = new OAuth2Module();
    if (!mod.initFromHostname(this.CALDAV_HOST, email, "caldav")) {
      return Promise.reject(
        new Error("OAuth cho Google chưa được cấu hình trong bản dựng này"));
    }
    return new Promise((resolve, reject) => {
      mod.getAccessToken({
        onSuccess: t => resolve(t),
        onFailure: () => reject(
          new Error("người dùng chưa cấp quyền truy cập lịch Google")),
      });
    });
  },

  // ------------------------------------------------------------- discovery

  async propfind(url, depth, props, token) {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
      'xmlns:a="http://apple.com/ns/ical/">' +
      `<d:prop>${props}</d:prop></d:propfind>`;
    let res;
    try {
      res = await fetch(url, {
        method: "PROPFIND",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: String(depth),
          Authorization: "Bearer " + token,
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

  resolve(base, href) {
    try {
      return new URL(href, base).href;
    } catch (e) {
      return null;
    }
  },

  /**
   * Every calendar in the account, primary and shared alike.
   * Falls back to the primary calendar when enumeration fails.
   */
  async calendars(email, token) {
    const root = `https://${this.CALDAV_HOST}/caldav/v2/`;
    const primary = {
      url: root + encodeURIComponent(email) + "/events/",
      name: email,
      color: null,
      readOnly: false,
    };

    const principal = root + encodeURIComponent(email) + "/user";
    const homeDoc = await this.propfind(
      principal, 0, "<c:calendar-home-set/>", token);
    const homeHref = homeDoc?.querySelector(
      "calendar-home-set > href")?.textContent?.trim();
    const home = homeHref
      ? this.resolve(principal, homeHref)
      : root + encodeURIComponent(email) + "/";

    const doc = await this.propfind(
      home, 1,
      "<d:displayname/><d:resourcetype/><a:calendar-color/>" +
      "<d:current-user-privilege-set/>",
      token);
    if (!doc) {
      return [primary];
    }

    const found = [];
    for (const r of doc.querySelectorAll("multistatus > response")) {
      if (!r.querySelector("resourcetype > calendar")) {
        continue;
      }
      const href = r.querySelector("href")?.textContent?.trim();
      const url = href && this.resolve(home, href);
      if (!url) {
        continue;
      }
      const priv = r.querySelector("current-user-privilege-set");
      found.push({
        url,
        name: r.querySelector("displayname")?.textContent?.trim() || email,
        color: r.querySelector("calendar-color")?.textContent?.trim() || null,
        // No privilege data means Google withheld it; assume writable and
        // let the server say no to an actual change.
        readOnly: !!priv && !priv.querySelector("write"),
      });
    }
    return found.length ? found : [primary];
  },

  // ---------------------------------------------------------- registration

  addCalendars(items, email) {
    let added = 0;
    for (const item of items) {
      const uri = Services.io.newURI(item.url);
      const already = cal.manager.getCalendars().some(
        c => c.uri && c.uri.spec.replace(/\/+$/, "") ===
             uri.spec.replace(/\/+$/, ""));
      if (already) {
        continue;
      }
      const calendar = cal.manager.createCalendar("caldav", uri);
      calendar.name = item.name;
      calendar.setProperty("username", email);
      calendar.setProperty("cache.enabled", true);
      if (item.color && /^#[0-9a-fA-F]{6}/.test(item.color)) {
        calendar.setProperty("color", item.color.slice(0, 7));
      }
      if (item.readOnly) {
        calendar.setProperty("readOnly", true);
      }
      cal.manager.registerCalendar(calendar);
      added++;
    }
    return added;
  },

  async addAddressBooks(email) {
    const { CardDAVUtils } = ChromeUtils.importESModule(
      "resource:///modules/CardDAVUtils.sys.mjs");
    let books = [];
    try {
      // CardDAVUtils sees a Google hostname and swaps Basic auth for the
      // same OAuth client the calendars use.
      books = await CardDAVUtils.detectAddressBooks(
        email, "", this.CARDDAV_BASE, false);
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

    let added = 0;
    for (const book of books) {
      if (existing.has(String(book.url).replace(/\/+$/, ""))) {
        continue;
      }
      try {
        await book.create();
        added++;
      } catch (e) {
        Cu.reportError("hMail GSync address book failed: " + e);
      }
    }
    return added;
  },

  // ----------------------------------------------------------------- entry

  async setupAll(win, { quiet = false } = {}) {
    const done = this.doneSet();
    const lines = [];
    let total = 0;

    const accounts = this.accounts();
    for (const { server, email } of accounts) {
      if (quiet && done.has(server.key)) {
        continue;
      }
      const name = server.prettyName || email;
      let token;
      try {
        token = await this.token(email);
      } catch (e) {
        // The quiet pass asks exactly once; declining the consent window
        // should not turn every start-up into a nag. The ribbon button
        // remains for whenever the user changes their mind.
        if (quiet) {
          this.markDone(server.key);
        }
        lines.push(`${name}: bỏ qua — ${e.message}`);
        continue;
      }

      let calendars = 0;
      let books = 0;
      try {
        calendars = this.addCalendars(await this.calendars(email, token),
                                      email);
      } catch (e) {
        lines.push(`${name}: lỗi lịch — ${e.message || e}`);
      }
      try {
        books = await this.addAddressBooks(email);
      } catch (e) {
        lines.push(`${name}: lỗi danh bạ — ${e.message || e}`);
      }

      this.markDone(server.key);
      total += calendars + books;
      lines.push(`${name}: thêm ${calendars} lịch, ${books} sổ địa chỉ`);
    }

    if (!quiet) {
      Services.prompt.alert(win, "Đồng bộ Google",
        lines.length ? lines.join("\n")
                     : "Không tìm thấy tài khoản Google nào trong hMail.");
    } else if (total) {
      Services.prompt.alert(win, "hMail Desktop",
        "Đã kết nối lịch và danh bạ Google:\n\n" + lines.join("\n"));
    }
    return lines;
  },
};
