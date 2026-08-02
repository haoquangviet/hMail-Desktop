/* hMail Desktop — bộ đọc tệp PST/OST của Outlook
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * Lõi đọc dữ liệu cho tính năng "Nhập dữ liệu từ Outlook": mở tệp .pst/.ost,
 * liệt kê cây thư mục và dựng lại từng thư thành chuỗi RFC 822 ghi ra .eml.
 *
 * Viết bằng JavaScript thuần cho chrome JS đặc quyền của Thunderbird — không
 * thư viện ngoài, không Node API. Chỉ dùng ArrayBuffer/DataView/TextDecoder và
 * IOUtils để đọc tệp.
 *
 * Cấu trúc theo đúng ba lớp của đặc tả [MS-PST], vì trộn chúng vào nhau là cách
 * nhanh nhất để sinh lỗi khó tìm:
 *
 *   NDB (Node Database) — header, hai cây BTree (NBT/BBT), block, cây dữ liệu
 *       (XBLOCK/XXBLOCK), cây subnode (SLBLOCK/SIBLOCK) và giải mã.
 *   LTP (Lists, Tables, Properties) — Heap-on-Node, BTree-on-Heap, Property
 *       Context, Table Context.
 *   Messaging — kho thư, cây thư mục, bảng nội dung, đối tượng thư/đính kèm.
 *
 * Tệp PST có thể lớn tới hàng GB nên KHÔNG nạp toàn bộ vào RAM: mọi truy cập
 * đi qua một lớp đọc theo khối 1 MB có bộ đệm LRU. Đó là lý do gần như toàn bộ
 * hàm nội bộ đều async. Bù lại, open() phải dựng sẵn cây thư mục (kể cả số thư)
 * để folders() giữ được API đồng bộ như hợp đồng đã cam kết.
 *
 * Nguyên tắc: đúng dữ liệu quan trọng hơn đủ tính năng. Thư nào không dựng lại
 * được thì bỏ qua và ghi vào handle.errors, tuyệt đối không ném lỗi ra ngoài
 * làm hỏng cả lần nhập.
 */

"use strict";

var hMailPst = {
  // ================================================================ hằng số

  /** Kích thước khối đọc và số khối giữ trong bộ đệm. */
  CHUNK_BITS: 20,
  CHUNK_CACHE: 48,

  /** Chặn trên để một tệp hỏng không kéo bộ nhớ đi theo. */
  MAX_BTREE_PAGES: 400000,
  MAX_DATA_BYTES: 128 * 1024 * 1024,
  MAX_TREE_DEPTH: 32,

  PTYPE_BBT: 0x80,
  PTYPE_NBT: 0x81,

  // Loại NID — 5 bit thấp của một node id.
  NID_TYPE_HID: 0x00,
  NID_TYPE_INTERNAL: 0x01,
  NID_TYPE_NORMAL_FOLDER: 0x02,
  NID_TYPE_SEARCH_FOLDER: 0x03,
  NID_TYPE_NORMAL_MESSAGE: 0x04,
  NID_TYPE_ATTACHMENT: 0x05,
  NID_TYPE_ASSOC_MESSAGE: 0x08,
  NID_TYPE_HIERARCHY_TABLE: 0x0d,
  NID_TYPE_CONTENTS_TABLE: 0x0e,
  NID_TYPE_ASSOC_CONTENTS_TABLE: 0x0f,
  NID_TYPE_ATTACHMENT_TABLE: 0x11,
  NID_TYPE_RECIPIENT_TABLE: 0x12,

  NID_MESSAGE_STORE: 0x21,
  NID_ROOT_FOLDER: 0x122,

  // Subnode cố định bên trong một đối tượng thư.
  NID_ATTACHMENT_TABLE: 0x671,
  NID_RECIPIENT_TABLE: 0x692,

  // Thẻ thuộc tính dùng đến (xem [MS-OXPROPS]).
  P: {
    DISPLAY_NAME: 0x3001,
    CONTENT_COUNT: 0x3602,
    SUBFOLDERS: 0x360a,
    IPM_SUBTREE_ENTRYID: 0x35e0,
    SUBJECT: 0x0037,
    NORMALIZED_SUBJECT: 0x0e1d,
    SENDER_NAME: 0x0c1a,
    SENDER_EMAIL: 0x0c1f,
    SENDER_ADDRTYPE: 0x0c1e,
    SENDER_SMTP: 0x5d01,
    SENT_REPR_NAME: 0x0042,
    SENT_REPR_EMAIL: 0x0065,
    SENT_REPR_SMTP: 0x5d02,
    DISPLAY_TO: 0x0e04,
    DISPLAY_CC: 0x0e03,
    DISPLAY_BCC: 0x0e02,
    CLIENT_SUBMIT_TIME: 0x0039,
    MESSAGE_DELIVERY_TIME: 0x0e06,
    LAST_MODIFICATION_TIME: 0x3008,
    BODY: 0x1000,
    BODY_HTML: 0x1013,
    RTF_COMPRESSED: 0x1009,
    TRANSPORT_HEADERS: 0x007d,
    MESSAGE_FLAGS: 0x0e07,
    MESSAGE_CLASS: 0x001a,
    HAS_ATTACH: 0x0e1b,
    INTERNET_MESSAGE_ID: 0x1035,
    INTERNET_CPID: 0x3fde,
    MESSAGE_CODEPAGE: 0x3ffd,
    ATTACH_DATA_BINARY: 0x3701,
    ATTACH_FILENAME: 0x3704,
    ATTACH_LONG_FILENAME: 0x3707,
    ATTACH_MIME_TAG: 0x370e,
    ATTACH_CONTENT_ID: 0x3712,
    ATTACH_METHOD: 0x3705,
    ATTACH_EXTENSION: 0x3703,
  },

  MSGFLAG_READ: 0x01,

  /* Bảng hoán vị của [MS-PST] mục 5.1. Ba bảng 256 byte liên tiếp: mpbbR dùng
   * để mã hoá, mpbbI để giải mã, mpbbS chỉ dùng trong phép cyclic. */
  _mpbb: null,

  _MPBB_SRC: [
    65, 54, 19, 98, 168, 33, 110, 187, 244, 22, 204, 4, 127, 100, 232, 93,
    30, 242, 203, 42, 116, 197, 94, 53, 210, 149, 71, 158, 150, 45, 154, 136,
    76, 125, 132, 63, 219, 172, 49, 182, 72, 95, 246, 196, 216, 57, 139, 231,
    35, 59, 56, 142, 200, 193, 223, 37, 177, 32, 165, 70, 96, 78, 156, 251,
    170, 211, 86, 81, 69, 124, 85, 0, 7, 201, 43, 157, 133, 155, 9, 160,
    143, 173, 179, 15, 99, 171, 137, 75, 215, 167, 21, 90, 113, 102, 66, 191,
    38, 74, 107, 152, 250, 234, 119, 83, 178, 112, 5, 44, 253, 89, 58, 134,
    126, 206, 6, 235, 130, 120, 87, 199, 141, 67, 175, 180, 28, 212, 91, 205,
    226, 233, 39, 79, 195, 8, 114, 128, 207, 176, 239, 245, 40, 109, 190, 48,
    77, 52, 146, 213, 14, 60, 34, 50, 229, 228, 249, 159, 194, 209, 10, 129,
    18, 225, 238, 145, 131, 118, 227, 151, 230, 97, 138, 23, 121, 164, 183, 220,
    144, 122, 92, 140, 2, 166, 202, 105, 222, 80, 26, 17, 147, 185, 82, 135,
    88, 252, 237, 29, 55, 73, 27, 106, 224, 41, 51, 153, 189, 108, 217, 148,
    243, 64, 84, 111, 240, 198, 115, 184, 214, 62, 101, 24, 68, 31, 221, 103,
    16, 241, 12, 25, 236, 174, 3, 161, 20, 123, 169, 11, 255, 248, 163, 192,
    162, 1, 247, 46, 188, 36, 104, 117, 13, 254, 186, 47, 181, 208, 218, 61,

    20, 83, 15, 86, 179, 200, 122, 156, 235, 101, 72, 23, 22, 21, 159, 2,
    204, 84, 124, 131, 0, 13, 12, 11, 162, 98, 168, 118, 219, 217, 237, 199,
    197, 164, 220, 172, 133, 116, 214, 208, 167, 155, 174, 154, 150, 113, 102, 195,
    99, 153, 184, 221, 115, 146, 142, 132, 125, 165, 94, 209, 93, 147, 177, 87,
    81, 80, 128, 137, 82, 148, 79, 78, 10, 107, 188, 141, 127, 110, 71, 70,
    65, 64, 68, 1, 17, 203, 3, 63, 247, 244, 225, 169, 143, 60, 58, 249,
    251, 240, 25, 48, 130, 9, 46, 201, 157, 160, 134, 73, 238, 111, 77, 109,
    196, 45, 129, 52, 37, 135, 27, 136, 170, 252, 6, 161, 18, 56, 253, 76,
    66, 114, 100, 19, 55, 36, 106, 117, 119, 67, 255, 230, 180, 75, 54, 92,
    228, 216, 53, 61, 69, 185, 44, 236, 183, 49, 43, 41, 7, 104, 163, 14,
    105, 123, 24, 158, 33, 57, 190, 40, 26, 91, 120, 245, 35, 202, 42, 176,
    175, 62, 254, 4, 140, 231, 229, 152, 50, 149, 211, 246, 74, 232, 166, 234,
    233, 243, 213, 47, 112, 32, 242, 31, 5, 103, 173, 85, 16, 206, 205, 227,
    39, 59, 218, 186, 215, 194, 38, 212, 145, 29, 210, 28, 34, 51, 248, 250,
    241, 90, 239, 207, 144, 182, 139, 181, 189, 192, 191, 8, 151, 30, 108, 226,
    97, 224, 198, 193, 89, 171, 187, 88, 222, 95, 223, 96, 121, 126, 178, 138,

    71, 241, 180, 230, 11, 106, 114, 72, 133, 78, 158, 235, 226, 248, 148, 83,
    224, 187, 160, 2, 232, 90, 9, 171, 219, 227, 186, 198, 124, 195, 16, 221,
    57, 5, 150, 48, 245, 55, 96, 130, 140, 201, 19, 74, 107, 29, 243, 251,
    143, 38, 151, 202, 145, 23, 1, 196, 50, 45, 110, 49, 149, 255, 217, 35,
    209, 0, 94, 121, 220, 68, 59, 26, 40, 197, 97, 87, 32, 144, 61, 131,
    185, 67, 190, 103, 210, 70, 66, 118, 192, 109, 91, 126, 178, 15, 22, 41,
    60, 169, 3, 84, 13, 218, 93, 223, 246, 183, 199, 98, 205, 141, 6, 211,
    105, 92, 134, 214, 20, 247, 165, 102, 117, 172, 177, 233, 69, 33, 112, 12,
    135, 159, 116, 164, 34, 76, 111, 191, 31, 86, 170, 46, 179, 120, 51, 80,
    176, 163, 146, 188, 207, 25, 28, 167, 99, 203, 30, 77, 62, 75, 27, 155,
    79, 231, 240, 238, 173, 58, 181, 89, 4, 234, 64, 85, 37, 81, 229, 122,
    137, 56, 104, 82, 123, 252, 39, 174, 215, 189, 250, 7, 244, 204, 142, 95,
    239, 53, 156, 132, 43, 21, 213, 119, 52, 73, 182, 18, 10, 127, 113, 136,
    253, 157, 24, 65, 125, 147, 216, 88, 44, 206, 254, 36, 175, 222, 184, 54,
    200, 161, 128, 166, 153, 152, 168, 47, 14, 129, 101, 115, 228, 194, 162, 138,
    212, 225, 17, 208, 8, 139, 42, 242, 237, 154, 100, 63, 193, 108, 249, 236,
  ],

  // ============================================================== API công khai

  /**
   * Mở một tệp PST/OST: đọc header, xác định ANSI hay Unicode, nạp NBT/BBT rồi
   * dựng sẵn cây thư mục. Ném lỗi chỉ khi tệp không phải PST hoặc không đọc nổi
   * hai cây BTree — tức là khi không còn gì để nhập.
   */
  async open(path) {
    const size = await this._fileSize(path);
    const handle = {
      path,
      size,
      isUnicode: true,
      cryptMethod: 0,
      codepage: 1252,
      nbt: new Map(),
      bbt: new Map(),
      tree: [],
      byPath: new Map(),
      errors: [],
      _io: this._makeIo(path, size),
      _hnCache: new Map(),
    };

    await this._readHeader(handle);
    await this._loadBTrees(handle);
    await this._buildFolderTree(handle);
    return handle;
  },

  /** Cây thư mục đã dựng sẵn lúc open(). */
  folders(handle) {
    return handle && handle.tree ? handle.tree : [];
  },

  /**
   * Lần lượt trả từng thư trong một thư mục. Lỗi của một thư chỉ làm mất thư
   * đó: nó được ghi vào handle.errors rồi vòng lặp đi tiếp.
   */
  async *messages(handle, folderPath) {
    const node = handle.byPath.get(this._normPath(folderPath));
    if (!node) {
      handle.errors.push({
        folder: folderPath,
        error: "Không tìm thấy thư mục trong tệp PST",
      });
      return;
    }

    let rowIds;
    try {
      rowIds = await this._contentRowIds(handle, node.nid);
    } catch (e) {
      handle.errors.push({
        folder: node.path,
        error: `Không đọc được bảng nội dung: ${e.message || e}`,
      });
      return;
    }

    for (const nid of rowIds) {
      let msg;
      try {
        msg = await this._readMessage(handle, nid);
      } catch (e) {
        handle.errors.push({
          folder: node.path,
          nid,
          error: `Bỏ qua thư không dựng lại được: ${e.message || e}`,
        });
        continue;
      }
      if (msg) {
        yield msg;
      }
    }
  },

  /** Nhả bộ đệm. Không có tài nguyên hệ điều hành nào cần đóng. */
  close(handle) {
    if (!handle) {
      return;
    }
    handle.nbt = new Map();
    handle.bbt = new Map();
    handle._hnCache = new Map();
    if (handle._io) {
      handle._io.clear();
    }
    handle._io = null;
  },

  // ================================================================ lớp I/O

  async _fileSize(path) {
    if (typeof IOUtils !== "undefined" && IOUtils.stat) {
      const info = await IOUtils.stat(path);
      return info.size;
    }
    // Không có stat: đành nạp hết một lần để biết kích thước.
    const all = await IOUtils.read(path);
    return all.byteLength;
  },

  /**
   * Đọc theo khối 1 MB với bộ đệm LRU. PST 5 GB không thể nằm hết trong RAM của
   * tiến trình chrome, và các block cần đọc gần như luôn cụm lại theo vị trí.
   */
  _makeIo(path, size) {
    const chunkBits = this.CHUNK_BITS;
    const chunkSize = 1 << chunkBits;
    const limit = this.CHUNK_CACHE;
    const cache = new Map();

    async function chunk(index) {
      const hit = cache.get(index);
      if (hit) {
        // Đưa lên cuối Map để thứ tự chèn phản ánh thứ tự dùng gần nhất.
        cache.delete(index);
        cache.set(index, hit);
        return hit;
      }
      const offset = index * chunkSize;
      const want = Math.min(chunkSize, Math.max(0, size - offset));
      let data = new Uint8Array(0);
      if (want > 0) {
        data = await IOUtils.read(path, { offset, maxBytes: want });
      }
      cache.set(index, data);
      while (cache.size > limit) {
        cache.delete(cache.keys().next().value);
      }
      return data;
    }

    return {
      async bytes(offset, length) {
        if (offset < 0 || length < 0 || offset + length > size) {
          throw new Error(
            `Đọc ngoài phạm vi tệp: offset=${offset} length=${length} size=${size}`
          );
        }
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
          const abs = offset + done;
          const index = Math.floor(abs / chunkSize);
          const within = abs - index * chunkSize;
          const src = await chunk(index);
          const take = Math.min(length - done, src.length - within);
          if (take <= 0) {
            throw new Error(`Tệp bị cắt ngắn tại offset ${abs}`);
          }
          out.set(src.subarray(within, within + take), done);
          done += take;
        }
        return out;
      },
      clear() {
        cache.clear();
      },
    };
  },

  // ================================================================ tiện ích

  _u8(b, o) {
    return b[o];
  },
  _u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  },
  _u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  },
  _i32(b, o) {
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  },
  /* BID và offset 64-bit trong PST thực tế luôn nhỏ hơn 2^53 (chúng là bộ đếm
   * nhân 4, và tệp lớn nhất Outlook tạo ra là 50 GB), nên Number an toàn và
   * tránh phải rải BigInt khắp nơi. */
  _u64(b, o) {
    return this._u32(b, o) + this._u32(b, o + 4) * 4294967296;
  },

  _decodeUtf16(bytes) {
    try {
      return new TextDecoder("utf-16le").decode(bytes);
    } catch (e) {
      return "";
    }
  },

  _decodeAnsi(bytes, codepage) {
    const label = this._codepageLabel(codepage);
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch (e) {
      try {
        return new TextDecoder("windows-1252").decode(bytes);
      } catch (e2) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) {
          s += String.fromCharCode(bytes[i]);
        }
        return s;
      }
    }
  },

  _codepageLabel(cp) {
    switch (cp) {
      case 65001:
        return "utf-8";
      case 1258:
        return "windows-1258";
      case 1251:
        return "windows-1251";
      case 1250:
        return "windows-1250";
      case 1253:
        return "windows-1253";
      case 1254:
        return "windows-1254";
      case 1255:
        return "windows-1255";
      case 1256:
        return "windows-1256";
      case 1257:
        return "windows-1257";
      case 932:
        return "shift_jis";
      case 936:
        return "gbk";
      case 949:
        return "euc-kr";
      case 950:
        return "big5";
      case 874:
        return "windows-874";
      default:
        return "windows-1252";
    }
  },

  /** FILETIME (100ns kể từ 1601-01-01 UTC) sang Date. */
  _fileTimeToDate(lo, hi) {
    const ticks = lo + hi * 4294967296;
    if (!ticks) {
      return null;
    }
    const ms = ticks / 10000 - 11644473600000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  },

  _nidType(nid) {
    return nid & 0x1f;
  },
  _nidIndex(nid) {
    return nid >>> 5;
  },
  /** NID cùng chỉ số nhưng khác loại — cách [MS-PST] đặt tên bảng con của thư mục. */
  _nidWithType(nid, type) {
    return ((nid & ~0x1f) | (type & 0x1f)) >>> 0;
  },

  // ================================================================ NDB: header

  async _readHeader(h) {
    const head = await h._io.bytes(0, Math.min(564, h.size));
    if (
      head[0] !== 0x21 ||
      head[1] !== 0x42 ||
      head[2] !== 0x44 ||
      head[3] !== 0x4e
    ) {
      throw new Error("Không phải tệp PST/OST hợp lệ (thiếu dấu hiệu !BDN)");
    }
    if (this._u16(head, 8) !== 0x4d53) {
      throw new Error("Không phải tệp PST/OST hợp lệ (wMagicClient sai)");
    }

    const wVer = this._u16(head, 10);
    // 14/15 = ANSI (Outlook 97-2002); 23 trở lên = Unicode (Outlook 2003+).
    h.isUnicode = wVer >= 23;
    h.wVer = wVer;

    const rootOff = h.isUnicode ? 0xb4 : 0xa4;
    h.cryptMethod = head[h.isUnicode ? 0x201 : 0x1cd];

    if (h.isUnicode) {
      // ROOT: dwReserved(4) ibFileEof(8) ibAMapLast(8) cbAMapFree(8)
      //       cbPMapFree(8) BREFNBT(16) BREFBBT(16) …
      h.ibFileEof = this._u64(head, rootOff + 4);
      h.brefNbt = {
        bid: this._u64(head, rootOff + 36),
        ib: this._u64(head, rootOff + 44),
      };
      h.brefBbt = {
        bid: this._u64(head, rootOff + 52),
        ib: this._u64(head, rootOff + 60),
      };
    } else {
      // Bản ANSI dùng trường 32 bit nên mọi offset co lại một nửa.
      h.ibFileEof = this._u32(head, rootOff + 4);
      h.brefNbt = {
        bid: this._u32(head, rootOff + 20),
        ib: this._u32(head, rootOff + 24),
      };
      h.brefBbt = {
        bid: this._u32(head, rootOff + 28),
        ib: this._u32(head, rootOff + 32),
      };
    }
  },

  // ================================================================ NDB: BTree

  async _loadBTrees(h) {
    const budget = { pages: this.MAX_BTREE_PAGES };
    await this._walkBTree(h, h.brefNbt.ib, this.PTYPE_NBT, budget, new Set(), 0);
    await this._walkBTree(h, h.brefBbt.ib, this.PTYPE_BBT, budget, new Set(), 0);
    if (!h.bbt.size || !h.nbt.size) {
      throw new Error("Không đọc được cây NBT/BBT — tệp có thể đã hỏng");
    }
  },

  async _walkBTree(h, ib, wantType, budget, seen, depth) {
    if (depth > this.MAX_TREE_DEPTH || budget.pages <= 0) {
      return;
    }
    if (ib <= 0 || ib + 512 > h.size || seen.has(ib)) {
      return;
    }
    seen.add(ib);
    budget.pages--;

    const page = await h._io.bytes(ib, 512);
    const u = h.isUnicode;
    const infoOff = u ? 488 : 496;
    const trailerOff = u ? 496 : 500;

    const cEnt = page[infoOff];
    const cbEnt = page[infoOff + 2];
    const cLevel = page[infoOff + 3];
    const ptype = page[trailerOff];

    if (ptype !== this.PTYPE_BBT && ptype !== this.PTYPE_NBT) {
      return;
    }
    if (!cbEnt || cEnt * cbEnt > infoOff) {
      return;
    }

    for (let i = 0; i < cEnt; i++) {
      const o = i * cbEnt;
      if (cLevel > 0) {
        // BTENTRY: khoá tìm kiếm rồi BREF tới trang con.
        const ibChild = u ? this._u64(page, o + 16) : this._u32(page, o + 8);
        await this._walkBTree(h, ibChild, wantType, budget, seen, depth + 1);
      } else if (ptype === this.PTYPE_NBT) {
        const nid = u ? this._u32(page, o) : this._u32(page, o);
        const entry = u
          ? {
              nid,
              bidData: this._u64(page, o + 8),
              bidSub: this._u64(page, o + 16),
              nidParent: this._u32(page, o + 24),
            }
          : {
              nid,
              bidData: this._u32(page, o + 4),
              bidSub: this._u32(page, o + 8),
              nidParent: this._u32(page, o + 12),
            };
        h.nbt.set(nid >>> 0, entry);
      } else {
        const bid = u ? this._u64(page, o) : this._u32(page, o);
        const entry = u
          ? { bid, ib: this._u64(page, o + 8), cb: this._u16(page, o + 16) }
          : { bid, ib: this._u32(page, o + 4), cb: this._u16(page, o + 8) };
        h.bbt.set(this._bidKey(bid), entry);
      }
    }
  },

  /* Bit 0 của BID là cờ nội bộ của Outlook, không thuộc khoá tra cứu; dùng phép
   * trừ chứ không phải & vì BID có thể vượt 32 bit. */
  _bidKey(bid) {
    return bid - (bid % 2);
  },
  _bidIsInternal(bid) {
    return bid % 4 >= 2;
  },

  // ================================================================ NDB: block

  async _readBlock(h, bid) {
    const e = h.bbt.get(this._bidKey(bid));
    if (!e) {
      throw new Error(`Không tìm thấy block BID ${bid} trong BBT`);
    }
    if (e.ib + e.cb > h.size) {
      throw new Error(`Block BID ${bid} nằm ngoài tệp`);
    }
    const raw = await h._io.bytes(e.ib, e.cb);
    // Chỉ block dữ liệu mới được mã hoá; XBLOCK/SLBLOCK luôn để trần.
    if (h.cryptMethod && !this._bidIsInternal(bid)) {
      this._decrypt(raw, h.cryptMethod, bid % 4294967296);
    }
    return raw;
  },

  _tables() {
    if (!this._mpbb) {
      this._mpbb = Uint8Array.from(this._MPBB_SRC);
    }
    return this._mpbb;
  },

  _decrypt(buf, method, key) {
    const t = this._tables();
    if (method === 1) {
      // NDB_CRYPT_PERMUTE: hoán vị byte, bảng giải mã là mpbbI (offset 512).
      for (let i = 0; i < buf.length; i++) {
        buf[i] = t[512 + buf[i]];
      }
    } else if (method === 2) {
      // NDB_CRYPT_CYCLIC: đối xứng, khoá là 32 bit thấp của BID.
      let w = (key ^ (key >>> 16)) & 0xffff;
      for (let i = 0; i < buf.length; i++) {
        let b = buf[i];
        b = (b + (w & 0xff)) & 0xff;
        b = t[b];
        b = (b + ((w >>> 8) & 0xff)) & 0xff;
        b = t[256 + b];
        b = (b - ((w >>> 8) & 0xff)) & 0xff;
        b = t[512 + b];
        b = (b - (w & 0xff)) & 0xff;
        buf[i] = b;
        w = (w + 1) & 0xffff;
        if (w === 0) {
          w = 1;
        }
      }
    }
  },

  /**
   * Cây dữ liệu của một block: trả về DANH SÁCH các block lá, không phải một
   * mảng phẳng. Heap-on-Node đánh địa chỉ theo chỉ số block nên việc nối chúng
   * lại quá sớm sẽ làm hỏng mọi HID.
   */
  async _readDataBlocks(h, bid, depth = 0) {
    if (depth > this.MAX_TREE_DEPTH) {
      throw new Error("Cây dữ liệu lồng quá sâu");
    }
    const buf = await this._readBlock(h, bid);
    if (!this._bidIsInternal(bid) || buf[0] !== 0x01) {
      return [buf];
    }
    // XBLOCK (cLevel 1) hoặc XXBLOCK (cLevel 2).
    const cEnt = this._u16(buf, 2);
    const step = h.isUnicode ? 8 : 4;
    if (8 + cEnt * step > buf.length) {
      throw new Error("XBLOCK khai báo nhiều mục hơn dữ liệu thực có");
    }
    let out = [];
    let total = 0;
    for (let i = 0; i < cEnt; i++) {
      const childBid = h.isUnicode
        ? this._u64(buf, 8 + i * 8)
        : this._u32(buf, 8 + i * 4);
      const parts = await this._readDataBlocks(h, childBid, depth + 1);
      for (const p of parts) {
        total += p.length;
        if (total > this.MAX_DATA_BYTES) {
          throw new Error("Cây dữ liệu vượt quá giới hạn an toàn");
        }
        out.push(p);
      }
    }
    return out;
  },

  _concat(parts) {
    let total = 0;
    for (const p of parts) {
      total += p.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  },

  /** Cây subnode của một node: Map(nid → {bidData, bidSub}). */
  async _readSubnodes(h, bidSub, depth = 0) {
    const map = new Map();
    if (!bidSub || depth > this.MAX_TREE_DEPTH) {
      return map;
    }
    const buf = await this._readBlock(h, bidSub);
    if (buf[0] !== 0x02) {
      return map;
    }
    const cLevel = buf[1];
    const cEnt = this._u16(buf, 2);
    const base = h.isUnicode ? 8 : 4;

    if (cLevel === 0) {
      const step = h.isUnicode ? 24 : 12;
      for (let i = 0; i < cEnt && base + (i + 1) * step <= buf.length; i++) {
        const o = base + i * step;
        if (h.isUnicode) {
          map.set(this._u32(buf, o) >>> 0, {
            bidData: this._u64(buf, o + 8),
            bidSub: this._u64(buf, o + 16),
          });
        } else {
          map.set(this._u32(buf, o) >>> 0, {
            bidData: this._u32(buf, o + 4),
            bidSub: this._u32(buf, o + 8),
          });
        }
      }
    } else {
      const step = h.isUnicode ? 16 : 8;
      for (let i = 0; i < cEnt && base + (i + 1) * step <= buf.length; i++) {
        const o = base + i * step;
        const childBid = h.isUnicode
          ? this._u64(buf, o + 8)
          : this._u32(buf, o + 4);
        const child = await this._readSubnodes(h, childBid, depth + 1);
        for (const [k, v] of child) {
          map.set(k, v);
        }
      }
    }
    return map;
  },

  // ================================================================ LTP: HN/BTH

  /** Nạp một node thành Heap-on-Node kèm bản đồ subnode. */
  async _openNode(h, nid) {
    const entry = h.nbt.get(nid >>> 0);
    if (!entry) {
      throw new Error(`Không tìm thấy node NID 0x${nid.toString(16)}`);
    }
    const blocks = await this._readDataBlocks(h, entry.bidData);
    const subs = await this._readSubnodes(h, entry.bidSub);
    return this._makeHn(h, blocks, subs);
  },

  /** Mở một subnode (đính kèm, bảng người nhận…) như một HN độc lập. */
  async _openSubnode(h, subs, nid) {
    const ref = subs.get(nid >>> 0);
    if (!ref) {
      throw new Error(`Không tìm thấy subnode 0x${nid.toString(16)}`);
    }
    const blocks = await this._readDataBlocks(h, ref.bidData);
    /* Bản đồ subnode KHÔNG kế thừa từ cha. Kế thừa từng làm thư lồng nhìn thấy
     * bảng đính kèm của thư cha và tự đính kèm chính nó — đệ quy vô hạn. Theo
     * [MS-PST], HNID bên trong một subnode chỉ tra trong cây subnode của chính
     * subnode đó. */
    const inner = await this._readSubnodes(h, ref.bidSub);
    return this._makeHn(h, blocks, inner);
  },

  _makeHn(h, blocks, subs) {
    if (!blocks.length) {
      throw new Error("Node rỗng, không có dữ liệu heap");
    }
    const first = blocks[0];
    if (first.length < 12 || first[2] !== 0xec) {
      throw new Error("Node không phải Heap-on-Node (thiếu chữ ký 0xEC)");
    }
    return {
      h,
      blocks,
      subs,
      clientSig: first[3],
      hidUserRoot: this._u32(first, 4),
    };
  },

  /** Lấy một mục trên heap theo HID. */
  _hidGet(hn, hid) {
    if (!hid) {
      return new Uint8Array(0);
    }
    if ((hid & 0x1f) !== 0) {
      throw new Error(`HID 0x${hid.toString(16)} không phải con trỏ heap`);
    }
    const index = (hid >>> 5) & 0x7ff;
    const blockIndex = hid >>> 16;
    const block = hn.blocks[blockIndex];
    if (!block || index < 1) {
      throw new Error(`HID 0x${hid.toString(16)} trỏ ra ngoài heap`);
    }
    const ibHnpm = this._u16(block, 0);
    if (ibHnpm + 4 > block.length) {
      throw new Error("HNPAGEMAP nằm ngoài block");
    }
    const cAlloc = this._u16(block, ibHnpm);
    if (index > cAlloc) {
      throw new Error(`HID 0x${hid.toString(16)} vượt số mục đã cấp phát`);
    }
    const start = this._u16(block, ibHnpm + 4 + (index - 1) * 2);
    const end = this._u16(block, ibHnpm + 4 + index * 2);
    if (end < start || end > block.length) {
      throw new Error("Mục heap có kích thước không hợp lệ");
    }
    return block.subarray(start, end);
  },

  /** Đọc mọi bản ghi lá của một BTree-on-Heap. */
  _bthRecords(hn, hidBth) {
    const header = this._hidGet(hn, hidBth);
    if (header.length < 8 || header[0] !== 0xb5) {
      throw new Error("Không phải BTree-on-Heap (thiếu chữ ký 0xB5)");
    }
    const cbKey = header[1];
    const cbEnt = header[2];
    const levels = header[3];
    const hidRoot = this._u32(header, 4);

    const out = [];
    const walk = (hid, level) => {
      if (!hid || level > this.MAX_TREE_DEPTH) {
        return;
      }
      const buf = this._hidGet(hn, hid);
      if (level === 0) {
        const step = cbKey + cbEnt;
        for (let o = 0; o + step <= buf.length; o += step) {
          out.push({
            key: buf.subarray(o, o + cbKey),
            value: buf.subarray(o + cbKey, o + step),
          });
        }
      } else {
        const step = cbKey + 4;
        for (let o = 0; o + step <= buf.length; o += step) {
          walk(this._u32(buf, o + cbKey), level - 1);
        }
      }
    };
    walk(hidRoot, levels);
    return { cbKey, cbEnt, records: out };
  },

  // ================================================================ LTP: PC

  /** Đọc Property Context thành Map(propId → {type, raw|value}). */
  async _readPc(hn) {
    const { records } = this._bthRecords(hn, hn.hidUserRoot);
    const props = new Map();
    for (const r of records) {
      if (r.key.length < 2 || r.value.length < 6) {
        continue;
      }
      const propId = this._u16(r.key, 0);
      const type = this._u16(r.value, 0);
      const raw = r.value.subarray(2, 6);
      props.set(propId, { type, raw });
    }
    return props;
  },

  /** Giải mã giá trị một thuộc tính; trả về undefined nếu không đọc được. */
  async _propValue(hn, props, propId, codepage) {
    const p = props.get(propId);
    if (!p) {
      return undefined;
    }
    try {
      return await this._decodeProp(hn, p, codepage);
    } catch (e) {
      return undefined;
    }
  },

  async _decodeProp(hn, p, codepage) {
    const { type, raw } = p;
    switch (type) {
      case 0x0002: // PT_SHORT
        return this._u16(raw, 0) << 16 >> 16;
      case 0x0003: // PT_LONG
        return this._i32(raw, 0);
      case 0x000a: // PT_ERROR
        return this._u32(raw, 0);
      case 0x0004: {
        // PT_FLOAT
        const v = new DataView(raw.buffer, raw.byteOffset, 4);
        return v.getFloat32(0, true);
      }
      case 0x000b: // PT_BOOLEAN
        return raw[0] !== 0;
      case 0x0005: {
        // PT_DOUBLE
        const b = await this._hnidBytes(hn, this._u32(raw, 0));
        if (b.length < 8) {
          return undefined;
        }
        return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
      }
      case 0x0014: {
        // PT_I8
        const b = await this._hnidBytes(hn, this._u32(raw, 0));
        return b.length >= 8 ? this._u64(b, 0) : undefined;
      }
      case 0x0040: {
        // PT_SYSTIME
        const b = await this._hnidBytes(hn, this._u32(raw, 0));
        if (b.length < 8) {
          return undefined;
        }
        return this._fileTimeToDate(this._u32(b, 0), this._u32(b, 4));
      }
      case 0x001f: {
        // PT_UNICODE
        const b = await this._hnidBytes(hn, this._u32(raw, 0));
        return this._decodeUtf16(b);
      }
      case 0x001e: {
        // PT_STRING8
        const b = await this._hnidBytes(hn, this._u32(raw, 0));
        return this._decodeAnsi(b, codepage || hn.h.codepage);
      }
      case 0x0102: // PT_BINARY
      case 0x000d: // PT_OBJECT
        return await this._hnidBytes(hn, this._u32(raw, 0));
      default:
        // Kiểu nhiều giá trị và kiểu lạ: trả về byte thô cho bên gọi tự lo.
        if (type & 0x1000) {
          return await this._hnidBytes(hn, this._u32(raw, 0));
        }
        return undefined;
    }
  },

  /**
   * HNID vừa có thể là HID trên heap của chính node, vừa có thể là NID trỏ tới
   * một subnode — phân biệt bằng 5 bit thấp.
   */
  async _hnidBytes(hn, hnid) {
    if (!hnid) {
      return new Uint8Array(0);
    }
    if ((hnid & 0x1f) === 0) {
      return this._hidGet(hn, hnid);
    }
    const ref = hn.subs.get(hnid >>> 0);
    if (!ref) {
      throw new Error(`HNID 0x${hnid.toString(16)} không có subnode tương ứng`);
    }
    const parts = await this._readDataBlocks(hn.h, ref.bidData);
    return this._concat(parts);
  },

  // ================================================================ LTP: TC

  /**
   * Chỉ lấy dwRowID của từng hàng. Mọi thứ hMail cần (danh sách thư mục con,
   * danh sách thư, danh sách đính kèm) đều là node id, còn thuộc tính thì đọc
   * thẳng từ PC của đối tượng — vừa đơn giản vừa ít cơ hội sai.
   */
  async _tcRowIds(hn) {
    const info = this._hidGet(hn, hn.hidUserRoot);
    if (info.length < 22 || info[0] !== 0x7c) {
      throw new Error("Không phải Table Context (thiếu chữ ký 0x7C)");
    }
    const rowSize = this._u16(info, 8); // rgib[TCI_bm] = độ dài một hàng
    const hnidRows = this._u32(info, 14);
    if (!rowSize || !hnidRows) {
      return [];
    }

    let chunks;
    if ((hnidRows & 0x1f) === 0) {
      chunks = [this._hidGet(hn, hnidRows)];
    } else {
      const ref = hn.subs.get(hnidRows >>> 0);
      if (!ref) {
        return [];
      }
      // Hàng không bao giờ nằm vắt qua hai block, nên phải cắt theo từng block.
      chunks = await this._readDataBlocks(hn.h, ref.bidData);
    }

    const ids = [];
    for (const chunk of chunks) {
      const rows = Math.floor(chunk.length / rowSize);
      for (let i = 0; i < rows; i++) {
        ids.push(this._u32(chunk, i * rowSize) >>> 0);
      }
    }
    return ids;
  },

  // ============================================================ Messaging: cây

  async _buildFolderTree(h) {
    // Codepage của kho thư quyết định cách giải mã chuỗi PT_STRING8.
    let rootNid = this.NID_ROOT_FOLDER;
    try {
      const storeHn = await this._openNode(h, this.NID_MESSAGE_STORE);
      const store = await this._readPc(storeHn);
      const cp = await this._propValue(storeHn, store, this.P.INTERNET_CPID);
      if (typeof cp === "number" && cp > 0) {
        h.codepage = cp;
      }
      const eid = await this._propValue(
        storeHn,
        store,
        this.P.IPM_SUBTREE_ENTRYID
      );
      // EntryID = flags(4) + uid(16) + nid(4).
      if (eid && eid.length >= 24) {
        rootNid = this._u32(eid, 20) >>> 0;
      }
    } catch (e) {
      h.errors.push({
        error: `Không đọc được kho thư, dùng thư mục gốc mặc định: ${e.message || e}`,
      });
    }

    const root = await this._readFolder(h, rootNid, "", new Set(), 0);
    // Thư mục gốc kỹ thuật ("Top of Personal Folders") tự nó không chứa thư;
    // trả về các con của nó để cây hiện ra giống hệt trong Outlook.
    h.tree = root ? root.children : [];
    if (root && root.messageCount > 0) {
      h.tree.unshift({ ...root, children: [] });
    }
    this._indexTree(h, h.tree);
  },

  _indexTree(h, nodes) {
    for (const n of nodes) {
      h.byPath.set(this._normPath(n.path), n);
      this._indexTree(h, n.children);
    }
  },

  _normPath(p) {
    return "/" + String(p || "").replace(/^\/+|\/+$/g, "");
  },

  async _readFolder(h, nid, parentPath, seen, depth) {
    if (seen.has(nid) || depth > this.MAX_TREE_DEPTH) {
      return null;
    }
    seen.add(nid);

    let name = `Folder_${nid.toString(16)}`;
    let count = 0;
    try {
      const hn = await this._openNode(h, nid);
      const pc = await this._readPc(hn);
      const dn = await this._propValue(hn, pc, this.P.DISPLAY_NAME);
      if (typeof dn === "string" && dn.length) {
        name = dn;
      }
      const cc = await this._propValue(hn, pc, this.P.CONTENT_COUNT);
      if (typeof cc === "number" && cc >= 0) {
        count = cc;
      }
    } catch (e) {
      h.errors.push({
        nid,
        error: `Không đọc được thuộc tính thư mục: ${e.message || e}`,
      });
    }

    const path = `${parentPath}/${name.replace(/\//g, "_")}`;
    const node = { name, path, messageCount: count, children: [], nid };

    let childNids = [];
    try {
      const hierNid = this._nidWithType(nid, this.NID_TYPE_HIERARCHY_TABLE);
      const hierHn = await this._openNode(h, hierNid);
      childNids = await this._tcRowIds(hierHn);
    } catch (e) {
      // Thư mục lá không có bảng phân cấp — đây là trường hợp bình thường.
    }

    for (const childNid of childNids) {
      const t = this._nidType(childNid);
      if (t !== this.NID_TYPE_NORMAL_FOLDER && t !== this.NID_TYPE_SEARCH_FOLDER) {
        continue;
      }
      const child = await this._readFolder(h, childNid, path, seen, depth + 1);
      if (child) {
        node.children.push(child);
      }
    }
    return node;
  },

  async _contentRowIds(h, folderNid) {
    const nid = this._nidWithType(folderNid, this.NID_TYPE_CONTENTS_TABLE);
    if (!h.nbt.has(nid >>> 0)) {
      return [];
    }
    const hn = await this._openNode(h, nid);
    const ids = await this._tcRowIds(hn);
    return ids.filter(
      (n) =>
        this._nidType(n) === this.NID_TYPE_NORMAL_MESSAGE ||
        this._nidType(n) === this.NID_TYPE_ASSOC_MESSAGE
    );
  },

  // ========================================================= Messaging: thư

  async _readMessage(h, nid) {
    const hn = await this._openNode(h, nid);
    return this._messageFromHn(h, hn, nid, 0);
  },

  async _messageFromHn(h, hn, nid, depth) {
    const pc = await this._readPc(hn);
    const get = (id) => this._propValue(hn, pc, id, h.codepage);

    const cp = await get(this.P.INTERNET_CPID);
    const codepage = typeof cp === "number" && cp > 0 ? cp : h.codepage;
    const getCp = (id) => this._propValue(hn, pc, id, codepage);

    let subject = (await getCp(this.P.SUBJECT)) || "";
    if (!subject) {
      subject = (await getCp(this.P.NORMALIZED_SUBJECT)) || "";
    }
    subject = this._stripSubjectPrefix(subject);

    const senderName =
      (await getCp(this.P.SENDER_NAME)) ||
      (await getCp(this.P.SENT_REPR_NAME)) ||
      "";
    const senderAddr =
      (await getCp(this.P.SENDER_SMTP)) ||
      (await getCp(this.P.SENT_REPR_SMTP)) ||
      (await getCp(this.P.SENDER_EMAIL)) ||
      (await getCp(this.P.SENT_REPR_EMAIL)) ||
      "";

    const to = (await getCp(this.P.DISPLAY_TO)) || "";
    const cc = (await getCp(this.P.DISPLAY_CC)) || "";
    const bcc = (await getCp(this.P.DISPLAY_BCC)) || "";

    const date =
      (await get(this.P.CLIENT_SUBMIT_TIME)) ||
      (await get(this.P.MESSAGE_DELIVERY_TIME)) ||
      (await get(this.P.LAST_MODIFICATION_TIME)) ||
      null;

    const flags = await get(this.P.MESSAGE_FLAGS);
    const isRead = typeof flags === "number" ? (flags & this.MSGFLAG_READ) !== 0 : false;

    const body = (await getCp(this.P.BODY)) || "";
    let html = await getCp(this.P.BODY_HTML);
    if (html instanceof Uint8Array) {
      html = this._decodeAnsi(html, codepage);
    }
    if (typeof html !== "string") {
      html = "";
    }

    const headers = (await getCp(this.P.TRANSPORT_HEADERS)) || "";
    const messageId = (await getCp(this.P.INTERNET_MESSAGE_ID)) || "";

    const attachments = await this._readAttachments(h, hn, codepage, depth);

    const rfc822 = this._buildRfc822({
      headers,
      subject,
      senderName,
      senderAddr,
      to,
      cc,
      bcc,
      date,
      body,
      html,
      attachments,
      messageId,
      nid,
      codepage,
    });

    return {
      subject,
      from: this._formatAddress(senderName, senderAddr),
      to,
      cc,
      date,
      isRead,
      hasAttachments: attachments.length > 0,
      rfc822,
    };
  },

  /* Outlook lưu tiền tố kiểu "RE: " bằng hai ký tự điều khiển ở đầu
   * PidTagSubject; giữ lại chúng sẽ làm hỏng header Subject. */
  _stripSubjectPrefix(s) {
    if (s && s.length >= 2 && s.charCodeAt(0) === 0x01) {
      const skip = s.charCodeAt(1);
      return s.substring(1 + skip);
    }
    return s;
  },

  /** Độ sâu tối đa của thư lồng trong thư, để một tệp hỏng không gây đệ quy vô hạn. */
  MAX_EMBED_DEPTH: 5,

  async _readAttachments(h, hn, codepage, depth) {
    const out = [];
    if (!hn.subs.has(this.NID_ATTACHMENT_TABLE)) {
      return out;
    }
    let rowIds;
    try {
      const tableHn = await this._openSubnode(h, hn.subs, this.NID_ATTACHMENT_TABLE);
      rowIds = await this._tcRowIds(tableHn);
    } catch (e) {
      return out;
    }

    for (const rid of rowIds) {
      try {
        const attHn = await this._openSubnode(h, hn.subs, rid);
        const pc = await this._readPc(attHn);
        const g = (id) => this._propValue(attHn, pc, id, codepage);

        const slot = pc.get(this.P.ATTACH_DATA_BINARY);
        if (!slot) {
          continue;
        }

        let name =
          (await g(this.P.ATTACH_LONG_FILENAME)) ||
          (await g(this.P.ATTACH_FILENAME)) ||
          `attachment-${out.length + 1}`;
        name = String(name);

        /* PidTagAttachDataBinary có hai dạng: PT_BINARY là byte tệp thật, còn
         * PT_OBJECT là một thư lồng bên trong thư. Trước đây đọc PT_OBJECT như
         * nhị phân sẽ ghi ra 8 byte định danh vô nghĩa — sai dữ liệu, nên phải
         * tách hai nhánh. */
        if (slot.type === 0x000d) {
          if (depth >= this.MAX_EMBED_DEPTH) {
            h.errors.push({ error: "Thư lồng quá sâu, bỏ qua tệp đính kèm" });
            continue;
          }
          const ref = await this._decodeProp(attHn, slot, codepage);
          if (!(ref instanceof Uint8Array) || ref.length < 4) {
            continue;
          }
          const embedNid = this._u32(ref, 0) >>> 0;
          const embedHn = await this._openSubnode(h, attHn.subs, embedNid);
          const embedded = await this._messageFromHn(h, embedHn, embedNid, depth + 1);
          out.push({
            name: /\.eml$/i.test(name) ? name : `${name}.eml`,
            mime: "message/rfc822",
            cid: "",
            data: this._utf8(embedded.rfc822),
          });
          continue;
        }

        const data = await this._decodeProp(attHn, slot, codepage);
        if (!(data instanceof Uint8Array) || !data.length) {
          continue;
        }
        let mime = await g(this.P.ATTACH_MIME_TAG);
        if (typeof mime !== "string" || !mime) {
          mime = this._guessMime(name);
        }
        const cid = await g(this.P.ATTACH_CONTENT_ID);
        out.push({
          name,
          mime,
          cid: typeof cid === "string" ? cid : "",
          data,
        });
      } catch (e) {
        h.errors.push({
          error: `Bỏ qua tệp đính kèm không đọc được: ${e.message || e}`,
        });
      }
    }
    return out;
  },

  _guessMime(name) {
    const ext = String(name).toLowerCase().replace(/^.*\./, "");
    const map = {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      txt: "text/plain",
      htm: "text/html",
      html: "text/html",
      zip: "application/zip",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      eml: "message/rfc822",
    };
    return map[ext] || "application/octet-stream";
  },

  // ========================================================= dựng lại RFC 822

  _buildRfc822(m) {
    const CRLF = "\r\n";
    const boundaryBase = `hmail-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    // Headers gốc từ Outlook luôn trung thực hơn bất cứ thứ gì ta tự sinh, nên
    // ưu tiên dùng lại chúng — chỉ bỏ các header mô tả thân thư vì thân thư
    // dưới đây được dựng mới.
    let headerLines;
    if (m.headers && /:/.test(m.headers)) {
      // Một số thư (bị máy chủ cắt, hoặc tải về chỉ phần đầu) không có cả
      // From/Subject trong headers gốc. Bổ sung từ thuộc tính PST thay vì để
      // sinh ra .eml mà Thunderbird từ chối hiển thị.
      headerLines = this._ensureHeaders(this._filterHeaders(m.headers), m);
    } else {
      headerLines = this._synthHeaders(m);
    }

    const hasText = !!m.body;
    const hasHtml = !!m.html;
    const hasAtt = m.attachments.length > 0;

    let bodyPart;
    if (hasText && hasHtml) {
      const alt = `${boundaryBase}-alt`;
      bodyPart = {
        headers: [`Content-Type: multipart/alternative; boundary="${alt}"`],
        body:
          `--${alt}${CRLF}` +
          this._textPart(m.body, "text/plain") +
          `${CRLF}--${alt}${CRLF}` +
          this._textPart(m.html, "text/html") +
          `${CRLF}--${alt}--${CRLF}`,
      };
    } else if (hasHtml) {
      bodyPart = {
        headers: [
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
        ],
        body: this._qp(m.html),
      };
    } else {
      bodyPart = {
        headers: [
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
        ],
        body: this._qp(m.body || ""),
      };
    }

    let out;
    if (hasAtt) {
      const mix = `${boundaryBase}-mix`;
      out =
        headerLines.join(CRLF) +
        CRLF +
        "MIME-Version: 1.0" +
        CRLF +
        `Content-Type: multipart/mixed; boundary="${mix}"` +
        CRLF +
        CRLF +
        `--${mix}${CRLF}` +
        bodyPart.headers.join(CRLF) +
        CRLF +
        CRLF +
        bodyPart.body;
      for (const a of m.attachments) {
        out += `${CRLF}--${mix}${CRLF}` + this._attachmentPart(a);
      }
      out += `${CRLF}--${mix}--${CRLF}`;
    } else {
      out =
        headerLines.join(CRLF) +
        CRLF +
        "MIME-Version: 1.0" +
        CRLF +
        bodyPart.headers.join(CRLF) +
        CRLF +
        CRLF +
        bodyPart.body;
    }
    return out;
  },

  /**
   * Giữ header gốc nhưng loại bỏ mọi thứ mô tả thân thư cũ. Giữ nguyên cả cách
   * gấp dòng (folding) của bản gốc: mở gấp sẽ tạo ra dòng dài quá 998 ký tự,
   * điều RFC 5322 cấm.
   */
  _filterHeaders(raw) {
    const lines = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const drop = /^(content-type|content-transfer-encoding|content-disposition|mime-version|content-length)\s*:/i;
    const kept = [];
    let keeping = false;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (/^[ \t]/.test(line)) {
        if (keeping) {
          kept.push(line.replace(/\s+$/, ""));
        }
        continue;
      }
      keeping = /^[!-9;-~]+[ \t]*:/.test(line) && !drop.test(line);
      if (keeping) {
        kept.push(line.replace(/\s+$/, ""));
      }
    }
    return kept;
  },

  /** Bổ sung các header bắt buộc còn thiếu, không đụng tới header đã có. */
  _ensureHeaders(lines, m) {
    const has = (name) =>
      lines.some((l) => new RegExp(`^${name}[ \\t]*:`, "i").test(l));
    const out = lines.slice();
    let patched = false;

    if (!has("Date")) {
      out.push(`Date: ${this._rfc2822Date(m.date)}`);
      patched = true;
    }
    if (!has("From")) {
      out.push(
        `From: ${
          m.senderName || m.senderAddr
            ? this._encodeAddressList(m.senderName, m.senderAddr)
            : "unknown <unknown@invalid.import>"
        }`
      );
      patched = true;
    }
    if (!has("Subject")) {
      out.push(
        `Subject: ${this._encodeHeaderWord(m.subject || "(không có tiêu đề)")}`
      );
      patched = true;
    }
    if (!has("To") && m.to) {
      out.push(`To: ${this._encodeAddressList(m.to, "")}`);
      patched = true;
    }
    if (!has("Message-ID")) {
      out.push(
        `Message-ID: <pst-${m.nid.toString(16)}.${Date.now().toString(36)}@hmail.import>`
      );
      patched = true;
    }
    if (patched) {
      out.push("X-hMail-Imported-From: Outlook PST (bổ sung header thiếu)");
    }
    return out;
  },

  /** Headers tối thiểu khi PST không lưu PidTagTransportMessageHeaders. */
  _synthHeaders(m) {
    const lines = [];
    lines.push(`Date: ${this._rfc2822Date(m.date)}`);
    lines.push(`From: ${this._encodeAddressList(m.senderName, m.senderAddr)}`);
    if (m.to) {
      lines.push(`To: ${this._encodeAddressList(m.to, "")}`);
    } else {
      lines.push("To: undisclosed-recipients:;");
    }
    if (m.cc) {
      lines.push(`Cc: ${this._encodeAddressList(m.cc, "")}`);
    }
    lines.push(`Subject: ${this._encodeHeaderWord(m.subject || "(không có tiêu đề)")}`);
    const id =
      m.messageId && /^<.*>$/.test(m.messageId.trim())
        ? m.messageId.trim()
        : `<pst-${m.nid.toString(16)}.${Date.now().toString(36)}@hmail.import>`;
    lines.push(`Message-ID: ${id}`);
    lines.push("X-hMail-Imported-From: Outlook PST");
    return lines;
  },

  _formatAddress(name, addr) {
    if (name && addr) {
      return `${name} <${addr}>`;
    }
    return addr || name || "";
  },

  /* Địa chỉ trong PST nhiều khi chỉ là tên hiển thị ("Nguyễn Văn A; Trần B").
   * Không đoán thành địa chỉ thật — bọc thành phrase hợp lệ để header không vỡ. */
  _encodeAddressList(names, addr) {
    if (addr) {
      const phrase = names ? this._encodeHeaderWord(names) : "";
      return phrase ? `${phrase} <${addr}>` : `<${addr}>`;
    }
    const parts = String(names)
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) {
      return "undisclosed-recipients:;";
    }
    return parts
      .map((p) => {
        if (/^[^<>@\s]+@[^<>@\s]+$/.test(p)) {
          return p;
        }
        return `${this._encodeHeaderWord(p)} <${this._slug(p)}@invalid.import>`;
      })
      .join(", ");
  },

  _slug(s) {
    const t = String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .toLowerCase();
    return t || "unknown";
  },

  /** RFC 2047 encoded-word, chỉ dùng khi header có ký tự ngoài US-ASCII. */
  _encodeHeaderWord(s) {
    const text = String(s).replace(/[\r\n]+/g, " ").trim();
    if (!text) {
      return "";
    }
    // eslint-disable-next-line no-control-regex
    if (!/[^\x20-\x7e]/.test(text)) {
      return /["(),:;<>@\\[\]]/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
    }
    const bytes = this._utf8(text);
    const b64 = this._base64(bytes);
    // Mỗi encoded-word tối đa 75 ký tự kể cả phần bao ngoài "=?utf-8?B?...?=".
    const chunk = 60 - (60 % 4);
    const words = [];
    for (let i = 0; i < b64.length; i += chunk) {
      words.push(`=?utf-8?B?${b64.substr(i, chunk)}?=`);
    }
    return words.join("\r\n ");
  },

  _rfc2822Date(d) {
    const date = d instanceof Date && !isNaN(d.getTime()) ? d : new Date(0);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const mons = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const p2 = (n) => String(n).padStart(2, "0");
    return (
      `${days[date.getUTCDay()]}, ${p2(date.getUTCDate())} ` +
      `${mons[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
      `${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:` +
      `${p2(date.getUTCSeconds())} +0000`
    );
  },

  _textPart(text, mime) {
    return (
      `Content-Type: ${mime}; charset=utf-8\r\n` +
      "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
      this._qp(text)
    );
  },

  _attachmentPart(a) {
    const name = this._encodeHeaderWord(a.name) || "attachment";
    let head =
      `Content-Type: ${a.mime}; name=${this._quoteParam(a.name)}\r\n` +
      "Content-Transfer-Encoding: base64\r\n" +
      `Content-Disposition: attachment; filename=${this._quoteParam(a.name)}\r\n`;
    if (a.cid) {
      const cid = a.cid.replace(/^<|>$/g, "");
      head += `Content-ID: <${cid}>\r\n`;
    }
    return head + "\r\n" + this._base64Lines(a.data);
  },

  /* Tên tệp không ASCII: dùng encoded-word trong dấu nháy. Không đúng chuẩn
   * RFC 2231 tuyệt đối nhưng là thứ mọi mail client thực tế đều hiểu. */
  _quoteParam(name) {
    // eslint-disable-next-line no-control-regex
    const safe = /[^\x20-\x7e]/.test(name)
      ? this._encodeHeaderWord(name).replace(/\r\n /g, "")
      : String(name).replace(/(["\\])/g, "\\$1");
    return `"${safe}"`;
  },

  _utf8(s) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(s);
    }
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63)
        );
      }
    }
    return Uint8Array.from(out);
  },

  _B64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",

  _base64(bytes) {
    const T = this._B64;
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + T[(n >> 6) & 63] + T[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
      const n = bytes[i] << 16;
      out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + "==";
    } else if (rest === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + T[(n >> 6) & 63] + "=";
    }
    return out;
  },

  /** Base64 xuống dòng ở 76 ký tự như RFC 2045 yêu cầu. */
  _base64Lines(bytes) {
    const b64 = this._base64(bytes);
    let out = "";
    for (let i = 0; i < b64.length; i += 76) {
      out += b64.substr(i, 76) + "\r\n";
    }
    return out;
  },

  /** Quoted-printable: an toàn cho mọi ký tự, giữ nguyên dòng gốc. */
  _qp(text) {
    const bytes = this._utf8(String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    let out = "";
    let lineLen = 0;
    const push = (s) => {
      if (lineLen + s.length > 75) {
        out += "=\r\n";
        lineLen = 0;
      }
      out += s;
      lineLen += s.length;
    };
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x0a) {
        out += "\r\n";
        lineLen = 0;
        continue;
      }
      if (b === 0x3d || b < 0x20 || b > 0x7e) {
        push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
      } else if ((b === 0x20 || b === 0x09) && bytes[i + 1] === 0x0a) {
        // Khoảng trắng cuối dòng phải mã hoá, nếu không nó sẽ bị cắt trên đường truyền.
        push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
      } else {
        push(String.fromCharCode(b));
      }
    }
    if (!out.endsWith("\r\n")) {
      out += "\r\n";
    }
    return out;
  },
};

// Cho phép nạp bằng Services.scriptloader hoặc bằng eval trong sandbox kiểm thử.
if (typeof globalThis !== "undefined") {
  globalThis.hMailPst = hMailPst;
}
