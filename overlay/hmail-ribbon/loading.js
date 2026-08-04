/* hMail Desktop — báo hiệu khi thư đang được nạp
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
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
    } catch (e) {
      Cu.reportError("hMail loading init failed: " + e);
    }
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
