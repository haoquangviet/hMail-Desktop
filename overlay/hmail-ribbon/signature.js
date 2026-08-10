/* hMail Desktop — trình tạo chữ ký thư trực quan
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Thunderbird đưa người dùng một ô textarea và câu đố "Dùng HTML (vd.:
 * <b>đậm</b>)" — nghĩa là muốn chữ ký có logo và liên kết thì phải viết mã.
 * Tab này là trình soạn WYSIWYG: gõ thấy ngay, đậm nghiêng màu mè bằng nút,
 * ảnh chèn từ máy thành data URI, và một mẫu danh thiếp sẵn cho người muốn
 * xong việc trong một phút. Lưu là ghi vào identity.htmlSigText — đúng chỗ
 * Thunderbird đọc khi soạn thư, không thêm cơ chế nào mới.
 */

"use strict";

var hMailSignature = {
  TAB_MODE: "hmailSignature",

  openTab(email = "") {
    const win = Services.wm.getMostRecentWindow("mail:3pane");
    const tabmail = win?.document.getElementById("tabmail");
    if (!tabmail) {
      return;
    }
    this._preselect = String(email || "").toLowerCase();
    if (!tabmail.tabModes?.[this.TAB_MODE]) {
      const self = this;
      tabmail.registerTabType({
        name: self.TAB_MODE,
        perTabPanel: "vbox",
        modes: { [self.TAB_MODE]: { type: self.TAB_MODE, maxTabs: 1 } },
        openTab(tab) {
          tab.title = "Chữ ký thư";
          tab.panel.classList.add("hmail-import-tab");
          try {
            tab.panel.appendChild(self.buildPanel(win));
          } catch (e) {
            // Lỗi dựng panel không được phép để lại một tab trắng câm:
            // ghi rõ tại chỗ và vào pref cho người gỡ lỗi.
            Cu.reportError("hMail signature panel failed: " + e + "\n" +
                           (e.stack || ""));
            try {
              Services.prefs.setCharPref("hmail.debug.sig",
                String(e) + " @ " +
                String(e.stack || "").split("\n").slice(0, 3).join(" | "));
            } catch (e2) {}
            const err = win.document.createElementNS(
              "http://www.w3.org/1999/xhtml", "div");
            err.style.cssText = "padding: 24px; font-size: 14px;";
            err.textContent = "Không dựng được trình soạn chữ ký: " + e;
            tab.panel.appendChild(err);
          }
        },
        closeTab() {},
        saveTabState() {},
        showTab(tab) {
          tab.title = "Chữ ký thư";
        },
        persistTab() {
          return null;
        },
      });
    }
    tabmail.openTab(this.TAB_MODE, {});
    // Tab đã mở từ trước: chuyển identity theo yêu cầu mới.
    const select = win.document.getElementById("hmail-sig-identity");
    if (select && this._preselect) {
      select.value = this._preselect;
      select.dispatchEvent(new win.Event("change"));
    }
  },

  /**
   * Đổ HTML vào editor. KHÔNG dùng innerHTML: document 3-pane là XHTML,
   * innerHTML ở đó parse theo luật XML — một chữ ký sẵn có chứa "<br>"
   * (không tự đóng) là ném SyntaxError ngay. DOMParser text/html nhai được
   * mọi HTML đời thực, xong import từng node sang.
   */
  setHtml(win, editor, html) {
    editor.textContent = "";
    if (!html) {
      return;
    }
    const parsed = new win.DOMParser().parseFromString(html, "text/html");
    for (const node of Array.from(parsed.body.childNodes)) {
      editor.appendChild(editor.ownerDocument.importNode(node, true));
    }
  },

  identities() {
    const seen = new Map();
    for (const identity of MailServices.accounts.allIdentities) {
      const email = (identity.email || "").trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.set(email, identity);
      }
    }
    return seen;
  },

  buildPanel(win) {
    const doc = win.document;
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (t, c, x) => {
      const n = doc.createElementNS(NS, t);
      if (c) {
        n.className = c;
      }
      if (x !== undefined) {
        n.textContent = x;
      }
      return n;
    };

    const root = el("div", "hmail-import hmail-ai");
    root.appendChild(el("div", "hmail-import-title", "Chữ ký thư"));
    root.appendChild(el("div", "hmail-import-note",
      "Soạn chữ ký như soạn thư: thấy gì lưu nấy. Ảnh chèn từ máy được " +
      "nhúng thẳng vào chữ ký; liên kết bấm được trong thư người nhận."));

    // --- identity -------------------------------------------------------
    const idRow = el("div", "hmail-move-row");
    idRow.appendChild(el("span", null, "Chữ ký cho tài khoản:"));
    const select = el("select", "hmail-ai-field");
    select.id = "hmail-sig-identity";
    const ids = this.identities();
    for (const email of ids.keys()) {
      const opt = el("option", null, email);
      opt.value = email;
      select.appendChild(opt);
    }
    if (this._preselect && ids.has(this._preselect)) {
      select.value = this._preselect;
    }
    idRow.appendChild(select);
    root.appendChild(idRow);

    // --- toolbar --------------------------------------------------------
    // --- thanh công cụ ---------------------------------------------------
    const bar = el("div", "hmail-sig-toolbar");
    const editor = el("div", "hmail-sig-editor");
    editor.setAttribute("contenteditable", "true");

    const exec = (cmd, value = null) => {
      editor.focus();
      try {
        doc.execCommand(cmd, false, value);
      } catch (e) {}
    };

    // Icon vẽ tay theo bộ dấu quốc tế (nét kiểu Feather) — không emoji,
    // không phụ thuộc font của hệ.
    const svgIcon = path => {
      const SVG = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      const p = doc.createElementNS(SVG, "path");
      p.setAttribute("d", path);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "currentColor");
      p.setAttribute("stroke-width", "1.8");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
      return svg;
    };
    const ICONS = {
      link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" +
            "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
      image: "M3 5h18v14H3z M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" +
             "M21 15l-5-5L5 21",
      table: "M3 4h18v16H3z M3 10h18 M3 16h18 M9 4v16 M15 4v16",
      alignLeft: "M4 6h16 M4 10h10 M4 14h16 M4 18h10",
      alignCenter: "M4 6h16 M7 10h10 M4 14h16 M7 18h10",
      alignRight: "M4 6h16 M10 10h10 M4 14h16 M10 18h10",
      ul: "M8 6h13 M8 12h13 M8 18h13 M3.6 6h.01 M3.6 12h.01 M3.6 18h.01",
      ol: "M10 6h11 M10 12h11 M10 18h11 M4 5.5h1.5 M4.75 4.5v3 " +
          "M4 11h1.5l-1.5 2h1.5 M4 16.5h1.5v1l-1.5.5h1.5v1H4",
      clear: "M20 20H8L3 15l9-9 8 8-5 6z M8 20h12",
      undo: "M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
      redo: "m15 14 5-5-5-5 M20 9H10a6 6 0 0 0 0 12h-3",
    };

    const tool = (content, title, run, host = bar) => {
      const b = el("button", "hmail-sig-tool");
      b.type = "button";
      b.title = title;
      if (typeof content === "string") {
        b.textContent = content;
      } else {
        b.appendChild(content);
      }
      // Giữ focus + vùng chọn trong editor — nút cướp focus là mất selection.
      b.addEventListener("mousedown", e => e.preventDefault());
      b.addEventListener("click", run);
      host.appendChild(b);
      return b;
    };
    const sep = (host = bar) => host.appendChild(el("span", "hmail-sig-sep"));

    // --- chữ -------------------------------------------------------------
    const family = el("select", "hmail-sig-tool hmail-sig-select");
    family.title = "Phông chữ";
    for (const f of ["Arial", "Segoe UI", "Tahoma", "Times New Roman",
                     "Courier New"]) {
      const opt = el("option", null, f);
      opt.value = f;
      opt.style.fontFamily = f;
      family.appendChild(opt);
    }
    family.addEventListener("change", () => exec("fontName", family.value));
    bar.appendChild(family);

    // execCommand chỉ hiểu cỡ 1–7; nhãn hiển thị là px cho người thường.
    const size = el("select", "hmail-sig-tool hmail-sig-select");
    size.title = "Cỡ chữ";
    for (const [px, legacy] of [["10px", "1"], ["13px", "2"], ["16px", "3"],
                                ["18px", "4"], ["24px", "5"], ["32px", "6"]]) {
      const opt = el("option", null, px);
      opt.value = legacy;
      size.appendChild(opt);
    }
    size.value = "3";
    size.addEventListener("change", () => exec("fontSize", size.value));
    bar.appendChild(size);

    tool("B", "In đậm (Ctrl+B)", () => exec("bold"))
      .style.fontWeight = "700";
    tool("I", "In nghiêng (Ctrl+I)", () => exec("italic"))
      .style.fontStyle = "italic";
    tool("U", "Gạch chân (Ctrl+U)", () => exec("underline"))
      .style.textDecoration = "underline";
    tool("S", "Gạch ngang", () => exec("strikeThrough"))
      .style.textDecoration = "line-through";

    const color = el("input", "hmail-sig-tool hmail-sig-color");
    color.type = "color";
    color.value = "#0F6CBD";
    color.title = "Màu chữ";
    color.addEventListener("change", () => exec("foreColor", color.value));
    bar.appendChild(color);

    sep();

    // --- đoạn ------------------------------------------------------------
    tool(svgIcon(ICONS.alignLeft), "Căn trái", () => exec("justifyLeft"));
    tool(svgIcon(ICONS.alignCenter), "Căn giữa", () => exec("justifyCenter"));
    tool(svgIcon(ICONS.alignRight), "Căn phải", () => exec("justifyRight"));
    tool(svgIcon(ICONS.ul), "Danh sách chấm đầu dòng",
         () => exec("insertUnorderedList"));
    tool(svgIcon(ICONS.ol), "Danh sách đánh số",
         () => exec("insertOrderedList"));

    sep();

    // --- chèn ------------------------------------------------------------
    tool(svgIcon(ICONS.link), "Chèn liên kết (bôi đen chữ trước)", () => {
      const url = { value: "https://" };
      if (Services.prompt.prompt(win, "Chèn liên kết",
            "Địa chỉ liên kết:", url, null, {})) {
        const target = url.value.trim();
        if (target) {
          exec("createLink", target);
        }
      }
    });

    tool(svgIcon(ICONS.image), "Chèn ảnh từ máy (logo, danh thiếp…)", () => {
      const fp = Cc["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, "Chọn ảnh", Ci.nsIFilePicker.modeOpen);
      fp.appendFilters(Ci.nsIFilePicker.filterImages);
      fp.open(rv => {
        if (rv !== Ci.nsIFilePicker.returnOK) {
          return;
        }
        try {
          // Ảnh phải sống bên trong chữ ký, không tham chiếu đường dẫn
          // trên máy người gửi: data URI được Thunderbird đổi thành phần
          // đính kèm nội tuyến khi gửi.
          IOUtils.read(fp.file.path).then(data => {
            const ext = fp.file.leafName.split(".").pop().toLowerCase();
            const mime = { png: "image/png", gif: "image/gif",
                           webp: "image/webp", svg: "image/svg+xml" }[ext] ||
                         "image/jpeg";
            let binary = "";
            for (let i = 0; i < data.length; i += 32768) {
              binary += String.fromCharCode
                .apply(null, data.subarray(i, i + 32768));
            }
            const uri = `data:${mime};base64,${win.btoa(binary)}`;
            editor.focus();
            doc.execCommand("insertImage", false, uri);
            // Logo nguyên khổ thường to đùng: mở màn ở cỡ vừa, chỉnh lại
            // bằng thanh "Ảnh" khi bấm vào ảnh.
            win.setTimeout(() => {
              const imgs = editor.querySelectorAll(`img[src="${uri}"]`);
              for (const img of imgs) {
                if (!img.style.width) {
                  img.style.width = "160px";
                }
              }
            }, 50);
          });
        } catch (e) {
          Cu.reportError("hMail signature image failed: " + e);
        }
      });
    });

    tool(svgIcon(ICONS.table), "Chèn bảng", () => {
      const spec = { value: "2x3" };
      if (!Services.prompt.prompt(win, "Chèn bảng",
            "Số hàng x số cột (ví dụ 2x3):", spec, null, {})) {
        return;
      }
      const m = /^\s*(\d{1,2})\s*[x×]\s*(\d{1,2})\s*$/i.exec(spec.value);
      const rows = Math.min(20, parseInt(m?.[1], 10) || 2);
      const cols = Math.min(10, parseInt(m?.[2], 10) || 3);
      // XHTML: chuỗi chèn phải well-formed (mọi thẻ tự đóng đàng hoàng).
      const td = '<td style="border:1px solid #cccccc; padding:4px 10px;">' +
                 " </td>";
      const table =
        '<table style="border-collapse:collapse;">' +
        Array.from({ length: rows },
                   () => "<tr>" + td.repeat(cols) + "</tr>").join("") +
        "</table><br/>";
      editor.focus();
      doc.execCommand("insertHTML", false, table);
    });

    sep();

    tool(svgIcon(ICONS.undo), "Hoàn tác", () => exec("undo"));
    tool(svgIcon(ICONS.redo), "Làm lại", () => exec("redo"));
    tool(svgIcon(ICONS.clear), "Xoá định dạng vùng bôi đen",
         () => exec("removeFormat"));

    tool("Mẫu", "Chèn mẫu danh thiếp", () => {
      const identity = this.identities().get(select.value);
      const name = identity?.fullName || "Họ và tên";
      const email = select.value;
      this.setHtml(win, editor,
        '<div style="font-family: Arial, sans-serif; font-size: 13px; ' +
        'color: #333;">--<br><b style="font-size:14px; color:#0F6CBD;">' +
        name + "</b><br>Chức danh · Tên công ty<br>" +
        '📧 <a href="mailto:' + email + '">' + email + "</a> · 📞 09xx xxx " +
        "xxx<br>🌐 <a href=\"https://example.com\">example.com</a></div>");
      editor.focus();
    });

    root.appendChild(bar);

    // --- thanh ngữ cảnh: thuộc tính ảnh thật sự --------------------------
    const imgBar = el("div", "hmail-sig-toolbar hmail-sig-context");
    imgBar.appendChild(el("span", "hmail-sig-context-label", "Ảnh"));
    let currentImg = null;

    const propInput = (label, width = 52) => {
      imgBar.appendChild(el("span", "hmail-sig-prop-label", label));
      const input = el("input", "hmail-sig-tool hmail-sig-prop");
      input.type = "number";
      input.min = "0";
      input.style.width = width + "px";
      imgBar.appendChild(input);
      return input;
    };
    const wIn = propInput("Rộng");
    const hIn = propInput("Cao");
    const bIn = propInput("Viền", 42);
    const bColor = el("input", "hmail-sig-tool hmail-sig-color");
    bColor.type = "color";
    bColor.value = "#cccccc";
    bColor.title = "Màu viền";
    imgBar.appendChild(bColor);

    imgBar.appendChild(el("span", "hmail-sig-prop-label", "Canh"));
    const alignSel = el("select", "hmail-sig-tool hmail-sig-select");
    for (const [v, label] of [["inline", "Nội dòng"],
                              ["left", "Trái — chữ bao quanh"],
                              ["right", "Phải — chữ bao quanh"],
                              ["center", "Giữa — một khối riêng"]]) {
      const opt = el("option", null, label);
      opt.value = v;
      alignSel.appendChild(opt);
    }
    imgBar.appendChild(alignSel);

    imgBar.appendChild(el("span", "hmail-sig-prop-label", "Dọc"));
    const vSel = el("select", "hmail-sig-tool hmail-sig-select");
    for (const v of ["baseline", "middle", "top", "bottom"]) {
      const opt = el("option", null, v);
      opt.value = v;
      vSel.appendChild(opt);
    }
    imgBar.appendChild(vSel);

    const applyImg = () => {
      if (!currentImg) {
        return;
      }
      currentImg.style.width = wIn.value ? wIn.value + "px" : "";
      currentImg.style.height = hIn.value ? hIn.value + "px" : "";
      const bw = parseInt(bIn.value, 10) || 0;
      currentImg.style.border =
        bw > 0 ? `${bw}px solid ${bColor.value}` : "";
      switch (alignSel.value) {
        case "left":
          currentImg.style.cssFloat = "left";
          currentImg.style.display = "";
          currentImg.style.margin = "0 12px 6px 0";
          break;
        case "right":
          currentImg.style.cssFloat = "right";
          currentImg.style.display = "";
          currentImg.style.margin = "0 0 6px 12px";
          break;
        case "center":
          currentImg.style.cssFloat = "";
          currentImg.style.display = "block";
          currentImg.style.margin = "6px auto";
          break;
        default:
          currentImg.style.cssFloat = "";
          currentImg.style.display = "";
          currentImg.style.margin = "";
      }
      currentImg.style.verticalAlign =
        alignSel.value === "inline" ? vSel.value : "";
    };
    for (const control of [wIn, hIn, bIn, bColor, alignSel, vSel]) {
      control.addEventListener("input", applyImg);
      control.addEventListener("change", applyImg);
    }
    // Đổ thuộc tính hiện tại của ảnh vào form khi vừa chọn.
    const syncImg = () => {
      if (!currentImg) {
        return;
      }
      wIn.value = parseInt(currentImg.style.width, 10) ||
                  currentImg.width || "";
      hIn.value = parseInt(currentImg.style.height, 10) || "";
      bIn.value = parseInt(currentImg.style.borderWidth, 10) || "";
      alignSel.value =
        currentImg.style.cssFloat === "left" ? "left" :
        currentImg.style.cssFloat === "right" ? "right" :
        currentImg.style.display === "block" ? "center" : "inline";
      vSel.value = currentImg.style.verticalAlign || "baseline";
    };

    tool("Gốc", "Về kích thước gốc của ảnh", () => {
      if (currentImg) {
        currentImg.style.width = "";
        currentImg.style.height = "";
        syncImg();
      }
    }, imgBar);
    tool("Xoá ảnh", "Bỏ ảnh này khỏi chữ ký", () => {
      currentImg?.remove();
      currentImg = null;
      refreshContext();
    }, imgBar);
    imgBar.hidden = true;
    root.appendChild(imgBar);

    const tableBar = el("div", "hmail-sig-toolbar hmail-sig-context");
    tableBar.appendChild(el("span", "hmail-sig-context-label", "Bảng:"));
    const currentTable = () => {
      const node = win.getSelection()?.anchorNode;
      const elem = node?.nodeType === 1 ? node : node?.parentElement;
      const table = elem?.closest?.("table");
      return table && editor.contains(table) ? table : null;
    };
    tool("+ Hàng", "Thêm hàng dưới cùng", () => {
      const table = currentTable();
      const last = table?.rows[table.rows.length - 1];
      if (last) {
        const row = last.cloneNode(true);
        for (const cell of row.cells) {
          cell.textContent = " ";
        }
        last.after(row);
      }
    }, tableBar);
    tool("+ Cột", "Thêm cột bên phải", () => {
      const table = currentTable();
      if (table) {
        for (const row of table.rows) {
          const cell = row.cells[row.cells.length - 1].cloneNode(true);
          cell.textContent = " ";
          row.appendChild(cell);
        }
      }
    }, tableBar);
    tool("Hàng đầu đậm", "Tô đậm + nền nhạt cho hàng tiêu đề", () => {
      const table = currentTable();
      for (const cell of table?.rows[0]?.cells || []) {
        cell.style.fontWeight = "700";
        cell.style.backgroundColor = "#f0f4f8";
      }
    }, tableBar);
    tool("Viền", "Bật / tắt viền bảng", () => {
      const table = currentTable();
      if (!table) {
        return;
      }
      const off = table.dataset.hmailNoborder === "1";
      table.dataset.hmailNoborder = off ? "" : "1";
      for (const row of table.rows) {
        for (const cell of row.cells) {
          cell.style.border = off ? "1px solid #cccccc" : "none";
        }
      }
    }, tableBar);
    tool("Xoá bảng", "Bỏ cả bảng", () => {
      currentTable()?.remove();
      refreshContext();
    }, tableBar);
    tableBar.hidden = true;
    root.appendChild(tableBar);

    const refreshContext = () => {
      imgBar.hidden = !currentImg;
      tableBar.hidden = !currentTable();
    };
    editor.addEventListener("click", event => {
      currentImg = event.target?.localName === "img" ? event.target : null;
      if (currentImg) {
        syncImg();
      }
      refreshContext();
    });
    editor.addEventListener("keyup", () => {
      currentImg = null;
      refreshContext();
    });
    // Document chứa tab là XUL: phím mũi tên nổi bọt lên bị bộ điều hướng
    // focus của XUL bắt mất — con trỏ đang gõ bỗng văng khỏi ô soạn. Caret
    // vẫn di chuyển bình thường (không preventDefault), chỉ không cho XUL
    // nhìn thấy phím nữa.
    editor.addEventListener("keydown", event => {
      const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                   "Home", "End", "PageUp", "PageDown"];
      if (nav.includes(event.key)) {
        event.stopPropagation();
      }
    });

    root.appendChild(editor);

    // --- load / save ----------------------------------------------------
    const status = el("div", "hmail-import-note", "");
    const load = () => {
      const identity = this.identities().get(select.value);
      if (!identity) {
        return;
      }
      this.setHtml(win, editor, identity.htmlSigText
        ? (identity.htmlSigFormat
            ? identity.htmlSigText
            // Chữ ký cũ dạng chữ trơn: bê nguyên vào, giữ xuống dòng.
            : identity.htmlSigText.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;").replace(/\r?\n/g, "<br>"))
        : "");
      status.textContent = "";
    };
    select.addEventListener("change", load);
    load();

    const actions = el("div", "hmail-move-row");
    const save = el("button", "hmail-ai-btn primary", "Lưu chữ ký");
    save.addEventListener("click", () => {
      try {
        const identity = this.identities().get(select.value);
        if (!identity) {
          return;
        }
        identity.htmlSigText = editor.innerHTML.trim();
        identity.htmlSigFormat = true;
        // Chữ ký lấy từ đây, không phải từ tập tin đính kèm nữa.
        identity.attachSignature = false;
        status.textContent =
          "Đã lưu. Thư mới soạn từ " + select.value + " sẽ mang chữ ký này.";
      } catch (e) {
        status.textContent = "Không lưu được: " + (e.message || e);
      }
    });
    const clear = el("button", "hmail-ai-btn", "Xoá chữ ký");
    clear.addEventListener("click", () => {
      const identity = this.identities().get(select.value);
      if (!identity) {
        return;
      }
      identity.htmlSigText = "";
      editor.innerHTML = "";
      status.textContent = "Đã xoá chữ ký của " + select.value + ".";
    });
    actions.append(save, clear);
    root.appendChild(actions);
    root.appendChild(status);
    return root;
  },
};
