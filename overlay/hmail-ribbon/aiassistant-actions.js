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
      description: "Tìm thư theo từ khoá (người gửi/tiêu đề), số ngày gần " +
                   "đây, có thể chỉ lấy thư chưa đọc. MẶC ĐỊNH tìm trong " +
                   "THƯ MỤC ĐANG MỞ trên màn hình (người dùng đang đứng ở " +
                   "hộp thư nào thì tìm ở đó); scope='account' = cả tài " +
                   "khoản đang mở; scope='all' = Hộp thư đến của mọi tài " +
                   "khoản — chỉ dùng khi người dùng nói rõ 'tất cả tài " +
                   "khoản'. Trả về {id, from, subject, date, unread, folder}.",
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
          scope: { type: "string", enum: ["folder", "account", "all"],
                   description: "folder (mặc định) = thư mục đang mở; " +
                                "account = mọi thư mục của tài khoản đang " +
                                "mở; all = Hộp thư đến của mọi tài khoản" },
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
      name: "filter_messages",
      description: "Điền từ khoá vào ô LỌC NHANH của thư mục đang mở (tự " +
                   "bật thanh lọc nếu đang ẩn) — danh sách thư trên màn " +
                   "hình thu lại đúng các thư khớp, người dùng nhìn thấy " +
                   "ngay. Trả về số thư đang hiển thị sau khi lọc. Dùng " +
                   "khi người dùng muốn THẤY/XỬ LÝ HÀNG LOẠT một nhóm thư " +
                   "(xoá, chuyển, gắn nhãn cả cụm) — sau đó gọi " +
                   "act_on_filtered.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string",
                   description: "Từ khoá lọc (người gửi/tiêu đề); chuỗi " +
                                "rỗng để bỏ lọc" },
          unread_only: { type: "boolean", description: "Chỉ thư chưa đọc" },
          account: { type: "string",
                     description: "Email/tên tài khoản cần lọc trong Hộp " +
                                  "thư đến của nó (lấy từ kết quả " +
                                  "search_messages: trường folder); bỏ " +
                                  "trống = thư mục đang mở" },
          folder: { type: "string",
                    description: "Tên thư mục cụ thể cần lọc (mặc định Hộp " +
                                 "thư đến của tài khoản)" },
        },
        required: ["query"],
      },
    },
    {
      name: "act_on_filtered",
      description: "Thực hiện MỘT hành động lên TOÀN BỘ thư đang hiển thị " +
                   "trong danh sách (sau khi filter_messages): 'trash' " +
                   "chuyển vào Thùng rác, 'move' chuyển sang thư mục, " +
                   "'tag' gắn nhãn, 'read' đánh dấu đã đọc, 'archive' lưu " +
                   "trữ. Luôn hỏi người dùng xác nhận số lượng trước khi " +
                   "làm.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string",
                    enum: ["trash", "move", "tag", "read", "archive"] },
          folder: { type: "string",
                    description: "Tên hoặc đường dẫn thư mục đích (cho " +
                                 "'move')" },
          tag: { type: "string", description: "Tên nhãn (cho 'tag')" },
        },
        required: ["action"],
      },
    },
    {
      name: "create_filter",
      description: "Tạo BỘ LỌC THƯ lâu dài cho một tài khoản (giống Công " +
                   "cụ ▸ Bộ lọc thư): thư ĐẾN sau này khớp điều kiện sẽ tự " +
                   "được xử lý. Điều kiện: người gửi chứa / tiêu đề chứa / " +
                   "người nhận chứa. Hành động: chuyển thư mục, gắn nhãn, " +
                   "đánh dấu đã đọc, xoá, gắn cờ. Dùng khi người dùng nói " +
                   "\"từ giờ thư của X thì…\", \"tự động chuyển…\". Bộ lọc " +
                   "hiện trong Công cụ ▸ Bộ lọc thư để người dùng sửa.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tên bộ lọc, ngắn gọn" },
          account: { type: "string",
                     description: "Email/tên tài khoản áp dụng; bỏ trống = " +
                                  "tài khoản của thư đang xem hoặc mặc định" },
          sender_contains: { type: "string" },
          subject_contains: { type: "string" },
          recipient_contains: { type: "string" },
          action: { type: "string",
                    enum: ["move", "tag", "read", "delete", "flag"] },
          folder: { type: "string",
                    description: "Thư mục đích cho 'move' (tạo mới nếu chưa " +
                                 "có, dưới gốc tài khoản)" },
          tag: { type: "string", description: "Tên nhãn cho 'tag'" },
          after_days: { type: "integer",
                        description: "CHỈ xử lý thư đã nhận quá N ngày — " +
                                     "dùng cho \"tự xoá sau 3 ngày\", \"dọn " +
                                     "thư cũ hơn 1 tuần\". Bỏ trống = xử lý " +
                                     "ngay khi thư đến." },
          apply_now: { type: "boolean",
                       description: "Chạy ngay bộ lọc lên Hộp thư đến hiện " +
                                    "có (mặc định false)" },
        },
        required: ["name", "action"],
      },
    },
    {
      name: "list_filters",
      description: "Liệt kê BỘ LỌC THƯ hiện có của một tài khoản kèm điều " +
                   "kiện và hành động. Gọi TRƯỚC khi sửa hoặc xoá bộ lọc để " +
                   "biết tên chính xác, và khi người dùng hỏi \"có bộ lọc " +
                   "nào\", \"bộ lọc đó đang làm gì\".",
      parameters: {
        type: "object",
        properties: {
          account: { type: "string",
                     description: "Email/tên tài khoản; bỏ trống = tài " +
                                  "khoản đang mở" },
        },
      },
    },
    {
      name: "update_filter",
      description: "SỬA một bộ lọc đã có — KHÔNG tạo bộ lọc mới. Dùng ngay " +
                   "khi người dùng chỉnh lại điều vừa yêu cầu: vừa tạo bộ " +
                   "lọc \"xoá\" mà người dùng nói \"phải là tự xoá sau 3 " +
                   "ngày\" thì gọi update_filter với after_days=3 cho đúng " +
                   "bộ lọc đó. Chỉ trường nào truyền vào mới đổi; phần còn " +
                   "lại giữ nguyên.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string",
                  description: "Tên bộ lọc cần sửa (khớp một phần cũng được)" },
          account: { type: "string" },
          rename: { type: "string", description: "Đổi tên bộ lọc" },
          sender_contains: { type: "string" },
          subject_contains: { type: "string" },
          recipient_contains: { type: "string" },
          after_days: { type: "integer",
                        description: "Chỉ xử lý thư quá N ngày; 0 = bỏ điều " +
                                     "kiện thời gian" },
          action: { type: "string",
                    enum: ["move", "tag", "read", "delete", "flag"] },
          folder: { type: "string" },
          tag: { type: "string" },
          enabled: { type: "boolean", description: "Bật/tắt bộ lọc" },
        },
        required: ["name"],
      },
    },
    {
      name: "delete_filter",
      description: "Xoá hẳn một bộ lọc thư. Hỏi xác nhận trước khi xoá.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tên bộ lọc (khớp một phần)" },
          account: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "open_window",
      description: "MỞ THẲNG một màn hình của hMail cho người dùng thay vì " +
                   "chỉ dẫn đường bằng lời. Dùng khi người dùng nói \"mở bộ " +
                   "lọc\", \"vào cài đặt\", \"mở sổ địa chỉ\", \"xem chi phí " +
                   "AI\", \"mở lịch\"…",
      parameters: {
        type: "object",
        properties: {
          screen: {
            type: "string",
            enum: ["filters", "server_filters", "account_settings", "settings",
                   "address_book", "calendar", "tasks", "ai_settings",
                   "ai_cost", "tracking", "quarantine", "local_ai",
                   "automation", "import", "mail_merge"],
            description: "filters = Bộ lọc thư; server_filters = lọc phía " +
                         "máy chủ; account_settings = Cài đặt tài khoản; " +
                         "settings = Tùy chọn; ai_settings = Cài đặt trợ " +
                         "lý; ai_cost = Chi phí AI; tracking = Trạng thái thư; " +
                         "quarantine = Thư bị giữ",
          },
        },
        required: ["screen"],
      },
    },
    {
      name: "set_reminder",
      description: "Đặt LỜI NHẮC / việc cần làm cho người dùng về thư đang " +
                   "xem (hoặc việc bất kỳ): tạo mục trong Lịch/Việc cần làm " +
                   "của hMail kèm báo thức, có thể LẶP HẰNG NGÀY tới hạn " +
                   "(ví dụ hoá đơn quá hạn: nhắc mỗi ngày cho tới khi thanh " +
                   "toán). Dùng khi người dùng nói 'nhắc tôi', 'nhắc lại', " +
                   "'đừng để tôi quên', 'theo dõi việc này'. KHÔNG dùng bộ " +
                   "lọc thư cho việc nhắc nhở.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Tiêu đề lời nhắc, ngắn gọn" },
          when: { type: "string",
                  description: "Thời điểm nhắc đầu tiên: 'tomorrow 09:00', " +
                               "'2026-08-20 08:30', 'in 2 hours', 'today 17:00'; " +
                               "bỏ trống = 9h sáng mai" },
          repeat: { type: "string", enum: ["none", "daily", "weekly"],
                    description: "Lặp lại; mặc định none" },
          until: { type: "string",
                   description: "Ngày kết thúc lặp (YYYY-MM-DD); bỏ trống = " +
                                "lặp 30 lần" },
          notes: { type: "string", description: "Ghi chú thêm" },
        },
        required: ["title"],
      },
    },
    {
      name: "test_filters",
      description: "Chẩn đoán vì sao BỘ LỌC THƯ không chạy với thư đang " +
                   "xem: duyệt mọi bộ lọc của tài khoản, cho biết bộ nào " +
                   "khớp/không khớp thư này, điều kiện nào trượt và lỗi " +
                   "cấu hình thường gặp (toán tử 'là' thay vì 'chứa', chọn " +
                   "'khớp tất cả' thay vì 'bất kỳ', bộ lọc đang tắt, không " +
                   "bật khi nhận thư mới). Dùng khi người dùng than 'rule " +
                   "không hoạt động'.",
      parameters: {
        type: "object",
        properties: {
          name_contains: { type: "string",
                           description: "Chỉ kiểm các bộ lọc có tên chứa " +
                                        "chuỗi này; bỏ trống = tất cả" },
        },
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
    // Gemini API chuẩn từ chối "parameters" có properties RỖNG (Map trống →
    // "Cannot bind a list to map for field 'properties'"); Google bỏ qua
    // nhưng máy chủ Gemini-compat (hMail AI services) thì không. Tool
    // không tham số → bỏ hẳn "parameters"; có tham số → giữ nguyên.
    const decls = this.TOOLS.map(t => {
      const props = t.parameters?.properties || {};
      if (!Object.keys(props).length) {
        const { parameters, ...rest } = t;
        return rest;
      }
      return t;
    });
    return [{ functionDeclarations: decls }];
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
                          "open_message", "filter_messages",
                          "act_on_filtered", "create_filter",
                          "set_reminder", "list_filters", "update_filter",
                          "delete_filter", "open_window"]),

  // ----------------------------------------------- bộ lọc: đọc, dựng, sửa

  /** Bộ lọc trùng tên (ưu tiên khớp đúng, sau đó khớp một phần). */
  findFilter(list, name) {
    const want = String(name || "").trim().toLowerCase();
    if (!want) {
      return null;
    }
    let partial = null;
    for (let i = 0; i < list.filterCount; i++) {
      const f = list.getFilterAt(i);
      const n = f.filterName.toLowerCase();
      if (n === want) {
        return f;
      }
      if (!partial && n.includes(want)) {
        partial = f;
      }
    }
    return partial;
  },

  filterIndex(list, filter) {
    for (let i = 0; i < list.filterCount; i++) {
      if (list.getFilterAt(i) === filter) {
        return i;
      }
    }
    return -1;
  },

  /** Đọc bộ lọc thành mô tả phẳng mà model hiểu và sửa được. */
  filterSpec(filter) {
    const A = Ci.nsMsgSearchAttrib;
    const FA = Ci.nsMsgFilterAction;
    const spec = { name: filter.filterName, enabled: filter.enabled,
                   sender_contains: "", subject_contains: "",
                   recipient_contains: "", after_days: 0,
                   action: "", folder: "", folderUri: "", tag: "",
                   other: [] };
    for (const t of filter.searchTerms) {
      const v = t.value;
      if (t.attrib === A.Sender) {
        spec.sender_contains = v.str || "";
      } else if (t.attrib === A.Subject) {
        spec.subject_contains = v.str || "";
      } else if (t.attrib === A.To) {
        spec.recipient_contains = v.str || "";
      } else if (t.attrib === A.AgeInDays) {
        spec.after_days = Number(v.age || 0);
      } else {
        // Điều kiện người dùng tự đặt trong hộp thoại: giữ lại để cảnh báo,
        // vì sửa qua trợ lý sẽ dựng lại bộ lọc và làm mất chúng.
        spec.other.push(t.attrib);
      }
    }
    for (let k = 0; k < filter.actionCount; k++) {
      const act = filter.getActionAt(k);
      if (act.type === FA.MoveToFolder) {
        spec.action = "move";
        spec.folderUri = act.targetFolderUri;
        spec.folder = MailServices.folderLookup
          .getFolderForURL(act.targetFolderUri)?.prettyName || "";
      } else if (act.type === FA.AddTag) {
        spec.action = "tag";
        spec.tag = act.strValue;
      } else if (act.type === FA.MarkRead) {
        spec.action = "read";
      } else if (act.type === FA.Delete) {
        spec.action = "delete";
      } else if (act.type === FA.MarkFlagged) {
        spec.action = "flag";
      }
    }
    return spec;
  },

  ACTION_LABELS: { move: "chuyển thư mục", tag: "gắn nhãn",
                   read: "đánh dấu đã đọc", delete: "xoá", flag: "gắn cờ" },

  /** Câu tiếng Việt mô tả bộ lọc, dùng chung cho hộp xác nhận và trả lời. */
  describeSpec(spec) {
    const conds = [];
    if (spec.sender_contains) {
      conds.push(`người gửi chứa "${spec.sender_contains}"`);
    }
    if (spec.subject_contains) {
      conds.push(`tiêu đề chứa "${spec.subject_contains}"`);
    }
    if (spec.recipient_contains) {
      conds.push(`người nhận chứa "${spec.recipient_contains}"`);
    }
    const when = spec.after_days > 0
      ? `thư đã nhận quá ${spec.after_days} ngày` : "";
    const act = this.ACTION_LABELS[spec.action] || spec.action;
    return (conds.join(" VÀ ") || "(chưa có điều kiện)") +
      (when ? ` VÀ ${when}` : "") + " → " + act +
      (spec.action === "move" && spec.folder ? ` sang "${spec.folder}"` : "") +
      (spec.action === "tag" && spec.tag ? ` "${spec.tag}"` : "");
  },

  /** Khoá nhãn theo tên, tạo mới nếu chưa có. */
  tagKeyFor(name) {
    const wanted = String(name || "").trim();
    for (const t of MailServices.tags.getAllTags()) {
      if (t.tag.toLowerCase() === wanted.toLowerCase()) {
        return t.key;
      }
    }
    MailServices.tags.addTagForKey(
      wanted.toLowerCase().replace(/[^a-z0-9]/g, "") || "hmailai",
      wanted, "#0F6CBD", "");
    for (const t of MailServices.tags.getAllTags()) {
      if (t.tag === wanted) {
        return t.key;
      }
    }
    return "";
  },

  /** Thư mục đích cho hành động "move", tạo dưới gốc tài khoản nếu chưa có. */
  async destFolder(win, server, wanted) {
    const name = String(wanted || "").trim();
    if (!name) {
      return null;
    }
    let dest = this.findFolderNamed(name, server);
    if (dest) {
      return dest;
    }
    try {
      server.rootFolder.createSubfolder(name, null);
      await new Promise(r => win.setTimeout(r, 800));
      dest = this.findFolderNamed(name, server);
    } catch (e) {}
    return dest;
  },

  /**
   * Dựng một bộ lọc từ spec.
   *
   * Điều kiện "quá N ngày" chỉ có nghĩa khi quét LẠI hộp thư: thư vừa đến
   * luôn 0 ngày tuổi, nên bộ lọc dạng này KHÔNG bật cờ "khi nhận thư mới"
   * (bật cũng không bao giờ khớp) — hMail tự chạy nó mỗi giờ, xem
   * runAgedFilters().
   */
  buildFilter(list, spec) {
    const filter = list.createFilter(String(spec.name));
    filter.enabled = spec.enabled !== false;
    filter.filterType = spec.after_days > 0
      ? Ci.nsMsgFilterType.Manual
      : (Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual);
    const addTerm = (attrib, fill) => {
      const term = filter.createTerm();
      term.attrib = attrib;
      const v = term.value;
      v.attrib = attrib;
      fill(term, v);
      term.value = v;
      term.booleanAnd = true;
      filter.appendTerm(term);
    };
    const A = Ci.nsMsgSearchAttrib;
    const pairs = [[A.Sender, spec.sender_contains],
                   [A.Subject, spec.subject_contains],
                   [A.To, spec.recipient_contains]];
    for (const [attrib, value] of pairs) {
      if (value) {
        addTerm(attrib, (term, v) => {
          term.op = Ci.nsMsgSearchOp.Contains;
          v.str = String(value);
        });
      }
    }
    if (spec.after_days > 0) {
      addTerm(A.AgeInDays, (term, v) => {
        term.op = Ci.nsMsgSearchOp.IsGreaterThan;
        v.age = Number(spec.after_days);
      });
    }
    const act = filter.createAction();
    if (spec.action === "move") {
      act.type = Ci.nsMsgFilterAction.MoveToFolder;
      act.targetFolderUri = spec.folderUri;
    } else if (spec.action === "tag") {
      act.type = Ci.nsMsgFilterAction.AddTag;
      act.strValue = this.tagKeyFor(spec.tag);
    } else if (spec.action === "read") {
      act.type = Ci.nsMsgFilterAction.MarkRead;
    } else if (spec.action === "delete") {
      act.type = Ci.nsMsgFilterAction.Delete;
    } else if (spec.action === "flag") {
      act.type = Ci.nsMsgFilterAction.MarkFlagged;
    }
    filter.appendAction(act);
    return filter;
  },

  // --------------------------------- bộ lọc theo thời gian: sổ ghi + quét

  AGED_PREF: "hmail.ai.agedFilters",

  agedRegistry() {
    try {
      const raw = Services.prefs.getCharPref(this.AGED_PREF, "[]");
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  rememberAged(server, name, keep) {
    try {
      const key = server.key;
      const list = this.agedRegistry()
        .filter(e => !(e.server === key && e.name === name));
      if (keep) {
        list.push({ server: key, name });
      }
      Services.prefs.setCharPref(this.AGED_PREF, JSON.stringify(list));
    } catch (e) {}
  },

  /**
   * Chạy các bộ lọc có điều kiện tuổi lên Hộp thư đến. Bộ lọc thường do
   * Thunderbird chạy lúc thư đến; loại "sau N ngày" thì phải có người quét
   * lại — đây là người đó, mỗi giờ một lượt.
   */
  async runAgedFilters(win, scheduled = false) {
    const entries = this.agedRegistry();
    if (!entries.length) {
      return 0;
    }
    // Mỗi cửa sổ 3-pane có hẹn giờ riêng; mở hai cửa sổ thì hai vòng quét
    // cùng chạy trên một hộp thư. Lượt theo giờ đi qua khoá thời gian
    // chung (pref), lượt do người dùng vừa tạo/sửa bộ lọc thì chạy ngay.
    if (scheduled) {
      const now = Date.now();
      let last = 0;
      try {
        last = Number(Services.prefs.getCharPref("hmail.ai.agedLast", "0"));
      } catch (e) {}
      if (now - last < 55 * 60 * 1000) {
        return 0;
      }
      try {
        Services.prefs.setCharPref("hmail.ai.agedLast", String(now));
      } catch (e) {}
    }
    let ran = 0;
    for (const entry of entries) {
      try {
        const server = MailServices.accounts.allServers
          .find(s => s.key === entry.server);
        if (!server) {
          continue;
        }
        const list = server.getFilterList(this.msgWindowOf(win));
        const filter = this.findFilter(list, entry.name);
        if (!filter || !filter.enabled) {
          continue;
        }
        const inbox = server.rootFolder
          .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
        if (!inbox) {
          continue;
        }
        const tmp = MailServices.filters.getTempFilterList(inbox);
        tmp.insertFilterAt(0, filter);
        MailServices.filters.applyFiltersToFolders(
          tmp, [inbox], this.msgWindowOf(win));
        ran++;
        // Nhường máy giữa hai tài khoản — mỗi lượt là một vòng quét thật.
        await new Promise(r => win.setTimeout(r, 3000));
      } catch (e) {
        Cu.reportError("hMail AI aged filter failed: " + e);
      }
    }
    return ran;
  },

  /** Mở thẳng một màn hình của hMail; trả về tên tiếng Việt đã mở. */
  openScreen(win, screen) {
    const space = id => {
      const button = win.document.getElementById(id);
      if (!button) {
        return false;
      }
      button.click();
      return true;
    };
    const map = {
      filters: ["Bộ lọc thư", () => win.MsgFilters()],
      server_filters: ["Lọc theo máy chủ",
                       () => win.hMailServerFilter?.openTab(win)],
      account_settings: ["Cài đặt tài khoản",
                         () => (win.MsgAccountManager
                                 ? win.MsgAccountManager(null)
                                 : win.openAccountSettings?.())],
      settings: ["Tùy chọn", () => win.openPreferencesTab()],
      address_book: ["Sổ địa chỉ", () => win.toAddressBook()],
      calendar: ["Lịch", () => space("calendarButton")],
      tasks: ["Việc cần làm", () => space("tasksButton")],
      ai_settings: ["Cài đặt trợ lý", () => this.showSettings(win)],
      ai_cost: ["Chi phí AI", () => win.hMailAICost?.openTab(win)],
      tracking: ["Trạng thái thư", () => win.hMailTrack?.openTab(win)],
      quarantine: ["Thư bị giữ", () => win.hMailSpam?.openTab(win)],
      local_ai: ["AI trên máy", () => win.hMailLocalAIUI?.openTab(win)],
      automation: ["Tự động hoá AI", () => win.hMailFlowUI?.openTab(win)],
      import: ["Nhập dữ liệu", () => win.hMailImport?.openTab(win)],
      mail_merge: ["Gửi hàng loạt", () => win.hMailMerge?.openTab(win)],
    };
    const hit = map[screen];
    if (!hit) {
      return "";
    }
    try {
      const res = hit[1]();
      return res === false ? "" : hit[0];
    } catch (e) {
      Cu.reportError(`hMail AI open ${screen}: ${e}`);
      return "";
    }
  },

  /** Hẹn giờ quét: sau khởi động một nhịp, rồi mỗi giờ. */
  startAgedSweep(win) {
    if (win._hmailAgedSweep) {
      return;
    }
    win._hmailAgedSweep = true;
    const run = () => {
      this.runAgedFilters(win, true).catch(e =>
        Cu.reportError("hMail AI aged sweep: " + e));
    };
    win.setTimeout(run, 90 * 1000);
    win.setInterval(run, 60 * 60 * 1000);
  },

  /**
   * Chẩn đoán bộ lọc với một thư: chạy MailServices.filters.matchHdr
   * (đúng bộ máy so khớp thật) cho từng bộ lọc, đồng thời soi cấu hình để
   * gọi tên lỗi bằng tiếng người — user viết rule sai kiểu gì cũng có lời
   * giải thích thay vì "không chạy".
   */
  async diagnoseFilters(win, hdr, nameContains = "") {
    const server = hdr.folder.server;
    const list = server.getFilterList(this.msgWindowOf(win));
    const want = String(nameContains || "").toLowerCase();
    const OP = Ci.nsMsgSearchOp;
    const ATTR = Ci.nsMsgSearchAttrib;
    const opName = op => ({
      [OP.Contains]: "chứa", [OP.DoesntContain]: "không chứa",
      [OP.Is]: "là", [OP.Isnt]: "không là",
      [OP.BeginsWith]: "bắt đầu bằng", [OP.EndsWith]: "kết thúc bằng",
      [OP.IsBefore]: "trước", [OP.IsAfter]: "sau",
      [OP.IsInAB]: "trong sổ địa chỉ", [OP.IsntInAB]: "không trong sổ",
    })[op] || `op${op}`;
    const attrName = a => ({
      [ATTR.Subject]: "Chủ đề", [ATTR.Sender]: "Từ", [ATTR.To]: "Đến",
      [ATTR.CC]: "Cc", [ATTR.ToOrCC]: "Đến hoặc Cc",
      [ATTR.AllAddresses]: "Người gửi, người nhận, Cc hoặc Bcc",
      [ATTR.Body]: "Nội dung", [ATTR.Date]: "Ngày", [ATTR.Priority]: "Ưu tiên",
      [ATTR.MsgStatus]: "Trạng thái", [ATTR.Keywords]: "Nhãn",
      [ATTR.Size]: "Kích thước", [ATTR.AgeInDays]: "Số ngày tuổi",
      [ATTR.HasAttachmentStatus]: "Đính kèm",
    })[a] || `thuộc tính ${a}`;
    const fromValue = hdr.mime2DecodedAuthor || "";
    const subjectValue = hdr.mime2DecodedSubject || "";
    const fieldValue = a => a === ATTR.Subject ? subjectValue
      : a === ATTR.Sender ? fromValue
      : a === ATTR.To || a === ATTR.ToOrCC || a === ATTR.AllAddresses
        ? `${hdr.mime2DecodedRecipients || ""} ${hdr.ccList || ""}` : null;

    const results = [];
    for (let i = 0; i < list.filterCount; i++) {
      const f = list.getFilterAt(i);
      if (want && !f.filterName.toLowerCase().includes(want)) {
        continue;
      }
      const item = { name: f.filterName, enabled: f.enabled,
                     matches: false, terms: [], warnings: [] };
      // Cờ áp dụng.
      const type = f.filterType;
      if (!f.enabled) {
        item.warnings.push("bộ lọc đang TẮT");
      }
      if (!(type & Ci.nsMsgFilterType.Incoming) &&
          !(type & Ci.nsMsgFilterType.InboxRule)) {
        item.warnings.push("không bật 'Nhận thư mới' — chỉ chạy khi bấm " +
                           "thủ công");
      }
      // So khớp thật.
      try {
        item.matches = MailServices.filters.matchHdr(
          f, hdr, hdr.folder, hdr.folder.msgDatabase, "");
      } catch (e) {
        item.warnings.push("không chạy được so khớp: " + (e.message || e));
      }
      // Soi từng điều kiện.
      const terms = f.searchTerms;
      let anyAnd = false, anyOr = false;
      for (const t of terms) {
        const v = t.value;
        const str = t.attrib === ATTR.Date ? "" : (v.str || "");
        const actual = fieldValue(t.attrib);
        let hit = null;
        if (actual !== null && str) {
          const a = actual.toLowerCase();
          const s = str.toLowerCase();
          hit = t.op === OP.Contains ? a.includes(s)
            : t.op === OP.DoesntContain ? !a.includes(s)
            : t.op === OP.Is ? a.trim() === s.trim()
            : t.op === OP.Isnt ? a.trim() !== s.trim()
            : t.op === OP.BeginsWith ? a.startsWith(s)
            : t.op === OP.EndsWith ? a.endsWith(s) : null;
        }
        item.terms.push({
          rule: `${attrName(t.attrib)} ${opName(t.op)} "${str}"`,
          and: t.booleanAnd, hit,
          actual: actual === null ? undefined : actual.slice(0, 120),
        });
        if (t.booleanAnd) {
          anyAnd = true;
        } else {
          anyOr = true;
        }
        // Lỗi kinh điển: "là" với chuỗi ngắn trên Từ/Chủ đề — gần như
        // không bao giờ bằng đúng cả trường.
        if (t.op === OP.Is && (t.attrib === ATTR.Sender ||
            t.attrib === ATTR.Subject || t.attrib === ATTR.Body) &&
            actual !== null && !actual.trim().toLowerCase().includes(
              str.trim().toLowerCase())) {
          // không chứa luôn thì là lỗi khác; bỏ qua
        } else if (t.op === OP.Is && (t.attrib === ATTR.Sender ||
                   t.attrib === ATTR.Subject || t.attrib === ATTR.Body)) {
          item.warnings.push(`điều kiện "${attrName(t.attrib)} LÀ '${str}'"` +
            " đòi hỏi bằng ĐÚNG toàn bộ trường — với Từ/Chủ đề/Nội dung " +
            "gần như không bao giờ đúng; nên đổi thành 'chứa'");
        }
      }
      if (anyAnd && terms.length > 1 && !item.matches) {
        const hits = item.terms.filter(t => t.hit === true).length;
        if (hits > 0 && hits < item.terms.length) {
          item.warnings.push("đang chọn 'Phù hợp TẤT CẢ' (mọi điều kiện " +
            `phải đúng cùng lúc) mà chỉ ${hits}/${item.terms.length} điều ` +
            "kiện đúng với thư này — muốn 'thư nào có MỘT trong các dấu " +
            "hiệu' thì chọn 'Phù hợp BẤT KỲ'");
        }
      }
      // Hành động.
      item.actions = [];
      for (let k = 0; k < f.actionCount; k++) {
        const act = f.getActionAt(k);
        const A = Ci.nsMsgFilterAction;
        item.actions.push(
          act.type === A.MoveToFolder ? "chuyển tới " +
            (MailServices.folderLookup.getFolderForURL(act.targetFolderUri)
              ?.prettyName || act.targetFolderUri)
          : act.type === A.CopyToFolder ? "sao chép tới thư mục"
          : act.type === A.AddTag ? "gắn nhãn " + act.strValue
          : act.type === A.MarkRead ? "đánh dấu đã đọc"
          : act.type === A.Delete ? "xoá"
          : act.type === A.MarkFlagged ? "gắn cờ"
          : act.type === A.JunkScore ? "chấm điểm rác"
          : `hành động ${act.type}`);
      }
      results.push(item);
    }
    const matched = results.filter(r => r.matches && r.enabled);
    return {
      ok: true,
      message: { from: fromValue, subject: subjectValue },
      total_filters: results.length,
      matched: matched.map(r => r.name),
      filters: results,
      hint: matched.length ? "" :
        "Không bộ lọc nào khớp thư này. Xem warnings từng bộ lọc: hầu hết " +
        "là do toán tử 'là' (cần 'chứa') hoặc chọn 'khớp tất cả' thay vì " +
        "'bất kỳ'.",
    };
  },

  /** Đổi mô tả thời điểm sang Date; hiểu vài dạng thường gặp, sai thì null. */
  parseWhen(text) {
    const t = String(text || "").trim().toLowerCase();
    const now = new Date();
    const at = (d, h = 9, m = 0) => { d.setHours(h, m, 0, 0); return d; };
    if (!t) {
      const d = new Date(now); d.setDate(d.getDate() + 1); return at(d);
    }
    let m;
    if ((m = /^(?:in|sau)\s+(\d+)\s*(h|hour|giờ|gio|m|min|phút|phut|d|day|ngày|ngay)/.exec(t))) {
      const n = +m[1], u = m[2][0];
      const d = new Date(now);
      if (u === "h" || u === "g") d.setHours(d.getHours() + n);
      else if (u === "m" || u === "p") d.setMinutes(d.getMinutes() + n);
      else d.setDate(d.getDate() + n);
      return d;
    }
    const hm = /(\d{1,2})[:h](\d{2})?/.exec(t);
    const h = hm ? +hm[1] : 9, mi = hm && hm[2] ? +hm[2] : 0;
    if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(t))) {
      return at(new Date(+m[1], +m[2] - 1, +m[3]), h, mi);
    }
    if ((m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/.exec(t))) {
      return at(new Date(m[3] ? +m[3] : now.getFullYear(), +m[2] - 1, +m[1]), h, mi);
    }
    if (/tomorrow|ngày mai|ngay mai|mai\b/.test(t)) {
      const d = new Date(now); d.setDate(d.getDate() + 1); return at(d, h, mi);
    }
    if (/today|hôm nay|hom nay|nay\b/.test(t)) {
      const d = at(new Date(now), h, mi);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    if (hm) {
      const d = at(new Date(now), h, mi);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    return null;
  },

  /**
   * Tạo lời nhắc thật trong lịch: một sự kiện 15 phút có báo thức lúc bắt
   * đầu, lặp theo yêu cầu, ghi chú kèm liên kết mở lại thư. Ghi vào lịch
   * đầu tiên ghi được (ưu tiên lịch cục bộ) — hMail có sẵn lịch cục bộ
   * "Home"; người dùng thấy ở tab Lịch và nhận thông báo như mọi sự kiện.
   */
  async createReminder(win, hdr, args) {
    const when = this.parseWhen(args.when);
    if (!when) {
      return { ok: false,
               error: "Không hiểu thời điểm \"" + args.when + "\" — dùng dạng " +
                      "'ngày mai 9:00', '2026-08-20 08:30', 'sau 2 giờ'." };
    }
    const { cal } = ChromeUtils.importESModule(
      "resource:///modules/calendar/calUtils.sys.mjs");
    const { CalEvent } = ChromeUtils.importESModule(
      "resource:///modules/CalEvent.sys.mjs");
    const { CalAlarm } = ChromeUtils.importESModule(
      "resource:///modules/CalAlarm.sys.mjs");
    const { CalRecurrenceRule } = ChromeUtils.importESModule(
      "resource:///modules/CalRecurrenceRule.sys.mjs");
    const { CalRecurrenceInfo } = ChromeUtils.importESModule(
      "resource:///modules/CalRecurrenceInfo.sys.mjs");
    const calendars = cal.manager.getCalendars()
      .filter(c => !c.readOnly && !c.getProperty("disabled"));
    // Thứ tự: lịch được người dùng chọn cho lời nhắc (pref) → lịch mặc
    // định của Thunderbird → lịch cục bộ → lịch đầu tiên.
    let preferred = "";
    try {
      preferred = Services.prefs.getCharPref("hmail.ai.reminderCalendar", "");
    } catch (e) {}
    let defaultId = "";
    try {
      defaultId = Services.prefs.getCharPref("calendar.default.calendar", "");
    } catch (e) {}
    const calendar = calendars.find(c => preferred && c.id === preferred) ||
      calendars.find(c => defaultId && c.id === defaultId) ||
      calendars.find(c => c.type === "storage") || calendars[0];
    if (!calendar) {
      return { ok: false, error: "Không có lịch nào ghi được để đặt lời nhắc." };
    }
    const title = String(args.title || "").trim() || "Lời nhắc từ hMail";
    const repeat = String(args.repeat || "none");
    const item = new CalEvent();
    item.title = title;
    const start = cal.dtz.jsDateToDateTime(when, cal.dtz.defaultTimezone);
    const end = start.clone();
    end.addDuration(cal.createDuration("PT15M"));
    item.startDate = start;
    item.endDate = end;
    let notes = String(args.notes || "").trim();
    if (hdr) {
      notes += (notes ? "\n\n" : "") +
        "Thư liên quan: " + (hdr.mime2DecodedSubject || "") +
        " — từ " + (hdr.mime2DecodedAuthor || "") + "\n" +
        "Mở thư: hmail://message/" +
        encodeURIComponent(hdr.messageId || "");
    }
    if (notes) {
      item.setProperty("DESCRIPTION", notes);
    }
    // Báo thức đúng lúc bắt đầu.
    const alarm = new CalAlarm();
    alarm.action = "DISPLAY";
    alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
    alarm.offset = cal.createDuration("PT0M");
    item.addAlarm(alarm);
    // Lặp.
    let repeatText = "";
    if (repeat === "daily" || repeat === "weekly") {
      const rule = new CalRecurrenceRule();
      rule.type = repeat === "daily" ? "DAILY" : "WEEKLY";
      const untilM = /(\d{4})-(\d{2})-(\d{2})/.exec(String(args.until || ""));
      if (untilM) {
        const u = new Date(+untilM[1], +untilM[2] - 1, +untilM[3], 23, 59, 0, 0);
        rule.untilDate = cal.dtz.jsDateToDateTime(u, cal.dtz.defaultTimezone);
        repeatText = (repeat === "daily" ? " mỗi ngày" : " mỗi tuần") +
          " tới " + untilM[3] + "/" + untilM[2] + "/" + untilM[1];
      } else {
        rule.count = 30;
        repeatText = (repeat === "daily" ? " mỗi ngày" : " mỗi tuần") +
          " (30 lần)";
      }
      item.recurrenceInfo = new CalRecurrenceInfo(item);
      item.recurrenceInfo.appendRecurrenceItem(rule);
    }
    await calendar.addItem(item);
    const whenText = when.toLocaleString("vi-VN");
    return { ok: true,
             done: `đã đặt lời nhắc "${title}" lúc ${whenText}${repeatText} ` +
                   `trong lịch "${calendar.name}" — có báo thức, xem ở tab Lịch` };
  },

  /** msgWindow của 3-pane (getFilterList/applyFilters cần một cái). */
  msgWindowOf(win) {
    try {
      return this.about3Pane(win)?.msgWindow ||
        Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);
    } catch (e) {
      return null;
    }
  },

  /** Server theo email/tên; không khớp thì server của thư đang xem/mặc định. */
  serverFor(account, fallbackHdr) {
    const acc = String(account || "").trim().toLowerCase();
    if (acc) {
      for (const server of MailServices.accounts.allServers) {
        const ident = MailServices.accounts
          .findAccountForServer(server)?.defaultIdentity?.email || "";
        if (server.prettyName.toLowerCase().includes(acc) ||
            ident.toLowerCase().includes(acc)) {
          return server;
        }
      }
      return null;
    }
    // Không nêu tài khoản: thư đang xem → thư mục đang mở → mặc định.
    return fallbackHdr?.folder?.server ||
      this.about3Pane(Services.wm.getMostRecentWindow("mail:3pane"))
        ?.gFolder?.server ||
      MailServices.accounts.defaultAccount?.incomingServer || null;
  },

  /** about:3pane của tab đang mở, nơi có thanh Lọc nhanh và gDBView. */
  about3Pane(win) {
    try {
      return win.document.getElementById("tabmail")?.currentAbout3Pane || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Nhường main thread một nhịp — mọi vòng quét dài (hàng nghìn hdr) phải
   * gọi định kỳ, không thì UI đứng hình suốt lúc AI "làm việc ở nền".
   */
  breathe() {
    return new Promise(resolve => {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      (win || globalThis).setTimeout(resolve, 0);
    });
  },

  /** Mọi hdr đang hiển thị trong view (đúng những gì người dùng thấy). */
  async visibleHeaders(a3) {
    const view = a3?.gDBView;
    const out = [];
    if (!view) {
      return out;
    }
    const rows = view.rowCount;
    for (let i = 0; i < rows; i++) {
      try {
        const hdr = view.getMsgHdrAt(i);
        if (hdr) {
          out.push(hdr);
        }
      } catch (e) {}
      if (i % 400 === 399) {
        await this.breathe();
      }
    }
    return out;
  },

  /** Tìm thư mục theo tên trong toàn bộ tài khoản (ưu tiên server đang mở). */
  findFolderNamed(name, preferServer) {
    const wanted = String(name || "").trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    let hit = null;
    const walk = f => {
      if (hit) {
        return;
      }
      if (f.prettyName.toLowerCase() === wanted ||
          f.name.toLowerCase() === wanted ||
          f.URI.toLowerCase().endsWith("/" + encodeURIComponent(wanted))) {
        hit = f;
        return;
      }
      for (const sub of f.subFolders) {
        walk(sub);
      }
    };
    if (preferServer) {
      walk(preferServer.rootFolder);
    }
    if (!hit) {
      for (const server of MailServices.accounts.allServers) {
        walk(server.rootFolder);
        if (hit) {
          break;
        }
      }
    }
    return hit;
  },

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
          // Phạm vi: mặc định là THƯ MỤC ĐANG MỞ — người dùng đứng ở hộp
          // thư nào thì AI làm việc ở đó, không tràn sang tài khoản khác.
          const scope = String(args.scope || "folder");
          const openFolder = this.about3Pane(win)?.gFolder || null;
          let targets = [];
          if (scope === "all" || !openFolder) {
            for (const server of MailServices.accounts.allServers) {
              if (!["imap", "pop3", "none"].includes(server.type)) {
                continue;
              }
              const inbox = server.rootFolder
                ?.getFolderWithFlags?.(Ci.nsMsgFolderFlags.Inbox);
              if (inbox) {
                targets.push(inbox);
              }
            }
          } else if (scope === "account") {
            const root = openFolder.server.rootFolder;
            const skip = Ci.nsMsgFolderFlags.Trash | Ci.nsMsgFolderFlags.Junk |
                         Ci.nsMsgFolderFlags.Drafts | Ci.nsMsgFolderFlags.Templates;
            for (const f of root.descendants) {
              if (!f.isServer && !(f.flags & skip)) {
                targets.push(f);
              }
            }
          } else {
            targets = [openFolder];
          }
          for (const folderT of targets) {
            const server = folderT.server;
            // Một thư mục hỏng không được kéo sập cả cuộc tìm — lỗi ở
            // đâu ghi lại ở đó rồi đi tiếp.
            try {
              const inbox = folderT;
              const db = inbox?.msgDatabase;
              if (!db) {
                stats.push({ server: server.prettyName, error: "no-db" });
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
                // Quét hàng nghìn hdr là việc dài trên main thread — nhả
                // ra định kỳ để người dùng vẫn cuộn, bấm, đọc thư được.
                if (checked % 500 === 0) {
                  await this.breathe();
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
                  folder: `${server.prettyName}` +
                    (scope === "account" ? ` / ${inbox.prettyName}` : ""),
                });
              }
              stats.push({ server: server.prettyName, folder: inbox.prettyName,
                           reverse, checked, kept });
            } catch (e) {
              stats.push({ server: server?.prettyName || "?",
                           error: String(e.message || e) });
            }
          }
          found.sort((a, b) => b.ts - a.ts);
          const items = found.slice(0, limit).map(({ ts, ...rest }) => rest);
          const out = { ok: true, count: items.length,
                        total_matched: found.length, items,
                        scope: scope === "all" || !openFolder ? "all"
                          : scope === "account"
                            ? `tài khoản ${openFolder.server.prettyName}`
                            : `thư mục ${openFolder.prettyName} của ` +
                              openFolder.server.prettyName };
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

        case "filter_messages": {
          const a3 = this.about3Pane(win);
          if (!a3?.quickFilterBar) {
            return { ok: false,
                     error: "Không có thư mục nào đang mở để lọc." };
          }
          const query = String(args.query || "").trim();
          // Có chỉ định thư mục/tài khoản: chuyển danh sách sang đó trước
          // (thư cần dọn thường nằm ở Hộp thư đến của một tài khoản cụ thể,
          // không phải thư mục đang mở).
          if (args.folder || args.account) {
            let target = null;
            if (args.account) {
              const acc = String(args.account).toLowerCase();
              for (const server of MailServices.accounts.allServers) {
                const ident = MailServices.accounts
                  .findAccountForServer(server)?.defaultIdentity?.email || "";
                if (server.prettyName.toLowerCase().includes(acc) ||
                    ident.toLowerCase().includes(acc)) {
                  target = args.folder
                    ? this.findFolderNamed(args.folder, server)
                    : server.rootFolder
                        .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
                  break;
                }
              }
            } else {
              target = this.findFolderNamed(args.folder, a3.gFolder?.server);
            }
            if (!target) {
              return { ok: false,
                       error: "Không tìm thấy thư mục/tài khoản yêu cầu." };
            }
            if (a3.gFolder?.URI !== target.URI) {
              a3.displayFolder(target);
              await new Promise(r => win.setTimeout(r, 900));
            }
          }
          const bar = a3.quickFilterBar;
          // Bật thanh lọc nếu đang ẩn — đúng nút người dùng hay bấm.
          try {
            if (!bar.filterer?.visible) {
              if (typeof a3.goDoCommand === "function") {
                a3.goDoCommand("cmd_showQuickFilterBar");
              } else {
                bar._showFilterBar?.(true);
              }
            }
          } catch (e) {}
          // Đi đường chính chủ của thanh lọc: đặt giá trị filter "text"
          // (giữ nguyên các ô Người gửi/Chủ đề… đang bật), để thanh tự vẽ
          // chữ vào ô <search-bar> rồi chạy tìm — không đụng DOM của ô
          // (value của nó chỉ có getter).
          try {
            const filterer = bar.filterer;
            const prev = filterer.getFilterValue?.("text") ||
                         filterer.filterValues?.text || null;
            const states = prev?.states || {
              sender: true, recipients: true, subject: true, body: false,
            };
            filterer.setFilterValue("text", { text: query, states });
            if (typeof args.unread_only === "boolean") {
              filterer.setFilterValue("unread", args.unread_only ? true : null);
            }
            bar.reflectFiltererState?.();
            // Cho người dùng THẤY từ khoá trong ô — API chính thức của
            // <search-bar> (value chỉ có getter).
            try {
              a3.document.getElementById("qfb-qs-textbox")
                ?.overrideSearchTerm?.(query);
            } catch (e) {}
            bar.updateSearch();
          } catch (e) {
            return { ok: false, error: "Không đặt được bộ lọc: " +
                                       (e.message || e) };
          }
          // Chờ view chạy xong tìm kiếm rồi mới đếm: quick filter cập
          // nhật theo timer + tìm kiếm bất đồng bộ, rowCount có thể trùng
          // số cũ ngay khi kết quả đã khác — chờ số ổn định 4 nhịp liền
          // sau ít nhất 1,2 giây, tối đa 8 giây.
          await new Promise(resolve => {
            let last = -2;
            let stable = 0;
            let ticks = 0;
            const poll = () => {
              const now = a3.gDBView?.rowCount ?? -1;
              stable = now === last ? stable + 1 : 0;
              last = now;
              ticks++;
              if ((ticks >= 8 && stable >= 4) || ticks > 53) {
                resolve();
              } else {
                win.setTimeout(poll, 150);
              }
            };
            win.setTimeout(poll, 300);
          });
          // Chỉ cần SỐ và vài mẫu — không quét cả danh sách.
          const count = a3.gDBView?.rowCount ?? 0;
          const sample = [];
          for (let i = 0; i < Math.min(5, count); i++) {
            try {
              const h = a3.gDBView.getMsgHdrAt(i);
              sample.push(`${h.mime2DecodedAuthor || ""} | ` +
                          `${h.mime2DecodedSubject || ""}`);
            } catch (e) {}
          }
          return { ok: true,
                   done: query
                     ? `đã lọc "${query}" — ${count} thư đang hiển thị`
                     : "đã bỏ lọc",
                   count, sample };
        }

        case "act_on_filtered": {
          const a3 = this.about3Pane(win);
          const hdrs = await this.visibleHeaders(a3);
          if (!hdrs.length) {
            return { ok: false, error: "Danh sách đang trống — lọc trước đã." };
          }
          const action = String(args.action || "");
          const byFolder = new Map();
          for (const h of hdrs) {
            const key = h.folder.URI;
            if (!byFolder.has(key)) {
              byFolder.set(key, { folder: h.folder, list: [] });
            }
            byFolder.get(key).list.push(h);
          }
          const label = {
            trash: "chuyển vào Thùng rác", move: "chuyển thư mục",
            tag: "gắn nhãn", read: "đánh dấu đã đọc", archive: "lưu trữ",
          }[action];
          if (!label) {
            return { ok: false, error: `Hành động không hỗ trợ: ${action}` };
          }
          let target = null;
          if (action === "move") {
            target = this.findFolderNamed(args.folder,
                                          hdrs[0].folder.server);
            if (!target) {
              return { ok: false,
                       error: `Không tìm thấy thư mục "${args.folder}".` };
            }
          }
          if (!this.confirm(win, "hMail AI",
                `${label[0].toUpperCase() + label.slice(1)} ${hdrs.length} ` +
                "thư đang hiển thị trong danh sách" +
                (target ? ` sang "${target.prettyName}"` : "") +
                (action === "tag" ? ` với nhãn "${args.tag}"` : "") +
                "?\n\n(Hoàn tác được bằng Ctrl+Z ngay sau đó.)")) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          // Nhãn: giải quyết key một lần trước vòng lặp.
          let tagKey = null;
          if (action === "tag") {
            const wanted = String(args.tag || "").trim();
            for (const t of MailServices.tags.getAllTags()) {
              if (t.tag.toLowerCase() === wanted.toLowerCase()) {
                tagKey = t.key;
              }
            }
            if (!tagKey) {
              MailServices.tags.addTagForKey(
                wanted.toLowerCase().replace(/[^a-z0-9]/g, "") || "hmailai",
                wanted, "#0F6CBD", "");
              for (const t of MailServices.tags.getAllTags()) {
                if (t.tag === wanted) {
                  tagKey = t.key;
                }
              }
            }
          }

          // Hàng nghìn thư trong MỘT lệnh copyMessages là một giao dịch
          // IMAP khổng lồ trên main thread — cả app đứng hình. Chia lô
          // 200 thư, chờ từng lô xong (copy listener) rồi mới lô kế, giữa
          // hai lô nhường main thread; tiến độ hiện trên thanh bận và
          // trong panel. Chạy NỀN: trả lời model ngay, việc dọn tự chạy.
          // Lô lớn hơn khi thư mục đang offline / cục bộ (không đi mạng
          // từng thư); IMAP chưa offline thì lô vừa phải để tiến độ nhúc
          // nhích và Dừng phản hồi nhanh.
          const firstFolder = hdrs[0].folder;
          const localish = firstFolder.server.type !== "imap" ||
            firstFolder.getFlag(Ci.nsMsgFolderFlags.Offline);
          const BATCH = localish ? 500 : 200;
          const jobId = "hmail-ai-bulk";
          const busy = typeof hMailBusy !== "undefined" ? hMailBusy
                                                        : win.hMailBusy;
          const total = hdrs.length;
          const say = text => {
            try {
              win.hMailAI?.notify?.(win, text);
            } catch (e) {}
          };
          // Nút Dừng: một dòng hành động trong panel mang nút; đóng app
          // giữa chừng cũng đi qua cùng cờ này (busy.onStop).
          let stopped = false;
          const stopRow = (() => {
            try {
              const doc = win.document;
              const log = doc.getElementById("hmail-ai-log");
              if (!log) {
                return null;
              }
              const NS = "http://www.w3.org/1999/xhtml";
              const row = doc.createElementNS(NS, "div");
              row.className = "hmail-ai-turn action hmail-ai-bulk-row";
              const text = doc.createElementNS(NS, "span");
              text.className = "hmail-ai-bulk-text";
              text.textContent = `Đang ${label} 0/${total} thư…`;
              const stopBtn = doc.createElementNS(NS, "button");
              stopBtn.className = "hmail-ai-btn";
              stopBtn.textContent = "Dừng";
              stopBtn.addEventListener("click", () => {
                stopped = true;
                stopBtn.disabled = true;
                stopBtn.textContent = "Đang dừng…";
              });
              row.append(text, stopBtn);
              log.appendChild(row);
              log.scrollTop = log.scrollHeight;
              return { row, text, stopBtn };
            } catch (e) {
              return null;
            }
          })();
          try {
            busy?.onStop(jobId, () => { stopped = true; });
          } catch (e) {}
          const copyBatch = (folder, list, dest, isMove) =>
            new Promise(resolve => {
              const listener = {
                QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
                onStartCopy() {},
                onProgress() {},
                setMessageKey() {},
                getMessageId() {
                  return null;
                },
                onStopCopy(status) {
                  resolve(Components.isSuccessCode(status));
                },
              };
              try {
                MailServices.copy.copyMessages(folder, list, dest, isMove,
                                               listener, a3.msgWindow, true);
              } catch (e) {
                resolve(false);
              }
            });
          const idle = () => new Promise(r => win.setTimeout(r, 60));

          const run = async () => {
            let done = 0;
            let failed = 0;
            try {
              busy?.start(jobId, `${label[0].toUpperCase() + label.slice(1)} ` +
                          `${total} thư`, "Việc dọn thư sẽ dừng dở dang.");
            } catch (e) {}
            for (const { folder, list } of byFolder.values()) {
              let dest = null;
              if (action === "trash") {
                dest = folder.server.rootFolder
                  .getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
                if (!dest) {
                  failed += list.length;
                  continue;
                }
              } else if (action === "move") {
                dest = target;
              }
              for (let i = 0; i < list.length; i += BATCH) {
                if (stopped) {
                  break;
                }
                const chunk = list.slice(i, i + BATCH);
                let ok = true;
                try {
                  if (action === "trash" || action === "move") {
                    ok = await copyBatch(folder, chunk, dest, true);
                  } else if (action === "archive") {
                    const { MessageArchiver } = ChromeUtils.importESModule(
                      "resource:///modules/MessageArchiver.sys.mjs");
                    const archiver = new MessageArchiver();
                    archiver.msgWindow = a3.msgWindow;
                    await new Promise(resolve => {
                      archiver.oncomplete = resolve;
                      archiver.archiveMessages(chunk);
                      // Không có oncomplete ở bản này thì đừng chờ mãi.
                      win.setTimeout(resolve, 4000);
                    });
                  } else if (action === "read") {
                    folder.markMessagesRead(chunk, true);
                  } else if (action === "tag") {
                    folder.addKeywordsToMessages(chunk, tagKey);
                  }
                } catch (e) {
                  ok = false;
                  Cu.reportError("hMail act_on_filtered batch: " + e);
                }
                if (ok) {
                  done += chunk.length;
                } else {
                  failed += chunk.length;
                }
                const pct = Math.round(((done + failed) / total) * 100);
                try {
                  busy?.update(jobId, `${done + failed}/${total} (${pct}%)`);
                } catch (e) {}
                say(`Đang ${label}: ${done + failed}/${total} thư…`);
                if (stopRow) {
                  stopRow.text.textContent =
                    `Đang ${label} ${done + failed}/${total} thư (${pct}%)…`;
                }
                await idle();
              }
              if (stopped) {
                break;
              }
            }
            try {
              busy?.end(jobId);
            } catch (e) {}
            const summary = (stopped ? "Đã dừng theo yêu cầu: " : "Hoàn tất: ") +
              `đã ${label} ${done}/${total} thư` +
              (failed ? ` — ${failed} thư không xử lý được` : "") +
              (stopped ? ` — ${total - done - failed} thư chưa đụng tới` : "");
            say(summary + ".");
            if (stopRow) {
              stopRow.text.textContent = summary;
              stopRow.stopBtn.remove();
            } else {
              try {
                win.hMailAI?.addTurn?.(win, "action", summary);
              } catch (e) {}
            }
          };
          // Không await: trả lời model ngay để panel không "suy nghĩ" suốt
          // 5 phút; tiến độ đi qua thanh trạng thái và thanh bận.
          run().catch(e => Cu.reportError("hMail act_on_filtered: " + e));
          return { ok: true,
                   done: `đã bắt đầu ${label} ${total} thư ở nền — chạy theo ` +
                         `lô ${BATCH} thư, tiến độ hiện trên thanh trạng ` +
                         "thái; app vẫn dùng bình thường",
                   background: true, total };
        }

        case "create_filter": {
          const server = this.serverFor(args.account, hdr);
          if (!server) {
            return { ok: false, error: "Không tìm thấy tài khoản để đặt bộ lọc." };
          }
          const action = String(args.action || "");
          if (!this.ACTION_LABELS[action]) {
            return { ok: false, error: `Hành động không hỗ trợ: ${action}` };
          }
          const spec = {
            name: String(args.name || "").trim() || "Bộ lọc hMail",
            enabled: true,
            sender_contains: String(args.sender_contains || "").trim(),
            subject_contains: String(args.subject_contains || "").trim(),
            recipient_contains: String(args.recipient_contains || "").trim(),
            after_days: Math.max(0, Number(args.after_days) || 0),
            action,
            folder: "", folderUri: "", tag: String(args.tag || "").trim(),
          };
          if (!spec.sender_contains && !spec.subject_contains &&
              !spec.recipient_contains) {
            return { ok: false,
                     error: "Bộ lọc cần ít nhất một điều kiện (người gửi / " +
                            "tiêu đề / người nhận)." };
          }
          if (action === "move") {
            const dest = await this.destFolder(win, server, args.folder);
            if (!dest) {
              return { ok: false,
                       error: `Không tạo được thư mục "${args.folder || ""}".` };
            }
            spec.folder = dest.prettyName;
            spec.folderUri = dest.URI;
          }
          const when = spec.after_days > 0
            ? `\n\nhMail tự quét Hộp thư đến mỗi giờ và xử lý thư đã quá ` +
              `${spec.after_days} ngày (bộ lọc kiểu này không chạy lúc thư ` +
              "vừa đến, vì lúc đó thư mới 0 ngày tuổi)."
            : "\n\nÁp dụng cho thư đến sau này" +
              (args.apply_now ? " và chạy ngay trên Hộp thư đến" : "") + ".";
          if (!this.confirm(win, "hMail AI — tạo bộ lọc",
                `Tạo bộ lọc "${spec.name}" cho tài khoản ` +
                `${server.prettyName}:\n\n${this.describeSpec(spec)}` +
                when + "\n\nSửa/xoá được trong Công cụ ▸ Bộ lọc thư.")) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }

          const list = server.getFilterList(this.msgWindowOf(win));
          const filter = this.buildFilter(list, spec);
          list.insertFilterAt(0, filter);
          list.saveToDefaultFile();
          this.rememberAged(server, spec.name, spec.after_days > 0);

          let applied = "";
          if (spec.after_days > 0) {
            // Quét ngay một lượt: thư cũ hơn N ngày đã nằm sẵn trong hộp.
            try {
              await this.runAgedFilters(win);
              applied = "; đã quét ngay một lượt và sẽ tự quét mỗi giờ";
            } catch (e) {
              applied = "; sẽ tự quét mỗi giờ";
            }
          } else if (args.apply_now) {
            try {
              const inbox = server.rootFolder
                .getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
              const tmp = MailServices.filters.getTempFilterList(inbox);
              tmp.insertFilterAt(0, filter);
              MailServices.filters.applyFiltersToFolders(
                tmp, [inbox], this.msgWindowOf(win));
              applied = " và đã chạy lên Hộp thư đến";
            } catch (e) {
              applied = " (chạy ngay không thành công: " + (e.message || e) + ")";
            }
          }
          return { ok: true,
                   done: `đã tạo bộ lọc "${spec.name}" ` +
                         `(${this.describeSpec(spec)})${applied}; xem ở ` +
                         "Công cụ ▸ Bộ lọc thư" };
        }

        case "list_filters": {
          const server = this.serverFor(args.account, hdr);
          if (!server) {
            return { ok: false, error: "Không tìm thấy tài khoản." };
          }
          const list = server.getFilterList(this.msgWindowOf(win));
          const filters = [];
          for (let i = 0; i < list.filterCount; i++) {
            const spec = this.filterSpec(list.getFilterAt(i));
            filters.push({
              name: spec.name, enabled: spec.enabled,
              rule: this.describeSpec(spec),
              after_days: spec.after_days,
              runs_on_incoming: spec.after_days === 0,
            });
          }
          return { ok: true, account: server.prettyName,
                   total: filters.length, filters,
                   hint: filters.length ? "" :
                     "Tài khoản này chưa có bộ lọc nào." };
        }

        case "update_filter": {
          const server = this.serverFor(args.account, hdr);
          if (!server) {
            return { ok: false, error: "Không tìm thấy tài khoản." };
          }
          const list = server.getFilterList(this.msgWindowOf(win));
          const filter = this.findFilter(list, args.name);
          if (!filter) {
            return { ok: false,
                     error: `Không có bộ lọc nào tên giống "${args.name}" ` +
                            `trong tài khoản ${server.prettyName}. Gọi ` +
                            "list_filters để xem tên chính xác." };
          }
          const before = this.filterSpec(filter);
          const spec = Object.assign({}, before);
          const has = k => args[k] !== undefined && args[k] !== null;
          if (has("rename") && String(args.rename).trim()) {
            spec.name = String(args.rename).trim();
          }
          for (const key of ["sender_contains", "subject_contains",
                             "recipient_contains"]) {
            if (has(key)) {
              spec[key] = String(args[key]).trim();
            }
          }
          if (has("after_days")) {
            spec.after_days = Math.max(0, Number(args.after_days) || 0);
          }
          if (has("enabled")) {
            spec.enabled = !!args.enabled;
          }
          if (has("action")) {
            const act = String(args.action);
            if (!this.ACTION_LABELS[act]) {
              return { ok: false, error: `Hành động không hỗ trợ: ${act}` };
            }
            spec.action = act;
            if (act !== "move") {
              spec.folder = "";
              spec.folderUri = "";
            }
          }
          if (has("tag")) {
            spec.tag = String(args.tag).trim();
          }
          if (spec.action === "move" && (has("folder") || !spec.folderUri)) {
            const dest = await this.destFolder(win, server,
                                               args.folder || spec.folder);
            if (!dest) {
              return { ok: false, error: "Thiếu thư mục đích cho hành động " +
                                         "chuyển thư mục." };
            }
            spec.folder = dest.prettyName;
            spec.folderUri = dest.URI;
          }
          if (!spec.sender_contains && !spec.subject_contains &&
              !spec.recipient_contains) {
            return { ok: false,
                     error: "Bộ lọc cần ít nhất một điều kiện người gửi / " +
                            "tiêu đề / người nhận." };
          }
          const lost = before.other.length
            ? "\n\nLưu ý: bộ lọc này có điều kiện đặt tay mà trợ lý không " +
              "đọc được — sửa qua đây sẽ làm mất chúng."
            : "";
          if (!this.confirm(win, "hMail AI — sửa bộ lọc",
                `Sửa bộ lọc "${before.name}" (tài khoản ` +
                `${server.prettyName}):\n\nTrước: ${this.describeSpec(before)}` +
                `\nSau:   ${this.describeSpec(spec)}` +
                (spec.after_days > 0
                  ? `\n\nhMail sẽ tự quét Hộp thư đến mỗi giờ để xử lý thư ` +
                    `đã quá ${spec.after_days} ngày.` : "") + lost)) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          const index = Math.max(0, this.filterIndex(list, filter));
          list.removeFilterAt(index);
          const fresh = this.buildFilter(list, spec);
          list.insertFilterAt(index, fresh);
          list.saveToDefaultFile();
          this.rememberAged(server, before.name, false);
          this.rememberAged(server, spec.name, spec.after_days > 0);
          let swept = "";
          if (spec.after_days > 0 && spec.enabled) {
            try {
              await this.runAgedFilters(win);
              swept = "; đã quét ngay một lượt";
            } catch (e) {}
          }
          return { ok: true,
                   done: `đã sửa bộ lọc "${spec.name}": ` +
                         `${this.describeSpec(spec)}${swept}` };
        }

        case "delete_filter": {
          const server = this.serverFor(args.account, hdr);
          if (!server) {
            return { ok: false, error: "Không tìm thấy tài khoản." };
          }
          const list = server.getFilterList(this.msgWindowOf(win));
          const filter = this.findFilter(list, args.name);
          if (!filter) {
            return { ok: false,
                     error: `Không có bộ lọc nào tên giống "${args.name}".` };
          }
          const spec = this.filterSpec(filter);
          if (!this.confirm(win, "hMail AI — xoá bộ lọc",
                `Xoá hẳn bộ lọc "${spec.name}" của tài khoản ` +
                `${server.prettyName}?\n\n${this.describeSpec(spec)}\n\n` +
                "Thư đã xử lý trước đó giữ nguyên; chỉ bộ lọc bị xoá.")) {
            return { ok: false, error: "Người dùng đã từ chối." };
          }
          list.removeFilterAt(this.filterIndex(list, filter));
          list.saveToDefaultFile();
          this.rememberAged(server, spec.name, false);
          return { ok: true, done: `đã xoá bộ lọc "${spec.name}"` };
        }

        case "open_window": {
          const screen = String(args.screen || "");
          const opened = this.openScreen(win, screen);
          if (!opened) {
            return { ok: false,
                     error: `Không mở được màn hình "${screen}".` };
          }
          return { ok: true, done: `đã mở ${opened}` };
        }

        case "set_reminder": {
          return this.createReminder(win, hdr, args);
        }

        case "test_filters": {
          return this.diagnoseFilters(win, hdr, args.name_contains);
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
// Đầu dò nạp module (pref hmail.debug.loadprobe = "run"): báo hMailInsight
// có tồn tại không, và thử nạp lại mailinsight.js để bắt đúng SyntaxError.
(function hMailLoadProbe() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.loadprobe", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  setTimeout(async () => {
    let out = "hMailInsight=" + (typeof hMailInsight);
    const mark = step => {
      try {
        Services.prefs.setCharPref("hmail.debug.loadprobe", "step:" + step);
        Services.prefs.savePrefFile(null);
      } catch (e) {}
    };
    mark("start");
    try {
      // Lời nhắc thật: tạo trong lịch, kiểm tra tồn tại + báo thức + lặp,
      // rồi xoá để không để lại rác.
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const res = await hMailAI.runTool(win, "set_reminder", {
        title: "hMail selftest reminder", when: "tomorrow 09:00",
        repeat: "daily", until: "2026-08-25", notes: "tự kiểm",
      });
      out += " reminder=" + (res.ok ? "ok" : "ERR:" + res.error);
      if (res.ok) {
        const { cal } = ChromeUtils.importESModule(
          "resource:///modules/calendar/calUtils.sys.mjs");
        let found = null;
        for (const c of cal.manager.getCalendars()) {
          try {
            const items = await c.getItemsAsArray(
              Ci.calICalendar.ITEM_FILTER_TYPE_EVENT |
              Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL, 0, null, null);
            found = items.find(i => i.title === "hMail selftest reminder");
            if (found) {
              out += " inCal=" + c.name + " alarms=" + found.getAlarms().length +
                " recur=" + (found.recurrenceInfo ? "yes" : "no");
              await c.deleteItem(found);
              out += " cleaned=yes";
              break;
            }
          } catch (e) {}
        }
        if (!found) {
          out += " inCal=NOT-FOUND";
        }
      }
      out += " done=" + res.done;
    } catch (e) {
      out += " analyze=ERR " + (e.message || e) + " @" +
             String(e.stack || "").split("\n")[0].slice(-80);
    }
    try {
      Services.prefs.setCharPref("hmail.debug.loadprobe", out.slice(0, 600));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  }, 12000);
})();

// ---------------------------------------------------------------------------
// Tự kiểm create_filter (pref hmail.debug.rulestest = "run"): tạo một bộ lọc
// thật (điều kiện + hành động gắn nhãn) trên tài khoản mặc định — hộp xác
// nhận được bấm hộ — kiểm tra nó nằm trong danh sách bộ lọc, rồi XOÁ NGAY
// để không để rác lại.
(function hMailRulesSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.rulestest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.rulestest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const origConfirm = hMailAI.confirm;
    hMailAI.confirm = () => true;
    try {
      const NAME = "hMail-selftest-" + Date.now();
      const res = await hMailAI.runTool(win, "create_filter", {
        name: NAME, sender_contains: "selftest@example.invalid",
        action: "tag", tag: "SelfTest",
      });
      const server = hMailAI.serverFor("", null);
      const list = server.getFilterList(hMailAI.msgWindowOf(win));
      let found = -1;
      for (let i = 0; i < list.filterCount; i++) {
        if (list.getFilterAt(i).filterName === NAME) {
          found = i;
        }
      }
      let terms = 0, actions = 0;
      if (found >= 0) {
        const f = list.getFilterAt(found);
        terms = f.searchTerms.length;
        actions = f.actionCount;
        list.removeFilterAt(found);
        list.saveToDefaultFile();
      }
      report(JSON.stringify({ ok: res.ok, done: res.done, error: res.error,
                              foundInList: found >= 0, terms, actions,
                              cleaned: found >= 0 }));
    } catch (e) {
      report("err: " + (e.message || e));
    } finally {
      hMailAI.confirm = origConfirm;
    }
  }, 15000);
})();

// ---------------------------------------------------------------------------
// Tự kiểm filter_messages (pref hmail.debug.filtertest = "run:<từ khoá>"):
// đổ từ khoá vào ô lọc nhanh của thư mục đang mở, chờ view cập nhật, ghi số
// thư hiển thị + mẫu; xong bỏ lọc trả lại như cũ.
(function hMailFilterSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.filtertest", "");
  } catch (e) {}
  if (!mode.startsWith("run:")) {
    return;
  }
  const query = mode.slice(4);
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.filtertest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const res = await hMailAI.runTool(win, "filter_messages",
        { query, account: "quyet@haoquangviet.com" });
      const visible = hMailAI.about3Pane(win)?.quickFilterBar?.filterer?.visible;
      let box = "";
      try {
        box = hMailAI.about3Pane(win)?.document
          .getElementById("qfb-qs-textbox")?.value ?? "";
      } catch (e) {
        box = "(getter lỗi)";
      }
      await hMailAI.runTool(win, "filter_messages", { query: "" });
      report(JSON.stringify({ ok: res.ok, count: res.count, barVisible: visible,
                              boxValue: box, sample: res.sample?.slice(0, 2),
                              error: res.error || null }));
    } catch (e) {
      report("err: " + (e.message || e));
    }
  }, 15000);
})();

// ---------------------------------------------------------------------------
// Tự kiểm ĐẦU-CUỐI với model thật (pref hmail.debug.aitest = "run"): không
// mở thư nào, hỏi "hôm nay có thư gì" qua đúng đường ask() của panel — model
// PHẢI gọi search_messages. Ghi lại: có gọi tool không, tool nào, và 200 ký
// tự đầu câu trả lời.
(function hMailAiToolSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.aitest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.aitest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.aitest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const called = [];
      const origRun = hMailAI.runTool.bind(hMailAI);
      hMailAI.runTool = async (w, name, args) => {
        called.push(name + "(" + JSON.stringify(args || {}).slice(0, 60) + ")");
        return origRun(w, name, args);
      };
      const turns = [{
        role: "user",
        text: "Bạn là trợ lý trong ứng dụng thư hMail Desktop. Hiện KHÔNG " +
              "có thư nào đang mở, nhưng bạn có công cụ tra cứu hộp thư: " +
              "search_messages, read_message, open_message, compose_new. " +
              "Người dùng hỏi về thư thì GỌI search_messages trước.",
      }, { role: "user", text: "tìm kiếm tất cả các thư dạng root@" }];
      const t0 = Date.now();
      // Đo UI có bị đứng không: một tick 50ms phải chạy đều trong lúc AI
      // làm việc; đếm số tick bị trễ quá 400ms.
      let ticks = 0, stalls = 0, lastTick = Date.now();
      const tickTimer = win.setInterval(() => {
        const now = Date.now();
        if (now - lastTick > 400) {
          stalls++;
        }
        lastTick = now;
        ticks++;
      }, 50);
      const reply = await hMailAI.ask(turns, { win, allowActions: true,
                                               onAction: () => {} });
      win.clearInterval(tickTimer);
      hMailAI.runTool = origRun;
      const hasChoices = /\[\[\s*ch[oọ]n\s*:/i.test(String(reply));
      report((called.length ? "ok" : "err-no-tool") +
             " tools=" + JSON.stringify(called) +
             " choices=" + hasChoices +
             " ms=" + (Date.now() - t0) + " ticks=" + ticks +
             " stalls>400ms=" + stalls +
             " reply=" + String(reply).replace(/\s+/g, " ").slice(-220));
    } catch (e) {
      report("err: " + hMailAI.explain(e));
    }
  }, 15000);
})();

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
        scope: res.scope, error: res.error || null,
        first: res.items?.[0]
          ? `${res.items[0].from} | ${res.items[0].subject}` : null,
        stats: res.stats,
      }));
    } catch (e) {
      report("err: " + (e.message || e));
    }
  }, 15000);
})();

// ---------------------------------------------------------------------------
// Tự kiểm bộ lọc theo thời gian và sửa bộ lọc (pref hmail.debug.agedtest =
// "run"): tạo bộ lọc "sau 3 ngày", đọc lại xem điều kiện tuổi có thật và cờ
// "khi nhận thư mới" đã TẮT chưa (bật cũng vô nghĩa vì thư mới 0 ngày tuổi),
// sửa thành 7 ngày kèm đổi tên qua update_filter (phải là SỬA, không đẻ thêm
// bộ lọc), chạy thử vòng quét, rồi xoá sạch. Hộp xác nhận được bấm hộ.
(function hMailAgedFilterSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.agedtest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.agedtest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.agedtest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const origConfirm = hMailAI.confirm;
    hMailAI.confirm = () => true;
    const out = {};
    try {
      const NAME = "hMail-agedtest-" + Math.floor(Date.now() / 1000);
      const NEW = NAME + "-doi-ten";
      const created = await hMailAI.runTool(win, "create_filter", {
        name: NAME, sender_contains: "agedtest@example.invalid",
        action: "delete", after_days: 3,
      });
      out.created = created.ok ? created.done : created.error;

      const server = hMailAI.serverFor("", null);
      const list = server.getFilterList(hMailAI.msgWindowOf(win));
      const before = hMailAI.findFilter(list, NAME);
      out.foundAfterCreate = !!before;
      if (before) {
        const spec = hMailAI.filterSpec(before);
        out.after_days = spec.after_days;
        out.action = spec.action;
        out.runsOnIncoming =
          !!(before.filterType & Ci.nsMsgFilterType.InboxRule);
        out.rule = hMailAI.describeSpec(spec);
      }
      out.registry = hMailAI.agedRegistry().filter(e => e.name === NAME).length;
      out.countBefore = list.filterCount;

      const updated = await hMailAI.runTool(win, "update_filter", {
        name: NAME, rename: NEW, after_days: 7,
      });
      out.updated = updated.ok ? updated.done : updated.error;
      const list2 = server.getFilterList(hMailAI.msgWindowOf(win));
      out.countAfterUpdate = list2.filterCount;
      const after = hMailAI.findFilter(list2, NEW);
      out.after_days2 = after ? hMailAI.filterSpec(after).after_days : -1;
      out.oldNameGone = !hMailAI.findFilter(list2, NAME);
      out.registry2 = hMailAI.agedRegistry().filter(e => e.name === NEW).length;

      const listed = await hMailAI.runTool(win, "list_filters", {});
      out.listed = listed.ok ? listed.total : listed.error;

      out.swept = await hMailAI.runAgedFilters(win);

      const removed = await hMailAI.runTool(win, "delete_filter",
                                            { name: NEW });
      out.deleted = removed.ok ? removed.done : removed.error;
      const list3 = server.getFilterList(hMailAI.msgWindowOf(win));
      out.gone = !hMailAI.findFilter(list3, NEW);
      out.registry3 = hMailAI.agedRegistry().filter(e => e.name === NEW).length;

      const opened = await hMailAI.runTool(win, "open_window",
                                           { screen: "tracking" });
      out.openWindow = opened.ok ? opened.done : opened.error;

      report(JSON.stringify(out));
    } catch (e) {
      out.err = String(e.message || e);
      report(JSON.stringify(out));
    } finally {
      hMailAI.confirm = origConfirm;
    }
  }, 15000);
})();
