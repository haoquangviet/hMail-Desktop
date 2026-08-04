/* hMail Desktop — Họp trực tuyến (Google Meet, Microsoft Teams)
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * CalDAV carries events but not conference links: Meet links exist only in
 * the Google Calendar REST API, Teams links only in Microsoft Graph. Both
 * Both APIs accept a token the account already holds: Google's calendar
 * scope, granted with the mail sign-in, covers the REST API as well as
 * CalDAV, while Teams needs the Graph scopes on HQV's own Azure app. Either
 * way, creating a meeting is one authorized POST. The event lands in the account's calendar, the CalDAV copy in the
 * app catches up on its next refresh, and the join link goes straight to
 * the clipboard.
 */

"use strict";

var hMailMeet = {
  // -------------------------------------------------------------- accounts

  accountsWhere(match) {
    const list = [];
    for (const server of MailServices.accounts.allServers) {
      if (!["imap", "pop3"].includes(server.type)) {
        continue;
      }
      const host = String(server.hostName || "").toLowerCase();
      const user = String(server.username || "").toLowerCase();
      if (!match(host, user)) {
        continue;
      }
      let email = server.username;
      if (!String(email).includes("@")) {
        const account = MailServices.accounts.findAccountForServer(server);
        email = account?.defaultIdentity?.email || null;
      }
      if (email && !list.includes(email)) {
        list.push(email);
      }
    }
    return list;
  },

  googleAccounts() {
    return this.accountsWhere((host, user) =>
      host.endsWith("gmail.com") || host.endsWith("googlemail.com") ||
      host.endsWith("google.com") ||
      user.endsWith("@gmail.com") || user.endsWith("@googlemail.com"));
  },

  microsoftAccounts() {
    return this.accountsWhere((host, user) =>
      host.endsWith("office365.com") || host.endsWith("outlook.com") ||
      /@(outlook|hotmail|live|msn)\./.test(user));
  },

  /** One account is used as-is; several become a picker. Null on cancel. */
  pick(win, emails, service) {
    if (emails.length === 1) {
      return emails[0];
    }
    const selected = {};
    const ok = Services.prompt.select(
      win, `Họp ${service}`, "Tạo cuộc họp từ tài khoản nào?",
      emails, selected);
    return ok ? emails[selected.value] : null;
  },

  // ----------------------------------------------------------------- oauth

  token(hostname, email, type) {
    const { OAuth2Module } = ChromeUtils.importESModule(
      "resource:///modules/OAuth2Module.sys.mjs");
    const mod = new OAuth2Module();
    if (!mod.initFromHostname(hostname, email, type)) {
      return Promise.reject(
        new Error("OAuth chưa được cấu hình cho " + hostname));
    }
    return new Promise((resolve, reject) => {
      mod.getAccessToken({
        onSuccess: t => resolve(t),
        onFailure: () => reject(
          new Error("bạn chưa cấp quyền cho hMail Desktop")),
      });
    });
  },

  // ------------------------------------------------------------------ time

  /** Next full half-hour, 30 minutes long, as UTC ISO strings. */
  slot() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 30 - (start.getMinutes() % 30));
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  },

  ask(win, service) {
    const value = { value: "Cuộc họp " + service };
    const ok = Services.prompt.prompt(
      win, `Họp ${service}`,
      "Tên cuộc họp (bắt đầu ở nửa giờ tới, dài 30 phút — sửa lại " +
      "trong Lịch nếu cần):",
      value, null, {});
    return ok && value.value.trim() ? value.value.trim() : null;
  },

  // ------------------------------------------------------------------ REST

  async post(url, token, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err.error?.message || err.error_description || "";
      } catch (e) {}
      throw new Error(`máy chủ trả về ${res.status} ${detail}`.trim());
    }
    return res.json();
  },

  finish(win, service, title, link) {
    if (!link) {
      Services.prompt.alert(win, `Họp ${service}`,
        `Đã tạo sự kiện "${title}" nhưng máy chủ chưa trả về đường dẫn ` +
        "tham gia. Mở sự kiện trong Lịch để xem chi tiết.");
      return;
    }
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper).copyString(link);
    } catch (e) {}
    Services.prompt.alert(win, `Họp ${service}`,
      `Đã tạo "${title}".\n\n${link}\n\nĐường dẫn đã được sao chép — ` +
      "dán vào thư mời là xong. Sự kiện sẽ hiện trong Lịch ở lần đồng " +
      "bộ tới.");
  },

  // ----------------------------------------------------------------- entry

  async createMeet(win) {
    try {
      const emails = this.googleAccounts();
      if (!emails.length) {
        Services.prompt.alert(win, "Họp Google Meet",
          "Chưa có tài khoản Google nào trong hMail. Thêm tài khoản Gmail " +
          "trước rồi thử lại.");
        return;
      }
      const email = this.pick(win, emails, "Google Meet");
      if (!email) {
        return;
      }
      const title = this.ask(win, "Google Meet");
      if (!title) {
        return;
      }
      const token = await this.token(
        "apidata.googleusercontent.com", email, "caldav");
      const { start, end } = this.slot();
      const event = await this.post(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
        "?conferenceDataVersion=1",
        token, {
          summary: title,
          start: { dateTime: start, timeZone: "UTC" },
          end: { dateTime: end, timeZone: "UTC" },
          conferenceData: {
            createRequest: {
              requestId: "hmail-" + Date.now() + "-" +
                Math.floor(Math.random() * 1e6),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        });
      const link = event.hangoutLink ||
        event.conferenceData?.entryPoints?.find(
          p => p.entryPointType === "video")?.uri;
      this.finish(win, "Google Meet", title, link);
    } catch (e) {
      Services.prompt.alert(win, "Họp Google Meet",
        "Không tạo được cuộc họp: " + (e.message || e));
    }
  },

  async createTeams(win) {
    try {
      const emails = this.microsoftAccounts();
      if (!emails.length) {
        Services.prompt.alert(win, "Họp Microsoft Teams",
          "Chưa có tài khoản Microsoft nào trong hMail. Thêm tài khoản " +
          "Outlook/Microsoft 365 trước rồi thử lại.");
        return;
      }
      const email = this.pick(win, emails, "Microsoft Teams");
      if (!email) {
        return;
      }
      const title = this.ask(win, "Microsoft Teams");
      if (!title) {
        return;
      }
      const token = await this.token("graph.microsoft.com", email, "graph");
      const { start, end } = this.slot();
      let event = await this.post(
        "https://graph.microsoft.com/v1.0/me/events", token, {
          subject: title,
          start: { dateTime: start, timeZone: "UTC" },
          end: { dateTime: end, timeZone: "UTC" },
          isOnlineMeeting: true,
          onlineMeetingProvider: "teamsForBusiness",
        });
      let link = event.onlineMeeting?.joinUrl;
      if (!link && event.id) {
        // Graph fills the join link in a beat after the event is created.
        await new Promise(r => win.setTimeout(r, 2000));
        const res = await fetch(
          "https://graph.microsoft.com/v1.0/me/events/" +
          encodeURIComponent(event.id) + "?$select=onlineMeeting,webLink",
          { headers: { Authorization: "Bearer " + token } });
        if (res.ok) {
          event = await res.json();
          link = event.onlineMeeting?.joinUrl;
        }
      }
      this.finish(win, "Microsoft Teams", title, link);
    } catch (e) {
      Services.prompt.alert(win, "Họp Microsoft Teams",
        "Không tạo được cuộc họp: " + (e.message || e));
    }
  },
};
