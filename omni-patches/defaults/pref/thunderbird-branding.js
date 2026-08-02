// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// hMail Desktop branding prefs — replaces the upstream Thunderbird
// release-channel branding prefs. All Mozilla/Thunderbird service
// endpoints are removed; hMail Desktop uses its own update channel
// (GitHub Releases) and has in-app notifications disabled.

// No remote start page.
pref("mailnews.start_page.url", "about:blank");
pref("mailnews.start_page.override_url", "");
pref("mailnews.start_page.enabled", false);

// Built-in application update is disabled entirely (see policies.json);
// keep the manual URLs pointing at the hMail release page just in case
// any UI surface still references them.
pref("app.update.interval", 315360000);
pref("app.update.promptWaitTime", 315360000);
pref("app.update.checkInstallTime.days", 36500);
pref("app.update.badgeWaitTime", 315360000);
pref("app.update.url.manual", "https://github.com/haoquangviet/hMail-Desktop/releases");
pref("app.update.url.details", "https://github.com/haoquangviet/hMail-Desktop/releases");

pref("app.vendorURL", "https://github.com/haoquangviet/hMail-Desktop");

// No in-app notification server.
pref("mail.inappnotifications.enabled", false);
pref("mail.inappnotifications.url", "");
