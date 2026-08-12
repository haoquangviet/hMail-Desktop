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
    this.sanitizeTree(parsed.body);
    for (const node of Array.from(parsed.body.childNodes)) {
      editor.appendChild(editor.ownerDocument.importNode(node, true));
    }
  },

  /**
   * Khử phần tử và thuộc tính thực thi được trước khi HTML bên ngoài đi
   * vào editor. Editor sống trong DOCUMENT CHROME: <script> qua DOMParser
   * vốn trơ vĩnh viễn, nhưng thuộc tính on* (onerror, onload…) hay
   * javascript: trong href/src thì vẫn sống — một chữ ký dán từ clipboard
   * mà mang onerror là mã lạ chạy với quyền chrome. Chữ ký hợp pháp không
   * bao giờ cần những thứ này nên cắt thẳng tay.
   */
  sanitizeTree(root) {
    for (const bad of root.querySelectorAll(
      "script, iframe, frame, frameset, object, embed, link, meta, base")) {
      bad.remove();
    }
    for (const node of root.querySelectorAll("*")) {
      for (const attr of Array.from(node.attributes || [])) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") ||
            (/^(href|src|action|formaction|xlink:href)$/.test(name) &&
             /^\s*(javascript|vbscript|data:text\/html)/i
               .test(attr.value || ""))) {
          node.removeAttribute(attr.name);
        }
      }
    }
  },

  /**
   * Gỡ mọi node chú thích — Windows nhét <!--StartFragment--> vào HTML
   * trong clipboard, dán một lần là rác đó sống mãi trong chữ ký.
   */
  stripComments(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) {
        child.remove();
      } else if (child.nodeType === 1) {
        this.stripComments(child);
      }
    }
  },

  /**
   * Serialize nội dung editor ra chuỗi HTML THẬT. Tuyệt đối không dùng
   * editor.innerHTML: document 3-pane là XHTML nên innerHTML serialize
   * theo luật XML — đẻ ra xmlns="…" và ô rỗng thành <td/>. Trình soạn
   * thư đọc <td/> theo luật HTML là thẻ mở không bao giờ đóng: các ô
   * lồng hết vào nhau, chữ ký sập thành cột dọc một ký tự. Bê nội dung
   * sang một document HTML rồi lấy innerHTML ở đó — serializer HTML
   * chuẩn, compose đọc gì hiểu nấy.
   */
  serializeHtml(doc, container) {
    const hdoc = doc.implementation.createHTMLDocument("");
    for (const child of container.childNodes) {
      hdoc.body.appendChild(hdoc.importNode(child, true));
    }
    return hdoc.body.innerHTML;
  },

  /**
   * Thu nhỏ THẬT một ảnh dataURI (vẽ lại qua canvas, re-encode) về bề
   * rộng tối đa cho trước. PNG/SVG giữ PNG (bảo toàn trong suốt của
   * logo), còn lại nén JPEG. Lỗi thì trả nguyên bản — không bao giờ làm
   * hỏng ảnh của người dùng.
   */
  shrinkImage(win, doc, uri, maxWidth) {
    return new Promise(resolve => {
      const img = new win.Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxWidth / (img.naturalWidth || 1));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = doc.createElementNS(
            "http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          const keepPng = /^data:image\/(png|svg)/i.test(uri);
          resolve(canvas.toDataURL(
            keepPng ? "image/png" : "image/jpeg", 0.85));
        } catch (e) {
          resolve(uri);
        }
      };
      img.onerror = () => resolve(uri);
      img.src = uri;
    });
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
            let uri = `data:${mime};base64,${win.btoa(binary)}`;

            // Ảnh nặng làm mọi thư mang chữ ký này nặng theo. Hỏi một
            // lần lúc chèn — thu nhỏ THẬT (re-encode) chứ không chỉ hiển
            // thị nhỏ đi.
            const shrinkReady = data.length > 300 * 1024
              ? (() => {
                  const flags = Services.prompt.BUTTON_POS_0 *
                      Services.prompt.BUTTON_TITLE_IS_STRING +
                    Services.prompt.BUTTON_POS_1 *
                      Services.prompt.BUTTON_TITLE_IS_STRING;
                  const pick = Services.prompt.confirmEx(
                    win, "Ảnh khá nặng",
                    "Ảnh này nặng " + Math.round(data.length / 1024) +
                    " KB — mỗi thư mang chữ ký sẽ cộng thêm từng ấy.\n\n" +
                    "Thu nhỏ thật về tối đa 800px cho nhẹ?",
                    flags, "Thu nhỏ (khuyên dùng)", "Giữ nguyên",
                    null, null, {});
                  return pick === 0
                    ? this.shrinkImage(win, doc, uri, 800)
                    : Promise.resolve(uri);
                })()
              : Promise.resolve(uri);

            shrinkReady.then(finalUri => {
              uri = finalUri;
              editor.focus();
              doc.execCommand("insertImage", false, uri);
              // Logo nguyên khổ thường to đùng: mở màn ở cỡ vừa, chỉnh
              // lại bằng thanh "Ảnh" khi bấm vào ảnh.
              win.setTimeout(() => {
                for (const img of editor.querySelectorAll("img")) {
                  if (img.src === uri && !img.style.width) {
                    img.style.width = "160px";
                  }
                }
              }, 50);
            });
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

    tool(svgIcon(ICONS.undo), "Hoàn tác (Ctrl+Z)", () => timeTravel(-1));
    tool(svgIcon(ICONS.redo), "Làm lại (Ctrl+Y)", () => timeTravel(1));
    tool(svgIcon(ICONS.clear), "Xoá định dạng vùng bôi đen",
         () => exec("removeFormat"));

    tool("Mẫu", "Chèn chữ ký mẫu chuẩn của HQV", () => {
      // Mẫu chính thức (banner + logo HQV, bảng bố cục) sống trong file
      // riêng cạnh script — đổi mẫu công ty không phải đụng vào code.
      const file = Services.dirsvc.get("GreD", Ci.nsIFile);
      file.append("hmail-ribbon");
      file.append("signature-template.html");
      IOUtils.readUTF8(file.path).then(html => {
        const identity = this.identities().get(select.value);
        const name = identity?.fullName || "Đội hỗ trợ";
        this.setHtml(win, editor, html
          .replace(/{{TEN}}/g, name)
          .replace(/{{EMAIL}}/g, select.value));
        editor.focus();
      }).catch(e => {
        status.textContent = "Không đọc được mẫu chữ ký: " + (e.message || e);
      });
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
      // Kích thước ghi bằng THUỘC TÍNH width/height (một mối duy nhất —
      // cùng định dạng lúc lưu và cùng thứ hộp thuộc tính ảnh của trình
      // soạn thư sửa); style bị xoá để không đè lên thuộc tính, và không
      // còn cảnh chỉnh một chiều bằng style trong khi chiều kia là thuộc
      // tính cũ khiến ảnh méo.
      if (wIn.value) {
        currentImg.setAttribute("width", wIn.value);
      } else {
        currentImg.removeAttribute("width");
      }
      if (hIn.value) {
        currentImg.setAttribute("height", hIn.value);
      } else {
        currentImg.removeAttribute("height");
      }
      currentImg.style.width = "";
      currentImg.style.height = "";
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
      wIn.value = parseInt(currentImg.getAttribute("width"), 10) ||
                  parseInt(currentImg.style.width, 10) ||
                  currentImg.width || "";
      hIn.value = parseInt(currentImg.getAttribute("height"), 10) ||
                  parseInt(currentImg.style.height, 10) || "";
      bIn.value = parseInt(currentImg.style.borderWidth, 10) || "";
      alignSel.value =
        currentImg.style.cssFloat === "left" ? "left" :
        currentImg.style.cssFloat === "right" ? "right" :
        currentImg.style.display === "block" ? "center" : "inline";
      vSel.value = currentImg.style.verticalAlign || "baseline";
    };

    tool("Gốc", "Về kích thước gốc của ảnh", () => {
      if (currentImg) {
        currentImg.removeAttribute("width");
        currentImg.removeAttribute("height");
        currentImg.style.width = "";
        currentImg.style.height = "";
        syncImg();
      }
    }, imgBar);
    tool("Nén ảnh", "Thu nhỏ THẬT dữ liệu ảnh về đúng cỡ đang hiển thị " +
                    "— chữ ký nhẹ đi, thư gửi nhanh hơn", () => {
      const img = currentImg;
      if (!img) {
        return;
      }
      const target = parseInt(img.getAttribute("width"), 10) ||
                     parseInt(img.style.width, 10) || img.width || 160;
      this.shrinkImage(win, doc, img.src, target).then(uri => {
        img.src = uri;
        // Dữ liệu mới đã đúng cỡ: gỡ mọi ép kích thước cũ để ảnh hiện
        // theo kích thước thật, tỷ lệ tự nhiên.
        img.removeAttribute("width");
        img.removeAttribute("height");
        img.style.width = "";
        img.style.height = "";
        syncImg();
      });
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

    // Thuộc tính bảng: sửa số là thấy ngay, đồng bộ ngược khi đặt con
    // trỏ vào bảng khác.
    const tProp = (label, width = 46) => {
      tableBar.appendChild(el("span", "hmail-sig-prop-label", label));
      const input = el("input", "hmail-sig-tool hmail-sig-prop");
      input.type = "number";
      input.min = "0";
      input.style.width = width + "px";
      tableBar.appendChild(input);
      return input;
    };
    const tBorder = tProp("Viền");
    const tBorderColor = el("input", "hmail-sig-tool hmail-sig-color");
    tBorderColor.type = "color";
    tBorderColor.value = "#cccccc";
    tBorderColor.title = "Màu viền";
    tableBar.appendChild(tBorderColor);
    const tPad = tProp("Đệm");
    const tWidth = tProp("Rộng", 56);
    tableBar.appendChild(el("span", "hmail-sig-prop-label", "Nền ô"));
    const tCellBg = el("input", "hmail-sig-tool hmail-sig-color");
    tCellBg.type = "color";
    tCellBg.value = "#f0f4f8";
    tCellBg.title = "Màu nền các ô đang chọn";
    tableBar.appendChild(tCellBg);

    const applyTable = () => {
      const table = currentTable();
      if (!table) {
        return;
      }
      // Ô trống = ĐỪNG ĐỤNG — mẫu có viền/đệm riêng từng ô, chạm một ô
      // khác trong thanh này mà quét "none" lên tất cả là nát thiết kế.
      const bw = tBorder.value === "" ? null : parseInt(tBorder.value, 10) || 0;
      const pad = tPad.value === "" ? null : parseInt(tPad.value, 10) || 0;
      for (const row of table.rows) {
        for (const cell of row.cells) {
          if (bw !== null) {
            cell.style.border =
              bw > 0 ? `${bw}px solid ${tBorderColor.value}` : "none";
          }
          if (pad !== null) {
            cell.style.padding = `${pad}px ${pad + 6}px`;
          }
        }
      }
      // 0 hay trống đều là "bỏ ép rộng" — width: 0px từng bóp cả chữ ký
      // thành cột dọc một ký tự trong thư.
      const tw = parseInt(tWidth.value, 10) || 0;
      table.style.width = tw > 0 ? tw + "px" : "";
    };
    for (const control of [tBorder, tBorderColor, tPad, tWidth]) {
      control.addEventListener("input", applyTable);
      control.addEventListener("change", applyTable);
    }
    tCellBg.addEventListener("change", () => {
      const cells = selectedCells();
      for (const cell of cells.length ? cells : []) {
        cell.style.backgroundColor = tCellBg.value;
      }
    });
    const syncTable = () => {
      const table = currentTable();
      if (!table) {
        return;
      }
      const first = table.rows[0]?.cells[0];
      const px = value => /%/.test(value || "")
        ? "" : (parseInt(value, 10) || "");
      tBorder.value = px(first?.style.borderWidth);
      tPad.value = px(first?.style.paddingTop);
      tWidth.value = px(table.style.width);
    };
    // Bản đồ lưới của bảng: grid[hàng][cột] -> ô chiếm chỗ đó, đã tính
    // cả colspan/rowspan — nền cho gộp/tách ô đúng đắn.
    const gridOf = table => {
      const grid = [];
      for (let r = 0; r < table.rows.length; r++) {
        grid[r] = grid[r] || [];
        let c = 0;
        for (const cell of table.rows[r].cells) {
          while (grid[r][c]) {
            c++;
          }
          for (let dr = 0; dr < cell.rowSpan; dr++) {
            for (let dc = 0; dc < cell.colSpan; dc++) {
              grid[r + dr] = grid[r + dr] || [];
              grid[r + dr][c + dc] = cell;
            }
          }
          c += cell.colSpan;
        }
      }
      return grid;
    };
    const selectedCells = () => {
      const sel = win.getSelection();
      const cells = [];
      const add = cell => {
        if (cell && editor.contains(cell) && !cells.includes(cell)) {
          cells.push(cell);
        }
      };
      for (let i = 0; i < (sel?.rangeCount || 0); i++) {
        const range = sel.getRangeAt(i);
        const node = range.startContainer;
        add((node.nodeType === 1 ? node : node.parentElement)
          ?.closest?.("td, th"));
        // Kéo chuột qua nhiều ô trong contenteditable cho MỘT range trải
        // dài chứ không phải mỗi ô một range — gom mọi ô giao với range,
        // không thì Gộp ô muôn đời chỉ thấy một ô.
        if (!range.collapsed) {
          const scope = range.commonAncestorContainer;
          const root = scope.nodeType === 1 ? scope : scope.parentElement;
          if (root && editor.contains(root) && root.querySelectorAll) {
            for (const cell of root.querySelectorAll("td, th")) {
              try {
                if (range.intersectsNode(cell)) {
                  add(cell);
                }
              } catch (e) {}
            }
          }
        }
      }
      return cells;
    };

    tool("Gộp ô", "Bôi chọn qua các ô rồi bấm để gộp; đặt con trỏ vào " +
                  "một ô rồi bấm là gộp với ô bên phải", () => {
      const cells = selectedCells();
      // Một ô + bấm Gộp = gộp cột với ô kề bên phải cùng hàng — khỏi cần
      // thao tác bôi chọn cho ca thường gặp nhất.
      if (cells.length === 1) {
        const cell = cells[0];
        const grid0 = gridOf(cell.closest("table"));
        for (let r = 0; r < grid0.length; r++) {
          const c = grid0[r].indexOf(cell);
          if (c >= 0) {
            const right = grid0[r][c + cell.colSpan];
            if (right && right.parentElement === cell.parentElement) {
              cells.push(right);
            }
            break;
          }
        }
      }
      const table = cells[0]?.closest("table");
      if (cells.length < 2 || !table ||
          cells.some(c => c.closest("table") !== table)) {
        status.textContent =
          "Gộp ô: bôi chọn qua từ 2 ô trở lên trong cùng bảng, hoặc đặt " +
          "con trỏ vào ô có ô kề bên phải.";
        return;
      }
      const grid = gridOf(table);
      let minR = 1e9, maxR = -1, minC = 1e9, maxC = -1;
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (cells.includes(grid[r][c])) {
            minR = Math.min(minR, r); maxR = Math.max(maxR, r);
            minC = Math.min(minC, c); maxC = Math.max(maxC, c);
          }
        }
      }
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          if (!cells.includes(grid[r][c])) {
            status.textContent = "Gộp ô: vùng chọn phải là hình chữ nhật.";
            return;
          }
        }
      }
      const target = grid[minR][minC];
      for (const cell of cells) {
        if (cell === target) {
          continue;
        }
        if (cell.textContent.trim()) {
          target.appendChild(doc.createTextNode(" "));
          while (cell.firstChild) {
            target.appendChild(cell.firstChild);
          }
        }
        cell.remove();
      }
      target.colSpan = maxC - minC + 1;
      target.rowSpan = maxR - minR + 1;
      status.textContent = "";
    }, tableBar);

    tool("Tách ô", "Tách ô đã gộp về từng ô đơn", () => {
      const cell = selectedCells()[0];
      const table = cell?.closest("table");
      if (!cell || !table || (cell.colSpan < 2 && cell.rowSpan < 2)) {
        status.textContent = "Tách ô: đặt con trỏ vào một ô đã gộp trước.";
        return;
      }
      const grid = gridOf(table);
      let r0 = -1, c0 = -1;
      outer:
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c] === cell) {
            r0 = r; c0 = c;
            break outer;
          }
        }
      }
      const spanR = cell.rowSpan, spanC = cell.colSpan;
      cell.colSpan = 1;
      cell.rowSpan = 1;
      for (let r = r0; r < r0 + spanR; r++) {
        for (let c = c0; c < c0 + spanC; c++) {
          if (r === r0 && c === c0) {
            continue;
          }
          const fresh = el("td");
          fresh.style.cssText = "border:1px solid #cccccc; padding:4px 10px;";
          fresh.textContent = " ";
          const row = table.rows[r];
          // Chèn đúng vị trí: trước ô đầu tiên trong hàng có cột lưới lớn hơn.
          let before = null;
          for (const sibling of row.cells) {
            let sc = -1;
            for (let cc = 0; cc < grid[r].length; cc++) {
              if (grid[r][cc] === sibling) {
                sc = cc;
                break;
              }
            }
            if (sc > c) {
              before = sibling;
              break;
            }
          }
          row.insertBefore(fresh, before);
        }
      }
      status.textContent = "";
    }, tableBar);

    tool("Xoá bảng", "Bỏ cả bảng", () => {
      currentTable()?.remove();
      refreshContext();
    }, tableBar);
    tableBar.hidden = true;
    root.appendChild(tableBar);

    // --- thanh ngữ cảnh: liên kết (địa chỉ, gạch chân, màu) --------------
    const linkBar = el("div", "hmail-sig-toolbar hmail-sig-context");
    linkBar.appendChild(el("span", "hmail-sig-context-label", "Liên kết"));
    const currentLink = () => {
      const node = win.getSelection()?.anchorNode;
      const elem = node?.nodeType === 1 ? node : node?.parentElement;
      const a = elem?.closest?.("a");
      return a && editor.contains(a) ? a : null;
    };
    linkBar.appendChild(el("span", "hmail-sig-prop-label", "Địa chỉ"));
    const urlIn = el("input", "hmail-sig-tool hmail-sig-prop");
    urlIn.type = "text";
    urlIn.style.width = "230px";
    linkBar.appendChild(urlIn);
    urlIn.addEventListener("input", () => {
      const a = currentLink();
      if (a && urlIn.value.trim()) {
        a.setAttribute("href", urlIn.value.trim());
      }
    });
    linkBar.appendChild(el("span", "hmail-sig-prop-label", "Gạch chân"));
    const uSel = el("select", "hmail-sig-tool hmail-sig-select");
    for (const [v, label] of [["", "Mặc định"], ["underline", "Có"],
                              ["none", "Không"]]) {
      const opt = el("option", null, label);
      opt.value = v;
      uSel.appendChild(opt);
    }
    linkBar.appendChild(uSel);
    uSel.addEventListener("change", () => {
      const a = currentLink();
      if (a) {
        // Ghi hẳn vào style của <a>: hộp thư người nhận nào cũng hiểu.
        a.style.textDecoration = uSel.value;
      }
    });
    const linkColor = el("input", "hmail-sig-tool hmail-sig-color");
    linkColor.type = "color";
    linkColor.value = "#0F6CBD";
    linkColor.title = "Màu liên kết";
    linkBar.appendChild(linkColor);
    linkColor.addEventListener("change", () => {
      const a = currentLink();
      if (a) {
        a.style.color = linkColor.value;
      }
    });
    tool("Bỏ liên kết", "Giữ chữ, bỏ liên kết", () => {
      const a = currentLink();
      if (a) {
        while (a.firstChild) {
          a.parentNode.insertBefore(a.firstChild, a);
        }
        a.remove();
        refreshContext();
      }
    }, linkBar);
    const syncLink = () => {
      const a = currentLink();
      if (!a) {
        return;
      }
      urlIn.value = a.getAttribute("href") || "";
      const deco = a.style.textDecoration || "";
      uSel.value = deco.includes("none") ? "none"
        : deco.includes("underline") ? "underline" : "";
    };
    linkBar.hidden = true;
    root.appendChild(linkBar);

    const refreshContext = () => {
      imgBar.hidden = !currentImg;
      const table = currentTable();
      if (tableBar.hidden && table) {
        syncTable();
      }
      tableBar.hidden = !table;
      const link = currentLink();
      if (link) {
        syncLink();
      }
      linkBar.hidden = !link;
    };

    // --- hoàn tác / làm lại -----------------------------------------------
    // Tự quản lịch sử: execCommand("undo") trong document chrome không có
    // transaction manager, và các thanh Ảnh/Bảng/Liên kết đổi DOM bằng JS
    // — thứ mà undo gốc có sống cũng không thấy. Chụp snapshot mỗi khi DOM
    // đổi (debounce), đi lui/tới trên chuỗi đó là undo phủ được tất cả.
    const history = { stack: [], pos: -1, timer: null };
    const snapshot = () => {
      const html = this.serializeHtml(doc, editor);
      if (history.stack[history.pos] === html) {
        return;
      }
      history.stack.splice(history.pos + 1);
      history.stack.push(html);
      if (history.stack.length > 100) {
        history.stack.shift();
      }
      history.pos = history.stack.length - 1;
    };
    new win.MutationObserver(() => {
      win.clearTimeout(history.timer);
      history.timer = win.setTimeout(snapshot, 400);
    }).observe(editor, { subtree: true, childList: true,
                         attributes: true, characterData: true });
    const timeTravel = dir => {
      win.clearTimeout(history.timer);
      // Chốt thay đổi đang dang dở trước khi di chuyển (snapshot tự bỏ
      // qua nếu nội dung trùng bước hiện tại — không phá nhánh redo).
      snapshot();
      const target = history.pos + dir;
      if (target < 0 || target >= history.stack.length) {
        return;
      }
      history.pos = target;
      this.setHtml(win, editor, history.stack[history.pos]);
      currentImg = null;
      refreshContext();
      editor.focus();
    };
    editor.addEventListener("click", event => {
      currentImg = event.target?.localName === "img" ? event.target : null;
      if (currentImg) {
        syncImg();
        // Chọn hẳn node ảnh để Ctrl+C/X/Delete thao tác đúng vào nó.
        try {
          const range = doc.createRange();
          range.selectNode(currentImg);
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
      }
      refreshContext();
    });

    // Clipboard trong document XHTML chrome mặc định chỉ chơi text trơn:
    // paste mất định dạng, ảnh không dán được. Tự lo cả hai chiều.
    const serializeNodes = nodes => {
      const xs = new win.XMLSerializer();
      return Array.from(nodes)
        .filter(n => n.nodeType !== 8 &&
                     !["script", "style"].includes(n.localName))
        .map(n => xs.serializeToString(n))
        .join("");
    };
    const onCopyCut = event => {
      const sel = win.getSelection();
      if (!sel || sel.isCollapsed) {
        return;
      }
      try {
        const holder = el("div");
        for (let i = 0; i < sel.rangeCount; i++) {
          holder.appendChild(sel.getRangeAt(i).cloneContents());
        }
        event.clipboardData.setData("text/html",
                                    serializeNodes(holder.childNodes));
        event.clipboardData.setData("text/plain", holder.textContent);
        event.preventDefault();
        if (event.type === "cut") {
          doc.execCommand("delete");
          currentImg = null;
          refreshContext();
        }
      } catch (e) {}
    };
    editor.addEventListener("copy", onCopyCut);
    editor.addEventListener("cut", onCopyCut);
    editor.addEventListener("paste", event => {
      try {
        const dt = event.clipboardData;
        for (const item of dt.items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            event.preventDefault();
            const reader = new win.FileReader();
            reader.onload = () => {
              editor.focus();
              doc.execCommand("insertImage", false, reader.result);
            };
            reader.readAsDataURL(item.getAsFile());
            return;
          }
        }
        const html = dt.getData("text/html");
        if (html) {
          event.preventDefault();
          // insertHTML trong XHTML đòi chuỗi well-formed: parse bằng
          // DOMParser (nuốt được HTML đời thực) rồi serialize lại.
          const parsed = new win.DOMParser()
            .parseFromString(html, "text/html");
          this.stripComments(parsed.body);
          this.sanitizeTree(parsed.body);
          doc.execCommand("insertHTML", false,
                          serializeNodes(parsed.body.childNodes));
        }
        // Không có HTML: để mặc định dán chữ trơn như cũ.
      } catch (e) {}
    });
    editor.addEventListener("keyup", () => {
      currentImg = null;
      refreshContext();
    });
    // Document chứa tab là XUL và bộ điều hướng focus của nó chạy trong
    // SYSTEM EVENT GROUP — stopPropagation vô nghĩa ở đó, chỉ preventDefault
    // mới chặn được; nhưng preventDefault thì caret cũng chết theo. Nên:
    // chặn hết bằng preventDefault rồi TỰ di chuyển caret qua
    // Selection.modify — mũi tên, Home/End, Shift bôi chọn, Ctrl nhảy từ
    // đều đúng như một editor thực thụ.
    editor.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          event.stopPropagation();
          timeTravel(key === "y" || event.shiftKey ? 1 : -1);
          return;
        }
      }
      const routes = {
        ArrowLeft: ["backward", event.ctrlKey ? "word" : "character"],
        ArrowRight: ["forward", event.ctrlKey ? "word" : "character"],
        ArrowUp: ["backward", "line"],
        ArrowDown: ["forward", "line"],
        Home: ["backward", "lineboundary"],
        End: ["forward", "lineboundary"],
      };
      const route = routes[event.key];
      if (!route) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        win.getSelection().modify(
          event.shiftKey ? "extend" : "move", route[0], route[1]);
      } catch (e) {}
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

    // Làm sạch nội dung editor và trả về chuỗi HTML sẵn sàng ghi vào
    // identity — dùng chung cho Lưu và Lưu-cho-tài-khoản-khác.
    const sigHtml = () => {
      // Kích thước ảnh chuyển từ style sang THUỘC TÍNH width/height:
      // hộp "Thuộc tính hình ảnh" của trình soạn thư chỉ sửa thuộc
      // tính, mà style thì đè thuộc tính — để nguyên style là người
      // dùng chỉnh ảnh trong thư kiểu gì cũng không ăn.
      for (const img of editor.querySelectorAll("img")) {
        // Chỉ quy đổi kích thước px; width theo % giữ nguyên style —
        // parseInt("100%") cũng ra 100 nhưng 100% không phải 100px.
        if (/%/.test(img.style.width + img.style.height)) {
          continue;
        }
        const w = parseInt(img.style.width, 10);
        const h = parseInt(img.style.height, 10);
        if (w) {
          img.setAttribute("width", w);
          img.style.width = "";
          if (h) {
            img.setAttribute("height", h);
          } else {
            img.removeAttribute("height");
          }
          img.style.height = "";
        }
      }
      // Dọn rác trước khi lưu: chú thích từ clipboard, bảng lỡ bị ép
      // về 0px (một cú bấm mũi tên xuống ở ô "Rộng" là đủ gây ra).
      this.stripComments(editor);
      for (const table of editor.querySelectorAll("table")) {
        if (parseInt(table.style.width, 10) === 0) {
          table.style.width = "";
        }
      }
      return this.serializeHtml(doc, editor).trim();
    };
    // Ghi chữ ký đang soạn cho một identity bất kỳ; tên và email trong
    // nội dung tự thay theo tài khoản đích (kể cả trong href mailto:).
    const applyTo = (identity, html) => {
      const from = this.identities().get(select.value);
      const toEmail = (identity.email || "").trim().toLowerCase();
      if (select.value && toEmail && select.value !== toEmail) {
        html = html.split(select.value).join(toEmail);
      }
      const fromName = (from?.fullName || "").trim();
      const toName = (identity.fullName || "").trim();
      if (fromName && toName && fromName !== toName) {
        html = html.split(fromName).join(toName);
      }
      identity.htmlSigText = html;
      identity.htmlSigFormat = true;
      identity.attachSignature = false;
    };

    const actions = el("div", "hmail-move-row");
    const save = el("button", "hmail-ai-btn primary", "Lưu chữ ký");
    save.addEventListener("click", () => {
      try {
        const identity = this.identities().get(select.value);
        if (!identity) {
          return;
        }
        identity.htmlSigText = sigHtml();
        identity.htmlSigFormat = true;
        // Chữ ký lấy từ đây, không phải từ tập tin đính kèm nữa.
        identity.attachSignature = false;
        // Nạp lại từ chính bản vừa ghi: những gì đang thấy CHÍNH LÀ những
        // gì đã lưu — có gì rơi rớt là lộ ra ngay tại đây chứ không phải
        // lúc soạn thư.
        load();
        const dims = [...editor.querySelectorAll("img")].map(img =>
          (img.getAttribute("width") || "auto") + "×" +
          (img.getAttribute("height") || "auto")).join(", ");
        status.textContent =
          "Đã lưu. Thư mới soạn từ " + select.value + " sẽ mang chữ ký này." +
          (dims ? " (ảnh: " + dims + ")" : "");
      } catch (e) {
        status.textContent = "Không lưu được: " + (e.message || e);
      }
    });
    // Một chữ ký đẹp thường dùng cho cả công ty: lưu thẳng cho các tài
    // khoản khác, tên và email trong nội dung tự thay theo từng người.
    const copyBtn = el("button", "hmail-ai-btn", "Lưu cho tài khoản khác…");
    copyBtn.addEventListener("click", () => {
      try {
        const ids = this.identities();
        const others = [...ids.keys()].filter(e => e !== select.value);
        if (!others.length) {
          status.textContent = "Chỉ có một tài khoản thư trong hMail.";
          return;
        }
        const html = sigHtml();
        const flags = Services.prompt.BUTTON_POS_0 *
            Services.prompt.BUTTON_TITLE_IS_STRING +
          Services.prompt.BUTTON_POS_1 *
            Services.prompt.BUTTON_TITLE_IS_STRING +
          Services.prompt.BUTTON_POS_2 *
            Services.prompt.BUTTON_TITLE_CANCEL;
        const pick = Services.prompt.confirmEx(win,
          "Lưu chữ ký cho tài khoản khác",
          "Chữ ký đang soạn sẽ được lưu cho tài khoản khác; tên và email " +
          "trong chữ ký tự thay theo từng tài khoản.",
          flags, "Tất cả tài khoản khác (" + others.length + ")",
          "Chọn một tài khoản…", null, null, {});
        if (pick === 0) {
          for (const email of others) {
            applyTo(ids.get(email), html);
          }
          status.textContent = "Đã lưu chữ ký cho " + others.length +
            " tài khoản khác (tên/email tự thay theo từng tài khoản).";
        } else if (pick === 1) {
          const sel = { value: 0 };
          if (Services.prompt.select(win, "Chọn tài khoản",
                "Lưu chữ ký này cho:", others, sel)) {
            applyTo(ids.get(others[sel.value]), html);
            status.textContent = "Đã lưu chữ ký cho " + others[sel.value] +
              " (tên/email đã thay theo tài khoản đó).";
          }
        }
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
    actions.append(save, copyBtn, clear);
    root.appendChild(actions);
    root.appendChild(status);
    return root;
  },
};

// ---------------------------------------------------------------------------
// Tự kiểm đường LƯU chữ ký, chạy khi pref hmail.debug.sigtest = "run": mở
// tab thật, bơm nội dung bẩn đúng kiểu đời thực (chú thích clipboard, bảng
// width:0px, ô rỗng, ảnh có width/height), bấm nút Lưu thật rồi soi chuỗi
// HTML đã ghi vào identity. Kết quả ghi ngược vào chính pref đó — đọc ở
// prefs.js là biết đậu hay rớt, không cần console. Chữ ký gốc được trả lại
// nguyên vẹn sau bài kiểm.
// Đầu dò render (pref hmail.debug.sigprobe = "run"): chờ một cửa sổ soạn
// thư mở ra rồi đo ảnh đầu tiên trong vùng soạn — thuộc tính nói gì và
// máy VẼ ra bao nhiêu px. Chứng cứ trực tiếp cho các lỗi kiểu "đổi height
// mà ảnh trơ trơ" (CSS đè thuộc tính), không cần chụp màn hình.
(function hMailSigProbe() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.sigprobe", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.sigprobe", text.slice(0, 500));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  let tries = 0;
  const tick = () => {
    try {
      const cw = Services.wm.getMostRecentWindow("msgcompose");
      const cdoc = cw?.GetCurrentEditorElement?.().contentDocument;
      const img = cdoc?.querySelector("img");
      if (img && img.complete) {
        const cs = cw.getComputedStyle(img);
        report("attr=" + img.getAttribute("width") + "x" +
               img.getAttribute("height") + " render=" + cs.width + " x " +
               cs.height + " natural=" + img.naturalWidth + "x" +
               img.naturalHeight);
        return;
      }
    } catch (e) {}
    if (++tries > 60) {
      report("err: khong thay cua so soan thu co anh");
      return;
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 5000);
})();

(function hMailSigSelfTest() {
  let mode = "";
  try {
    mode = Services.prefs.getCharPref("hmail.debug.sigtest", "");
  } catch (e) {}
  if (mode !== "run") {
    return;
  }
  Services.prefs.setCharPref("hmail.debug.sigtest", "running");
  const report = text => {
    try {
      Services.prefs.setCharPref("hmail.debug.sigtest", text.slice(0, 900));
      Services.prefs.savePrefFile(null);
    } catch (e) {}
  };
  setTimeout(() => {
    try {
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      hMailSignature.openTab("");
      win.setTimeout(() => {
        try {
          const doc = win.document;
          const editor = doc.querySelector(".hmail-sig-editor");
          const select = doc.getElementById("hmail-sig-identity");
          const save = [...doc.querySelectorAll("button")]
            .find(b => b.textContent === "Lưu chữ ký");
          if (!editor || !select || !save) {
            report("err: khong thay editor/nut luu");
            return;
          }
          const identity = hMailSignature.identities().get(select.value);
          const orig = identity.htmlSigText;
          const origFmt = identity.htmlSigFormat;
          hMailSignature.setHtml(win, editor,
            '<!--StartFragment--><table style="width: 0px; ' +
            'border-collapse: collapse;"><tbody><tr><td></td>' +
            '<td><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" ' +
            'width="440" height="80"><br>x</td></tr></tbody></table>' +
            "<!--EndFragment-->");
          save.click();
          const out = identity.htmlSigText;
          identity.htmlSigText = orig;
          identity.htmlSigFormat = origFmt;
          // Trả giao diện về chữ ký thật, không bỏ lại bãi test.
          select.dispatchEvent(new win.Event("change"));
          const bad = [];
          if (/xmlns/.test(out)) {
            bad.push("xmlns");
          }
          if (/<!--/.test(out)) {
            bad.push("comment");
          }
          if (/width:\s*0px/.test(out)) {
            bad.push("width-0px");
          }
          if (/<td\s*\/>/.test(out)) {
            bad.push("td-tu-dong");
          }
          if (!/width="440"/.test(out) || !/height="80"/.test(out)) {
            bad.push("mat-thuoc-tinh-anh");
          }
          report(bad.length
            ? "err: " + bad.join(",") + " :: " + out.slice(0, 400)
            : "ok: " + out.slice(0, 300));
        } catch (e) {
          report("err: " + e + " @ " +
                 String(e.stack || "").split("\n")[0]);
        }
      }, 3000);
    } catch (e) {
      report("err: " + e);
    }
  }, 12000);
})();
