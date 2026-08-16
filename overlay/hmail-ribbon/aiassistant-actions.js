/* hMail Desktop — actions the AI assistant can take
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * The assistant can do things, not just talk: file a message, tag it, mark it,
 * or open a reply with a draft already written. Implemented with the model's
 * function-calling support — the model asks for an action, this code performs
 * it against Thunderbird and reports the result back so the model can carry on.
 *
 * Everything runs locally with the user's own privileges. Nothing is executed
 * that the user could not do from the interface, and destructive actions ask
 * first.
 */

"use strict";

Object.assign(hMailAI, {
  /** Declarations sent to the model. Keep names and wording stable. */
  TOOLS: [
    {
      name: "mark_read",
      description: "Đánh dấu thư hiện tại là đã đọc hoặc chưa đọc.",
      parameters: {
        type: "object",
        properties: {
          read: { type: "boolean", description: "true = đã đọc, false = chưa đọc" },
        },
        required: ["read"],
      },
    },
    {
      name: "flag_message",
      description: "Gắn hoặc bỏ cờ theo dõi cho thư hiện tại.",
      parameters: {
        type: "object",
        properties: {
          flagged: { type: "boolean" },
        },
        required: ["flagged"],
      },
    },
    {
      name: "add_tag",
      description: "Gắn nhãn cho thư hiện tại. Nhãn sẽ được tạo nếu chưa có.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Tên nhãn, ví dụ: Khách hàng" },
        },
        required: ["tag"],
      },
    },
    {
      name: "list_folders",
      description: "Liệt kê các thư mục của tài khoản đang xem, để biết có " +
                   "thể chuyển thư vào đâu.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "move_to_folder",
      description: "Chuyển thư hiện tại sang một thư mục. Hãy gọi " +
                   "list_folders trước nếu chưa chắc tên thư mục.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Tên thư mục đích" },
        },
        required: ["folder"],
      },
    },
    {
      name: "archive_message",
      description: "Lưu trữ thư hiện tại.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "mark_junk",
      description: "Đánh dấu thư hiện tại là thư rác và chuyển vào Thư rác.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "compose_reply",
      description: "Mở cửa sổ trả lời cho thư hiện tại với nội dung soạn sẵn. " +
                   "Thư KHÔNG được gửi đi — người dùng sẽ xem lại rồi tự gửi.",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "Nội dung thư trả lời" },
          reply_all: { type: "boolean", description: "Trả lời tất cả" },
        },
        required: ["body"],
      },
    },
    {
      name: "search_messages",
      description: "Tìm thư trong Hộp thư đến của MỌI tài khoản: theo từ " +
                   "khoá (người gửi/tiêu đề), số ngày gần đây, có thể chỉ " +
                   "lấy thư chưa đọc. Trả về danh sách {id, from, subject, " +
                   "date, unread, folder}. Dùng khi người dùng hỏi về thư " +
                   "từ, việc cần làm, thư mới… mà chưa mở thư nào.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string",
                   description: "Từ khoá lọc người gửi/tiêu đề; bỏ trống " +
                                "để lấy tất cả" },
          days: { type: "number",
                  description: "Chỉ lấy thư trong N ngày gần đây (mặc định 7)" },
          unread_only: { type: "boolean",
                         description: "true = chỉ thư chưa đọc" },
          limit: { type: "number", description: "Tối đa bao nhiêu thư (mặc định 20)" },
        },
      },
    },
    {
      name: "read_message",
      description: "Đọc nội dung một thư theo id lấy từ search_messages — " +
                   "không cần mở thư trên màn hình. Dùng để tóm tắt hay " +
                   "trả lời câu hỏi về thư đó.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "id thư từ search_messages" },
        },
        required: ["id"],
      },
    },
    {
      name: "open_message",
      description: "Mở một thư (theo id từ search_messages) lên màn hình " +
                   "cho người dùng xem.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "id thư từ search_messages" },
        },
        required: ["id"],
      },
    },
    {
      name: "compose_new",
      description: "Mở cửa sổ soạn THƯ MỚI (không phải trả lời) tới một " +
                   "người nhận với tiêu đề và nội dung soạn sẵn. Dùng khi " +
                   "người dùng nhờ 'viết thư riêng/thư mới cho ai đó'. Thư " +
                   "KHÔNG được gửi đi — người dùng xem lại rồi tự gửi.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string",
                description: "Địa chỉ email người nhận (lấy từ thư đang " +
                             "xem nếu có); để trống nếu chưa rõ" },
          subject: { type: "string", description: "Tiêu đề thư" },
          body: { type: "string", description: "Nội dung thư" },
        },
        required: ["body"],
      },
    },
  ],

  /** Actions that change or send things get a confirmation. */
  NEEDS_CONFIRM: new Set(["move_to_folder", "mark_junk", "archive_message"]),

  toolDeclarations() {
    return [{ functionDeclarations: this.TOOLS }];
  },

  confirm(win, title, message) {
    try {
      return Services.prompt.confirm(win, title, message);
    } catch (e) {
      return false;
    }
  },

  /**
   * Perform one action. Returns a small object the model gets back verbatim,
   * so failures are described rather than thrown.
   */
  /** Các hành động cấp HỘP THƯ — chạy được khi chưa mở thư nào. */
  MAILBOX_TOOLS: new Set(["compose_new", "search_messages", "read_message",
                          "open_message"]),

  /** Đổi id "folderURI#key" từ search_messages ngược về nsIMsgDBHdr. */
  hdrFromId(id) {
    try {
      const cut = String(id || "").lastIndexOf("#");
      if (cut < 0) {
        return null;
      }
      const { MailUtils } = ChromeUtils.importESModule(
        "resource:///modules/MailUtils.sys.mjs");
      const folder = MailUtils.getExistingFolder(id.slice(0, cut));
      const key = parseInt(id.slice(cut + 1), 10);
      return folder?.msgDatabase?.getMsgHdrForKey?.(key) || null;
    } catch (e) {
      return null;
    }
  },

  async runTool(win, name, args) {
    const hdr = this.selectedMessage(win);
    // Hành động cấp hộp thư không cần thư nào đang chọn — mọi hành động
    // khác đều tác động lên "thư hiện tại" nên thiếu là dừng.
    if (!hdr && !this.MAILBOX_TOOLS.has(name)) {
      return { ok: false, error: "Không có thư nào đang được chọn." };
    }
    const folder = hdr?.folder;

    try {
      switch (name) {
        case "mark_read": {
          folder.markMessagesRead([hdr], !!args.read);
          return { ok: true, done: args.read ? "đã đánh dấu đã đọc"
                                             : "đã đánh dấu chưa đọc" };
        }

        case "flag_message": {
          folder.markMessagesFlagged([hdr], !!args.flagged);
          return { ok: true, done: args.flagged ? "đã gắn cờ" : "đã bỏ cờ" };
        }

        case "add_tag": {
          const label = String(args.tag || "").trim();
          if (!label) {
            return { ok: false, error: "Thiếu tên nhãn." };
          }
          let key = null;
          for (const tag of MailServices.tags.getAllTags()) {
            if (tag.tag.toLowerCase() === label.toLowerCase()) {
              key = tag.key;
              break;
            }
          }
          if (!key) {
            MailServices.tags.addTagForKey(
              label.toLowerCase().replace(/[^a-z0-9]/g, "") || "hmailai",
              label, "#0F6CBD", "");
            for (const tag of MailServices.tags.getAllTags()) {
              if (tag.tag === label) {
                key = tag.key;
              }
            }
          }
          if (!key) {
            return { ok: false, error: "Không tạo được nhãn." };
          }
          folder.addKeywordsToMessages([hdr], key);
          return { ok: true, done: `đã gắn nhãn "${label}"` };
        }

        case "list_folders": {
          const names = [];
          const walk = f => {
            names.push(f.prettyName);
            for (const sub of f.subFolders) {
              if (names.length < 60) {
                walk(sub);
              }
            }
          };
          for (const root of MailServices.accounts
                 .findAccountForServer(folder.server).incomingServer
                 .rootFolder.subFolders) {
            walk(root);
          }
          return { ok: true, folders: names };
        }

        case "move_to_folder": {
          const wanted = String(args.folder || "").trim().toLowerCase();
          if (!wanted) {
            return { ok: false, error: "Thiếu tên thư mục." };
          }
          let target = null;
          const find = f => {
            if (target) {
              return;
            }
            if (f.prettyName.toLowerCase() === wanted ||
                f.name.toLowerCase() === wanted) {
              target = f;
              return;
            }
            for (const sub of f.subFolders) {
              find(sub);
            }
          };
          find(folder.server.rootFolder);
          if (!target) {
            return { ok: false,
                     error: `Không tìm thấy thư mục "${args.folder}".` };
          }
          if (!this.confirm(win, "hMail AI",
                `Chuyển thư này sang thư mục "${target.prettyName}"?`)) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          MailServices.copy.copyMessages(folder, [hdr], target, true,
                                         null, null, false);
          return { ok: true, done: `đã chuyển sang "${target.prettyName}"` };
        }

        case "archive_message": {
          if (!this.confirm(win, "hMail AI", "Lưu trữ thư này?")) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          win.goDoCommand("cmd_archive");
          return { ok: true, done: "đã lưu trữ" };
        }

        case "mark_junk": {
          if (!this.confirm(win, "hMail AI",
                            "Đánh dấu thư này là thư rác?")) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          win.goDoCommand("cmd_markAsJunk");
          return { ok: true, done: "đã đánh dấu thư rác" };
        }

        case "compose_reply": {
          const body = String(args.body || "").trim();
          if (!body) {
            return { ok: false, error: "Thiếu nội dung thư trả lời." };
          }
          // Opens the composer with the draft in place. Never sends.
          const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
            .createInstance(Ci.nsIMsgComposeParams);
          const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
            .createInstance(Ci.nsIMsgCompFields);
          fields.body = body.replace(/\n/g, "<br>");
          params.composeFields = fields;
          params.type = args.reply_all
            ? Ci.nsIMsgCompType.ReplyAll
            : Ci.nsIMsgCompType.ReplyToSender;
          params.format = Ci.nsIMsgCompFormat.HTML;
          params.originalMsgURI = folder.getUriForMsg(hdr);
          params.identity = MailServices.accounts
            .findAccountForServer(folder.server)?.defaultIdentity;
          MailServices.compose.OpenComposeWindowWithParams(null, params);
          return { ok: true,
                   done: "đã mở cửa sổ trả lời với nội dung soạn sẵn " +
                         "(chưa gửi)" };
        }

        case "search_messages": {
          const query = String(args.query || "").trim().toLowerCase();
          const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
          const cutoff = Date.now() / 1000 - days * 86400;
          const found = [];
          const stats = [];
          for (const server of MailServices.accounts.allServers) {
            // Một tài khoản hỏng không được kéo sập cả cuộc tìm — lỗi ở
            // đâu ghi lại ở đó rồi đi tiếp.
            try {
              if (!["imap", "pop3", "none"].includes(server.type)) {
                continue;
              }
              const inbox = server.rootFolder
                ?.getFolderWithFlags?.(Ci.nsMsgFolderFlags.Inbox);
              const db = inbox?.msgDatabase;
              if (!db) {
                stats.push({ server: server.prettyName, error: "no-inbox-db" });
                continue;
              }
              // Đi từ thư mới nhất lùi về; quá mốc thời gian là dừng —
              // hộp trăm nghìn thư không bị quét trọn. Không có enumerator
              // ngược thì đành quét xuôi TOÀN BỘ: duyệt 5000 thư CŨ NHẤT
              // rồi dừng (bản trước) là hộp lớn không bao giờ thấy thư mới.
              const reverse = typeof db.reverseEnumerateMessages === "function";
              let checked = 0;
              let kept = 0;
              for (const msg of (reverse ? db.reverseEnumerateMessages()
                                         : inbox.messages)) {
                checked++;
                if (reverse && checked > 20000) {
                  break;
                }
                if (msg.dateInSeconds < cutoff) {
                  if (reverse) {
                    break;
                  }
                  continue;
                }
                if (args.unread_only && msg.isRead) {
                  continue;
                }
                const from = msg.mime2DecodedAuthor || "";
                const subject = msg.mime2DecodedSubject || "";
                if (query &&
                    !(from + " " + subject).toLowerCase().includes(query)) {
                  continue;
                }
                kept++;
                found.push({
                  id: `${inbox.URI}#${msg.messageKey}`,
                  from, subject,
                  ts: msg.dateInSeconds,
                  date: new Date(msg.dateInSeconds * 1000).toLocaleString(),
                  unread: !msg.isRead,
                  folder: `${server.prettyName}`,
                });
              }
              stats.push({ server: server.prettyName, reverse, checked, kept });
            } catch (e) {
              stats.push({ server: server?.prettyName || "?",
                           error: String(e.message || e) });
            }
          }
          found.sort((a, b) => b.ts - a.ts);
          const items = found.slice(0, limit).map(({ ts, ...rest }) => rest);
          const out = { ok: true, count: items.length,
                        total_matched: found.length, items };
          if (args.debug) {
            out.stats = stats;
          }
          this._lastSearchStats = stats;
          return out;
        }

        case "read_message": {
          const target = this.hdrFromId(args.id);
          if (!target) {
            return { ok: false, error: "Không tìm thấy thư với id này." };
          }
          const text = String(await this.messageText(target) || "");
          return { ok: true,
                   from: target.mime2DecodedAuthor || "",
                   subject: target.mime2DecodedSubject || "",
                   date: new Date(target.dateInSeconds * 1000).toLocaleString(),
                   body: text.slice(0, 6000) };
        }

        case "open_message": {
          const target = this.hdrFromId(args.id);
          if (!target) {
            return { ok: false, error: "Không tìm thấy thư với id này." };
          }
          const { MailUtils } = ChromeUtils.importESModule(
            "resource:///modules/MailUtils.sys.mjs");
          MailUtils.displayMessageInFolderTab(target);
          return { ok: true, done: "đã mở thư lên màn hình" };
        }

        case "compose_new": {
          const body = String(args.body || "").trim();
          if (!body) {
            return { ok: false, error: "Thiếu nội dung thư." };
          }
          const params = Cc["@mozilla.org/messengercompose/composeparams;1"]
            .createInstance(Ci.nsIMsgComposeParams);
          const fields = Cc["@mozilla.org/messengercompose/composefields;1"]
            .createInstance(Ci.nsIMsgCompFields);
          fields.to = String(args.to || "").trim();
          fields.subject = String(args.subject || "").trim();
          fields.body = body.replace(/\n/g, "<br>");
          params.composeFields = fields;
          params.type = Ci.nsIMsgCompType.New;
          params.format = Ci.nsIMsgCompFormat.HTML;
          params.identity = (folder && MailServices.accounts
              .findAccountForServer(folder.server)?.defaultIdentity) ||
            MailServices.accounts.defaultAccount?.defaultIdentity || null;
          MailServices.compose.OpenComposeWindowWithParams(null, params);
          return { ok: true,
                   done: "đã mở cửa sổ soạn thư mới" +
                         (fields.to ? ` tới ${fields.to}` : "") +
                         " với nội dung soạn sẵn (chưa gửi)" };
        }

        default:
          return { ok: false, error: `Hành động không hỗ trợ: ${name}` };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },
});

// ---------------------------------------------------------------------------
// Tự kiểm search_messages (pref hmail.debug.searchtest = "run"): chạy đúng
// tool trong app thật với hộp thư thật, ghi số liệu từng tài khoản (đi
// ngược được không, duyệt bao nhiêu, giữ bao nhiêu) vào pref.
(function hMailSearchSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.searchtest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.searchtest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const res = await hMailAI.runTool(win, "search_messages",
                                        { days: 3, limit: 5, debug: true });
      report(JSON.stringify({
        ok: res.ok, count: res.count, total: res.total_matched,
        error: res.error || null,
        first: res.items?.[0]
          ? `${res.items[0].from} | ${res.items[0].subject}` : null,
        stats: res.stats,
      }));
    } catch (e) {
      report("err: " + (e.message || e));
    }
  }, 15000);
})();

