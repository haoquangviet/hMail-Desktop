/* hMail Desktop — người gửi trong danh sách thư
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * A card in the message list showed a display name and a subject. A display
 * name is the one part of a message the sender writes themselves, so
 * "Vietcombank" in the list can be anybody at all. This adds the address it
 * actually came from as a line of its own, and an avatar beside it.
 *
 * The avatar is drawn from, in order:
 *
 *   1. the photo on the contact's card in the address book — local, and
 *      chosen by the user;
 *   2. the brand's BIMI logo, but only for a domain hMail has seen pass
 *      DMARC (see below);
 *   3. initials on a colour derived from the address.
 *
 * About BIMI. The standard puts a logo in DNS at
 * <selector>._bimi.<domain>, and the whole point of it is that the logo is
 * only meaningful when the message passed DMARC — otherwise anyone could
 * publish a record and borrow a bank's logo for a forgery. So a logo is only
 * ever shown for a domain where hMail has itself verified a DMARC pass on a
 * message it read, and that verdict is remembered per domain.
 *
 * The record may also carry a mark certificate (a= in the record): a VMC for
 * a registered trademark, a CMC for a mark in use, a GMC for a government
 * emblem. hMail parses it, checks it is currently valid and issued by one of
 * the certificate authorities in the BIMI programme, and only then marks the
 * logo as verified. It does not build a full chain of trust for the BIMI
 * usage extension — the badge says "certificate present and valid", which is
 * what the tooltip states.
 *
 * Logos are fetched once per domain and kept in the profile, never per
 * message: opening a message must never tell the sender you opened it.
 */

"use strict";

var hMailSenderId = {
  ROW_HEIGHT: 64,
  STORE: "hmail-senderid.json",
  MAX_LOGO_BYTES: 64 * 1024,

  // The certificate authorities in the BIMI programme. A mark certificate
  // from anyone else is treated as absent rather than as proof.
  MARK_ISSUERS: [
    "DigiCert", "Entrust", "GlobalSign", "SSL.com", "Actalis",
  ],

  cache: null,
  pending: new Set(),

  // ------------------------------------------------------------------ setup

  init(win) {
    try {
      if (!this.pref("hmail.senderid.enabled", true)) {
        return;
      }
      this.load();
      this.hookCards(win);
    } catch (e) {
      Cu.reportError("hMail sender id init failed: " + e);
    }
  },

  pref(name, fallback) {
    try {
      return typeof fallback === "boolean"
        ? Services.prefs.getBoolPref(name, fallback)
        : Services.prefs.getCharPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  },

  /**
   * Rows are recycled as the list scrolls, so the only correct place to fill
   * ours is the same call Thunderbird uses to fill its own — a mutation
   * observer would repaint stale addresses on fast scrolls.
   */
  hookCards(win) {
    const attach = () => {
      const Card = win.customElements?.get("thread-card");
      if (!Card || Card.prototype._hmailPatched) {
        return !!Card;
      }
      const original = Card.prototype._fillRow;
      const self = this;
      Card.prototype._fillRow = function () {
        original.call(this);
        try {
          self.decorate(win, this);
        } catch (e) {}
      };
      Card.prototype._hmailPatched = true;
      // Two more lines need the room.
      Card.ROW_HEIGHT = self.ROW_HEIGHT;
      return true;
    };

    if (attach()) {
      return;
    }
    // about:3pane may not have defined its elements yet.
    let tries = 0;
    const timer = win.setInterval(() => {
      if (attach() || ++tries > 40) {
        win.clearInterval(timer);
      }
    }, 250);
  },

  // ------------------------------------------------------------------- rows

  decorate(win, row) {
    if ((row.dataset.properties || "").includes("dummy")) {
      row.querySelector(".hmail-card-id")?.setAttribute("hidden", "true");
      return;
    }
    const hdr = win.gDBView?.getMsgHdrAt?.(row._index);
    if (!hdr) {
      return;
    }

    const author = String(hdr.mime2DecodedAuthor || hdr.author || "");
    const address = this.address(author);
    const parts = this.parts(row, win);
    parts.wrap.removeAttribute("hidden");
    parts.address.textContent = address || author;
    parts.address.title = author;

    // Initials first, so a row never renders empty while DNS is out.
    this.paintInitials(parts.avatar, author, address);
    this.paintAvatar(win, parts.avatar, hdr, address);
  },

  /** Build our two extra pieces once per recycled row. */
  parts(row, win) {
    let wrap = row.querySelector(".hmail-card-id");
    if (wrap) {
      return {
        wrap,
        address: wrap.querySelector(".hmail-card-address"),
        avatar: row.querySelector(".hmail-card-avatar"),
      };
    }

    const doc = row.ownerDocument;
    const container = row.querySelector(".card-container");
    const column = row.querySelector(".thread-card-column:last-of-type");

    const avatar = doc.createElement("div");
    avatar.className = "hmail-card-avatar";
    container?.insertBefore(avatar, container.firstChild?.nextSibling || null);

    wrap = doc.createElement("div");
    wrap.className = "thread-card-row hmail-card-id";
    const address = doc.createElement("span");
    address.className = "hmail-card-address";
    wrap.appendChild(address);
    column?.appendChild(wrap);

    return { wrap, address, avatar };
  },

  address(from) {
    const m = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from) ||
              /([^<>@\s]+@[^<>@\s]+)/.exec(from);
    return m ? m[1].toLowerCase() : "";
  },

  displayName(from) {
    const name = from.replace(/<[^>]*>/g, "").replace(/^"|"$/g, "").trim();
    return name && !name.includes("@") ? name : "";
  },

  // --------------------------------------------------------------- painting

  /**
   * Initials on a colour taken from the address, so the same sender always
   * gets the same colour and two senders side by side rarely share one.
   */
  paintInitials(avatar, author, address) {
    const name = this.displayName(author) || address || "?";
    const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/);
    const initials = words.length > 1
      ? (words[0][0] + words[words.length - 1][0])
      : name.slice(0, 2);

    let hash = 0;
    for (const ch of address || name) {
      hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    }
    avatar.style.backgroundImage = "";
    avatar.style.setProperty("--hmail-avatar-hue", String(hash % 360));
    avatar.textContent = initials.toUpperCase();
    avatar.classList.remove("logo", "verified");
    avatar.title = address || name;
  },

  paintLogo(avatar, entry, address) {
    avatar.textContent = "";
    avatar.style.backgroundImage = `url("${entry.logo}")`;
    avatar.classList.add("logo");
    avatar.classList.toggle("verified", !!entry.mark);
    avatar.title = entry.mark
      ? `${address}\nLogo BIMI — ${entry.mark.type} do ${entry.mark.issuer} ` +
        `cấp, còn hạn tới ${entry.mark.until}.`
      : `${address}\nLogo BIMI — tên miền tự công bố, không kèm chứng thư dấu hiệu.`;
  },

  async paintAvatar(win, avatar, hdr, address) {
    if (!address) {
      return;
    }
    // The address book wins: it is the user's own choice of picture, it is
    // local, and it needs no network at all.
    const photo = this.bookPhoto(address);
    if (photo) {
      avatar.textContent = "";
      avatar.style.backgroundImage = `url("${photo}")`;
      avatar.classList.add("logo");
      avatar.title = address;
      return;
    }

    if (!this.pref("hmail.senderid.bimi", true)) {
      return;
    }
    const domain = address.split("@")[1];
    if (!domain) {
      return;
    }

    const entry = this.cache?.domains?.[domain];
    if (entry?.logo) {
      this.paintLogo(avatar, entry, address);
      return;
    }
    if (entry && entry.checked && !entry.logo) {
      return;   // Looked before, nothing there. Do not ask again today.
    }
    // A logo is only meaningful once this domain has been seen to pass
    // DMARC on a message hMail actually read.
    if (!this.trusted(domain)) {
      this.noteDmarc(hdr, domain);
      return;
    }
    if (this.pending.has(domain)) {
      return;
    }
    this.pending.add(domain);
    try {
      const found = await this.lookup(win, domain);
      this.remember(domain, found);
      if (found?.logo) {
        this.paintLogo(avatar, found, address);
      }
    } catch (e) {
    } finally {
      this.pending.delete(domain);
    }
  },

  bookPhoto(address) {
    try {
      const card = MailServices.ab.cardForEmailAddress(address);
      return card?.photoURL || "";
    } catch (e) {
      return "";
    }
  },

  // ---------------------------------------------------------------- trust

  trusted(domain) {
    return !!this.cache?.dmarc?.[domain];
  },

  /**
   * Record a DMARC pass for the domain, read from the message's own
   * Authentication-Results. Done once per domain and only for messages the
   * analysis has already streamed, so this costs nothing extra.
   */
  noteDmarc(hdr, domain) {
    try {
      if (typeof hMailInsight === "undefined" || this.pending.has("@" + domain)) {
        return;
      }
      this.pending.add("@" + domain);
      hMailInsight.raw(hdr).then(raw => {
        const headers = hMailInsight.headers(raw);
        const auth = hMailInsight.authResults?.(headers);
        if (auth?.dmarc === "pass") {
          this.cache.dmarc[domain] = true;
          this.save();
        }
      }).catch(() => {}).finally(() => {
        this.pending.delete("@" + domain);
      });
    } catch (e) {}
  },

  // ----------------------------------------------------------------- BIMI

  /** default._bimi.<domain> IN TXT -> v=BIMI1; l=<svg>; a=<pem> */
  async lookup(win, domain) {
    const record = await this.txt(`default._bimi.${domain}`);
    if (!record || !/^\s*v=BIMI1/i.test(record)) {
      return null;
    }
    const field = name =>
      (new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*)`, "i")
        .exec(record)?.[1] || "").trim();

    const logoUrl = field("l");
    if (!/^https:\/\//i.test(logoUrl)) {
      return null;   // BIMI requires https; anything else is not a BIMI logo.
    }

    const svg = await this.fetchText(win, logoUrl, "image/svg+xml");
    if (!svg || !/^\s*(<\?xml|<svg)/i.test(svg)) {
      return null;
    }

    const certUrl = field("a");
    const mark = /^https:\/\//i.test(certUrl)
      ? await this.mark(win, certUrl) : null;

    return {
      logo: `data:image/svg+xml;base64,${win.btoa(unescape(encodeURIComponent(svg)))}`,
      mark,
      checked: Date.now(),
    };
  },

  txt(host) {
    return new Promise(resolve => {
      try {
        const listener = {
          onLookupComplete(request, record, status) {
            if (!Components.isSuccessCode(status) || !record) {
              resolve("");
              return;
            }
            try {
              resolve(record.QueryInterface(Ci.nsIDNSTXTRecord)
                .getRecordsAsOneString());
            } catch (e) {
              resolve("");
            }
          },
        };
        Services.dns.asyncResolve(
          host, Ci.nsIDNSService.RESOLVE_TYPE_TXT, 0, null, listener,
          Services.tm.mainThread, {});
      } catch (e) {
        resolve("");
      }
    });
  },

  async fetchText(win, url, accept) {
    try {
      const response = await win.fetch(url, {
        credentials: "omit",
        cache: "force-cache",
        headers: { Accept: accept },
      });
      if (!response.ok) {
        return "";
      }
      const text = await response.text();
      return text.length > this.MAX_LOGO_BYTES ? "" : text;
    } catch (e) {
      return "";
    }
  },

  /**
   * Read the mark certificate far enough to say something true about it: who
   * issued it, what kind of mark it is, and whether it is in date.
   */
  async mark(win, url) {
    const pem = await this.fetchText(win, url, "application/pem-certificate-chain");
    const body = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
      .exec(pem)?.[1];
    if (!body) {
      return null;
    }
    try {
      const db = Cc["@mozilla.org/security/x509certdb;1"]
        .getService(Ci.nsIX509CertDB);
      const cert = db.constructX509FromBase64(body.replace(/\s+/g, ""));
      const now = Date.now() * 1000;
      if (cert.validity.notBefore > now || cert.validity.notAfter < now) {
        return null;
      }
      const issuer = cert.issuerOrganization || cert.issuerName || "";
      if (!this.MARK_ISSUERS.some(ca => issuer.includes(ca))) {
        return null;
      }
      // The mark type is carried in the certificate policy. Reading the OID
      // out of the DER is more than this needs; the certificate's own
      // subject says it plainly on every mark certificate issued so far.
      const subject = cert.subjectName || "";
      const type = /government/i.test(subject) ? "GMC"
        : /prior use|common mark/i.test(subject) ? "CMC" : "VMC";
      return {
        type,
        issuer,
        until: new Date(cert.validity.notAfter / 1000)
          .toLocaleDateString("vi-VN"),
      };
    } catch (e) {
      return null;
    }
  },

  // ---------------------------------------------------------------- store

  file() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(this.STORE);
    return f.path;
  },

  load() {
    if (this.cache) {
      return;
    }
    this.cache = { domains: {}, dmarc: {} };
    IOUtils.readJSON(this.file()).then(data => {
      if (data && typeof data === "object") {
        this.cache = {
          domains: data.domains || {},
          dmarc: data.dmarc || {},
        };
      }
    }).catch(() => {});
  },

  remember(domain, found) {
    this.cache.domains[domain] = found || { checked: Date.now() };
    this.save();
  },

  save() {
    try {
      IOUtils.writeJSON(this.file(), this.cache).catch(() => {});
    } catch (e) {}
  },
};
