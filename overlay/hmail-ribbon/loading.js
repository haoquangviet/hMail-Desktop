/* hMail Desktop — báo hiệu khi thư đang được nạp
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Clicking a message in a thread gave no sign that anything had happened: the
 * previous message stayed on screen until the new one arrived, which on a slow
 * IMAP folder is several seconds. People clicked again, then a third time.
 *
 * A skeleton — the shape of a message, greyed and breathing — covers the pane
 * from the moment a different message is asked for until it has rendered. It
 * is drawn in CSS; this only decides when it is on screen.
 *
 * The floor of 180ms matters: a message already in the cache appears at once,
 * and flashing a skeleton for one frame looks like a fault rather than a wait.
 */

"use strict";

var hMailLoading = {
  MIN_MS: 180,
  MAX_MS: 12000,

  init(win) {
    try {
      const doc = win.document;
      const tree = doc.getElementById("threadTree");
      if (!tree) {
        return;
      }
      this.win = win;
      tree.addEventListener("select", () => this.start(win));
      // The pane is a browser: its load event fires when the message is
      // rendered, which is exactly when the wait is over.
      const browser = doc.getElementById("messageBrowser");
      browser?.addEventListener("load", () => this.stop(win), true);

      // Dải loading + nút Dừng cho DANH SÁCH thư (folder lớn qua IMAP).
      this.initListBar(win);
    } catch (e) {
      Cu.reportError("hMail loading init failed: " + e);
    }
  },

  /**
   * Dải "đang tải" nổi trên danh sách thư, kèm nút Dừng — cho lúc mở/chuyển
   * folder lớn qua IMAP khi Thunderbird đang nạp danh sách. Nhận biết "đang tải"
   * qua thanh tiến trình gốc (#progressBar / #statusText) nên phủ mọi hoạt động
   * tải, không đụng nội bộ khó bền của message list.
   */
  initListBar(win) {
    try {
      const doc = win.document;
      const tree = doc.getElementById("threadTree");
      const host = tree?.parentNode;
      if (!host) {
        return;
      }
      if (win.getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }

      const NS = "http://www.w3.org/1999/xhtml";
      const bar = doc.createElementNS(NS, "div");
      bar.id = "hmail-loading-bar";
      bar.hidden = true;

      const dots = doc.createElementNS(NS, "span");
      dots.className = "hmail-loading-bar-dots";
      for (let i = 0; i < 3; i++) {
        dots.appendChild(doc.createElementNS(NS, "span"));
      }
      const label = doc.createElementNS(NS, "span");
      label.className = "hmail-loading-bar-text";
      label.textContent = "Đang tải thư…";

      const stop = doc.createElementNS(NS, "button");
      stop.className = "hmail-loading-bar-stop";
      stop.textContent = "Dừng";
      stop.addEventListener("click", () => this.stopLoading(win));

      bar.append(dots, label, stop);
      host.appendChild(bar);
      this.listBar = bar;

      const obs = new win.MutationObserver(() => this.reflectLoading(win));
      const status = doc.getElementById("statusText");
      const progress = doc.getElementById("progressBar");
      if (status) {
        obs.observe(status, { childList: true, characterData: true, subtree: true });
      }
      if (progress) {
        obs.observe(progress,
          { attributes: true, attributeFilter: ["hidden", "collapsed", "value", "mode"] });
      }
      this._loadObs = obs;
      this.reflectLoading(win);
    } catch (e) {
      Cu.reportError("hMail list loading bar failed: " + e);
    }
  },

  /** Thanh tiến trình gốc có đang chạy không. */
  progressActive(win) {
    try {
      const p = win.document.getElementById("progressBar");
      if (!p) {
        return false;
      }
      // Idle: bị ẩn/collapsed. Busy: hiện ra (có value hoặc mode=undetermined).
      if (p.hidden || p.getAttribute("collapsed") === "true") {
        return false;
      }
      const style = win.getComputedStyle(p);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch (e) {
      return false;
    }
  },

  reflectLoading(win) {
    try {
      const txt = (win.document.getElementById("statusText")?.textContent || "")
        .trim();
      const busy = this.progressActive(win) ||
        /đang tải|đang nhận|đang kết nối|loading|receiving|connecting/i.test(txt);
      this.showList(win, !!busy);
    } catch (e) {}
  },

  showList(win, on) {
    try {
      if (this.listBar) {
        this.listBar.hidden = !on;
      }
    } catch (e) {}
  },

  /** Nút Dừng: hủy các URL đang tải của Thunderbird. */
  stopLoading(win) {
    try { win.goDoCommand?.("cmd_stop"); } catch (e) {}
    try { win.msgWindow?.StopUrls?.(); } catch (e) {}
    try { win.top?.msgWindow?.StopUrls?.(); } catch (e) {}
    this.showList(win, false);
  },

  pane(win) {
    const doc = win.document;
    return doc.getElementById("messageBrowser") ||
           doc.getElementById("messagePane");
  },

  start(win) {
    const pane = this.pane(win);
    if (!pane) {
      return;
    }
    // Nothing selected, or a multi-selection: there is no single message
    // coming, so there is nothing to wait for.
    const count = win.gDBView?.numSelected ?? 0;
    if (count !== 1) {
      this.stop(win);
      return;
    }

    this.since = win.performance.now();
    pane.classList.add("hmail-loading");
    win.clearTimeout(this._giveUp);
    // A message that never finishes loading must not leave the pane covered.
    this._giveUp = win.setTimeout(() => this.clear(win), this.MAX_MS);
  },

  stop(win) {
    const elapsed = win.performance.now() - (this.since || 0);
    if (elapsed >= this.MIN_MS) {
      this.clear(win);
      return;
    }
    win.clearTimeout(this._settle);
    this._settle = win.setTimeout(() => this.clear(win),
                                  this.MIN_MS - elapsed);
  },

  clear(win) {
    try {
      win.clearTimeout(this._giveUp);
      this.pane(win)?.classList.remove("hmail-loading");
    } catch (e) {}
  },
};
