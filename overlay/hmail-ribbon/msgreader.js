/* hMail Desktop — đọc tệp .msg của Outlook
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * A .msg file is a Compound File Binary container ([MS-CFB]) holding one
 * message as a set of MAPI property streams ([MS-OXMSG]). It is the format
 * you get when someone drags a message out of Outlook onto the desktop, and
 * it is the one format a mail client cannot read by dropping it in a folder,
 * because it is not RFC 5322 at all.
 *
 * This reads enough of both specifications to rebuild the message: the
 * original transport headers when Outlook kept them, the plain and HTML
 * bodies, the recipients, and the attachments. What comes out is ordinary
 * RFC 5322 text that any mail store can hold.
 *
 * Only reading is implemented, and nothing here writes to the .msg file.
 */

"use strict";

var hMailMsg = {
  SIGNATURE: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],

  // The MAPI properties worth having. Keys are the property id; the reader
  // tries the unicode stream first, then the 8-bit one.
  PROPS: {
    headers: 0x007d,      // PR_TRANSPORT_MESSAGE_HEADERS
    subject: 0x0037,
    body: 0x1000,
    bodyHtml: 0x1013,
    senderName: 0x0c1a,
    senderEmail: 0x0c1f,
    senderSmtp: 0x5d01,
    displayTo: 0x0e04,
    displayCc: 0x0e03,
    messageId: 0x1035,
    date: 0x0039,
  },

  // ------------------------------------------------------------ container

  async read(path) {
    const bytes = await IOUtils.read(path);
    return this.parse(bytes);
  },

  parse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== this.SIGNATURE[i]) {
        throw new Error("không phải tệp .msg của Outlook");
      }
    }

    const sectorSize = 1 << view.getUint16(30, true);
    const miniSectorSize = 1 << view.getUint16(32, true);
    const numFAT = view.getUint32(44, true);
    const firstDir = view.getUint32(48, true);
    const miniCutoff = view.getUint32(56, true);
    const firstMiniFAT = view.getUint32(60, true);
    const numMiniFAT = view.getUint32(64, true);
    const firstDIFAT = view.getUint32(68, true);
    const numDIFAT = view.getUint32(72, true);

    const offsetOf = sector => (sector + 1) * sectorSize;

    // --- FAT ---------------------------------------------------------------
    // The first 109 FAT sector numbers live in the header; the rest are in a
    // chain of DIFAT sectors.
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < numFAT; i++) {
      const sector = view.getUint32(76 + i * 4, true);
      if (sector === 0xffffffff) {
        break;
      }
      fatSectors.push(sector);
    }
    let difat = firstDIFAT;
    for (let n = 0; n < numDIFAT && difat !== 0xfffffffe &&
                    difat !== 0xffffffff; n++) {
      const base = offsetOf(difat);
      const perSector = sectorSize / 4 - 1;
      for (let i = 0; i < perSector; i++) {
        const sector = view.getUint32(base + i * 4, true);
        if (sector !== 0xffffffff) {
          fatSectors.push(sector);
        }
      }
      difat = view.getUint32(base + perSector * 4, true);
    }

    const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
    fatSectors.forEach((sector, index) => {
      const base = offsetOf(sector);
      for (let i = 0; i < sectorSize / 4; i++) {
        fat[index * (sectorSize / 4) + i] = view.getUint32(base + i * 4, true);
      }
    });

    const chain = (start, table) => {
      const out = [];
      let sector = start;
      // The guard is a corrupt-file backstop: a loop in the table would
      // otherwise hang the import.
      while (sector !== 0xfffffffe && sector !== 0xffffffff &&
             sector < table.length && out.length < 1e6) {
        out.push(sector);
        sector = table[sector];
      }
      return out;
    };

    const readSectors = (sectors, size, base) => {
      const out = new Uint8Array(sectors.length * sectorSize);
      sectors.forEach((sector, i) => {
        out.set(bytes.subarray(base(sector), base(sector) + sectorSize),
                i * sectorSize);
      });
      return size === undefined ? out : out.subarray(0, size);
    };

    // --- directory ---------------------------------------------------------
    const dirBytes = readSectors(chain(firstDir, fat), undefined, offsetOf);
    const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset,
                                 dirBytes.byteLength);
    const entries = [];
    for (let i = 0; i + 128 <= dirBytes.length; i += 128) {
      const nameLen = dirView.getUint16(i + 64, true);
      let name = "";
      for (let c = 0; c + 1 < Math.max(0, nameLen - 2); c += 2) {
        name += String.fromCharCode(dirView.getUint16(i + c, true));
      }
      entries.push({
        name,
        type: dirBytes[i + 66],           // 1 storage, 2 stream, 5 root
        child: dirView.getUint32(i + 76, true),
        left: dirView.getUint32(i + 68, true),
        right: dirView.getUint32(i + 72, true),
        start: dirView.getUint32(i + 116, true),
        size: dirView.getUint32(i + 120, true),
      });
    }
    if (!entries.length) {
      throw new Error("tệp .msg rỗng");
    }

    // --- mini stream -------------------------------------------------------
    let miniFAT = new Uint32Array(0);
    if (numMiniFAT) {
      const miniBytes = readSectors(chain(firstMiniFAT, fat), undefined,
                                    offsetOf);
      const miniView = new DataView(miniBytes.buffer, miniBytes.byteOffset,
                                    miniBytes.byteLength);
      miniFAT = new Uint32Array(miniBytes.length / 4);
      for (let i = 0; i < miniFAT.length; i++) {
        miniFAT[i] = miniView.getUint32(i * 4, true);
      }
    }
    const miniStream = entries[0].size
      ? readSectors(chain(entries[0].start, fat), entries[0].size, offsetOf)
      : new Uint8Array(0);

    const streamOf = entry => {
      if (!entry.size) {
        return new Uint8Array(0);
      }
      if (entry.size < miniCutoff) {
        const out = new Uint8Array(
          chain(entry.start, miniFAT).length * miniSectorSize);
        chain(entry.start, miniFAT).forEach((sector, i) => {
          const at = sector * miniSectorSize;
          out.set(miniStream.subarray(at, at + miniSectorSize),
                  i * miniSectorSize);
        });
        return out.subarray(0, entry.size);
      }
      return readSectors(chain(entry.start, fat), entry.size, offsetOf);
    };

    // Walk the red-black tree of each storage into a flat child list.
    const childrenOf = index => {
      const out = [];
      const walk = node => {
        if (node === 0xffffffff || node >= entries.length) {
          return;
        }
        walk(entries[node].left);
        out.push(entries[node]);
        walk(entries[node].right);
      };
      walk(entries[index].child);
      return out;
    };

    return this.build(entries, childrenOf, streamOf);
  },

  // --------------------------------------------------------------- message

  /** Pull the properties out of the tree and turn them into RFC 5322. */
  build(entries, childrenOf, streamOf) {
    const indexOf = entry => entries.indexOf(entry);
    const top = childrenOf(0);

    const text = (list, id) => {
      const hex = id.toString(16).padStart(4, "0").toUpperCase();
      const unicode = list.find(
        e => e.name === `__substg1.0_${hex}001F`);
      if (unicode) {
        return this.utf16(streamOf(unicode));
      }
      const ansi = list.find(e => e.name === `__substg1.0_${hex}001E`);
      return ansi ? this.latin(streamOf(ansi)) : "";
    };
    const binary = (list, id) => {
      const hex = id.toString(16).padStart(4, "0").toUpperCase();
      const entry = list.find(e => e.name === `__substg1.0_${hex}0102`);
      return entry ? streamOf(entry) : null;
    };

    const get = id => text(top, id);

    const message = {
      headers: get(this.PROPS.headers),
      subject: get(this.PROPS.subject),
      body: get(this.PROPS.body),
      senderName: get(this.PROPS.senderName),
      senderEmail: get(this.PROPS.senderSmtp) || get(this.PROPS.senderEmail),
      displayTo: get(this.PROPS.displayTo),
      displayCc: get(this.PROPS.displayCc),
      messageId: get(this.PROPS.messageId),
      recipients: [],
      attachments: [],
    };

    const html = binary(top, this.PROPS.bodyHtml);
    message.bodyHtml = html ? this.latin(html) : text(top, this.PROPS.bodyHtml);

    for (const entry of top) {
      if (entry.type !== 1) {
        continue;
      }
      const list = childrenOf(indexOf(entry));
      if (entry.name.startsWith("__recip_version1.0")) {
        const address = text(list, 0x39fe) ||     // PR_SMTP_ADDRESS
                        text(list, 0x3003);       // PR_EMAIL_ADDRESS
        const name = text(list, 0x3001);
        const type = text(list, 0x0c15) || "";
        if (address) {
          message.recipients.push({ address, name, type });
        }
      } else if (entry.name.startsWith("__attach_version1.0")) {
        const data = binary(list, 0x3701);        // PR_ATTACH_DATA_BIN
        const name = text(list, 0x3707) ||        // PR_ATTACH_LONG_FILENAME
                     text(list, 0x3704);          // PR_ATTACH_FILENAME
        const mime = text(list, 0x370e) || "application/octet-stream";
        if (data && data.length) {
          message.attachments.push({ name: name || "attachment", mime, data });
        }
      }
    }

    return message;
  },

  utf16(bytes) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out.replace(/\0+$/, "");
  },

  latin(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += String.fromCharCode(bytes[i]);
    }
    return out.replace(/\0+$/, "");
  },

  // ------------------------------------------------------------- RFC 5322

  /**
   * Rebuild the message as mail text.
   *
   * When Outlook kept the original transport headers, those are used as they
   * are: they carry the real Message-ID, the authentication results and the
   * full Received chain, and nothing reconstructed can match that. For a
   * message composed in Outlook and never sent there are no transport
   * headers, so a minimal set is synthesised from the MAPI properties.
   */
  toRfc822(message) {
    const boundary = "hmail-msg-" + Math.abs(this.hash(
      message.subject + message.senderEmail + message.body.length)).toString(36);

    let head = (message.headers || "").replace(/\r?\n/g, "\r\n").trim();
    if (head) {
      // The stored body is what will be written, so any description of the
      // old encoding has to go or the message will not decode.
      head = head.replace(
        /^(?:Content-Type|Content-Transfer-Encoding|MIME-Version)[^\n]*(?:\r?\n[ \t][^\n]*)*\r?\n?/gim,
        "");
    } else {
      const from = message.senderEmail
        ? `${message.senderName || ""} <${message.senderEmail}>`.trim()
        : (message.senderName || "unknown@invalid");
      const to = message.recipients.filter(r => r.type !== "3")
        .map(r => r.name ? `${r.name} <${r.address}>` : r.address)
        .join(", ") || message.displayTo || "undisclosed-recipients:;";
      head = [
        `From: ${from}`,
        `To: ${to}`,
        message.displayCc ? `Cc: ${message.displayCc}` : "",
        `Subject: ${this.encodeHeader(message.subject)}`,
        `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
        message.messageId ? `Message-ID: ${message.messageId}` : "",
      ].filter(Boolean).join("\r\n");
    }

    const parts = [];
    if (message.body) {
      parts.push({
        type: "text/plain; charset=utf-8",
        encoding: "base64",
        body: this.base64(this.utf8(message.body)),
      });
    }
    if (message.bodyHtml) {
      parts.push({
        type: "text/html; charset=utf-8",
        encoding: "base64",
        body: this.base64(this.utf8(message.bodyHtml)),
      });
    }
    if (!parts.length) {
      parts.push({ type: "text/plain; charset=utf-8", encoding: "7bit",
                   body: "" });
    }

    const lines = [head, "MIME-Version: 1.0"];

    if (parts.length === 1 && !message.attachments.length) {
      lines.push(`Content-Type: ${parts[0].type}`,
                 `Content-Transfer-Encoding: ${parts[0].encoding}`,
                 "", parts[0].body);
      return lines.join("\r\n");
    }

    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
    for (const part of parts) {
      lines.push(`--${boundary}`,
                 `Content-Type: ${part.type}`,
                 `Content-Transfer-Encoding: ${part.encoding}`,
                 "", part.body, "");
    }
    for (const attachment of message.attachments) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mime}; name="${attachment.name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${attachment.name}"`,
        "", this.base64(attachment.data), "");
    }
    lines.push(`--${boundary}--`, "");
    return lines.join("\r\n");
  },

  /** A .eml file is already mail text; it only needs its line endings fixed. */
  async readEml(path) {
    const bytes = await IOUtils.read(path);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return text.replace(/\r?\n/g, "\r\n");
  },

  // ------------------------------------------------------------- utilities

  utf8(text) {
    return new TextEncoder().encode(text);
  },

  base64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    // Wrapped at 76 characters, as RFC 2045 asks.
    return btoa(binary).replace(/(.{76})/g, "$1\r\n");
  },

  /** Non-ASCII in a header has to be an encoded word. */
  encodeHeader(text) {
    if (!text) {
      return "";
    }
    // eslint-disable-next-line no-control-regex
    if (!/[^\x00-\x7f]/.test(text)) {
      return text;
    }
    return `=?UTF-8?B?${btoa(String.fromCharCode(...this.utf8(text)))}?=`;
  },

  hash(text) {
    let value = 0;
    for (const ch of String(text)) {
      value = (value * 31 + ch.charCodeAt(0)) | 0;
    }
    return value;
  },
};
