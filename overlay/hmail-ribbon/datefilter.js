/* hMail Desktop — lọc nhanh theo thời gian
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Thanh Lọc nhanh của Thunderbird biết Chưa đọc, Gắn sao, Liên hệ, Nhãn,
 * Đính kèm — nhưng không biết "thư tuần này" hay "thư cũ hơn ba tháng",
 * hai câu hỏi thường gặp nhất trên hộp thư mười nghìn thư. Đây là nhóm
 * "Thời gian" thêm vào chính menu ấy: các mốc nhanh (hôm nay, 7 ngày, cũ
 * hơn 30 ngày…) và hai mục nhập ngày cụ thể — Sau ngày… / Trước ngày…
 *
 * Cắm đúng cơ chế mở rộng của thanh lọc: QuickFilterManager.defineFilter,
 * chính cách Chưa đọc/Gắn sao được định nghĩa — filter của hMail đóng góp
 * điều kiện nsMsgSearchAttrib.Date vào cùng gói tìm kiếm, ghép được với ô
 * tìm kiếm và mọi bộ lọc khác, và tự dọn khi người dùng bấm xoá lọc.
 */

"use strict";

var hMailDateFilter = {
  NAME: "hmailDate",
  PRESETS: [
    { id: "today", label: "Hôm nay", days: 1, newer: true },
    { id: "7d", label: "7 ngày qua", days: 7, newer: true },
    { id: "30d", label: "30 ngày qua", days: 30, newer: true },
    { id: "older30", label: "Cũ hơn 30 ngày", days: 30, newer: false },
    { id: "older90", label: "Cũ hơn 90 ngày", days: 90, newer: false },
    { id: "older365", label: "Cũ hơn 1 năm", days: 365, newer: false },
  ],

  init(win) {
    try {
      this.defineFilter();
      win.setInterval(() => {
        try {
          const a3 = win.document.getElementById("tabmail")?.currentAbout3Pane;
          if (a3?.document) {
            this.attachMenu(win, a3);
          }
        } catch (e) {}
      }, 1500);
    } catch (e) {
      Cu.reportError("hMail date filter init failed: " + e);
    }
  },

  /**
   * Định nghĩa filter với QuickFilterManager (một lần cho cả app — module
   * là singleton). Giá trị filter: {after: ms|null, before: ms|null,
   * label} — null nghĩa là không có bộ lọc.
   */
  defineFilter() {
    const { QuickFilterManager } = ChromeUtils.importESModule(
      "resource:///modules/QuickFilterManager.sys.mjs");
    if (QuickFilterManager.filterDefsByName[this.NAME]) {
      return;
    }
    QuickFilterManager.defineFilter({
      name: this.NAME,
      // Không có nút riêng trên thanh (domId trỏ vào id không tồn tại để
      // _bindUI bỏ qua); trạng thái điều khiển qua menu và chip do hMail
      // tự vẽ trong paintChip.
      domId: "hmail-date-nonode",
      appendTerms(aTermCreator, aTerms, aFilterValue) {
        if (!aFilterValue) {
          return;
        }
        const add = (op, ms) => {
          const term = aTermCreator.createTerm();
          term.attrib = Ci.nsMsgSearchAttrib.Date;
          term.op = op;
          const value = term.value;
          value.attrib = Ci.nsMsgSearchAttrib.Date;
          // nsMsgSearchValue.date là PRTime (micro giây).
          value.date = ms * 1000;
          term.value = value;
          term.booleanAnd = true;
          aTerms.push(term);
        };
        if (aFilterValue.after) {
          add(Ci.nsMsgSearchOp.IsAfter, aFilterValue.after);
        }
        if (aFilterValue.before) {
          add(Ci.nsMsgSearchOp.IsBefore, aFilterValue.before);
        }
      },
      // Không lưu qua các lần chuyển thư mục kiểu "sticky" — người dùng
      // đặt lại khi cần; nhưng khi thanh còn mở thì giữ nguyên.
      propagateState(aOld, aSticky) {
        return aSticky ? aOld : null;
      },
      reflectInDOM() {},
      onCommand() {
        return [null, true];
      },
    });
  },

  midnight(shiftDays = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + shiftDays);
    return d.getTime();
  },

  valueFor(preset) {
    if (preset.newer) {
      return { after: this.midnight(-(preset.days - 1)) - 1, before: null,
               label: preset.label };
    }
    return { after: null, before: this.midnight(-preset.days),
             label: preset.label };
  },

  fmt(ms) {
    return new Date(ms).toLocaleDateString("vi-VN");
  },

  /** Hỏi một ngày (dd/mm/yyyy); trả về mốc 0h ngày đó theo giờ máy, hoặc null. */
  askDate(win, title) {
    const input = { value: new Date().toLocaleDateString("vi-VN") };
    if (!Services.prompt.prompt(win, title,
          "Nhập ngày (ngày/tháng/năm), ví dụ 15/08/2026:", input, null, {})) {
      return null;
    }
    const m = /^\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\s*$/.exec(input.value);
    if (!m) {
      Services.prompt.alert(win, title, "Ngày không hợp lệ. Dùng dạng " +
                            "ngày/tháng/năm, ví dụ 15/08/2026.");
      return null;
    }
    const d = new Date(+m[3], +m[2] - 1, +m[1], 0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d.getTime();
  },

  setValue(a3, value) {
    const bar = a3.quickFilterBar;
    if (!bar?.filterer) {
      return;
    }
    if (!bar.filterer.visible) {
      try {
        a3.goDoCommand("cmd_showQuickFilterBar");
      } catch (e) {
        bar._showFilterBar?.(true);
      }
    }
    bar.filterer.setFilterValue(this.NAME, value);
    bar.reflectFiltererState?.();
    bar.updateSearch();
    this.paintChip(a3);
  },

  /** Chip do hMail tự vẽ theo trạng thái filter (reflectInDOM có thể bị
   *  thanh lọc gọi với trạng thái cũ giữa chừng nên không tin nó). */
  paintChip(a3) {
    try {
      const chip = a3.document.getElementById("hmail-date-chip");
      if (!chip) {
        return;
      }
      const value = this.currentValue(a3);
      chip.hidden = !value;
      if (value) {
        chip.textContent = "⏱ " + value.label + "  ✕";
      }
    } catch (e) {}
  },

  currentValue(a3) {
    try {
      return a3.quickFilterBar?.filterer?.filterValues?.[this.NAME] || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Thanh lọc gốc tìm lại gần như NGAY sau mỗi ký tự (deferredUpdateSearch
   * là setTimeout không độ trễ, ô nhập chỉ đợi 250 ms): gõ "ovhcloud" trên
   * thư mục trăm nghìn thư là tám lần quét chồng nhau, app đứng hình. Bọc
   * lại với độ trễ theo cỡ thư mục — chờ người dùng gõ xong mới tìm.
   */
  tameSearchDelay(a3) {
    const bar = a3.quickFilterBar;
    if (!bar || bar._hmailDebounced || typeof bar.updateSearch !== "function") {
      return;
    }
    bar._hmailDebounced = true;
    const original = bar.updateSearch.bind(bar);
    let timer = null;
    let lastTerms = "";
    bar.deferredUpdateSearch = function () {
      const count = a3.gFolder?.getTotalMessages?.(false) || 0;
      // 250 ms cho thư mục nhỏ, tới 900 ms cho hộp trăm nghìn thư.
      const delay = count < 5000 ? 250 : count < 30000 ? 500 :
                    count < 100000 ? 700 : 900;
      a3.clearTimeout(timer);
      timer = a3.setTimeout(() => {
        // Từ khoá không đổi (ví dụ chỉ nháy chuột) thì đừng quét lại.
        let terms = "";
        try {
          terms = JSON.stringify(bar.filterer?.filterValues || {});
        } catch (e) {}
        if (terms === lastTerms) {
          return;
        }
        lastTerms = terms;
        original();
      }, delay);
    };
    // Gọi thẳng updateSearch (đổi thư mục, bấm nút) thì ghi nhớ trạng thái
    // để lần gõ sau so sánh đúng.
    bar.updateSearch = function (...args) {
      try {
        lastTerms = JSON.stringify(bar.filterer?.filterValues || {});
      } catch (e) {}
      return original(...args);
    };
  },

  /** Cắm nhóm "Thời gian" vào popup của nút bộ lọc + chip trên thanh. */
  attachMenu(win, a3) {
    const doc = a3.document;
    const bar = doc.getElementById("quick-filter-bar");
    if (!bar) {
      return;
    }
    this.tameSearchDelay(a3);
    // Chip hiển thị bộ lọc đang áp, ngay cạnh nhãn số kết quả.
    if (!doc.getElementById("hmail-date-chip")) {
      const host = doc.getElementById("qfb-results-label")?.parentElement ||
                   bar;
      const chip = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      chip.id = "hmail-date-chip";
      chip.type = "button";
      chip.className = "hmail-date-chip";
      chip.title = "Đang lọc theo thời gian — bấm để bỏ";
      chip.hidden = !this.currentValue(a3);
      chip.addEventListener("click", () => this.setValue(a3, null));
      host.appendChild(chip);
    } else {
      // Thanh lọc tự dọn filter khi người dùng bấm xoá / đổi thư mục —
      // chip phải theo kịp trạng thái thật.
      this.paintChip(a3);
    }

    // Popup của nút "bộ lọc" (⚙) — id đổi theo đời TB, tìm theo mục con
    // quen thuộc của nó.
    const popup = doc.getElementById("quickFilterButtonsContext") ||
      doc.getElementById("quickFilterButtonsContextUnreadToggle")
        ?.closest("menupopup");
    if (!popup || popup.dataset.hmailDate) {
      return;
    }
    popup.dataset.hmailDate = "1";

    const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    const mk = (tag, attrs = {}) => {
      const n = doc.createElementNS(XUL, tag);
      for (const [k, v] of Object.entries(attrs)) {
        n.setAttribute(k, v);
      }
      return n;
    };
    popup.appendChild(mk("menuseparator"));
    popup.appendChild(mk("menuitem", { label: "Thời gian", disabled: "true" }));
    const items = [];
    const radio = (label, id, onCommand) => {
      const item = mk("menuitem", { type: "radio", name: "hmail-date",
                                    label, closemenu: "auto" });
      item.dataset.choice = id;
      item.addEventListener("command", onCommand);
      popup.appendChild(item);
      items.push(item);
      return item;
    };
    radio("Mọi lúc", "", () => this.setValue(a3, null));
    for (const preset of this.PRESETS) {
      radio(preset.label, preset.id,
            () => this.setValue(a3, this.valueFor(preset)));
    }
    popup.appendChild(mk("menuseparator"));
    radio("Sau ngày…", "after", () => {
      const ms = this.askDate(win, "Lọc thư sau ngày");
      if (ms !== null) {
        this.setValue(a3, { after: ms - 1, before: null,
                            label: "Sau " + this.fmt(ms) });
      }
    });
    radio("Trước ngày…", "before", () => {
      const ms = this.askDate(win, "Lọc thư trước ngày");
      if (ms !== null) {
        this.setValue(a3, { after: null, before: ms,
                            label: "Trước " + this.fmt(ms) });
      }
    });
    radio("Trong khoảng…", "range", () => {
      const from = this.askDate(win, "Từ ngày");
      if (from === null) {
        return;
      }
      const to = this.askDate(win, "Đến ngày (bao gồm)");
      if (to === null) {
        return;
      }
      this.setValue(a3, { after: from - 1, before: to + 86400000,
                          label: this.fmt(from) + " – " + this.fmt(to) });
    });
    popup.addEventListener("popupshowing", () => {
      const cur = this.currentValue(a3);
      const id = cur ? (this.PRESETS.find(p =>
        this.valueFor(p).label === cur.label)?.id ||
        (cur.after && cur.before ? "range" : cur.after ? "after" : "before"))
        : "";
      for (const item of items) {
        item.setAttribute("checked", item.dataset.choice === id ? "true"
                                                                : "false");
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Tự kiểm (pref hmail.debug.datetest = "run"): áp mốc "7 ngày qua" lên thư
// mục đang mở, chờ view tính lại, ghi số dòng trước/sau và ngày cũ nhất
// còn hiển thị (phải nằm trong 7 ngày); rồi bỏ lọc trả lại như cũ.
(function hMailDateSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.datetest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.datetest",
                                 String(text).slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(async () => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const a3 = win.document.getElementById("tabmail").currentAbout3Pane;
      const before = a3.gDBView?.rowCount ?? -1;
      const preset = hMailDateFilter.PRESETS.find(p => p.id === "7d");
      hMailDateFilter.setValue(a3, hMailDateFilter.valueFor(preset));
      await new Promise(r => win.setTimeout(r, 2500));
      const after = a3.gDBView?.rowCount ?? -1;
      let oldest = null;
      for (let i = 0; i < after; i++) {
        try {
          const h = a3.gDBView.getMsgHdrAt(i);
          if (h && (oldest === null || h.dateInSeconds < oldest)) {
            oldest = h.dateInSeconds;
          }
        } catch (e) {}
      }
      const chip = a3.document.getElementById("hmail-date-chip");
      const menu = a3.document.getElementById("quickFilterButtonsContext");
      const hasMenu = !!menu?.dataset.hmailDate;
      const chipInfo = chip ? {
        shown: !chip.hidden && chip.getBoundingClientRect().width > 0,
        text: chip.textContent,
      } : null;
      hMailDateFilter.setValue(a3, null);
      await new Promise(r => win.setTimeout(r, 1500));
      const restored = a3.gDBView?.rowCount ?? -1;
      const cutoff = hMailDateFilter.midnight(-6) / 1000;
      report(JSON.stringify({
        before, after, restored,
        oldestShown: oldest ? new Date(oldest * 1000).toISOString().slice(0, 10) : null,
        oldestWithin7d: oldest === null ? null : oldest >= cutoff - 1,
        chipInfo, menuInjected: hasMenu,
      }));
    } catch (e) {
      report("err: " + (e.message || e) + " @ " + String(e.stack || "").split("\n")[0]);
    }
  }, 15000);
})();
