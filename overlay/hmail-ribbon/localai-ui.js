/* hMail Desktop — màn hình cho AI chạy trên máy
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * One tab holds the whole feature: pick a model, download it, index the mail,
 * then search by meaning. Keeping it together means the person deciding
 * whether to spend 16 MB and a few minutes of indexing can see exactly what
 * they get for it.
 */

"use strict";

var hMailLocalAIUI = {
  TAB_MODE: "hmailLocalAI",

  init(win) {
    try {
      this.registerTabType(win);
    } catch (e) {
      Cu.reportError("hMail local AI init failed: " + e);
    }
  },

  el(doc, tag, cls, text) {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  },

  registerTabType(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail || tabmail.tabModes?.[this.TAB_MODE]) {
      return;
    }
    const self = this;
    tabmail.registerTabType({
      name: self.TAB_MODE,
      perTabPanel: "vbox",
      modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
      openTab(tab) {
        tab.title = "AI trên máy";
        tab.panel.classList.add("hmail-localai-tab");
        try {
          tab.panel.appendChild(self.build(win));
        } catch (e) {
          Cu.reportError("hMail local AI page failed: " + e);
          tab.panel.appendChild(self.el(win.document, "div",
            "hmail-localai-page", "Không dựng được trang: " + e));
        }
      },
      closeTab() {},
      saveTabState() {},
      showTab(tab) {
        tab.title = "AI trên máy";
      },
      persistTab() {
        return null;
      },
      restoreTab(tabmailToRestore) {
        tabmailToRestore.openTab(self.TAB_MODE, {});
      },
      supportsCommand() {
        return false;
      },
    });
  },

  openTab(win) {
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this.registerTabType(win);
    const existing = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (existing) {
      tabmail.switchToTab(existing);
      this.refresh(win);
      return;
    }
    tabmail.openTab(this.TAB_MODE, {});
    const opened = tabmail.tabInfo.find(t => t.mode?.name === this.TAB_MODE);
    if (opened) {
      tabmail.switchToTab(opened);
    }
  },

  // ----------------------------------------------------------------- trang

  build(win) {
    const doc = win.document;
    const el = (t, c, x) => this.el(doc, t, c, x);

    const page = el("div", "hmail-localai-page hmail-ai");
    page.id = "hmail-localai-page";

    page.appendChild(el("div", "hmail-localai-title", "AI chạy trên máy này"));
    page.appendChild(el("div", "hmail-ai-hint",
      "Không cần API key, không mất phí, và nội dung thư không rời khỏi máy. " +
      "Một mô hình nhỏ biến mỗi thư thành một dãy số, đủ để tìm theo ý " +
      "nghĩa, gom nhóm hội thoại và phân loại nhanh — chạy được trên máy văn " +
      "phòng thường, không cần card đồ họa rời."));

    // --- 1. mô hình -------------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "1. Mô hình"));

    const capability = hMailLocalAI.capability(win);
    const caps = el("div", "hmail-ai-hint",
      `Máy này: ${capability.memoryGB} GB RAM, ${capability.cores} nhân CPU.` +
      (capability.ok ? " Đủ để chạy."
                     : " Có thể không đủ — mô hình cần ít nhất 4 GB RAM và 2 nhân."));
    page.appendChild(caps);

    const picker = el("div", "hmail-localai-models");
    for (const model of hMailLocalAI.MODELS) {
      const item = el("label", "hmail-localai-model");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "hmail-localai-model";
      radio.value = `${model.id}|${model.dtype}`;
      const current = hMailLocalAI.model();
      radio.checked = current.id === model.id && current.dtype === model.dtype;
      const text = el("span", "hmail-localai-model-text");
      text.append(
        el("span", "hmail-localai-model-name", model.label),
        el("span", "hmail-localai-model-size", model.size),
        el("span", "hmail-localai-model-note", model.note));
      item.append(radio, text);
      picker.appendChild(item);
    }
    page.appendChild(picker);

    const actions = el("div", "hmail-ai-actions");
    const activate = el("button", "hmail-ai-btn primary",
                        "Tải về và kích hoạt");
    activate.id = "hmail-localai-activate";
    activate.addEventListener("click", () => this.activate(win));
    const off = el("button", "hmail-ai-btn", "Tắt và xoá dữ liệu");
    off.id = "hmail-localai-off";
    off.addEventListener("click", () => this.deactivate(win));
    actions.append(activate, off);
    page.appendChild(actions);

    const status = el("div", "hmail-ai-status", "");
    status.id = "hmail-localai-status";
    page.appendChild(status);

    const bar = el("div", "hmail-merge-bar");
    bar.id = "hmail-localai-bar";
    bar.hidden = true;
    bar.appendChild(el("div", "hmail-merge-bar-fill"));
    page.appendChild(bar);

    // --- 2. lập chỉ mục ---------------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "2. Lập chỉ mục thư"));
    page.appendChild(el("div", "hmail-ai-hint",
      "Chỉ mục là bảng vector lưu trong hồ sơ của bạn, ở tệp " +
      "hmail-vectors.sqlite. Lập lần đầu mất một lúc; sau đó chỉ thư mới " +
      "được thêm vào."));

    const indexRow = el("div", "hmail-ai-actions");
    const indexBtn = el("button", "hmail-ai-btn",
                        "Lập chỉ mục thư mục đang mở");
    indexBtn.id = "hmail-localai-index";
    indexBtn.addEventListener("click", () => this.index(win));
    const stopBtn = el("button", "hmail-ai-btn", "Dừng");
    stopBtn.id = "hmail-localai-stop";
    stopBtn.hidden = true;
    stopBtn.addEventListener("click", () => {
      this.stopping = true;
    });
    indexRow.append(indexBtn, stopBtn);
    page.appendChild(indexRow);

    const indexStatus = el("div", "hmail-ai-status", "");
    indexStatus.id = "hmail-localai-index-status";
    page.appendChild(indexStatus);

    // --- 3. tìm theo ý nghĩa ---------------------------------------------
    page.appendChild(el("div", "hmail-ai-section", "3. Tìm theo ý nghĩa"));
    page.appendChild(el("div", "hmail-ai-hint",
      "Gõ điều bạn nhớ về nội dung, không cần nhớ đúng từ trong thư. " +
      "Ví dụ: “hợp đồng tháng trước” vẫn tìm ra thư nói “thỏa thuận dịch vụ " +
      "quý 1”."));

    const searchRow = el("div", "hmail-ai-row");
    const input = el("input", "hmail-ai-field");
    input.id = "hmail-localai-query";
    input.placeholder = "Bạn nhớ gì về thư đó?";
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.search(win);
      }
    });
    const go = el("button", "hmail-ai-btn primary", "Tìm");
    go.addEventListener("click", () => this.search(win));
    searchRow.append(input, go);
    page.appendChild(searchRow);

    const results = el("div", "hmail-localai-results");
    results.id = "hmail-localai-results";
    page.appendChild(results);

    win.setTimeout(() => this.refresh(win), 0);
    return page;
  },

  say(win, id, text) {
    const node = win.document.getElementById(id);
    if (node) {
      node.textContent = text;
    }
  },

  async refresh(win) {
    const doc = win.document;
    if (!doc.getElementById("hmail-localai-page")) {
      return;
    }
    const on = hMailLocalAI.enabled();
    const count = on ? await hMailLocalAI.count() : 0;
    this.say(win, "hmail-localai-status", on
      ? `Đang bật — ${hMailLocalAI.model().label}. ` +
        `${count.toLocaleString("vi-VN")} thư đã có vector.`
      : "Chưa bật. Chọn một mô hình rồi bấm “Tải về và kích hoạt”.");
    doc.getElementById("hmail-localai-activate").hidden = on;
    doc.getElementById("hmail-localai-off").hidden = !on;
    doc.getElementById("hmail-localai-index").hidden = !on;
  },

  chosen(win) {
    const radio = win.document.querySelector(
      "input[name='hmail-localai-model']:checked");
    const value = radio ? radio.value : "";
    const [id, dtype] = value.split("|");
    return hMailLocalAI.MODELS.find(m => m.id === id && m.dtype === dtype) ||
           hMailLocalAI.MODELS[0];
  },

  async activate(win) {
    const model = this.chosen(win);
    const capability = hMailLocalAI.capability(win);
    if (!capability.ok &&
        !Services.prompt.confirm(win, "AI trên máy",
          `Máy này có ${capability.memoryGB} GB RAM và ${capability.cores} ` +
          `nhân CPU, thấp hơn mức khuyến nghị. Vẫn thử?`)) {
      return;
    }

    // Say plainly what turning this on does before it happens.
    if (!hMailLocalAI.settingsChannelOpen() &&
        !Services.prompt.confirm(win, "AI trên máy",
          `Bật tính năng này sẽ tải về:\n\n` +
          `  · Bộ chạy ONNX của Mozilla (một lần)\n` +
          `  · Mô hình ${model.label}, ${model.size}\n\n` +
          `Cả hai lấy từ máy chủ của Mozilla, nên hMail sẽ mở kênh cấu hình ` +
          `của Mozilla cho riêng việc này. Tắt tính năng thì kênh đó đóng ` +
          `lại.\n\nSau khi tải xong, mọi thứ chạy trên máy bạn: nội dung thư ` +
          `không gửi đi đâu cả.\n\nTiếp tục?`)) {
      return;
    }
    hMailLocalAI.openSettingsChannel();

    Services.prefs.setCharPref(hMailLocalAI.MODEL_PREF, model.id);
    Services.prefs.setCharPref(hMailLocalAI.DTYPE_PREF, model.dtype);

    const bar = win.document.getElementById("hmail-localai-bar");
    const fill = bar.firstChild;
    bar.hidden = false;
    fill.style.width = "0%";
    this.say(win, "hmail-localai-status",
      `Đang tải ${model.label} (${model.size})…`);

    try {
      await hMailLocalAI.engine(percent => {
        fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      });
      // Prove it works before claiming it does.
      const vector = await hMailLocalAI.embed("kiểm tra mô hình");
      if (!vector || vector.length < 8) {
        throw new Error("mô hình không trả về vector hợp lệ");
      }
      Services.prefs.setBoolPref(hMailLocalAI.ENABLED_PREF, true);
        bar.hidden = true;
      this.say(win, "hmail-localai-status",
        `Đã kích hoạt — ${model.label}, vector ${vector.length} chiều. ` +
        `Bước tiếp theo là lập chỉ mục.`);
      this.refresh(win);
    } catch (e) {
      bar.hidden = true;
      const message = String(e?.message || e);
      Services.prefs.setBoolPref(hMailLocalAI.ENABLED_PREF, false);
      // A failure to reach the runtime is a network problem, not something a
      // restart fixes. Telling the user to restart when it will not help sends
      // them round the same loop for as long as they have patience.
      if (/Remote Settings|ML engine|ONNX/i.test(message)) {
        this.say(win, "hmail-localai-status",
          "Không tải được bộ chạy ONNX. Bộ chạy này lấy từ máy chủ cấu hình " +
          "của Mozilla, nên hãy kiểm tra mạng, tường lửa hoặc proxy của công " +
          "ty có chặn firefox.settings.services.mozilla.com hay không, rồi " +
          "thử lại. Chi tiết: " + message);
        return;
      }
      this.say(win, "hmail-localai-status",
        "Không kích hoạt được: " + message);
    }
  },

  async deactivate(win) {
    if (!Services.prompt.confirm(win, "AI trên máy",
          "Tắt AI trên máy và xoá toàn bộ vector đã lập chỉ mục?")) {
      return;
    }
    Services.prefs.setBoolPref(hMailLocalAI.ENABLED_PREF, false);
    await hMailLocalAI.shutdown();
    await hMailLocalAI.clear();
    hMailLocalAI.closeSettingsChannel();
    this.say(win, "hmail-localai-index-status", "");
    win.document.getElementById("hmail-localai-results").textContent = "";
    this.refresh(win);
  },

  currentFolder(win) {
    try {
      return win.document.getElementById("tabmail")
        ?.tabInfo?.find(t => t.mode?.name === "mail3PaneTab")
        ?.chromeBrowser?.contentWindow?.gFolder ||
        win.document.getElementById("tabmail")?.currentAbout3Pane?.gFolder;
    } catch (e) {
      return null;
    }
  },

  async index(win) {
    const folder = this.currentFolder(win);
    if (!folder) {
      this.say(win, "hmail-localai-index-status",
        "Hãy mở một thư mục trong thẻ thư trước.");
      return;
    }
    const doc = win.document;
    doc.getElementById("hmail-localai-index").hidden = true;
    doc.getElementById("hmail-localai-stop").hidden = false;
    this.stopping = false;

    try {
      const result = await hMailLocalAI.indexFolder(win, folder,
        (done, total) => {
          this.say(win, "hmail-localai-index-status",
            `${folder.prettyName}: ${done}/${total} thư…`);
          return !this.stopping;
        });
      this.say(win, "hmail-localai-index-status",
        `${folder.prettyName}: đã lập chỉ mục ${result.indexed} thư` +
        (result.skipped ? `, bỏ qua ${result.skipped} thư đã có.` : "."));
    } catch (e) {
      this.say(win, "hmail-localai-index-status",
        "Lỗi khi lập chỉ mục: " + (e.message || e));
    } finally {
      doc.getElementById("hmail-localai-index").hidden = false;
      doc.getElementById("hmail-localai-stop").hidden = true;
      this.refresh(win);
    }
  },

  async search(win) {
    const doc = win.document;
    const query = doc.getElementById("hmail-localai-query").value.trim();
    const box = doc.getElementById("hmail-localai-results");
    if (!query) {
      return;
    }
    if (!hMailLocalAI.enabled()) {
      this.say(win, "hmail-localai-status", "Hãy kích hoạt mô hình trước.");
      return;
    }

    box.textContent = "";
    const el = (t, c, x) => this.el(doc, t, c, x);
    box.appendChild(el("div", "hmail-ai-hint", "Đang tìm…"));

    try {
      const hits = await hMailLocalAI.search(query, 25);
      box.textContent = "";
      if (!hits.length) {
        box.appendChild(el("div", "hmail-ai-hint",
          "Chưa có thư nào trong chỉ mục. Hãy lập chỉ mục trước."));
        return;
      }
      for (const hit of hits) {
        const row = el("div", "hmail-localai-hit");
        const when = hit.date
          ? new Date(hit.date * 1000).toLocaleDateString("vi-VN") : "";
        row.append(
          el("span", "hmail-localai-score",
             `${Math.round(hit.score * 100)}%`),
          el("span", "hmail-localai-subject",
             hit.subject || "(không có tiêu đề)"),
          el("span", "hmail-localai-from", hit.author || ""),
          el("span", "hmail-localai-when", when));
        row.addEventListener("click", () => hMailLocalAI.reveal(win, hit));
        box.appendChild(row);
      }
    } catch (e) {
      box.textContent = "";
      box.appendChild(el("div", "hmail-ai-hint",
        "Lỗi khi tìm: " + (e.message || e)));
    }
  },
};
