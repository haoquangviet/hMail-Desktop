# hMail Desktop — Licensing

hMail Desktop is a "Larger Work" in the sense of the Mozilla Public License 2.0, §3.3.
It combines several independently licensed components. This file explains exactly
which license applies to which part of this repository and of the shipped product.

## 1. Mozilla Thunderbird code — Mozilla Public License 2.0

hMail Desktop is built by repackaging an official, unmodified Mozilla Thunderbird
release for Windows (the exact version, download URL and SHA-256 checksum are pinned
in [UPSTREAM.md](UPSTREAM.md)), then applying the modifications contained in this
repository.

- All Thunderbird / Mozilla source files, and **all modified versions of Mozilla
  files** contained in [`omni-patches/`](omni-patches/), are and remain licensed
  under the **Mozilla Public License, v. 2.0** (<https://mozilla.org/MPL/2.0/>).
- Per MPL 2.0 §3.2(a), the complete Source Code Form is available at no charge:
  - Upstream Thunderbird source: <https://hg-edge.mozilla.org/releases/comm-esr140/>
    and <https://archive.mozilla.org/pub/thunderbird/releases/>
  - Our modifications: this repository
    (<https://github.com/haoquangviet/hMail-Desktop>), together with the
    reproducible repack script [`build/build.ps1`](build/build.ps1).
- License and copyright notices of the upstream product (`license.txt`,
  `about:license`, in-file MPL headers) are preserved unmodified in the shipped
  binaries.

## 2. Files authored by HQV Software — hMail Community License

All files in this repository that are **not** modified copies of Mozilla files
and **not** third-party components — including the build scripts (`build/`),
installer scripts (`installer/`), configuration overlay
(`overlay/distribution/`, `overlay/defaults/`, `overlay/hmail.cfg`), the
ribbon/sidebar/AI/import/calendar modules in `overlay/hmail-ribbon/`, and CSS
written by HQV Software — are licensed under the **hMail Community License**
(see [LICENSE-HQV.md](LICENSE-HQV.md)):

- **free of charge for personal, non-commercial use**;
- **use by or for a business, organization or government requires a paid
  commercial license** from HQV Software (<hqv@haoquangviet.com>).

Releases up to and including v1.0.3 shipped these files under the MIT License
and remain so for those exact versions.

## 3. Outlook-style base theme — MIT License

Parts of `overlay/hmail-chrome/` are derived from
[Browmew/thunderbird-outlook-theme](https://github.com/Browmew/thunderbird-outlook-theme),
© its authors, MIT License. The original MIT notice is retained in the headers of
the derived CSS files. That theme in turn uses Microsoft's
[Fluent UI icons](https://github.com/microsoft/fluentui-system-icons) (MIT License).

## 4. hMail AI — hMail Community License

The AI assistant is **written by HQV Software**, not adapted from anyone
else's work, and is covered by the hMail Community License in section 2 above. It lives in
[`overlay/hmail-ribbon/aiassistant.js`](overlay/hmail-ribbon/aiassistant.js),
`aiassistant-actions.js`, `aiassistant-ui.js` and `compose-ai.js`.

**hMail Desktop ships no GPL component.** The assistant talks to whichever AI
service the user configures — Google Gemini, any service speaking the OpenAI
chat-completions API, or a model running on the user's own machine — over
plain HTTP. No third-party AI add-on is bundled.

## 5. hMail brand — All rights reserved

The name "hMail", "hMail Desktop", and the hMail logo/artwork in
[`branding/`](branding/) are trademarks and copyrighted works of HQV Software.
They are **not** covered by any of the open-source licenses above and may not be
used in derivative distributions without written permission.

## 6. Trademark notice

Mozilla Thunderbird and the Thunderbird logos are trademarks of the Mozilla
Foundation. This product does not include or use those trademarks.
**hMail Desktop and Thunderbird are not officially associated with Mozilla or
its products.**
