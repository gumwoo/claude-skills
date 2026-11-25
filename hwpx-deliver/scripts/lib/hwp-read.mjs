// 바이너리 HWP(5.0) 읽기(한컴 없이). 본문을 문단과 표로 꺼내 readHwpx와 같은 모양으로 돌려준다.
// 구조: OLE 복합 문서 → FileHeader(압축·암호 표시) → BodyText/SectionN(zlib 압축) → 레코드(태그·수준·크기)
// 읽기만 한다. 암호가 걸렸거나 배포용으로 저장한 문서는 읽지 못한다(본문이 암호화돼 있다).
import zlib from "node:zlib";
import { readCfb } from "./cfb.mjs";

// 레코드 태그(HWPTAG_BEGIN = 16)
const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };

// 문단 글자 안의 제어 문자: 글자 하나 크기(char)와 8글자 크기(inline·extended)
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const EXT_CTRL = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

function inflate(data, compressed) {
  if (!compressed) return data;
  try { return zlib.inflateRawSync(data); }
  catch { return zlib.inflateSync(data); }
}

export function readRecords(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const h = buf.readUInt32LE(p);
    p += 4;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) { size = buf.readUInt32LE(p); p += 4; }
    out.push({ tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: buf.subarray(p, p + size) });
    p += size;
  }
  return out;
}

// 레코드 목록 → 나무(수준이 더 깊은 뒤 레코드는 앞 레코드의 자식)
function tree(records) {
  const root = { children: [] }, stack = [{ level: -1, node: root }];
  for (const r of records) {
    const node = { ...r, children: [] };
    while (stack[stack.length - 1].level >= r.level) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level: r.level, node });
  }
  return root.children;
}

// 제어 ID: 4글자를 큰 수부터 담은 정수("tbl ", "head", "foot", "fn  ", "en  ", "gso ")
const ctrlId = (rec) => (rec.data.length >= 4 ? String.fromCharCode(rec.data[3], rec.data[2], rec.data[1], rec.data[0]) : "");

function paraText(textRec) {
  if (!textRec) return "";
  const d = textRec.data;
  let out = "";
  for (let i = 0; i + 1 < d.length;) {
    const c = d.readUInt16LE(i);
    if (c >= 32) { out += String.fromCharCode(c); i += 2; continue; }
    if (CHAR_CTRL.has(c)) {
      if (c === 10) out += "\n";
      else if (c === 30 || c === 31) out += " ";
      i += 2;
      continue;
    }
    if (c === 9) out += "\t";
    i += 16; // inline·extended 제어는 8글자(16바이트)
  }
  return out;
}

// 칸 목록 머리(LIST_HEADER): 문단 수(2바이트), 2바이트, 속성(4바이트), 그다음 열·행 주소, 병합 수, 크기 …
// 한컴 2022가 저장한 파일과 법령정보센터 원본에서 칸 정보는 8바이트 자리에서 시작했다.
// 자료에 따라 6바이트로 적힌 것이 있어, 8이 표 크기와 맞지 않을 때만 6을 시도한다
function cellInfo(rec, rows, cols) {
  const d = rec.data;
  for (const off of [8, 6]) {
    if (d.length < off + 8) continue;
    const col = d.readUInt16LE(off), row = d.readUInt16LE(off + 2), colspan = d.readUInt16LE(off + 4), rowspan = d.readUInt16LE(off + 6);
    if (col < cols && row < rows && colspan >= 1 && rowspan >= 1 && col + colspan <= cols && row + rowspan <= rows) return { paraCount: d.readInt16LE(0), col, row, colspan, rowspan };
  }
  throw new Error("HWP 표 칸 정보를 읽지 못했습니다");
}

function readParas(nodes, ctx) {
  // nodes: 같은 수준의 레코드들. PARA_HEADER마다 문단 하나
  const blocks = [];
  for (const n of nodes) {
    if (n.tag !== TAG.PARA_HEADER) continue;
    const text = paraText(n.children.find((c) => c.tag === TAG.PARA_TEXT));
    const tables = [], subs = [];
    for (const c of n.children.filter((x) => x.tag === TAG.CTRL_HEADER)) {
      const id = ctrlId(c);
      if (id === "tbl ") tables.push(readTable(c, ctx));
      else subs.push(...subParas(c, ctx, id));
    }
    blocks.push({ text: text.replace(/\r$/, ""), tables, subs });
  }
  return blocks;
}

const SUB_KIND = { head: "header", foot: "footer", "fn  ": "footNote", "en  ": "endNote", "gso ": "drawText" };

// 머리말·꼬리말·각주·글상자: 안의 문단을 모두 꺼낸다(표 안 표처럼 깊이 들어 있어도)
function subParas(ctrl, ctx, id) {
  const out = [];
  const walk = (nodes) => {
    for (const b of readParas(nodes, ctx)) {
      if (b.text.trim()) out.push({ kind: SUB_KIND[id] ?? "sub", text: b.text });
      out.push(...b.subs);
    }
    for (const n of nodes) if (n.tag !== TAG.PARA_HEADER) walk(n.children);
  };
  walk(ctrl.children);
  return out;
}

function readTable(ctrl, ctx) {
  const kids = ctrl.children;
  const t = kids.find((k) => k.tag === TAG.TABLE);
  if (!t) throw new Error("HWP 표 레코드가 없습니다");
  const rowCnt = t.data.readUInt16LE(4), colCnt = t.data.readUInt16LE(6);
  const cells = [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tag !== TAG.LIST_HEADER) continue;
    const info = cellInfo(kids[i], rowCnt, colCnt);
    // 칸의 문단은 LIST_HEADER 뒤에 이어지는 같은 수준의 PARA_HEADER들(문단 수만큼)
    const paras = [];
    for (let j = i + 1; j < kids.length && paras.length < info.paraCount && kids[j].tag !== TAG.LIST_HEADER; j++) if (kids[j].tag === TAG.PARA_HEADER) paras.push(kids[j]);
    const bs = readParas(paras, ctx);
    cells.push({ row: info.row, col: info.col, rowspan: info.rowspan, colspan: info.colspan, header: false, text: bs.map((b) => b.text).join("\n"), tables: bs.flatMap((b) => b.tables) });
  }
  return { rowCnt, colCnt, cells };
}

// 반환: readHwpx와 같은 { blocks: [{ type: "para", text, sub? } | { type: "table", rowCnt, colCnt, cells }] }
export function readHwp(buf) {
  const files = readCfb(buf);
  const head = files.get("FileHeader");
  if (!head || head.toString("latin1", 0, 17) !== "HWP Document File") throw new Error("HWP 파일 머리(FileHeader)가 없습니다");
  const props = head.readUInt32LE(36);
  if (props & 2) throw new Error("암호가 걸린 HWP는 읽지 못합니다");
  if (props & 4) throw new Error("배포용 문서로 저장한 HWP는 읽지 못합니다(본문이 암호화돼 있음)");
  const compressed = Boolean(props & 1);
  const sections = [...files.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]));
  if (!sections.length) throw new Error("HWP 본문(BodyText)이 없습니다");
  const blocks = [];
  sections.forEach((name, si) => {
    const nodes = tree(readRecords(inflate(files.get(name), compressed)));
    readParas(nodes, {}).forEach((b, pi) => {
      if (b.text || !b.tables.length) blocks.push({ type: "para", text: b.text, section: si, index: pi });
      for (const t of b.tables) blocks.push({ type: "table", ...t, section: si, index: pi });
      for (const s of b.subs) blocks.push({ type: "para", text: s.text, section: si, index: pi, sub: s.kind });
    });
  });
  return { blocks };
}
