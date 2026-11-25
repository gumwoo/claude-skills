// 시스템에 깔린 글꼴의 이름(name 테이블)을 읽어, 문서가 쓰는 글꼴이 실제로 있는지 확인한다.
// 없으면 브라우저와 한컴이 서로 다른 글꼴로 대체해 줄·쪽 나눔이 어긋나므로, 대체하지 않고 알린다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fontDirs() {
  if (process.platform === "win32") {
    const win = process.env.WINDIR || "C:\\Windows";
    return [path.join(win, "Fonts"), path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts")];
  }
  if (process.platform === "darwin") return ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local", "share", "fonts")];
}

function namesAt(buf, off) {
  const out = new Set();
  const numTables = buf.readUInt16BE(off + 4);
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    if (buf.toString("latin1", r, r + 4) !== "name") continue;
    const t = buf.readUInt32BE(r + 8);
    const count = buf.readUInt16BE(t + 2), strOff = t + buf.readUInt16BE(t + 4);
    for (let j = 0; j < count; j++) {
      const n = t + 6 + j * 12;
      const pid = buf.readUInt16BE(n), nid = buf.readUInt16BE(n + 6), len = buf.readUInt16BE(n + 8), o = buf.readUInt16BE(n + 10);
      if (nid !== 1 && nid !== 4 && nid !== 16) continue;
      const raw = Buffer.from(buf.subarray(strOff + o, strOff + o + len));
      if (pid === 3 || pid === 0) { if (raw.length % 2 === 0) out.add(raw.swap16().toString("utf16le")); }
      else out.add(raw.toString("latin1"));
    }
  }
  return out;
}

// 한글 글꼴은 수십 MB라 통째로 읽지 않는다. 표 목록과 name 표 부분만 읽는다
function fontNames(file) {
  const fd = fs.openSync(file, "r");
  const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const namesOfFace = (off) => {
    const head = read(off, 12);
    const n = head.readUInt16BE(4);
    const dir = read(off + 12, n * 16);
    for (let i = 0; i < n; i++) {
      if (dir.toString("latin1", i * 16, i * 16 + 4) !== "name") continue;
      const t = dir.readUInt32BE(i * 16 + 8), len = dir.readUInt32BE(i * 16 + 12);
      // namesAt이 쓰는 모양(오프셋 0에 표 목록 하나)으로 다시 엮는다
      const fake = Buffer.alloc(12 + 16 + len);
      fake.writeUInt16BE(1, 4);
      fake.write("name", 12, "latin1");
      fake.writeUInt32BE(28, 20);
      read(t, len).copy(fake, 28);
      return namesAt(fake, 0);
    }
    return new Set();
  };
  try {
    const tag = read(0, 4).toString("latin1");
    if (tag === "ttcf") {
      const hdr = read(0, 12), n = hdr.readUInt32BE(8), offs = read(12, n * 4), all = new Set();
      for (let i = 0; i < n; i++) for (const x of namesOfFace(offs.readUInt32BE(i * 4))) all.add(x);
      return all;
    }
    return namesOfFace(0);
  } catch { return new Set(); } finally { fs.closeSync(fd); }
}

let cache = null;
export function installedFonts() {
  if (cache) return cache;
  cache = new Map(); // 이름 → 파일
  const walk = (d, depth = 0) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name)) for (const n of fontNames(p)) if (!cache.has(n)) cache.set(n, p);
    }
  };
  for (const d of fontDirs()) walk(d);
  return cache;
}

export function missingFonts(names) {
  const have = installedFonts();
  return [...new Set(names)].filter((n) => !have.has(n));
}
