// HWPX 양식 다루기(한컴 없이). 문단·표·칸에 주소를 붙이고, 채울 칸을 추정하고(scan), 값을 넣는다(fill).
//
// 주소(1부터 셈):
//   본문 문단 P3, 본문 표 T1, 칸 T1.r2c1, 칸 안 문단 T1.r2c1.p4, 칸 안 표 T1.r3c1.T1, 그 칸 T1.r3c1.T1.r1c1
//   구역(section)이 둘 이상이면 앞에 "2:"를 붙인다(2:P1)
//
// 값을 넣을 때 지키는 것:
//   - 양식의 글자 모양·문단 모양·표 크기는 그대로 둔다. 바꾼 문단은 글자가 있던 run의 글자 모양을 따른다
//   - 바꾼 문단의 줄 배치 정보(linesegarray)는 지운다. 남겨 두면 한컴이 옛 배치로 그려 글자가 겹칠 수 있다
//   - header.xml(글자·문단 모양 목록)은 건드리지 않는다
import { readZip, writeZip } from "./zip.mjs";
import { paraText, splitTop, ownPart, tTokens, readHwpx } from "./hwpx-read.mjs";
import { esc } from "./hwpx-write.mjs";

const OBJ = /<hp:(tbl|pic|rect|ellipse|arc|polygon|curve|line|container|equation|textart|ole|connectLine)\b/;
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

// 같은 이름 태그의 최상위 요소 위치(깊이를 맞춘다). [from, to) 안에서 찾는다
function tops(xml, tag, from, to) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "g");
  re.lastIndex = from;
  const out = [];
  let depth = 0, start = -1, m;
  while ((m = re.exec(xml)) && m.index < to) {
    if (m[2]) { if (depth === 0) out.push({ start: m.index, end: re.lastIndex }); continue; }
    if (!m[1]) { if (depth === 0) start = m.index; depth++; }
    else { depth--; if (depth === 0) out.push({ start, end: re.lastIndex }); }
  }
  return out;
}

const openTag = (xml, at) => xml.slice(at, xml.indexOf(">", at) + 1);
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// 칸 자신의 부분(하위 subList를 뺀 것)
function cellSelf(tcXml) {
  const sub = tops(tcXml, "hp:subList", 1, tcXml.length)[0];
  return sub ? tcXml.slice(0, sub.start) + tcXml.slice(sub.end) : tcXml;
}

export function parseSection(xml, sec = 0, multi = false) {
  const pre = multi ? `${sec + 1}:` : "";
  const open = xml.match(/<hs:sec\b[^>]*>/);
  if (!open) throw new Error("구역 XML에 hs:sec가 없습니다");
  const out = { paras: [], tables: [], cells: [] };
  let topT = 0;
  const walk = (from, to, prefix, cell, nextTable) => {
    tops(xml, "hp:p", from, to).forEach((p, k) => {
      const id = `${prefix}${k + 1}`;
      const pxml = xml.slice(p.start, p.end);
      const fields = [...pxml.matchAll(/<hp:fieldBegin\b[^>]*>/g)].filter((m) => attr(m[0], "type") === "CLICK_HERE").map((m) => attr(m[0], "name") ?? "");
      out.paras.push({ id, start: p.start, end: p.end, text: paraText(pxml), obj: isObjPara(pxml), cell, fields });
      for (const t of tops(xml, "hp:tbl", p.start + 1, p.end)) {
        const tag = openTag(xml, t.start);
        const table = { id: nextTable(), start: t.start, end: t.end, para: id, rowCnt: Number(attr(tag, "rowCnt")), colCnt: Number(attr(tag, "colCnt")), rows: [] };
        out.tables.push(table);
        tops(xml, "hp:tr", t.start + tag.length, t.end).forEach((tr, ri) => {
          const row = { index: ri, start: tr.start, end: tr.end, cells: [] };
          table.rows.push(row);
          for (const tc of tops(xml, "hp:tc", tr.start + 1, tr.end)) {
            const tcx = xml.slice(tc.start, tc.end);
            const self = cellSelf(tcx);
            const addr = self.match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/);
            const span = self.match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/);
            const col = Number(addr?.[1] ?? 0), r = Number(addr?.[2] ?? ri);
            const cid = `${table.id}.r${r + 1}c${col + 1}`;
            const c = { id: cid, start: tc.start, end: tc.end, table: table.id, row: r, col, colspan: Number(span?.[1] ?? 1), rowspan: Number(span?.[2] ?? 1), name: attr(openTag(tcx, 0), "name") ?? "", paras: [] };
            out.cells.push(c);
            row.cells.push(c);
            const sub = tops(xml, "hp:subList", tc.start + 1, tc.end)[0];
            if (sub) {
              const before = out.paras.length;
              let n = 0;
              walk(sub.start + openTag(xml, sub.start).length, sub.end, `${cid}.p`, cid, () => `${cid}.T${++n}`);
              c.paras = out.paras.slice(before).filter((x) => x.cell === cid);
            }
          }
        });
      }
    });
  };
  walk(open.index + open[0].length, xml.lastIndexOf("</hs:sec>"), `${pre}P`, null, () => `${pre}T${++topT}`);
  return out;
}

export function parseTemplate(buf) {
  const entries = readZip(buf);
  const secs = entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e.name)).sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  if (!secs.length) throw new Error("Contents/section*.xml이 없습니다(HWPX 양식이 아님)");
  return { entries, sections: secs.map((e, i) => { const xml = e.data.toString("utf8"); return { name: e.name, xml, ...parseSection(xml, i, secs.length > 1) }; }) };
}

// ---------- 채울 칸 추정 ----------
const LABELS = /^(수\s*신|\(?경\s*유\)?|제\s*목|일\s*시|장\s*소|참\s*석\s*자|안\s*건|내\s*용|결\s*과|기\s*간|목\s*적|비\s*고)$/;
const MARKER = /○○+|ㅇㅇ+|△△+|(?<![A-Za-z])(OO+|XX+)(?![A-Za-z])/;
const GUIDE = /이 난은 서식에 포함하지|작성\s?방법|작성\s?요령|유의\s?사항|기재\s?요령|^\s*※/;

export function scanTemplate(doc) {
  const out = [];
  for (const s of doc.sections) {
    for (const p of s.paras) {
      for (const m of p.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) out.push({ kind: "placeholder", at: p.id, find: m[0], key: m[1] });
      const mk = p.text.match(MARKER);
      if (mk) out.push({ kind: "marker", at: p.id, find: mk[0] });
      for (const f of p.fields) out.push({ kind: "click-here", at: p.id, name: f });
      const t = p.text.trim();
      if (t && (LABELS.test(t) || /[:：]$/.test(t) || (/\s$/.test(p.text) && t.length <= 10))) out.push({ kind: "label-inline", at: p.id, label: t });
      if (GUIDE.test(p.text)) out.push({ kind: "guide", at: p.id, text: t.slice(0, 40) });
    }
    for (const c of s.cells) {
      if (c.name) out.push({ kind: "named-cell", at: c.id, name: c.name });
      // 빈 문단이 3개 이상 이어진 칸: 본문을 적는 자리
      let run = 0, best = 0;
      for (const p of c.paras) { if (!p.obj && !p.text.trim()) { run++; best = Math.max(best, run); } else run = 0; }
      if (best >= 3) out.push({ kind: "body-area", at: c.id, empty: best });
    }
    for (const t of s.tables) {
      const byPos = new Map(s.cells.filter((c) => c.table === t.id).map((c) => [`${c.row},${c.col}`, c]));
      const empty = (c) => c.paras.every((p) => !p.obj && !p.text.trim());
      // 항목 이름 칸 오른쪽의 빈 칸
      for (const c of byPos.values()) {
        const label = c.paras.map((p) => p.text).join(" ").trim();
        const right = byPos.get(`${c.row},${c.col + c.colspan}`);
        if (label && label.length <= 12 && !/\d{2,}/.test(label) && right && empty(right) && right.rowspan === c.rowspan) out.push({ kind: "label-cell", at: right.id, label });
      }
      // 같은 모양의 빈 행이 둘 이상 이어지면 반복 행
      const sig = (r) => r.cells.map((c) => `${c.col}:${c.colspan}:${c.rowspan}`).join(",");
      for (let i = 0; i < t.rows.length; i++) {
        let j = i;
        // 위 행에서 세로로 병합된 칸이 내려와 걸친 행은 반복 행으로 쓰지 못한다
        const covered = (r) => [...byPos.values()].some((c) => c.row < r && c.row + c.rowspan - 1 >= r);
        while (j < t.rows.length && t.rows[j].cells.length && sig(t.rows[j]) === sig(t.rows[i]) && !covered(j) && t.rows[j].cells.every((c) => c.rowspan === 1 && empty(c))) j++;
        if (j - i >= 2) { out.push({ kind: "repeat-rows", table: t.id, from_row: i + 1, count: j - i, cols: t.rows[i].cells.length }); i = j - 1; }
      }
    }
  }
  return out;
}

const KIND_KO = { placeholder: "자리표시자", marker: "자리표시 문자", "click-here": "누름틀", "label-inline": "항목 이름 뒤에 적는 칸(추정)", guide: "서식 안내문(제출본에서 지울지 확인)", "named-cell": "이름 붙은 칸", "body-area": "본문 자리(빈 문단)", "label-cell": "항목 이름 옆 빈 칸(추정)", "repeat-rows": "반복 행" };

// Claude가 읽을 양식 지도: 주소와 글자, 빈 문단은 묶어서
export function outline(doc) {
  const lines = [];
  for (const s of doc.sections) {
    const tableOf = new Map(s.tables.map((t) => [t.para, []]));
    for (const t of s.tables) tableOf.get(t.para).push(t);
    const paraLine = (p, ind) => `${ind}${p.id}${p.obj ? " [개체]" : ""}: ${JSON.stringify(p.text)}`;
    const emit = (paras, ind) => {
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        if (!p.obj && !p.text.trim()) {
          let j = i;
          while (j + 1 < paras.length && !paras[j + 1].obj && !paras[j + 1].text.trim()) j++;
          lines.push(j > i ? `${ind}${p.id}~${paras[j].id.split(".").pop()}: (빈 문단 ${j - i + 1}개)` : `${ind}${p.id}: (빈 문단)`);
          i = j;
          continue;
        }
        lines.push(paraLine(p, ind));
        for (const t of tableOf.get(p.id) ?? []) {
          lines.push(`${ind}  ${t.id}: 표 ${t.rowCnt}행 ${t.colCnt}열`);
          for (const r of t.rows) for (const c of r.cells) {
            lines.push(`${ind}    ${c.id}${c.rowspan > 1 || c.colspan > 1 ? ` (${c.rowspan}x${c.colspan} 병합)` : ""}${c.name ? ` 이름="${c.name}"` : ""}`);
            emit(c.paras, ind + "      ");
          }
        }
      }
    };
    emit(s.paras.filter((p) => p.cell === null), "");
  }
  return lines.join("\n");
}

export function scanText(doc) {
  const sug = scanTemplate(doc);
  const out = ["# 양식 지도", "", outline(doc), "", "# 채울 칸 후보", ""];
  for (const x of sug) {
    const where = x.at ?? `${x.table} ${x.from_row}행부터 ${x.count}행`;
    const detail = x.find ? `"${x.find}"` : x.label ? `"${x.label}"` : x.name != null ? `이름 "${x.name}"` : x.key ? x.key : x.empty ? `빈 문단 ${x.empty}개` : x.cols ? `칸 ${x.cols}개` : x.text ? `"${x.text}"` : "";
    out.push(`- ${where}: ${KIND_KO[x.kind]}${detail ? ` ${detail}` : ""}`);
  }
  if (!sug.length) out.push("- 없음(양식 지도를 보고 직접 정한다)");
  return out.join("\n");
}

// ---------- 값 넣기 ----------
const T_RE = /<hp:t\b[^>]*?(?:\/>|>[\s\S]*?<\/hp:t>)/g;
const HOLD = (i) => `@@HWPX_HOLD_${i}@@`;
const LINESEG = /<hp:linesegarray\b[\s\S]*?<\/hp:linesegarray>|<hp:linesegarray\/>/g;
// 넣는 글자 → hp:t 내용. 문단 안 줄바꿈은 한컴처럼 <hp:lineBreak/>로
const tXml = (text) => esc(text).split("\n").join("<hp:lineBreak/>");
const tInner = (m) => (/^<hp:t\b[^>]*\/>$/.test(m) ? "" : m.replace(/^<hp:t\b[^>]*>/, "").replace(/<\/hp:t>$/, ""));
const isObjPara = (p) => OBJ.test(ownPart(p).replace(/^<hp:p\b[^>]*>/, ""));

// 문단의 하위 글(표 칸, 머리말·꼬리말, 각주, 글상자 — 모두 subList)을 잠시 빼 두고 f로 고친 뒤 되돌린다. 자기 줄 배치 정보는 지운다
function editOwn(p, f) {
  const held = splitTop(p, "hp:subList");
  let s = held.reduce((acc, t, i) => acc.replace(t, () => HOLD(i)), p);
  s = f(s.replace(LINESEG, ""));
  return held.reduce((acc, t, i) => acc.replace(HOLD(i), () => t), s);
}

export function setParaText(p, text) {
  return editOwn(p, (s) => {
    if (s.match(T_RE)) {
      let first = true;
      return s.replace(T_RE, () => { if (first) { first = false; return text ? `<hp:t>${tXml(text)}</hp:t>` : "<hp:t/>"; } return "<hp:t/>"; });
    }
    if (!text) return s;
    const t = `<hp:t>${tXml(text)}</hp:t>`;
    const run = s.match(/<hp:run\b[^>]*?(\/?)>/);
    if (!run) return s.replace(/^<hp:p\b[^>]*>/, (o) => `${o}<hp:run charPrIDRef="0">${t}</hp:run>`);
    if (run[1]) return s.replace(run[0], () => `${run[0].slice(0, -2)}>${t}</hp:run>`);
    const i = s.indexOf("</hp:run>", run.index);
    return s.slice(0, i) + t + s.slice(i);
  });
}

// 줄을 늘릴 때 쓰는 새 문단: 원래 문단(또는 like)의 문단 모양·글자 모양만 가져온다. 구역 설정·개체·쪽 나눔은 복제하지 않는다
function newPara(p, line, st) {
  const s = st ?? styleOf(p);
  const open = openTag(p, 0).replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${s.paraPr}"`).replace(/\bstyleIDRef="\d+"/, `styleIDRef="${s.style}"`).replace(/\bpageBreak="1"/, 'pageBreak="0"').replace(/\bcolumnBreak="1"/, 'columnBreak="0"');
  const cp = s.charPr ?? "0";
  return `${open}${line ? `<hp:run charPrIDRef="${cp}"><hp:t>${tXml(line)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${cp}"/>`}</hp:p>`;
}

// 문단 안 글자 바꾸기. 글자가 run 여러 개에 나뉘어 있어도, 같은 hp:t 안에 탭이 있어도 된다(탭을 걸치지만 않으면).
// 바뀐 글자는 찾은 글자의 첫 조각 모양을 따른다. 새 글자의 "\n"은 줄바꿈(<hp:lineBreak/>)이 된다
export function replaceInPara(p, find, text, all = false) {
  if (typeof find !== "string" || !find) throw new Error("find는 비어 있지 않은 글자여야 합니다");
  text = String(text);
  let count = 0;
  const out = editOwn(p, (s) => {
    const ts = (s.match(T_RE) ?? []).map((m) => tTokens(tInner(m)));
    const chars = [];
    ts.forEach((toks, ti) => toks.forEach((tk, k) => { for (let o = 0; o < tk.text.length; o++) chars.push({ ti, k, o, tag: Boolean(tk.tag) }); }));
    const full = ts.flatMap((toks) => toks.map((t) => t.text)).join("");
    const hits = [];
    for (let i = full.indexOf(find); i >= 0; i = full.indexOf(find, i + find.length)) hits.push(i);
    count = hits.length;
    if (!hits.length || (hits.length > 1 && !all)) return s;
    for (const h of hits.reverse()) {
      const span = chars.slice(h, h + find.length);
      if (span.some((c) => c.tag)) throw new Error(`탭·줄바꿈을 걸쳐서는 바꾸지 못합니다: "${find}". 탭 앞뒤를 따로 바꾸거나 문단 전체를 text로 바꾸세요`);
      const groups = [];
      for (const c of span) {
        const g = groups[groups.length - 1];
        if (g && g.ti === c.ti && g.k === c.k) g.end = c.o + 1; else groups.push({ ti: c.ti, k: c.k, start: c.o, end: c.o + 1 });
      }
      groups.forEach((g, gi) => { const tk = ts[g.ti][g.k]; tk.text = tk.text.slice(0, g.start) + (gi === 0 ? text : "") + tk.text.slice(g.end); });
    }
    let i = 0;
    return s.replace(T_RE, () => {
      const inner = ts[i++].map((t) => (t.tag ? t.tag : tXml(t.text))).join("");
      return inner ? `<hp:t>${inner}</hp:t>` : "<hp:t/>";
    });
  });
  return { xml: out, count };
}

// 칸(hp:tc 문자열)의 글자를 바꾼다: 개체 없는 문단에 줄을 차례로 넣고, 모자라면 새 문단을 더하고, 남는 문단은 비운다.
// 칸 안에 개체(직인 상자 등)가 있고 그 앞에 빈 자리가 있으면 그 앞에만 쓴다(넘치는 줄은 개체 앞에 더한다)
export function setCellText(tc, text, st = null) {
  const sub = tops(tc, "hp:subList", 1, tc.length)[0];
  if (!sub) throw new Error("칸에 subList가 없습니다");
  const ps = tops(tc, "hp:p", sub.start + openTag(tc, sub.start).length, sub.end);
  const obj = ps.map((p) => isObjPara(tc.slice(p.start, p.end)));
  const firstObj = obj.indexOf(true);
  const free = ps.filter((p, i) => !obj[i]);
  const before = firstObj > 0 ? free.filter((p) => p.start < ps[firstObj].start) : [];
  const slots = before.length ? before : free;
  if (!slots.length) throw new Error("글자를 넣을 문단이 없는 칸입니다(개체만 있음)");
  const lines = String(text).split("\n");
  let s = tc;
  const last = slots[Math.min(lines.length, slots.length) - 1];
  const extra = lines.slice(slots.length).map((l) => newPara(tc.slice(last.start, last.end), l, st)).join("");
  for (let i = slots.length - 1; i >= 0; i--) {
    const p = slots[i];
    let nx = setParaText(tc.slice(p.start, p.end), i < lines.length ? lines[i] : "");
    if (i < lines.length) nx = applyStyle(nx, st);
    if (p === last) nx += extra;
    s = s.slice(0, p.start) + nx + s.slice(p.end);
  }
  return s;
}

const setRowAddr = (tr, r) => {
  let out = tr;
  for (const tc of tops(tr, "hp:tc", 1, tr.length).reverse()) {
    const x = tr.slice(tc.start, tc.end);
    const sub = tops(x, "hp:subList", 1, x.length)[0];
    const fix = (part) => part.replace(/(<hp:cellAddr\s+colAddr="\d+"\s+rowAddr=")\d+(")/, `$1${r}$2`);
    const nx = sub ? fix(x.slice(0, sub.start)) + x.slice(sub.start, sub.end) + fix(x.slice(sub.end)) : fix(x);
    out = out.slice(0, tc.start) + nx + out.slice(tc.end);
  }
  return out;
};

function setRowTexts(tr, values, where) {
  const tcs = tops(tr, "hp:tc", 1, tr.length);
  if (values.length !== tcs.length) throw new Error(`${where}: 값이 ${values.length}개인데 칸은 ${tcs.length}개입니다`);
  let out = tr;
  for (let i = tcs.length - 1; i >= 0; i--) {
    if (values[i] == null) continue;
    out = out.slice(0, tcs[i].start) + setCellText(tr.slice(tcs[i].start, tcs[i].end), values[i]) + out.slice(tcs[i].end);
  }
  return out;
}

// 다른 문단의 모양(문단 모양·스타일·글자 모양)을 빌린다. 양식의 빈 문단이 높이만 잡아 둔 문단일 때 쓴다
function styleOf(xml) {
  const own = ownPart(xml);
  const runs = [...own.matchAll(/<hp:run\b[^>]*?(?:\/>|>[\s\S]*?<\/hp:run>)/g)].map((m) => m[0]);
  const run = runs.find((r) => /<hp:t\b[^>]*>[^<]/.test(r)) ?? runs[0] ?? "";
  const open = openTag(own, 0);
  return { paraPr: attr(open, "paraPrIDRef"), style: attr(open, "styleIDRef"), charPr: attr(run, "charPrIDRef") };
}
export function applyStyle(p, st) {
  if (!st) return p;
  return editOwn(p, (s) => {
    s = s.replace(/^<hp:p\b[^>]*>/, (o) => o.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${st.paraPr}"`).replace(/\bstyleIDRef="\d+"/, `styleIDRef="${st.style}"`));
    return st.charPr == null ? s : s.replace(/<hp:run\b[^>]*?charPrIDRef="\d+"/g, (r) => r.replace(/charPrIDRef="\d+"/, `charPrIDRef="${st.charPr}"`));
  });
}

function findIn(doc, id) {
  for (const s of doc.sections) {
    const p = s.paras.find((x) => x.id === id); if (p) return { s, kind: "para", it: p };
    const c = s.cells.find((x) => x.id === id); if (c) return { s, kind: "cell", it: c };
    const t = s.tables.find((x) => x.id === id); if (t) return { s, kind: "table", it: t };
  }
  return null;
}

function applyOp(doc, op, n) {
  const where = `ops[${n}]`;
  const splice = (s, a, b, x) => { s.xml = s.xml.slice(0, a) + x + s.xml.slice(b); };
  if (op.delete_row) {
    const m = String(op.delete_row).match(/^(.*)\.r(\d+)$/);
    const f = m && findIn(doc, m[1]);
    if (!f || f.kind !== "table") throw new Error(`${where}: 표를 찾지 못했습니다: ${op.delete_row}`);
    const t = f.it, r = Number(m[2]) - 1;
    if (!t.rows[r]) throw new Error(`${where}: ${m[1]}에 ${r + 1}행이 없습니다`);
    const cells = f.s.cells.filter((c) => c.table === t.id);
    if (cells.some((c) => c.row <= r && c.row + c.rowspan - 1 >= r && c.rowspan > 1)) throw new Error(`${where}: ${op.delete_row}에 세로로 병합된 칸이 걸쳐 있어 지우지 못합니다`);
    let x = f.s.xml.slice(t.start, t.end);
    const trs = tops(x, "hp:tr", 1, x.length);
    for (let i = trs.length - 1; i > r; i--) x = x.slice(0, trs[i].start) + setRowAddr(x.slice(trs[i].start, trs[i].end), i - 1) + x.slice(trs[i].end);
    x = x.slice(0, trs[r].start) + x.slice(trs[r].end);
    x = x.replace(/(<hp:tbl\b[^>]*\browCnt=")\d+(")/, `$1${t.rows.length - 1}$2`);
    splice(f.s, t.start, t.end, x);
    return `${op.delete_row} 행 지움`;
  }
  if (op.table) {
    const f = findIn(doc, op.table);
    if (!f || f.kind !== "table") throw new Error(`${where}: 표를 찾지 못했습니다: ${op.table}`);
    const t = f.it, r0 = Number(op.from_row ?? 1) - 1;
    if (!Array.isArray(op.rows) || !op.rows.length) throw new Error(`${where}: rows가 비었습니다`);
    if (!t.rows[r0]) throw new Error(`${where}: ${op.table}에 ${r0 + 1}행이 없습니다`);
    const sig = (row) => row.cells.map((c) => `${c.col}:${c.colspan}:${c.rowspan}`).join(",");
    if (t.rows[r0].cells.some((c) => c.rowspan > 1)) throw new Error(`${where}: ${op.table} ${r0 + 1}행에 세로 병합 칸이 있어 반복 행으로 쓰지 못합니다`);
    // 위 행에서 세로로 병합된 칸이 내려와 걸친 행은 복제하면 표에 구멍이 생긴다
    const tcells = f.s.cells.filter((c) => c.table === t.id);
    const covered = (r) => tcells.some((c) => c.row < r && c.row + c.rowspan - 1 >= r);
    if (covered(r0)) throw new Error(`${where}: ${op.table} ${r0 + 1}행에 위 행에서 세로로 병합된 칸이 걸쳐 있어 반복 행으로 쓰지 못합니다`);
    // 쓸 수 있는 행: from_row와 그 아래로 이어지는, 모양이 같고 비어 있는 행(합계 행처럼 글자가 있는 행은 덮어쓰지 않는다)
    const empty = (c) => c.paras.every((p) => !p.obj && !p.text.trim());
    let slots = 1;
    while (r0 + slots < t.rows.length && sig(t.rows[r0 + slots]) === sig(t.rows[r0]) && !covered(r0 + slots) && t.rows[r0 + slots].cells.every(empty)) slots++;
    let x = f.s.xml.slice(t.start, t.end);
    const trs = tops(x, "hp:tr", 1, x.length);
    const tmpl = x.slice(trs[r0].start, trs[r0].end);
    const add = Math.max(0, op.rows.length - slots);
    const filled = op.rows.slice(0, slots).map((v, i) => setRowTexts(x.slice(trs[r0 + i].start, trs[r0 + i].end), v, `${where} rows[${i}]`));
    const clones = op.rows.slice(slots).map((v, i) => setRowAddr(setRowTexts(tmpl, v, `${where} rows[${slots + i}]`), r0 + slots + i));
    // 채운 행·새 행 뒤에 있던 행(남은 빈 행, 합계 행 등)은 늘어난 만큼 행 번호를 민다
    const rest = r0 + Math.min(slots, op.rows.length);
    const after = trs.slice(rest).map((tr, i) => (add ? setRowAddr(x.slice(tr.start, tr.end), rest + i + add) : x.slice(tr.start, tr.end)));
    const before = trs.slice(0, r0).map((tr) => x.slice(tr.start, tr.end)).join("");
    x = x.slice(0, trs[0].start) + before + filled.join("") + clones.join("") + after.join("") + x.slice(trs[trs.length - 1].end);
    if (add) x = x.replace(/(<hp:tbl\b[^>]*\browCnt=")\d+(")/, `$1${t.rows.length + add}$2`);
    splice(f.s, t.start, t.end, x);
    return `${op.table} ${r0 + 1}행부터 ${op.rows.length}행(${add}행 추가)`;
  }
  if (!op.at) throw new Error(`${where}: at, table, delete_row 중 하나가 필요합니다`);
  const f = findIn(doc, op.at);
  if (!f) throw new Error(`${where}: 주소를 찾지 못했습니다: ${op.at}`);
  if (f.kind === "table") throw new Error(`${where}: ${op.at}는 표입니다. 칸(${op.at}.r1c1)이나 문단 주소를 쓰세요`);
  if (op.text == null) throw new Error(`${where}: text가 필요합니다`);
  if (op.find != null && (typeof op.find !== "string" || !op.find)) throw new Error(`${where}: find는 비어 있지 않은 글자여야 합니다`);
  const { s, it } = f;
  let st = null;
  if (op.like) {
    const ref = findIn(doc, op.like);
    if (!ref || ref.kind !== "para") throw new Error(`${where}: like는 문단 주소여야 합니다: ${op.like}`);
    st = styleOf(ref.s.xml.slice(ref.it.start, ref.it.end));
  }
  if (op.find != null) {
    const paras = f.kind === "para" ? [it] : it.paras;
    let total = 0;
    const results = paras.map((p) => { const r = replaceInPara(s.xml.slice(p.start, p.end), op.find, String(op.text), op.all); total += r.count; return { p, r }; });
    if (!total) throw new Error(`${where}: ${op.at}에서 "${op.find}"를 찾지 못했습니다`);
    if (total > 1 && !op.all) throw new Error(`${where}: ${op.at}에 "${op.find}"가 ${total}번 있습니다. 더 좁은 주소를 주거나 "all": true`);
    for (const { p, r } of results.reverse()) if (r.count) splice(s, p.start, p.end, applyStyle(r.xml, st));
    // 고정 크기 칸에서 글자가 많이 길어지면 줄이 접히거나 넘칠 수 있다(글자 폭은 재지 않는다)
    const longer = String(op.text).length - op.find.length;
    return `${op.at} "${op.find}" 바꿈${longer >= 3 && String(op.text).length > op.find.length * 1.5 ? ` — 원래보다 ${longer}자 길어짐: 칸이 넘치지 않는지 PDF로 확인` : ""}`;
  }
  if (f.kind === "para") {
    // 둘째 줄부터는 새 문단으로 더한다(첫 문단의 구역 설정·개체를 복제하지 않는다)
    const [first, ...rest] = String(op.text).split("\n");
    const px = s.xml.slice(it.start, it.end);
    splice(s, it.start, it.end, applyStyle(setParaText(px, first), st) + rest.map((l) => newPara(px, l, st)).join(""));
    return `${op.at} 문단`;
  }
  splice(s, it.start, it.end, setCellText(s.xml.slice(it.start, it.end), op.text, st));
  return `${op.at} 칸`;
}

// ops를 차례로 적용한다. 하나 적용할 때마다 다시 읽어 주소를 새로 맞춘다(행을 늘리면 뒤 주소가 바뀐다)
export function fillTemplate(buf, ops) {
  let doc = parseTemplate(buf);
  const log = [];
  ops.forEach((op, i) => {
    log.push(applyOp(doc, op, i));
    doc = { entries: doc.entries, sections: doc.sections.map((s, k) => ({ name: s.name, xml: s.xml, ...parseSection(s.xml, k, doc.sections.length > 1) })) };
  });
  const changed = new Map(doc.sections.map((s) => [s.name, s.xml]));
  const zip = (extra) => writeZip(doc.entries.map((e) => ({ name: e.name, data: changed.has(e.name) ? changed.get(e.name) : extra.has(e.name) ? extra.get(e.name) : e.data, store: e.method === 0 })));
  let out = zip(new Map());
  // 미리보기 글(탐색기 등에 보이는 글)도 채운 내용으로 바꾼다. 미리보기 그림(PrvImage.png)은 만들지 못해 그대로 둔다
  if (doc.entries.some((e) => e.name === "Preview/PrvText.txt")) out = zip(new Map([["Preview/PrvText.txt", previewText(readHwpx(out))]]));
  return { buf: out, log };
}

// 한컴 미리보기 글 모양: 문단은 한 줄, 표는 행마다 <칸><칸>, 줄 끝은 CRLF
function previewText(doc) {
  const lines = [];
  const table = (t) => {
    const rows = new Map();
    for (const c of t.cells) (rows.get(c.row) ?? rows.set(c.row, []).get(c.row)).push(c.text.replace(/\s*\n\s*/g, " "));
    for (const r of [...rows.keys()].sort((a, b) => a - b)) lines.push(rows.get(r).map((x) => `<${x}>`).join(""));
  };
  for (const b of doc.blocks) { if (b.type === "table") table(b); else if (!b.sub) lines.push(b.text.replace(/\n/g, " ")); }
  return lines.join("\r\n").slice(0, 1024);
}
