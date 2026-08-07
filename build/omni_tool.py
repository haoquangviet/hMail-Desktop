#!/usr/bin/env python3
# MIT License — Copyright (c) 2026 HQV Software
"""
omni_tool.py — rebrand a Thunderbird application directory into hMail Desktop.

Operations (run from anywhere):
  python omni_tool.py --core <path-to-app-dir> --repo <repo-root> [--buildid YYYYMMDDHHMMSS]

What it does:
  1. Rewrites omni.ja, replacing:
       - localization/<loc>/branding/brand.ftl        (all locales found)
       - chrome/<loc>/locale/branding/brand.dtd       (all locales found)
       - chrome/<loc>/locale/branding/brand.properties
       - defaults/pref/thunderbird-branding.js
       - chrome/messenger/content/branding/*.png|*.svg (hMail art, sizes matched
         to the original files so no CSS/layout breaks)
     The archive is written the way Mozilla ships it: ZIP method 0 (Stored),
     no directory entries, no extra fields, normalized timestamps.
  2. Bumps BuildID= in application.ini and platform.ini (invalidates the
     startup cache so stale Thunderbird chrome is never shown).
  3. Generates VisualElements tiles + hmail.VisualElementsManifest.xml.

MPL 2.0 note: the replacement text files in omni-patches/ are modified Mozilla
files and remain MPL 2.0 (see LICENSE.md). This tool itself is MIT.
"""

import argparse
import io
import json
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from PIL import Image

# Normalized timestamp used by Mozilla packaging.
ZIP_DATE = (2010, 1, 1, 0, 0, 0)

BRANDING_DIR = "chrome/messenger/content/branding/"

# Generic (English) fallbacks for locales that have no file in omni-patches/.
FALLBACK_DTD = """<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<!ENTITY brandShortName "hMail">
<!ENTITY brandShorterName "hMail">
<!ENTITY brandFullName "hMail Desktop">
<!ENTITY brandProductName "hMail">
<!ENTITY vendorShortName "HQV Software">
<!ENTITY trademarkInfo.part1 "hMail and the hMail logos are trademarks of HQV Software.">
"""

FALLBACK_PROPERTIES = """# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
brandShortName = hMail
brandShorterName = hMail
brandFullName = hMail Desktop
vendorShortName = HQV Software
"""

ABOUT_PARAGRAPH = (
    "about-paragraph = { -brand-full-name } is built by HQV Software on the "
    "Mozilla Thunderbird open source code base. { -brand-full-name } and "
    "Thunderbird are not officially associated with Mozilla or its products. "
    "Source code: https://github.com/haoquangviet/hMail-Desktop"
)

# Thunderbird's About dialog says the program is made by a global community.
# Rebranded, that sentence would claim HQV Software is one, which is untrue —
# and it also drops the attribution that actually matters. These say who wrote
# hMail and what it is built on. The <a data-l10n-name=...> elements must stay:
# Fluent overlays them onto anchors that exist in the dialog markup.
COMMUNITY_STRINGS = {
    "en-US": {
        "community-desc":
            "community-desc = { -brand-short-name } is developed by "
            "<a data-l10n-name=\"community-mozilla-link\">"
            "{ -vendor-short-name }</a> on the "
            "<a data-l10n-name=\"community-credits-link\">Mozilla Thunderbird "
            "open source code</a>.",
        "community-experimental":
            "community-experimental = "
            "<a data-l10n-name=\"community-exp-mozilla-link\">"
            "{ -vendor-short-name }</a> builds { -brand-short-name } on the "
            "<a data-l10n-name=\"community-exp-credits-link\">Mozilla "
            "Thunderbird open source code</a>.",
        "rights-intro":
            "rights-intro = { -brand-full-name } is developed by "
            "{ -vendor-short-name } from Mozilla Thunderbird, free and open "
            "source software built by a community of thousands of people all "
            "over the world. There are a few things you should know:",
        "about-rights-notification-text":
            "about-rights-notification-text = { -brand-short-name } is built "
            "on Mozilla Thunderbird, free and open source software made by a "
            "community of thousands of people all over the world.",
        # Point 3 upstream is about sending crash reports to the vendor. The
        # crash reporter is switched off in hMail, so the slot carries the
        # warranty disclaimer instead.
        "rights-intro-point-3":
            "rights-intro-point-3 = { -brand-short-name } is provided \"as "
            "is\", without warranty of any kind, express or implied. To the "
            "fullest extent permitted by law, { -vendor-short-name } accepts "
            "no liability and owes no compensation for any loss or damage "
            "arising from your use of { -brand-short-name } — including lost "
            "or corrupted mail, lost business, or any direct, indirect, "
            "incidental or consequential damage. You use { -brand-short-name "
            "} at your own risk and are responsible for keeping your own "
            "backups of your data.",
        "rights-intro-point-4":
            "rights-intro-point-4 = { -brand-short-name } sends nothing to "
            "{ -vendor-short-name }. Mail, calendars and contacts go only to "
            "the servers you configure, and the assistant sends a message to "
            "an AI provider only when you ask it to, using the service and "
            "the key you chose.",
        "rights-webservices-term-5":
            "rights-webservices-term-5 = <strong>To the fullest extent "
            "permitted by law, { -vendor-short-name }, its contributors, "
            "licensors and distributors are not liable for any damage of any "
            "kind arising out of or in any way relating to the use of "
            "{ -brand-short-name } or the Services, and owe no compensation "
            "in respect of any claim relating to them. Some jurisdictions do "
            "not allow the exclusion or limitation of certain damages, so "
            "this exclusion may not apply to you.</strong>",
        "rights-webservices-term-7":
            "rights-webservices-term-7 = These terms are governed by the laws "
            "of Viet Nam. If any part of these terms is held invalid or "
            "unenforceable, the remaining parts remain in full force and "
            "effect. Where a translated version conflicts with the "
            "Vietnamese version, the Vietnamese version prevails.",
        "rights-webservices-header":
            "rights-webservices-header = { -brand-full-name } terms of use",
        "rights-webservices2":
            "rights-webservices2 = { -brand-full-name } is software that runs "
            "on your own machine, not a service operated by "
            "{ -vendor-short-name }. Mail, calendars and contacts go only to "
            "the servers you configure, and the assistant sends a message to "
            "an AI provider only when you ask it to, using the service and "
            "key you chose. The full terms are in EULA.txt in the "
            "installation folder and were shown to you during installation.",
        "rights-webservices-term-1":
            "rights-webservices-term-1 = { -brand-short-name } is provided as "
            "is, without warranty of any kind. { -vendor-short-name } does "
            "not promise that mail will always be sent, received, stored or "
            "synchronised completely and on time.",
        "rights-webservices-term-2":
            "rights-webservices-term-2 = You are responsible for keeping your "
            "own backups, particularly before using the import or migration "
            "features, and for the content of the mail you send and its "
            "compliance with the law.",
        "rights-webservices-term-3":
            "rights-webservices-term-3 = Anything the assistant produces "
            "comes from the AI provider you chose, is for reference only and "
            "should be checked before use. Any charges for that service are "
            "yours. You may choose an AI service running on your own machine "
            "so that message content never leaves it.",
        "rights-webservices-term-4":
            "rights-webservices-term-4 = <strong>To the fullest extent "
            "permitted by law, { -vendor-short-name }, its contributors, "
            "licensors and distributors are not liable for any damage arising "
            "out of or relating to the use of, or inability to use, "
            "{ -brand-short-name } — including lost mail, corrupted or "
            "disclosed data, business interruption, lost profits or lost "
            "opportunities.</strong>",
        "rights-webservices-term-6":
            "rights-webservices-term-6 = { -vendor-short-name } may issue "
            "updates but is under no obligation to do so, and may stop "
            "developing or supporting the software at any time.",
    },
    "vi": {
        "community-desc":
            "community-desc = { -brand-short-name } do "
            "<a data-l10n-name=\"community-mozilla-link\">"
            "{ -vendor-short-name }</a> phát triển trên "
            "<a data-l10n-name=\"community-credits-link\">mã nguồn mở Mozilla "
            "Thunderbird</a>.",
        "community-experimental":
            "community-experimental = "
            "<a data-l10n-name=\"community-exp-mozilla-link\">"
            "{ -vendor-short-name }</a> phát triển { -brand-short-name } trên "
            "<a data-l10n-name=\"community-exp-credits-link\">mã nguồn mở "
            "Mozilla Thunderbird</a>.",
        "rights-intro":
            "rights-intro = { -brand-full-name } do { -vendor-short-name } "
            "phát triển từ Mozilla Thunderbird — phần mềm tự do mã nguồn mở "
            "được xây dựng bởi cộng đồng gồm hàng nghìn người trên khắp thế "
            "giới. Có vài điều mà bạn nên biết:",
        "about-rights-notification-text":
            "about-rights-notification-text = { -brand-short-name } được xây "
            "dựng trên Mozilla Thunderbird — phần mềm nguồn mở và miễn phí, "
            "do cộng đồng gồm hàng ngàn người từ khắp nơi trên thế giới tạo "
            "ra.",
        "rights-intro-point-3":
            "rights-intro-point-3 = { -brand-short-name } được cung cấp theo "
            "hiện trạng (\"nguyên trạng\"), không kèm bất kỳ bảo hành nào, dù "
            "rõ ràng hay ngụ ý. Trong phạm vi pháp luật cho phép, "
            "{ -vendor-short-name } không chịu trách nhiệm và không có nghĩa "
            "vụ bồi thường đối với bất kỳ tổn thất hay thiệt hại nào phát "
            "sinh từ việc bạn sử dụng { -brand-short-name } — kể cả mất thư, "
            "hỏng dữ liệu, gián đoạn công việc, hay bất kỳ thiệt hại trực "
            "tiếp, gián tiếp, ngẫu nhiên hoặc hệ quả nào. Bạn tự chịu trách "
            "nhiệm khi sử dụng { -brand-short-name } và tự sao lưu dữ liệu "
            "của mình.",
        "rights-intro-point-4":
            "rights-intro-point-4 = { -brand-short-name } không gửi gì về "
            "{ -vendor-short-name }. Thư, lịch và danh bạ chỉ đi tới đúng máy "
            "chủ bạn cấu hình; trợ lý chỉ gửi nội dung thư tới nhà cung cấp "
            "AI khi bạn yêu cầu, bằng dịch vụ và API key do chính bạn chọn.",
        "rights-webservices-term-5":
            "rights-webservices-term-5 = <strong>Trong phạm vi pháp luật cho "
            "phép, { -vendor-short-name } cùng những người đóng góp, các bên "
            "cấp phép và phân phối không chịu trách nhiệm đối với bất kỳ "
            "thiệt hại nào phát sinh từ hoặc liên quan tới việc sử dụng "
            "{ -brand-short-name } và các Dịch Vụ, và không có nghĩa vụ bồi "
            "thường đối với bất kỳ yêu cầu nào liên quan. Nếu theo pháp luật "
            "áp dụng, một phần trách nhiệm nào đó không thể được miễn trừ, "
            "thì tổng trách nhiệm của { -vendor-short-name } được giới hạn ở "
            "số tiền bạn đã thực trả cho { -vendor-short-name } để sử dụng "
            "{ -brand-short-name } trong mười hai tháng liền trước sự kiện "
            "phát sinh khiếu nại; nếu bạn không trả khoản tiền nào thì giới "
            "hạn này bằng không. Một số hệ thống pháp luật không cho phép "
            "miễn trừ hoặc giới hạn đối với một số loại thiệt hại, khi đó "
            "phần miễn trừ chỉ không áp dụng ở đúng phạm vi bị cấm.</strong>",
        "rights-webservices-term-7":
            "rights-webservices-term-7 = Các điều khoản này được điều chỉnh "
            "bởi pháp luật Việt Nam. Nếu bất kỳ phần nào bị xem là vô hiệu "
            "hoặc không thể thi hành, các phần còn lại vẫn giữ nguyên hiệu "
            "lực. Khi bản dịch có mâu thuẫn với bản tiếng Việt, bản tiếng "
            "Việt được ưu tiên áp dụng.",
        # Upstream this section is about Mozilla's own web services — Safe
        # Browsing, geolocation — every one of which hMail switches off. Left
        # as it stood it would describe services this program does not use,
        # so it carries hMail's actual terms instead.
        "rights-webservices-header":
            "rights-webservices-header = Điều khoản sử dụng "
            "{ -brand-full-name }",
        "rights-webservices2":
            "rights-webservices2 = { -brand-full-name } là phần mềm chạy trên "
            "máy của bạn, không phải một dịch vụ do { -vendor-short-name } "
            "vận hành. Thư, lịch và danh bạ chỉ đi tới đúng những máy chủ bạn "
            "cấu hình; trợ lý chỉ gửi nội dung thư tới nhà cung cấp AI khi "
            "bạn yêu cầu, bằng dịch vụ và API key do chính bạn chọn. Bản đầy "
            "đủ của điều khoản nằm trong tệp EULA.txt ở thư mục cài đặt và đã "
            "được hiển thị khi bạn cài phần mềm.",
        "rights-webservices-term-1":
            "rights-webservices-term-1 = { -brand-short-name } được cung cấp "
            "theo hiện trạng, không kèm bảo hành dưới bất kỳ hình thức nào. "
            "{ -vendor-short-name } không cam kết rằng thư sẽ luôn được gửi "
            "đi, nhận về, lưu giữ hay đồng bộ đầy đủ và đúng hạn.",
        "rights-webservices-term-2":
            "rights-webservices-term-2 = Bạn tự chịu trách nhiệm sao lưu dữ "
            "liệu của mình, đặc biệt trước khi dùng các chức năng nhập hoặc "
            "chuyển dữ liệu, và tự chịu trách nhiệm về nội dung thư mình gửi "
            "đi cũng như việc tuân thủ pháp luật.",
        "rights-webservices-term-3":
            "rights-webservices-term-3 = Nội dung do trợ lý AI tạo ra là của "
            "nhà cung cấp AI mà bạn chọn, chỉ mang tính tham khảo và cần được "
            "bạn kiểm tra trước khi dùng. Mọi chi phí sử dụng dịch vụ AI do "
            "bạn chịu. Bạn có thể chọn dịch vụ AI chạy ngay trên máy để nội "
            "dung thư không rời khỏi máy.",
        "rights-webservices-term-4":
            "rights-webservices-term-4 = <strong>Trong phạm vi pháp luật cho "
            "phép, { -vendor-short-name } cùng người đóng góp, bên cấp phép "
            "và bên phân phối không chịu trách nhiệm đối với bất kỳ thiệt hại "
            "nào phát sinh từ hoặc liên quan tới việc sử dụng hay không sử "
            "dụng được { -brand-short-name }, kể cả mất thư, hỏng hoặc lộ dữ "
            "liệu, gián đoạn công việc, mất lợi nhuận hay cơ hội kinh "
            "doanh.</strong>",
        "rights-webservices-term-6":
            "rights-webservices-term-6 = { -vendor-short-name } có thể phát "
            "hành bản cập nhật nhưng không có nghĩa vụ phải làm vậy, và có "
            "thể ngừng phát triển hoặc hỗ trợ phần mềm vào bất kỳ lúc nào.",
    },
}

# Which message lives in which file.
COMMUNITY_FILES = {
    "messenger/aboutDialog.ftl": ("community-desc", "community-experimental"),
    "messenger/aboutRights.ftl": (
        "rights-intro", "rights-intro-point-3", "rights-intro-point-4",
        "rights-webservices-header", "rights-webservices2",
        "rights-webservices-term-1", "rights-webservices-term-2",
        "rights-webservices-term-3", "rights-webservices-term-4",
        "rights-webservices-term-5", "rights-webservices-term-6",
        "rights-webservices-term-7"),
    "messenger/messenger.ftl": ("about-rights-notification-text",),
}


def patch_about_dialog(text: str) -> str:
    """
    Trim the About dialog to what attribution actually requires.

    Kept, because they are required: the distribution blurb naming Mozilla
    Thunderbird as the code base with the "not officially associated" wording
    (Mozilla Trademark Policy), the link to our source (MPL 2.0 §3.2), the
    trademark line, and the links to about:license and about:rights.

    Removed, because none of it is required and all of it misleads: the
    donation and get-involved links, which would send an hMail customer's
    money to Thunderbird and imply an association we must explicitly deny;
    the privacy-policy link pointing at Mozilla's policy, which does not
    govern this product; and Thunderbird's release-codename emblem, which is
    their artwork, not ours to ship.
    """
    # Donation / get involved.
    text = re.sub(
        r'\s*<div class="text-blurb" id="contributeDesc".*?</div>',
        "", text, flags=re.S)
    # Mozilla privacy policy link.
    text = re.sub(
        r'\s*<a class="text-link bottom-link browser-link"'
        r'\s+href="https://www\.mozilla\.org/privacy/[^"]*"\s*'
        r'data-l10n-id="bottom-links-privacy"></a>',
        "", text, flags=re.S)
    # Thunderbird release codename emblem.
    text = re.sub(r'\s*<img src="chrome://messenger/skin/icons/brand/'
                  r'[^"]*"[^>]*id="codenameLogo"\s*/>', "", text)
    # Those two anchors now read "HQV Software", so they must not go to
    # Mozilla. The links naming Thunderbird itself are left alone.
    text = re.sub(
        r'href="https://www\.mozilla\.org/"(\s*)'
        r'(data-l10n-name="community(?:-exp)?-mozilla-link")',
        r'href="https://github.com/haoquangviet/hMail-Desktop"\1\2',
        text)
    return text


def patch_community(text: str, locale: str, keys) -> str:
    """Replace whole Fluent messages, continuation lines included."""
    strings = COMMUNITY_STRINGS.get(locale, COMMUNITY_STRINGS["en-US"])
    for key in keys:
        replacement = strings.get(key)
        if not replacement:
            continue
        text = re.sub(
            r"(?m)^" + re.escape(key) + r"\s*=.*(?:\n[ \t]+.*)*",
            lambda _m, r=replacement: r,
            text,
        )
    return text


WORDMARK_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" width="320" height="80">
  <text x="0" y="56" font-family="'Segoe UI', system-ui, sans-serif" font-size="46"
        font-weight="600" fill="#FFFFFF">hMail Desktop</text>
</svg>
"""


def log(msg):
    print(f"[omni_tool] {msg}")


def load_repo_patch(repo: Path, rel: str):
    p = repo / "omni-patches" / Path(rel)
    return p.read_bytes() if p.exists() else None


def strip_fence(text: str, tag: str) -> str:
    """Drop the block between `// TAG>>` and `// <<TAG` (fences included)."""
    return re.sub(rf"// {tag}>>.*?// <<{tag}\n?", "", text, flags=re.S)


def load_oauth_clients(repo: Path):
    """OAuth client registrations from the untracked secrets/ directory —
    the repo is public, so credentials live outside it. Only Microsoft needs
    one: Google rides on Thunderbird's own client (see the append file).
    Returns a map of placeholder -> value plus the providers present."""
    values = {}
    providers = set()

    microsoft = repo / "secrets" / "microsoft-oauth.json"
    if microsoft.exists():
        try:
            data = json.loads(microsoft.read_text("utf-8"))
            values["@MS_CLIENT_ID@"] = data["client_id"]
            providers.add("MICROSOFT")
        except (KeyError, ValueError):
            sys.exit("secrets/microsoft-oauth.json needs a client_id")

    return values, providers


def render_png(logo: Image.Image, width: int, height: int, opacity: float = 1.0) -> bytes:
    """Render the hMail logo centered on a transparent canvas of given size."""
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    side = min(width, height)
    scaled = logo.resize((side, side), Image.LANCZOS)
    if opacity < 1.0:
        alpha = scaled.getchannel("A").point(lambda a: int(a * opacity))
        scaled.putalpha(alpha)
    canvas.paste(scaled, ((width - side) // 2, (height - side) // 2), scaled)
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# Support links baked into the code, not read from a preference. Sending an
# hMail user to Mozilla's support site is wrong twice over: the page describes
# Thunderbird, and the trademark policy is explicit that a rebuild must not
# imply an association with Mozilla. app.support.baseURL already points at
# hMail's own wiki; these are the ones that ignore it.
SUPPORT_URL_FILES = {
    "chrome/messenger/content/messenger/msgHdrView.js",
    "chrome/messenger/content/messenger/aboutImport.xhtml",
    "chrome/messenger/content/messenger/am-e2e.xhtml",
    "chrome/messenger/content/messenger/aboutRights.xhtml",
    # The account hub footer: Support, Release notes and Donate, all three
    # pointing at Mozilla from inside a dialog headed "hMail Desktop".
    "chrome/messenger/content/messenger/messenger.xhtml",
}

HMAIL_WIKI = "https://github.com/haoquangviet/hMail-Desktop/wiki/"

SUPPORT_URL_MAP = {
    "https://support.mozilla.org/kb/thunderbird-and-junk-spam-messages":
        HMAIL_WIKI + "Thu-rac",
    "https://support.mozilla.org/kb/introduction-to-e2e-encryption":
        HMAIL_WIKI + "Ma-hoa-dau-cuoi",
    "https://support.mozilla.org/products/thunderbird":
        HMAIL_WIKI,
}


def patch_support_urls(text: str) -> str:
    """Point in-code help links at hMail's own documentation."""
    for old, new in SUPPORT_URL_MAP.items():
        text = text.replace(old, new)
    # Anything else still aimed at SUMO goes to the wiki index rather than to
    # a page about a different product.
    text = re.sub(r"https://support\.mozilla\.org/[^\s\"'<>)]*",
                  HMAIL_WIKI, text)
    return text


def build_replacements(zf: zipfile.ZipFile, repo: Path):
    """Map of omni.ja entry name -> new bytes."""
    logo = Image.open(repo / "branding" / "hMail-transparent.png").convert("RGBA")
    hmail_svg = (repo / "branding" / "hMail.svg").read_bytes()

    ftl_en = load_repo_patch(repo, "localization/en-US/branding/brand.ftl")
    if ftl_en is None:
        sys.exit("omni-patches/localization/en-US/branding/brand.ftl is required")

    repl = {}
    for info in zf.infolist():
        name = info.filename

        m = re.fullmatch(r"localization/([^/]+)/branding/brand\.ftl", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or ftl_en
            continue

        if name.endswith("content/messenger/aboutDialog.xhtml"):
            repl[name] = patch_about_dialog(
                zf.read(name).decode("utf-8")).encode("utf-8")
            continue

        # Troubleshooting page: the version cell says 140.13.0esr; lead with
        # hMail's own version there too. The page fills itself in async, so
        # the rewrite retries briefly until the cell has content.
        if name.endswith("content/global/aboutSupport.js"):
            extra = (
                b"\n// hMail: the version cell names the product the user"
                b" installed.\n"
                b'window.addEventListener("load", () => {\n'
                b"  let tries = 0;\n"
                b"  const fix = () => {\n"
                b"    try {\n"
                b'      const v = Services.prefs.getCharPref("hmail.version", "");\n'
                b'      const box = document.getElementById("version-box");\n'
                b"      if (v && box && box.textContent) {\n"
                b"        box.textContent =\n"
                b'          v + " (Thunderbird " + Services.appinfo.version + ")";\n'
                b"        return;\n"
                b"      }\n"
                b"    } catch (e) {}\n"
                b"    if (++tries < 20) {\n"
                b"      setTimeout(fix, 250);\n"
                b"    }\n"
                b"  };\n"
                b"  fix();\n"
                b"});\n"
            )
            repl[name] = zf.read(name) + extra
            continue

        # The dialog's headline version is Thunderbird's ("140.13.0esr").
        # The user installed hMail Desktop, so the line leads with hMail's
        # version; the platform stays visible as a parenthetical.
        if name.endswith("content/messenger/aboutDialog.js"):
            extra = (
                b"\n// hMail: the version line names the product the user"
                b" installed.\n"
                b'window.addEventListener("load", () => {\n'
                b"  setTimeout(() => {\n"
                b"    try {\n"
                b'      const v = Services.prefs.getCharPref("hmail.version", "");\n'
                b'      const label = document.getElementById("version");\n'
                b"      if (v && label) {\n"
                b"        label.textContent =\n"
                b'          v + " (Thunderbird " + Services.appinfo.version + ")";\n'
                b"      }\n"
                b"    } catch (e) {}\n"
                b"  }, 0);\n"
                b"});\n"
            )
            repl[name] = zf.read(name) + extra
            continue

        if name in SUPPORT_URL_FILES:
            repl[name] = patch_support_urls(
                zf.read(name).decode("utf-8")).encode("utf-8")
            continue

        m = re.fullmatch(r"localization/([^/]+)/(.+)", name)
        if m and m.group(2) in COMMUNITY_FILES:
            text = zf.read(name).decode("utf-8")
            repl[name] = patch_community(
                text, m.group(1), COMMUNITY_FILES[m.group(2)]).encode("utf-8")
            continue

        # Account Central: drop the Thunderbird donation pitch, keep the rest
        # of the localized strings untouched.
        if re.fullmatch(r"localization/[^/]+/messenger/accountCentral\.ftl", name):
            text = zf.read(name).decode("utf-8")
            text = re.sub(
                r"(?m)^about-paragraph\s*=.*(?:\n[ \t]+.*)*",
                ABOUT_PARAGRAPH,
                text,
            )
            text = re.sub(
                r"(?m)^about-paragraph-consider-donation\s*=.*(?:\n[ \t]+.*)*",
                "about-paragraph-consider-donation = ",
                text,
            )
            repl[name] = text.encode("utf-8")
            continue

        # Swap Mozilla's Google/Microsoft OAuth clients for hMail's own.
        if name == "modules/OAuth2Providers.sys.mjs":
            extra = load_repo_patch(
                repo, "appended/OAuth2Providers.append.mjs")
            values, providers = load_oauth_clients(repo)
            if extra and providers:
                text = extra.decode("utf-8")
                for tag in ("MICROSOFT",):
                    if tag not in providers:
                        text = strip_fence(text, tag)
                for placeholder, value in values.items():
                    text = text.replace(placeholder, value)
                repl[name] = zf.read(name) + b"\n" + text.encode("utf-8")
            continue

        # The meeting-invitation panel renders in a shadow root, so page-level
        # CSS (userChrome, custom.css) cannot reach it — its look can only be
        # adjusted on the sheet the shadow imports. The stock layout is a
        # two-column table whose columns collapse to one character each in a
        # narrow message pane; stacked label-over-value rows survive any
        # width the pane is given.
        if name.endswith("shared/widgets/calendar-invitation-panel.css"):
            extra = (
                b"\n/* hMail: stacked rows instead of a two-column table -"
                b" the table collapsed\n   to one-character columns in a"
                b" narrow message pane. */\n"
                b".calendar-invitation-panel-props,\n"
                b".calendar-invitation-panel-props tbody,\n"
                b".calendar-invitation-panel-props tr,\n"
                b".calendar-invitation-panel-props th,\n"
                b".calendar-invitation-panel-props td {\n"
                b"  display: block;\n"
                b"  text-align: start;\n"
                b"}\n"
                b".calendar-invitation-panel-props {\n"
                b"  width: 100%;\n"
                b"  margin: 0.75em 0;\n"
                b"}\n"
                b".calendar-invitation-panel-props th {\n"
                b"  padding-inline-end: 0;\n"
                b"  padding-block: 6px 0;\n"
                b"  opacity: 0.7;\n"
                b"  font-size: 0.9em;\n"
                b"  font-weight: 600;\n"
                b"}\n"
                b".calendar-invitation-panel-props td.content {\n"
                b"  max-width: none;\n"
                b"}\n"
                b".calendar-invitation-panel-wrapper {\n"
                b"  flex-wrap: wrap;\n"
                b"}\n"
            )
            repl[name] = zf.read(name) + extra
            continue

        # Append hMail rules to the Account Central stylesheet.
        if name.endswith("messenger/shared/accountCentral.css"):
            extra = load_repo_patch(repo, "appended/accountCentral.append.css")
            if extra:
                repl[name] = zf.read(name) + b"\n" + extra
            continue

        m = re.fullmatch(r"chrome/([^/]+)/locale/branding/brand\.dtd", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or FALLBACK_DTD.encode()
            continue

        m = re.fullmatch(r"chrome/([^/]+)/locale/branding/brand\.properties", name)
        if m:
            repl[name] = load_repo_patch(repo, name) or FALLBACK_PROPERTIES.encode()
            continue

        if name == "defaults/pref/thunderbird-branding.js":
            patched = load_repo_patch(repo, name)
            if patched is None:
                sys.exit("omni-patches/defaults/pref/thunderbird-branding.js is required")
            repl[name] = patched
            continue

        # Thunderbird bird watermark on the Account Central page — outside the
        # branding directory, but still trademarked artwork that must go.
        if name.endswith(("images/account-watermark.png",
                          "images/account-watermark-light.png")):
            orig = Image.open(io.BytesIO(zf.read(name)))
            repl[name] = render_png(logo, orig.width, orig.height, opacity=0.10)
            continue

        if name.startswith(BRANDING_DIR):
            base = name[len(BRANDING_DIR):]
            if base.endswith(".png"):
                orig = Image.open(io.BytesIO(zf.read(name)))
                repl[name] = render_png(logo, orig.width, orig.height)
            elif base in ("about-logo.svg", "logo-gradient.svg"):
                repl[name] = hmail_svg
            elif base == "about-wordmark.svg":
                repl[name] = WORDMARK_SVG.encode()
            # aboutDialog.css and inAppNotificationData.json are kept as-is.
            continue

    return repl


def rewrite_omni(core: Path, repo: Path):
    omni = core / "omni.ja"
    if not omni.exists():
        sys.exit(f"omni.ja not found in {core}")

    tmp = core / "omni.ja.hmail-tmp"
    with zipfile.ZipFile(omni, "r") as zin:
        repl = build_replacements(zin, repo)
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as zout:
            for info in zin.infolist():
                data = repl.get(info.filename)
                if data is None:
                    data = zin.read(info.filename)
                out = zipfile.ZipInfo(info.filename, date_time=ZIP_DATE)
                out.compress_type = zipfile.ZIP_STORED
                out.create_system = 0
                out.external_attr = 0
                zout.writestr(out, data)
    omni.unlink()
    tmp.rename(omni)
    log(f"omni.ja rewritten: {len(repl)} entries replaced")


def patch_inis(core: Path, buildid: str):
    """Bump BuildID (invalidates the startup cache) and rebrand the ini strings.

    application.ini is documented as unused at runtime (the real values are
    compiled into xul.dll), but it ships in the install directory and is
    plainly readable, so the Mozilla/Thunderbird names are replaced there too.
    """
    for ini in ("application.ini", "platform.ini"):
        p = core / ini
        if not p.exists():
            log(f"WARN: {ini} not found, skipped")
            continue
        text = p.read_text(encoding="utf-8")
        text = re.sub(r"(?m)^BuildID=.*$", f"BuildID={buildid}", text)
        if ini == "application.ini":
            text = re.sub(r"(?m)^Vendor=.*$", "Vendor=HQV Software", text)
            text = re.sub(r"(?m)^Name=.*$", "Name=hMail Desktop", text)
            text = re.sub(r"(?m)^RemotingName=.*$", "RemotingName=hmail", text)
        # open() rather than Path.write_text: the newline argument only reached
        # write_text in Python 3.10, and the macOS system Python is 3.9.
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    log(f"ini files patched (BuildID {buildid})")


def visual_elements(core: Path, repo: Path):
    logo = Image.open(repo / "branding" / "hMail-transparent.png").convert("RGBA")
    ve = core / "VisualElements"
    ve.mkdir(exist_ok=True)
    # Remove Thunderbird tile art and manifest.
    for old in ve.glob("*.png"):
        old.unlink()
    for old in core.glob("*.VisualElementsManifest.xml"):
        old.unlink()
    (ve / "VisualElements_150.png").write_bytes(render_png(logo, 150, 150))
    (ve / "VisualElements_70.png").write_bytes(render_png(logo, 70, 70))
    manifest = (
        '<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        "  <VisualElements\n"
        '      ShowNameOnSquare150x150Logo="on"\n'
        '      Square150x150Logo="VisualElements\\VisualElements_150.png"\n'
        '      Square70x70Logo="VisualElements\\VisualElements_70.png"\n'
        '      ForegroundText="light"\n'
        '      BackgroundColor="#0F6CBD"/>\n'
        "</Application>\n"
    )
    (core / "hmail.VisualElementsManifest.xml").write_text(manifest, encoding="utf-8")
    log("VisualElements regenerated")


def patch_info_plist(app: Path):
    """Rebrand the macOS bundle's Info.plist (name, identifier, icon, executable)."""
    plist = app / "Contents" / "Info.plist"
    if not plist.exists():
        sys.exit(f"Info.plist not found: {plist}")
    text = plist.read_text(encoding="utf-8")

    def set_key(key: str, value: str, src: str) -> str:
        # <key>Name</key>\n\t<string>old</string>
        pattern = rf"(<key>{re.escape(key)}</key>\s*<string>)[^<]*(</string>)"
        new, n = re.subn(pattern, lambda m: m.group(1) + value + m.group(2), src)
        if n:
            return new
        # Thunderbird's plist omits some of the keys we want (CFBundleDisplayName,
        # NSHumanReadableCopyright); insert them rather than silently skipping.
        entry = f"\t<key>{key}</key>\n\t<string>{value}</string>\n"
        marker = "</dict>\n</plist>"
        if marker in src:
            return src.replace(marker, entry + marker, 1)
        log(f"WARN: could not set Info.plist key {key}")
        return src

    for key, value in (
        ("CFBundleName", "hMail Desktop"),
        ("CFBundleDisplayName", "hMail Desktop"),
        ("CFBundleIdentifier", "com.hqvsoftware.hmail"),
        ("CFBundleExecutable", "hmail"),
        ("CFBundleIconFile", "hmail.icns"),
        ("NSHumanReadableCopyright",
         "(c) HQV Software. Based on Mozilla Thunderbird (MPL 2.0)."),
    ):
        text = set_key(key, value, text)

    text = add_url_scheme(text)
    plist.write_text(text, encoding="utf-8")
    log("Info.plist rebranded")


def add_url_scheme(text: str) -> str:
    """Register hmail:// with Launch Services, the macOS half of what the
    Windows installer writes into the registry. Thunderbird's plist already
    declares mailto:, so the entry is appended to the existing array."""
    if "hmail</string>" in text:
        return text
    entry = (
        "\t\t<dict>\n"
        "\t\t\t<key>CFBundleURLName</key>\n"
        "\t\t\t<string>hMail Desktop Link</string>\n"
        "\t\t\t<key>CFBundleURLSchemes</key>\n"
        "\t\t\t<array>\n"
        "\t\t\t\t<string>hmail</string>\n"
        "\t\t\t</array>\n"
        "\t\t</dict>\n"
    )
    m = re.search(r"(<key>CFBundleURLTypes</key>\s*<array>\n)", text)
    if m:
        return text[:m.end()] + entry + text[m.end():]
    block = ("\t<key>CFBundleURLTypes</key>\n\t<array>\n" + entry + "\t</array>\n")
    marker = "</dict>\n</plist>"
    if marker in text:
        return text.replace(marker, block + marker, 1)
    log("WARN: could not register the hmail:// URL scheme")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True,
                    help="Windows: app dir containing omni.ja. "
                         "macOS: <bundle>.app/Contents/Resources")
    ap.add_argument("--repo", required=True, help="hMail-Desktop repo root")
    ap.add_argument("--platform", choices=("win", "mac"), default="win")
    ap.add_argument("--app-bundle", help="macOS: path to the .app bundle")
    ap.add_argument("--buildid", default=datetime.now().strftime("%Y%m%d%H%M%S"))
    args = ap.parse_args()

    core, repo = Path(args.core), Path(args.repo)
    rewrite_omni(core, repo)
    patch_inis(core, args.buildid)

    if args.platform == "win":
        visual_elements(core, repo)
    else:
        if not args.app_bundle:
            sys.exit("--app-bundle is required with --platform mac")
        patch_info_plist(Path(args.app_bundle))
    log("done")


if __name__ == "__main__":
    main()
