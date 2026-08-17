/* hMail Desktop — trang Chi phí AI
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Badge dưới ô nhập cho biết lượt vừa rồi tốn bao nhiêu; trang này trả lời
 * câu hỏi lớn hơn: tháng này tốn bao nhiêu, dịch vụ nào ăn nhiều nhất, tính
 * năng nào dùng nhiều nhất, và từng lượt một là gì. Dữ liệu từ nhật ký
 * hmail-ai-usage.jsonl (mỗi lượt gọi một dòng) — xem lại được toàn bộ lịch
 * sử, lọc theo thời gian/dịch vụ, xuất CSV cho kế toán.
 */

"use strict";

var hMailAICost = {
  TAB_MODE: "hmailAICost",

  openTab(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    if (!tabmail.tabModes?.[this.TAB_MODE]) {
      const self = this;
      tabmail.registerTabType({
        name: self.TAB_MODE,
        perTabPanel: "vbox",
        modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
        openTab(tab) {
          tab.title = "Chi phí AI";
          tab.panel.classList.add("hmail-import-tab");
          tab.panel.appendChild(self.buildPanel(win));
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Chi phí AI";
        },
        persistTab() {
          return null;
        },
      });
    }
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
  },

  el(doc, tag, cls, text) {
    const n = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  },

  fmtInt(n) {
    return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  },

  fmtUsd(v) {
    return v > 0 ? "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(4)) : "0đ";
  },

  buildPanel(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);
    const root = el("div", "hmail-import hmail-aicost");
    root.appendChild(el("div", "hmail-import-title", "Chi phí AI"));
    root.appendChild(el("div", "hmail-import-note",
      "Tổng chi phí ước tính theo đơn giá bạn đặt cho từng dịch vụ, và " +
      "toàn bộ lịch sử từng lượt gọi. Con số là ước tính từ số token nhà " +
      "cung cấp báo về — hoá đơn thật lấy ở trang quản trị của họ."));

    // Bộ lọc --------------------------------------------------------------
    const bar = el("div", "hmail-aicost-bar");
    const range = el("select", "hmail-ai-field");
    for (const [v, label] of [["7", "7 ngày qua"], ["30", "30 ngày qua"],
                              ["month", "Tháng này"], ["90", "90 ngày qua"],
                              ["all", "Toàn bộ"]]) {
      const opt = el("option", null, label);
      opt.value = v;
      range.appendChild(opt);
    }
    range.value = "30";
    const svc = el("select", "hmail-ai-field");
    const optAll = el("option", null, "Mọi dịch vụ");
    optAll.value = "";
    svc.appendChild(optAll);
    const search = el("input", "hmail-ai-field");
    search.type = "search";
    search.placeholder = "Lọc theo tiêu đề thư / tính năng…";
    const exportBtn = el("button", "hmail-ai-btn", "Xuất CSV");
    const clearBtn = el("button", "hmail-ai-btn", "Xoá lịch sử…");
    bar.append(range, svc, search, exportBtn, clearBtn);
    root.appendChild(bar);

    // Tổng quan -------------------------------------------------------------
    const cards = el("div", "hmail-aicost-cards");
    root.appendChild(cards);
    const byService = el("div", "hmail-aicost-section");
    root.appendChild(byService);
    const byFeature = el("div", "hmail-aicost-section");
    root.appendChild(byFeature);

    // Lịch sử ---------------------------------------------------------------
    const histHead = el("div", "hmail-aicost-section-title", "Lịch sử từng lượt");
    root.appendChild(histHead);
    const table = el("table", "hmail-aicost-table");
    root.appendChild(table);
    const more = el("button", "hmail-ai-btn", "Hiện thêm");
    more.hidden = true;
    root.appendChild(more);

    let rows = [];
    let shown = 0;
    const PAGE = 200;

    const inRange = r => {
      const v = range.value;
      if (v === "all") {
        return true;
      }
      if (v === "month") {
        const d = new Date();
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        return r.t >= d.getTime();
      }
      return r.t >= Date.now() - Number(v) * 86400000;
    };
    const filtered = () => {
      const q = search.value.trim().toLowerCase();
      return rows.filter(r => inRange(r) &&
        (!svc.value || r.service === svc.value) &&
        (!q || (r.subject || "").toLowerCase().includes(q) ||
               (r.feature || "").toLowerCase().includes(q)));
    };

    const card = (label, value, sub) => {
      const c = el("div", "hmail-aicost-card");
      c.append(el("div", "hmail-aicost-card-value", value),
               el("div", "hmail-aicost-card-label", label));
      if (sub) {
        c.appendChild(el("div", "hmail-aicost-card-sub", sub));
      }
      return c;
    };
    const breakdown = (host, title, keyFn, labelFn) => {
      host.textContent = "";
      host.appendChild(el("div", "hmail-aicost-section-title", title));
      const agg = new Map();
      for (const r of filtered()) {
        const k = keyFn(r);
        const a = agg.get(k) || { label: labelFn(r), calls: 0, in: 0, out: 0,
                                  cost: 0 };
        a.calls++;
        a.in += r.in || 0;
        a.out += r.out || 0;
        a.cost += r.cost || 0;
        agg.set(k, a);
      }
      const list = [...agg.values()].sort((a, b) => b.cost - a.cost ||
                                                    b.calls - a.calls);
      const total = list.reduce((s, a) => s + a.cost, 0) || 1;
      for (const a of list) {
        const row = el("div", "hmail-aicost-row");
        const barWrap = el("div", "hmail-aicost-barwrap");
        const barFill = el("div", "hmail-aicost-barfill");
        barFill.style.width = Math.max(2, Math.round(a.cost / total * 100)) + "%";
        barWrap.appendChild(barFill);
        row.append(
          el("span", "hmail-aicost-row-label", a.label),
          barWrap,
          el("span", "hmail-aicost-row-num",
             `${this.fmtInt(a.calls)} lượt · ${this.fmtInt(a.in + a.out)} token`),
          el("span", "hmail-aicost-row-cost", this.fmtUsd(a.cost)));
        host.appendChild(row);
      }
      if (!list.length) {
        host.appendChild(el("div", "hmail-ai-hint", "Chưa có dữ liệu."));
      }
    };

    const renderTable = (reset) => {
      const list = filtered();
      if (reset) {
        table.textContent = "";
        shown = 0;
        const head = el("tr");
        for (const h of ["Thời điểm", "Dịch vụ / model", "Tính năng",
                         "Thư", "Gửi", "Nhận", "Chi phí"]) {
          head.appendChild(el("th", null, h));
        }
        table.appendChild(head);
      }
      const slice = list.slice(shown, shown + PAGE);
      for (const r of slice) {
        const tr = el("tr");
        tr.append(
          el("td", null, new Date(r.t).toLocaleString("vi-VN")),
          el("td", null, (r.label || r.service) +
                         (r.model ? ` · ${r.model}` : "")),
          el("td", null, r.feature || ""),
          el("td", "hmail-aicost-subject", r.subject || ""),
          el("td", "num", this.fmtInt(r.in)),
          el("td", "num", this.fmtInt(r.out)),
          el("td", "num", this.fmtUsd(r.cost)));
        table.appendChild(tr);
      }
      shown += slice.length;
      more.hidden = shown >= list.length;
      more.textContent = `Hiện thêm (${this.fmtInt(list.length - shown)} lượt nữa)`;
    };

    const render = () => {
      const list = filtered();
      const totalCost = list.reduce((s, r) => s + (r.cost || 0), 0);
      const totalIn = list.reduce((s, r) => s + (r.in || 0), 0);
      const totalOut = list.reduce((s, r) => s + (r.out || 0), 0);
      const days = new Set(list.map(r => new Date(r.t).toDateString())).size || 1;
      cards.textContent = "";
      cards.append(
        card("Tổng chi phí", this.fmtUsd(totalCost),
             `≈ ${this.fmtUsd(totalCost / days)} / ngày có dùng`),
        card("Lượt gọi", this.fmtInt(list.length)),
        card("Token gửi", this.fmtInt(totalIn)),
        card("Token nhận", this.fmtInt(totalOut)));
      breakdown(byService, "Theo dịch vụ", r => r.service,
                r => r.label || r.service);
      breakdown(byFeature, "Theo tính năng", r => r.feature || "chat",
                r => r.feature || "chat");
      renderTable(true);
    };

    for (const c of [range, svc]) {
      c.addEventListener("change", render);
    }
    let timer = null;
    search.addEventListener("input", () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(render, 250);
    });
    more.addEventListener("click", () => renderTable(false));

    exportBtn.addEventListener("click", async () => {
      try {
        const list = filtered();
        const esc = v => `"${String(v ?? "").replace(/"/g, "\"\"")}"`;
        const lines = [["thoi_diem", "dich_vu", "model", "tinh_nang", "thu",
                        "token_gui", "token_nhan", "chi_phi_usd"].join(",")];
        for (const r of list) {
          lines.push([new Date(r.t).toISOString(), r.label || r.service,
                      r.model, r.feature, r.subject, r.in, r.out,
                      (r.cost || 0).toFixed(6)].map(esc).join(","));
        }
        const fp = Cc["@mozilla.org/filepicker;1"]
          .createInstance(Ci.nsIFilePicker);
        fp.init(win.browsingContext, "Xuất chi phí AI", Ci.nsIFilePicker.modeSave);
        fp.defaultString = "hmail-ai-chi-phi.csv";
        fp.appendFilter("CSV", "*.csv");
        fp.open(async rv => {
          if (rv === Ci.nsIFilePicker.returnCancel) {
            return;
          }
          // BOM để Excel mở tiếng Việt đúng.
          await IOUtils.writeUTF8(fp.file.path, "﻿" + lines.join("\r\n"));
        });
      } catch (e) {
        Cu.reportError("hMail AI cost export failed: " + e);
      }
    });

    clearBtn.addEventListener("click", async () => {
      if (!Services.prompt.confirm(win, "Chi phí AI",
            "Xoá toàn bộ lịch sử chi phí AI? Bộ đếm tổng theo dịch vụ " +
            "cũng về 0. Không hoàn tác được.")) {
        return;
      }
      try {
        await IOUtils.remove(hMailAI.usageLogPath()).catch(() => {});
        hMailAI.clearUsage();
        rows = [];
        render();
      } catch (e) {}
    });

    (async () => {
      rows = await hMailAI.readUsageLog();
      // Danh sách dịch vụ có trong lịch sử.
      const seen = new Map();
      for (const r of rows) {
        if (!seen.has(r.service)) {
          seen.set(r.service, r.label || r.service);
        }
      }
      for (const [id, label] of seen) {
        const opt = el("option", null, label);
        opt.value = id;
        svc.appendChild(opt);
      }
      // Bộ đếm cũ (trước khi có nhật ký) vẫn hiện để không "mất" chi phí
      // đã tiêu — như một dòng riêng, không lẫn vào lịch sử.
      const legacy = hMailAI.usage();
      const logged = new Map();
      for (const r of rows) {
        const a = logged.get(r.service) || { in: 0, out: 0 };
        a.in += r.in || 0;
        a.out += r.out || 0;
        logged.set(r.service, a);
      }
      const notes = [];
      for (const [id, u] of Object.entries(legacy)) {
        const l = logged.get(id) || { in: 0, out: 0 };
        const extraIn = Math.max(0, (u.in || 0) - l.in);
        const extraOut = Math.max(0, (u.out || 0) - l.out);
        if (extraIn + extraOut > 0) {
          const def = hMailAI.serviceDef(id);
          notes.push(`${def.label}: ${this.fmtInt(extraIn + extraOut)} token ` +
            `(≈ ${this.fmtUsd(hMailAI.cost({ in: extraIn, out: extraOut }, id))})`);
        }
      }
      if (notes.length) {
        root.insertBefore(el("div", "hmail-ai-hint",
          "Chi phí trước khi có nhật ký chi tiết (chỉ có tổng): " +
          notes.join(" · ")), byService);
      }
      render();
    })();
    return root;
  },
};
