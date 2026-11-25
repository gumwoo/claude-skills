// 원자료 읽기(한컴 없이). 파일마다 번호를 붙인 조각(unit)으로 나눠, 문서 모델의 src에서 "S1:12"처럼 가리킬 수 있게 한다.
//
// 조각 id = "S<파일 번호>:<위치>"
//   회의록(클로바노트 등): 발언 번호(1부터)           S1:12, 첫 발언 앞 줄(제목·일시·참석자) S1:h1
//   텍스트·마크다운: 문단 번호(1부터)                  S2:3
//   쪽 표시(=== p.3 ===)가 있는 텍스트: 쪽.문단        S2:p3.2
//   HWPX·HWP·DOCX: 문단 번호, 표 칸 t<표>.r<행>c<열>       S3:7, S3:t2.r3c1
//   XLSX: 시트!셀                                       S4:견적!B3
//
// PDF는 읽지 않는다(오류로 이유를 알린다). 바이너리 HWP는 암호·배포용 문서만 못 읽는다.
import fs from "node:fs";
import path from "node:path";
import { readZip } from "./zip.mjs";
import { readHwpx } from "./hwpx-read.mjs";
import { readHwp } from "./hwp-read.mjs";

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
const clean = (s) => s.replace(/[ \t]+$/gm, "").trim();

// 텍스트 파일 글자 판정: BOM → UTF-8 → (깨지면) CP949
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  let s;
  try { s = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { s = new TextDecoder("euc-kr").decode(buf); }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// 발언 머리줄: "참석자 1 00:00", "김팀장 01:02:03", "참석자 1 / 00:00". 이름은 30자 이하, 문장부호로 끝나지 않음
const SPEAKER_TIME = /^([^\s].{0,29}?)\s*(?:[/|·]\s*)?\s(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const TIME_ONLY = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const PAGE_MARK = /^=+\s*p\.?\s*(\d+)\s*=+$/i;

function readTranscript(lines) {
  const heads = lines.map((l) => { const m = l.match(SPEAKER_TIME); return m && !/[.,!?。]$/.test(m[1]) ? { speaker: m[1].trim(), time: m[2] } : null; });
  const timeOnly = lines.map((l) => { const m = l.match(TIME_ONLY); return m ? { speaker: null, time: m[1] } : null; });
  const pick = heads.filter(Boolean).length >= 2 ? heads : timeOnly.filter(Boolean).length >= 2 ? timeOnly : null;
  if (!pick) return null;
  const meta = [], units = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (pick[i]) { cur = { ...pick[i], lines: [], line: i + 1 }; units.push(cur); return; }
    if (cur) cur.lines.push(l); else if (l.trim()) meta.push(l.trim());
  });
  // 머리줄 다음에 발언이 없는 줄이 많으면 회의록이 아니다("개회 14:00"처럼 시각이 붙은 일정표 등)
  if (units.filter((u) => !u.lines.join("").trim()).length > units.length * 0.3) return null;
  return {
    kind: "transcript",
    meta,
    // 첫 발언 앞의 줄(제목, 일시, 참석자)도 근거로 가리킬 수 있게 h1, h2…로 둔다
    units: [...meta.map((t, k) => ({ loc: `h${k + 1}`, text: t })), ...units.map((u, k) => ({ loc: String(k + 1), speaker: u.speaker, time: u.time, line: u.line, text: clean(u.lines.join("\n")) }))],
  };
}

const LIST_LINE = /^\s*([-*•□○ㆍ·]|\d+[.)]|[가-힣][.)])\s/;

function paragraphs(lines, startLine) {
  const out = [];
  let buf = [], first = 0;
  const flush = () => {
    if (!buf.length) return;
    // 줄마다 목록 기호로 시작하는 문단은 줄 단위로 나눈다
    if (buf.length > 1 && buf.every((l) => LIST_LINE.test(l))) buf.forEach((l, k) => out.push({ text: l.trim(), line: first + k }));
    else out.push({ text: clean(buf.join("\n")), line: first });
    buf = [];
  };
  lines.forEach((l, i) => {
    if (l.trim() === "") { flush(); return; }
    if (!buf.length) first = startLine + i;
    buf.push(l);
  });
  flush();
  return out;
}

// 클로바노트 내보내기(실제 파일로 확인한 모양):
//   제목 / "2026.11.17 화 오전 10:22 ・ 1분 50초" / 작성자, 빈 줄 둘, 발언들, 빈 줄 둘, "clovanote.naver.com"
//   내보낼 때 작성자(참석자)·시간을 넣거나 뺄 수 있다. 둘 다 넣으면 "참석자 1 00:00" 줄이 발언 앞에 오고,
//   둘 다 빼면 발언이 빈 줄로만 나뉜다. 하나만 넣은 모양은 "참석자 1" 또는 "00:00" 줄이 앞에 온다고 보고 읽는다
const CLOVA_FOOTER = /^clovanote\.naver\.com$/i;
const CLOVA_DATE = /^\d{4}\.\d{1,2}\.\d{1,2}\s+[월화수목금토일]\s+(오전|오후)\s+\d{1,2}:\d{2}/;

function stripClova(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const footer = out.length > 0 && CLOVA_FOOTER.test(out[out.length - 1].trim());
  if (footer) out.pop();
  return { lines: out, clova: footer || CLOVA_DATE.test(lines[1]?.trim() ?? "") };
}

// 빈 줄로 나뉜 덩어리들
function blocksOf(lines) {
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (!l.trim()) { cur = null; return; }
    if (!cur) { cur = { line: i, lines: [] }; out.push(cur); }
    cur.lines.push(l);
  });
  return out;
}

// 시각 줄이 없는 클로바노트: 머리말(첫 빈 줄 전까지)과, 빈 줄로 나뉜 발언
function readClovaBlocks(lines) {
  const end = lines.findIndex((l) => !l.trim());
  const head = (end < 0 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean);
  const blocks = blocksOf(end < 0 ? [] : lines.slice(end)).map((b) => ({ ...b, line: b.line + end }));
  // 작성자만 넣은 모양: 모든 덩어리의 첫 줄이 짧은 이름이고, 그 이름이 몇 개 안 되며 되풀이된다
  const firsts = blocks.map((b) => b.lines[0].trim());
  const names = new Set(firsts);
  const speakerOnly = blocks.length >= 2 && blocks.every((b) => b.lines.length >= 2) && firsts.every((f) => f.length <= 20 && !/[.,!?]$/.test(f)) && names.size <= Math.max(2, Math.ceil(blocks.length / 3));
  return {
    kind: "transcript",
    meta: head,
    units: [
      ...head.map((t, k) => ({ loc: `h${k + 1}`, text: t })),
      ...blocks.map((b, k) => ({ loc: String(k + 1), speaker: speakerOnly ? firsts[k] : null, time: null, line: b.line + 1 + (speakerOnly ? 1 : 0), text: clean((speakerOnly ? b.lines.slice(1) : b.lines).join("\n")) })),
    ],
  };
}

function readPlain(text) {
  const { lines, clova } = stripClova(text.replace(/\r\n?/g, "\n").split("\n"));
  const tr = readTranscript(lines);
  if (tr) return tr;
  if (clova) return readClovaBlocks(lines);
  const marks = lines.map((l) => l.match(PAGE_MARK)?.[1] ?? null);
  if (marks.some(Boolean)) {
    // Claude가 PDF를 읽고 옮겨 적은 텍스트: === p.3 === 표시로 쪽을 나눈다
    const units = [];
    let page = null, start = 0;
    const take = (end) => { if (page != null) paragraphs(lines.slice(start, end), start + 1).forEach((p, k) => units.push({ loc: `p${page}.${k + 1}`, line: p.line, text: p.text })); };
    marks.forEach((m, i) => { if (m) { take(i); page = Number(m); start = i + 1; } });
    take(lines.length);
    return { kind: "paged-text", meta: [], units };
  }
  return { kind: "text", meta: [], units: paragraphs(lines, 1).map((p, k) => ({ loc: String(k + 1), line: p.line, text: p.text })) };
}

// 표 칸: 칸 안의 하위 표 글자는 칸 글자 뒤에 붙인다
function hwpxCellText(c) {
  const parts = [c.text];
  const walk = (t) => t.cells.forEach((x) => { parts.push(x.text); x.tables.forEach(walk); });
  c.tables.forEach(walk);
  return clean(parts.filter(Boolean).join("\n"));
}

// HWPX·HWP 모두 같은 모양(readHwpx, readHwp)으로 읽은 뒤 조각으로
function hwpDocUnits(doc, kind) {
  const units = [];
  let p = 0, t = 0;
  for (const b of doc.blocks) {
    if (b.type === "para") { const text = clean(b.text); if (text) units.push({ loc: String(++p), text }); continue; }
    t++;
    for (const c of b.cells) { const text = hwpxCellText(c); if (text) units.push({ loc: `t${t}.r${c.row + 1}c${c.col + 1}`, text, header: c.header || undefined }); }
  }
  return { kind, meta: [], units };
}

// 최상위 요소를 순서대로 자른다(tags 중 아무거나). 같은 이름이 안에 겹쳐도 깊이로 짝을 맞춘다
function splitTopAny(xml, tags) {
  const out = [];
  const re = new RegExp(`<(/?)(${tags.join("|")})\\b[^>]*?(/?)>`, "g");
  const stack = [];
  let start = -1, m;
  while ((m = re.exec(xml))) {
    const [, close, tag, self] = m;
    if (self) { if (!stack.length) out.push({ tag, xml: m[0] }); continue; }
    if (!close) { if (!stack.length) start = m.index; stack.push(tag); }
    else { stack.pop(); if (!stack.length) out.push({ tag, xml: xml.slice(start, re.lastIndex) }); }
  }
  return out;
}

function docxParaText(p) {
  let out = "";
  for (const m of p.matchAll(/<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g)) {
    if (m[0].startsWith("<w:tab")) out += "\t";
    else if (m[0].startsWith("<w:br") || m[0].startsWith("<w:cr")) out += "\n";
    else if (m[1]) out += unesc(m[1]);
  }
  return out;
}

function docxCellText(tc) {
  // 칸 안의 문단과 하위 표의 글자를 차례로
  const inner = tc.replace(/^<w:tc\b[^>]*>/, "").replace(/<\/w:tc>$/, "");
  const parts = [];
  for (const e of splitTopAny(inner, ["w:p", "w:tbl"])) {
    if (e.tag === "w:p") parts.push(docxParaText(e.xml));
    else for (const tr of splitTopAny(e.xml.replace(/^<w:tbl\b[^>]*>/, "").replace(/<\/w:tbl>$/, ""), ["w:tr"])) for (const c of splitTopAny(tr.xml.replace(/^<w:tr\b[^>]*>/, "").replace(/<\/w:tr>$/, ""), ["w:tc"])) parts.push(docxCellText(c.xml));
  }
  return clean(parts.filter(Boolean).join("\n"));
}

function readDocxUnits(buf) {
  const xml = readZip(buf).find((e) => e.name === "word/document.xml")?.data.toString("utf8");
  if (!xml) throw new Error("word/document.xml이 없습니다(DOCX가 아님)");
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/)?.[1] ?? "";
  const units = [];
  let p = 0, t = 0;
  for (const e of splitTopAny(body, ["w:p", "w:tbl"])) {
    if (e.tag === "w:p") { const text = clean(docxParaText(e.xml)); if (text) units.push({ loc: String(++p), text }); continue; }
    t++;
    const rows = splitTopAny(e.xml.replace(/^<w:tbl\b[^>]*>/, "").replace(/<\/w:tbl>$/, ""), ["w:tr"]);
    rows.forEach((tr, r) => {
      let c = 0;
      for (const tc of splitTopAny(tr.xml.replace(/^<w:tr\b[^>]*>/, "").replace(/<\/w:tr>$/, ""), ["w:tc"])) {
        const span = Number(tc.xml.match(/<w:gridSpan\s+w:val="(\d+)"/)?.[1] ?? 1);
        // 세로 병합의 이어지는 칸(<w:vMerge/> 또는 val="continue")은 위 칸에 합쳐져 있으므로 건너뛴다
        const cont = /<w:vMerge(?:\s+w:val="continue")?\s*\/>/.test(tc.xml);
        const text = cont ? "" : docxCellText(tc.xml);
        if (text) units.push({ loc: `t${t}.r${r + 1}c${c + 1}`, text });
        c += span;
      }
    });
  }
  return { kind: "docx", meta: [], units };
}

// 엑셀 날짜 서식: 기본 번호 14~22, 45~47 또는 y·m·d가 든 사용자 서식
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const serialDate = (v) => {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
const colNum = (ref) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

function readXlsxUnits(buf) {
  const entries = readZip(buf);
  const get = (n) => entries.find((e) => e.name === n)?.data.toString("utf8");
  const wb = get("xl/workbook.xml");
  if (!wb) throw new Error("xl/workbook.xml이 없습니다(XLSX가 아님)");
  const rels = get("xl/_rels/workbook.xml.rels") ?? "";
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1], t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && t) target[id] = t.startsWith("/") ? t.slice(1) : `xl/${t}`;
  }
  const shared = [];
  for (const m of (get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const si = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    shared.push([...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join(""));
  }
  const styles = get("xl/styles.xml") ?? "";
  const customDate = new Set([...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].filter((m) => /[ymd]/i.test(unesc(m[2]).replace(/"[^"]*"|\[[^\]]*\]/g, ""))).map((m) => Number(m[1])));
  const xfs = [...(styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? "").matchAll(/<xf\b[^>]*>/g)].map((m) => Number(m[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0));
  const isDate = (s) => { const id = xfs[s]; return id != null && (DATE_FMT_IDS.has(id) || customDate.has(id)); };
  const units = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unesc(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const xml = rid && target[rid] ? get(target[rid]) : null;
    if (!xml) continue;
    const cells = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], inner = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!ref) continue;
      const t = attrs.match(/\bt="([^"]+)"/)?.[1], s = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text;
      if (t === "s") text = shared[Number(v)] ?? "";
      else if (t === "inlineStr") text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join("");
      else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (v == null) continue;
      else if (t === "str" || t === "e") text = unesc(v);
      else text = isDate(s) && Number.isFinite(Number(v)) ? serialDate(Number(v)) : v;
      text = clean(text);
      if (text) cells.push({ ref, row: Number(ref.match(/\d+$/)[0]), col: colNum(ref), text });
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    for (const c of cells) units.push({ loc: `${name}!${c.ref}`, text: c.text });
  }
  return { kind: "xlsx", meta: [], units };
}

export function readSource(file, n) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  let r;
  if (ext === ".txt" || ext === ".md") r = readPlain(decodeText(buf));
  else if (ext === ".hwpx") r = hwpDocUnits(readHwpx(buf), "hwpx");
  else if (ext === ".hwp") r = hwpDocUnits(readHwp(buf), "hwp");
  else if (ext === ".docx") r = readDocxUnits(buf);
  else if (ext === ".xlsx") r = readXlsxUnits(buf);
  else if (ext === ".pdf") throw new Error(`${path.basename(file)}: PDF는 스크립트가 읽지 않습니다. Claude가 PDF를 읽고 쪽마다 "=== p.3 ===" 표시를 붙여 텍스트로 옮긴 뒤(<이름>.pdf.txt) 그 파일을 넣으세요`);
  else throw new Error(`${path.basename(file)}: 지원하지 않는 형식(${ext || "확장자 없음"}). txt, md, hwpx, hwp, docx, xlsx만 읽습니다`);
  const id = `S${n}`;
  return { id, file: path.basename(file), path: path.resolve(file), kind: r.kind, meta: r.meta, units: r.units.map((u) => ({ id: `${id}:${u.loc}`, ...u })) };
}

export function readSources(files) {
  return { sources: files.map((f, i) => readSource(f, i + 1)) };
}

const KIND_KO = { transcript: "회의록(발언)", "paged-text": "쪽 표시 텍스트", text: "텍스트", hwpx: "HWPX", hwp: "HWP", docx: "DOCX", xlsx: "XLSX" };

// Claude가 읽을 목록: 조각 id와 글자 전체
export function listing(src) {
  const out = [];
  for (const s of src.sources) {
    out.push(`[${s.id}] ${s.file} — ${KIND_KO[s.kind] ?? s.kind}, 조각 ${s.units.length}개`);
    for (const u of s.units) {
      const who = [u.speaker, u.time].filter(Boolean).join(" ");
      out.push(`${u.id}${who ? ` (${who})` : ""}${u.header ? " [머리 칸]" : ""}: ${u.text.replace(/\n/g, " / ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function unitIndex(src) {
  const map = new Map();
  for (const s of src?.sources ?? []) for (const u of s.units) map.set(u.id, { ...u, file: s.file });
  return map;
}
