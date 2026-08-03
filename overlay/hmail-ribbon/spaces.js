/* hMail Desktop — thanh điều hướng bên trái luôn hiện
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Thunderbird lets the spaces toolbar be collapsed. At Thunderbird's own
 * width that trade is arguable; at ours it is not — the rail is already down
 * to a single column of icons, so collapsing it saves 45 pixels and costs the
 * only way to move between mail, calendar, tasks and contacts.
 *
 * Worse, it is a one-way door in practice. What comes back is an unlabelled
 * 16px chevron in the bottom-left corner of the window, and a pinned button
 * in the tab bar — which is itself hidden while only one tab is open. Someone
 * who collapses the rail by accident has no obvious way back.
 *
 * So the affordance is gone: the hide button, the reveal button, the pinned
 * button and both menu entries are hidden in CSS, and this puts the rail back
 * for anyone who already collapsed it before the change landed.
 */

"use strict";

var hMailSpaces = {
  init(win) {
    try {
      // Someone who collapsed it in an earlier build is stuck with the state
      // saved in the xulStore; clear it, then put the rail back.
      const spaces = win.gSpacesToolbar;
      if (!spaces) {
        return;
      }
      try {
        Services.xulStore.setValue(
          spaces.docURL || win.document.documentURI,
          "spacesToolbar", "hidden", "false");
      } catch (e) {}

      if (spaces.isHidden && typeof spaces.toggleToolbar === "function") {
        spaces.toggleToolbar(false);
      }
    } catch (e) {
      Cu.reportError("hMail spaces init failed: " + e);
    }
  },
};
