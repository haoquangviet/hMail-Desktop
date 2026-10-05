/* hMail Desktop — đồng bộ mật khẩu SMTP theo IMAP/POP3
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Ca thật: khách gửi SMTP thất bại từng đợt ("Không thể đăng nhập vào tài
 * khoản…", 3 nút Thử lại / Nhập mật khẩu mới / Hủy bỏ), trong khi POP3 cùng
 * tài khoản đăng nhập đều đặn mỗi vài phút không lỗi. Nhật ký máy chủ khớp:
 * cùng một kết nối SMTP, 2 lần AUTH thất bại rồi lần 3 mới qua — máy chủ
 * nhận đúng/sai y hệt lúc được test trực tiếp. Tức là mật khẩu LƯU cho SMTP
 * trong Thunderbird lệch với mật khẩu LƯU cho IMAP/POP3 của cùng tài khoản
 * (đổi mật khẩu hộp thư nhưng chỉ sửa một chỗ, hoặc account wizard lưu lệch
 * nhau lúc tạo) — nơi còn đăng nhập được (IMAP/POP3) là nơi giữ mật khẩu
 * đúng hiện tại.
 *
 * Trước mỗi lần gửi: so hai mật khẩu đã lưu trong login manager (cùng
 * username, cùng máy chủ) — khác nhau thì chép mật khẩu IMAP/POP3 sang cho
 * SMTP rồi mới để Thunderbird gửi tiếp. Không đoán mò khi SMTP dùng OAuth2,
 * không đoán mò khi hai nơi là hai username khác nhau (relay qua tài khoản
 * khác là chủ đích, không phải lỗi).
 */

"use strict";

var hMailSmtpAuth = {
  PREF_ENABLED: "hmail.smtpauth.syncPassword",

  initCompose(win) {
    try {
      if (win._hmailSmtpAuthInit) {
        return;
      }
      win._hmailSmtpAuthInit = true;
      // Trước khi Thunderbird dựng kết nối thật — cùng thời điểm tracking.js
      // gắn header, đã chứng minh chạy đồng bộ kịp trước lúc gửi.
      win.addEventListener("compose-send-message", () => {
        try {
          this.syncForWindow(win);
        } catch (e) {
          Cu.reportError("hMail smtpauth: đồng bộ thất bại: " + e);
        }
      }, true);
    } catch (e) {
      Cu.reportError("hMail smtpauth init failed: " + e);
    }
  },

  enabled() {
    try {
      return Services.prefs.getBoolPref(this.PREF_ENABLED);
    } catch (e) {
      return true;
    }
  },

  syncForWindow(win) {
    if (!this.enabled()) {
      return;
    }
    const identity = win.gCurrentIdentity || win.getCurrentIdentity?.();
    if (identity) {
      this.syncForIdentity(identity);
    }
  },

  accountOf(identity) {
    try {
      for (const account of MailServices.accounts.accounts) {
        if (account.identities.some(i => i.key === identity.key)) {
          return account;
        }
      }
    } catch (e) {}
    return null;
  },

  /** origin dùng trong login manager cho incoming server — như hMailAI.serverPassword. */
  incomingLoginFor(server) {
    try {
      if (!server || !["imap", "pop3"].includes(server.type)) {
        return null;
      }
      const scheme = server.type === "pop3" ? "mailbox" : server.type;
      const origin = `${scheme}://${server.hostName}`;
      const logins = Services.logins.findLogins(origin, null, origin);
      return logins.find(l => l.username === server.username) ||
             logins[0] || null;
    } catch (e) {
      return null;
    }
  },

  smtpLoginFor(smtpServer) {
    try {
      const origin = `smtp://${smtpServer.hostname}`;
      const logins = Services.logins.findLogins(origin, null, origin);
      return logins.find(l => l.username === smtpServer.username) ||
             logins[0] || null;
    } catch (e) {
      return null;
    }
  },

  syncForIdentity(identity) {
    try {
      const account = this.accountOf(identity);
      if (!account) {
        return;
      }
      const incomingLogin = this.incomingLoginFor(account.incomingServer);
      if (!incomingLogin || !incomingLogin.password) {
        return;
      }

      const smtpKey = identity.smtpServerKey;
      if (!smtpKey) {
        return;
      }
      const smtpServer = MailServices.outgoingServer
        .getServerByKey(smtpKey)?.QueryInterface(Ci.nsISmtpServer);
      if (!smtpServer) {
        return;
      }
      // OAuth2 không có "mật khẩu" để lệch — đụng vào chỉ phá luồng token.
      try {
        if (smtpServer.authMethod === Ci.nsMsgAuthMethod.OAuth2) {
          return;
        }
      } catch (e) {}

      const smtpLogin = this.smtpLoginFor(smtpServer);
      // Chưa từng lưu mật khẩu SMTP riêng — không có gì để đối chiếu, khỏi
      // đoán mò (lần đầu nhập thì để Thunderbird tự hỏi như bình thường).
      if (!smtpLogin) {
        return;
      }
      if (smtpLogin.username !== incomingLogin.username) {
        return; // Khác tài khoản thật (relay qua nơi khác) — chủ đích.
      }
      if (smtpLogin.password === incomingLogin.password) {
        return; // Đã khớp sẵn.
      }

      const newLogin = Cc["@mozilla.org/login-manager/loginInfo;1"]
        .createInstance(Ci.nsILoginInfo);
      newLogin.init(smtpLogin.origin, smtpLogin.formActionOrigin,
                     smtpLogin.httpRealm, smtpLogin.username,
                     incomingLogin.password, smtpLogin.usernameField,
                     smtpLogin.passwordField);
      Services.logins.modifyLogin(smtpLogin, newLogin);
      // server.password chỉ là cache trong phiên (xem hMailAI.serverPassword)
      // — xoá để lần gửi này đọc lại đúng bản vừa sửa thay vì bản cũ còn giữ.
      try {
        smtpServer.password = "";
      } catch (e) {}
      Cu.reportError(
        "hMail smtpauth: mật khẩu SMTP lệch IMAP/POP3 cho " +
        smtpLogin.username + " (" + smtpServer.hostname +
        ") — đã đồng bộ lại trước khi gửi.");
    } catch (e) {
      Cu.reportError("hMail smtpauth sync failed: " + e);
    }
  },
};
