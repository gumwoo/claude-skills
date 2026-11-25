// HWPX 읽기(한컴 없이). 본문을 문단과 표로 꺼낸다. 2단계(원자료 읽기)의 바탕이고, 1단계에서는 시험에 쓴다.
import { readZip } from "./zip.mjs";

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

// hp:t 안의 내용을 조각으로 나눈다. 한컴은 탭·줄바꿈을 hp:t 안에 둔다(<hp:t>회의명:<hp:tab …/>{{회의명}}</hp:t>)
//   { text } 글자, { tag, text: "\t" | "\n" | "" } 태그(탭, 줄바꿈, 그 밖의 표시)
export function tTokens(inner) {
  const out = [];
  let last = 0;
  for (const m of inner.matchAll(/<[^>]+>/g)) {
    if (m.index > last) out.push({ text: unesc(inner.slice(last, m.index)) });
    out.push({ tag: m[0], text: /^<hp:tab\b/.test(m[0]) ? "\t" : /^<hp:lineBreak\b/.test(m[0]) ? "\n" : "" });
    last = m.index + m[0].length;
  }
  if (last < inner.length) out.push({ text: unesc(inner.slice(last)) });
  return out;
}

// 문단 자신의 부분: 하위 글(표 칸, 머리말·꼬리말, 각주·미주, 글상자 — 모두 subList에 든다)을 깊이 맞춰 뺀 것
export function ownPart(p) {
  let own = p;
  for (const s of splitTop(p, "hp:subList")) own = own.replace(s, "");
  return own;
}

// 문단 하나의 글자: 자기 hp:t의 글자와 탭·줄바꿈. 하위 글은 빼고 따로 다룬다
export function paraText(p) {
  let out = "";
  for (const m of ownPart(p).matchAll(/<hp:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/hp:t>)|<hp:tab\b[^>]*\/>|<hp:lineBreak\b[^>]*\/>/g)) {
    if (m[0].startsWith("<hp:tab")) out += "\t";
    else if (m[0].startsWith("<hp:lineBreak")) out += "\n";
    else if (m[1]) out += tTokens(m[1]).map((t) => t.text).join("");
  }
  return out;
}

// 최상위 문단을 차례로 자른다(표 안의 문단은 표에 딸린 것으로 남긴다)
export function splitTop(xml, tag) {
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
    // 칸 주소·병합은 칸 자신의 것을 본다(하위 표의 칸 주소가 먼저 나오므로 subList를 빼고 찾는다)
    const sub = tc.match(/<hp:subList\b[\s\S]*<\/hp:subList>/)?.[0] ?? "";
    const self = tc.replace(sub, "");
    const addr = self.match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/) ?? [0, 0, 0];
    const span = self.match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/) ?? [0, 1, 1];
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
      // 표 밖의 하위 글(머리말·꼬리말, 각주, 글상자)은 본문 글자에 붙이지 않고 따로 문단으로
      const rest = tables.reduce((s, t) => s.replace(t, ""), p);
      for (const sub of splitTop(rest, "hp:subList")) {
        const opens = [...rest.slice(0, rest.indexOf(sub)).matchAll(/<hp:(header|footer|footNote|endNote|drawText)\b/g)];
        const kind = opens.length ? opens[opens.length - 1][1] : "sub";
        for (const sp of splitTop(sub.replace(/^<hp:subList\b[^>]*>/, "").replace(/<\/hp:subList>$/, ""), "hp:p")) {
          const t = paraText(sp);
          if (t.trim()) blocks.push({ type: "para", text: t, section: si, index: pi, sub: kind });
        }
      }
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
