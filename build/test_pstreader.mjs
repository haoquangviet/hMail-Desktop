/* hMail Desktop — kiểm thử bộ đọc PST ngoài Thunderbird
 * MIT License, Copyright (c) 2026 HQV Software
 *
 * pstreader.js chạy trong chrome JS đặc quyền, nơi IOUtils là API sẵn có. Ở đây
 * ta dựng một sandbox tối thiểu có IOUtils giả lập bằng fs rồi eval tệp đó — nhờ
 * vậy kiểm thử chạy đúng mã sẽ ship, không phải một bản chép lại.
 *
 * Cách dùng:  node build/test_pstreader.mjs <đường-dẫn.pst> [thư-mục-xuất]
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readerPath = path.join(here, "..", "overlay", "hmail-ribbon", "pstreader.js");

const pstPath = process.argv[2];
const outDir = process.argv[3] || path.join(process.cwd(), "pst-out");
if (!pstPath) {
  console.error("Cách dùng: node build/test_pstreader.mjs <đường-dẫn.pst> [thư-mục-xuất]");
  process.exit(2);
}

// ------------------------------------------------------------------ sandbox

const IOUtils = {
  async stat(p) {
    const st = fs.statSync(p);
    return { size: st.size };
  },
  async read(p, opts) {
    const fd = fs.openSync(p, "r");
    try {
      if (!opts) {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        return new Uint8Array(buf);
      }
      const want = opts.maxBytes;
      const buf = Buffer.alloc(want);
      const got = fs.readSync(fd, buf, 0, want, opts.offset);
      return new Uint8Array(buf.subarray(0, got));
    } finally {
      fs.closeSync(fd);
    }
  },
};

const sandbox = {
  IOUtils,
  TextDecoder,
  TextEncoder,
  DataView,
  ArrayBuffer,
  Uint8Array,
  Date,
  Math,
  JSON,
  console,
  isNaN,
  String,
  Number,
  Array,
  Map,
  Set,
  Object,
  Error,
  RegExp,
  Promise,
  Symbol,
  parseInt,
  parseFloat,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(readerPath, "utf8"), sandbox, { filename: readerPath });

const hMailPst = sandbox.hMailPst;
if (!hMailPst || typeof hMailPst.open !== "function") {
  console.error("Không nạp được hMailPst từ pstreader.js");
  process.exit(1);
}

// -------------------------------------------------------------- kiểm chứng

/** Một .eml phải có ba header bắt buộc, và nếu multipart thì boundary phải khớp. */
function checkEml(text, label) {
  const problems = [];
  const sep = text.indexOf("\r\n\r\n");
  if (sep < 0) {
    return [`${label}: không có dòng trống ngăn headers và body`];
  }
  const head = text.slice(0, sep);
  const body = text.slice(sep + 4);
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");

  for (const name of ["Subject", "From", "Date"]) {
    const re = new RegExp(`^${name}:[ \\t]*\\S`, "mi");
    if (!re.test(unfolded)) {
      problems.push(`${label}: thiếu hoặc rỗng header ${name}:`);
    }
  }

  const dm = unfolded.match(/^Date:[ \t]*(.+)$/mi);
  if (dm) {
    const d = new Date(dm[1].trim());
    if (isNaN(d.getTime())) {
      problems.push(`${label}: Date không phân tích được: ${dm[1].trim()}`);
    }
  }

  const ctm = unfolded.match(/^Content-Type:[ \t]*multipart\/[^;]+;.*boundary="?([^";\r\n]+)"?/mi);
  if (ctm) {
    const b = ctm[1];
    if (!body.includes(`--${b}\r\n`)) {
      problems.push(`${label}: không thấy boundary mở --${b}`);
    }
    if (!body.includes(`--${b}--`)) {
      problems.push(`${label}: không thấy boundary đóng --${b}--`);
    }
    // Boundary lồng nhau (alternative bên trong mixed) cũng phải khớp.
    const inner = body.match(/Content-Type:[ \t]*multipart\/[^;]+;[ \t]*boundary="([^"]+)"/i);
    if (inner && (!body.includes(`--${inner[1]}\r\n`) || !body.includes(`--${inner[1]}--`))) {
      problems.push(`${label}: boundary lồng ${inner[1]} không khớp`);
    }
  }

  // Thân thư rỗng là hợp lệ với thư chỉ có phần đầu (server cắt, tải header-only),
  // nên chỉ đếm chứ không coi là lỗi — trừ khi thư khai là multipart.
  if (!body.trim() && ctm) {
    problems.push(`${label}: multipart nhưng thân thư rỗng`);
  }
  return problems;
}

function printTree(nodes, depth = 0) {
  let total = 0;
  for (const n of nodes) {
    console.log(`${"  ".repeat(depth)}- ${n.name}  [${n.messageCount} thư]`);
    total += n.messageCount;
    total += printTree(n.children, depth + 1);
  }
  return total;
}

function flatten(nodes, acc = []) {
  for (const n of nodes) {
    acc.push(n);
    flatten(n.children, acc);
  }
  return acc;
}

// ------------------------------------------------------------------- chạy

const t0 = Date.now();
const h = await hMailPst.open(pstPath);
console.log(`Tệp    : ${pstPath}`);
console.log(`Kích cỡ: ${h.size} byte`);
console.log(`Định dạng: ${h.isUnicode ? "Unicode (Outlook 2003+)" : "ANSI (Outlook 97-2002)"}` +
            `, wVer=${h.wVer}, mã hoá=${["không", "permute", "cyclic"][h.cryptMethod] || h.cryptMethod}`);
console.log(`NBT: ${h.nbt.size} node, BBT: ${h.bbt.size} block, codepage=${h.codepage}`);
console.log("");
console.log("Cây thư mục:");
const totalCount = printTree(hMailPst.folders(h));
console.log(`Tổng cộng: ${totalCount} thư`);
console.log("");

fs.mkdirSync(outDir, { recursive: true });

let exported = 0;
let allProblems = [];
// Mặc định xuất 5 thư đầu; đặt PST_ALL=1 để quét toàn bộ tệp làm kiểm thử tải.
const WANT = process.env.PST_ALL ? Infinity : 5;
const VERBOSE = !process.env.PST_ALL;

for (const folder of flatten(hMailPst.folders(h))) {
  if (exported >= WANT) {
    break;
  }
  for await (const m of hMailPst.messages(h, folder.path)) {
    const name = `msg-${String(exported + 1).padStart(2, "0")}.eml`;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(m.rfc822, "utf8"));
    const problems = checkEml(m.rfc822, name);
    allProblems = allProblems.concat(problems);
    if (VERBOSE || problems.length) {
      console.log(
      `${problems.length ? "FAIL" : "OK  "} ${name}  ` +
        `[${folder.path}] ${m.rfc822.length} byte` +
        `\n      Subject : ${JSON.stringify(m.subject)}` +
        `\n      From    : ${JSON.stringify(m.from)}` +
        `\n      To      : ${JSON.stringify(m.to)}` +
        `\n      Date    : ${m.date ? m.date.toISOString() : "(không có)"}` +
        `\n      Đã đọc  : ${m.isRead}   Đính kèm: ${m.hasAttachments}`
      );
    }
    for (const p of problems) {
      console.log(`      ! ${p}`);
    }
    exported++;
    if (exported >= WANT) {
      break;
    }
  }
}

console.log("");
console.log(`Đã xuất ${exported} tệp .eml vào ${outDir}`);
if (h.errors.length) {
  console.log(`Lỗi ghi nhận (${h.errors.length}):`);
  for (const e of h.errors.slice(0, 20)) {
    console.log(`  - ${JSON.stringify(e)}`);
  }
} else {
  console.log("Không có lỗi nào được ghi nhận.");
}

hMailPst.close(h);
console.log(`Thời gian: ${Date.now() - t0} ms`);

if (allProblems.length) {
  console.log(`\nKẾT QUẢ: THẤT BẠI — ${allProblems.length} vấn đề trong .eml`);
  process.exit(1);
}
// Một tệp PST mới tinh thật sự không có thư nào; chỉ coi là lỗi khi cây thư mục
// báo có thư mà không đọc ra được thư nào.
if (exported === 0 && totalCount > 0) {
  console.log("\nKẾT QUẢ: THẤT BẠI — cây thư mục báo có thư nhưng không đọc được thư nào");
  process.exit(1);
}
if (exported === 0) {
  console.log("\nKẾT QUẢ: ĐẠT — tệp PST rỗng, không có thư để xuất");
  process.exit(0);
}
console.log("\nKẾT QUẢ: ĐẠT — mọi .eml đều hợp lệ");
