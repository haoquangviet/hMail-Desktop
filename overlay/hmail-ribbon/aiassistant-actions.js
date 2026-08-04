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
  async runTool(win, name, args) {
    const hdr = this.selectedMessage(win);
    if (!hdr) {
      return { ok: false, error: "Không có thư nào đang được chọn." };
    }
    const folder = hdr.folder;

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

        default:
          return { ok: false, error: `Hành động không hỗ trợ: ${name}` };
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },
});
