/* hMail Desktop — những việc đang chạy
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * hMail has grown several jobs that outlive the click that started them: an
 * Outlook import that runs for hours, a model download of half a gigabyte,
 * indexing a mailbox, a bulk send, a rule sweeping a folder. Closing the
 * window in the middle of any of them loses work, and in the case of a bulk
 * send can leave half a mailing list wondering why they got nothing.
 *
 * Each of those grew its own idea of whether it was running, and only the
 * import ever asked before closing. This is the one register they all report
 * to, and the one place that asks.
 *
 * Deliberately not a lock: the user can always close. They are told what is
 * running and what stopping costs, and then it is their decision — a program
 * that refuses to close is worse than one that loses a download.
 */

"use strict";

var hMailBusy = {
  /** id -> {label, detail, stopHint} */
  jobs: new Map(),

  init(win) {
    try {
      if (this.guarded) {
        return;
      }
      this.guarded = true;
      win.addEventListener("close", event => this.onClose(win, event), true);
    } catch (e) {
      Cu.reportError("hMail busy init failed: " + e);
    }
  },

  /**
   * @param {string} id       stable key, so a job started twice counts once
   * @param {string} label    what it is, in the user's words
   * @param {string} stopHint what closing now would cost
   */
  start(id, label, stopHint = "") {
    this.jobs.set(id, { label, detail: "", stopHint });
  },

  update(id, detail) {
    const job = this.jobs.get(id);
    if (job) {
      job.detail = detail;
    }
  },

  end(id) {
    this.jobs.delete(id);
  },

  running() {
    return this.jobs.size > 0;
  },

  onClose(win, event) {
    if (!this.jobs.size) {
      return;
    }
    const lines = [];
    for (const job of this.jobs.values()) {
      lines.push(`  • ${job.label}` + (job.detail ? ` — ${job.detail}` : ""));
      if (job.stopHint) {
        lines.push(`      ${job.stopHint}`);
      }
    }

    const stay = Services.prompt.confirmEx(
      win, "hMail đang làm việc",
      `Có ${this.jobs.size} việc đang chạy:\n\n${lines.join("\n")}\n\n` +
      "Đóng bây giờ sẽ dừng chúng giữa chừng.",
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING,
      "Để chạy tiếp", "Đóng và dừng", null, null, {});

    if (stay === 0) {
      event.preventDefault();
      return;
    }
    // Let each job stop itself tidily rather than being cut off mid-write.
    for (const id of this.jobs.keys()) {
      try {
        this.stoppers.get(id)?.();
      } catch (e) {}
    }
  },

  /** A job can hand in the function that stops it cleanly. */
  stoppers: new Map(),

  onStop(id, fn) {
    this.stoppers.set(id, fn);
  },
};
