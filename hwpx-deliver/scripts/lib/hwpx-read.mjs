// HWPX 읽기(한컴 없이). 본문을 문단과 표로 꺼낸다. 2단계(원자료 읽기)의 바탕이고, 1단계에서는 시험에 쓴다.
import { readZip } from "./zip.mjs";

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

// 문단 하나의 글자: hp:t 안의 글자와 탭·줄바꿈. 표·그림 같은 개체 안의 글자는 빼고 따로 다룬다
function paraText(p) {
  const own = p.replace(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/g, "");
  let out = "";
  for (const m of own.matchAll(/<hp:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/hp:t>)|<hp:tab\b[^>]*\/>|<hp:lineBreak\b[^>]*\/>/g)) {
    if (m[0].startsWith("<hp:tab")) out += "\t";
    else if (m[0].startsWith("<hp:lineBreak")) out += "\n";
    else if (m[1]) out += unesc(m[1].replace(/<[^>]+>/g, ""));
  }
  return out;
}

// 최상위 문단을 차례로 자른다(표 안의 문단은 표에 딸린 것으로 남긴다)
function splitTop(xml, tag) {
  const out = [];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "g");
  let depth = 0, start = -1, m;
  while ((m = re.exec(xml))) {
    if (m[2]) { if (depth === 0) out.push(xml.slice(m.index, re.lastIndex)); continue; }
    if (!m[1]) { if (depth === 0) start = m.index; depth++; }
    else { depth--; if (depth === 0) out.push(xml.slice(start, re.lastIndex)); }
  }
  return out;
}

function readTable(tbl) {
  const rowCnt = Number(tbl.match(/\browCnt="(\d+)"/)?.[1]), colCnt = Number(tbl.match(/\bcolCnt="(\d+)"/)?.[1]);
  const inner = tbl.replace(/^<hp:tbl\b[^>]*>/, "").replace(/<\/hp:tbl>$/, "");
  const cells = splitTop(inner, "hp:tc").map((tc) => {
    const addr = tc.match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/) ?? [0, 0, 0];
    const span = tc.match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/) ?? [0, 1, 1];
    const sub = tc.match(/<hp:subList\b[\s\S]*<\/hp:subList>/)?.[0] ?? "";
    const paras = splitTop(sub.replace(/^<hp:subList\b[^>]*>/, "").replace(/<\/hp:subList>$/, ""), "hp:p");
    return { row: Number(addr[2]), col: Number(addr[1]), rowspan: Number(span[2]), colspan: Number(span[1]), header: /^<hp:tc\b[^>]*\sheader="1"/.test(tc), text: paras.map(paraText).join("\n"), tables: paras.flatMap((p) => splitTop(p, "hp:tbl").map(readTable)) };
  });
  return { rowCnt, colCnt, cells };
}

// 반환: { blocks: [{ type: "para", text, section, index } | { type: "table", rowCnt, colCnt, cells, section, index }] }
export function readHwpx(buf) {
  const entries = readZip(buf);
  const sections = entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e.name)).sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  const blocks = [];
  sections.forEach((sec, si) => {
    const xml = sec.data.toString("utf8");
    const body = xml.replace(/^[\s\S]*?<hs:sec\b[^>]*>/, "").replace(/<\/hs:sec>\s*$/, "");
    splitTop(body, "hp:p").forEach((p, pi) => {
      const text = paraText(p);
      const tables = splitTop(p, "hp:tbl");
      if (text || !tables.length) blocks.push({ type: "para", text, section: si, index: pi });
      for (const t of tables) blocks.push({ type: "table", ...readTable(t), section: si, index: pi });
    });
  });
  return { blocks };
}

// 한컴 GetTextFile("UNICODE")와 비교하기 쉬운 줄 목록(빈 줄 제외): 문단은 한 줄, 표는 칸마다 한 줄
export function textLines(doc) {
  const out = [];
  const pushTable = (t) => t.cells.forEach((c) => { for (const l of c.text.split("\n")) out.push(l); c.tables.forEach(pushTable); });
  for (const b of doc.blocks) {
    if (b.type === "para") out.push(...b.text.split("\n"));
    else pushTable(b);
  }
  return out.map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
}
