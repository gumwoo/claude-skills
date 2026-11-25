#!/usr/bin/env node
// HWPX 구조 검사(S1). XML이 맞아도 한컴이 못 열거나 서식이 밀리는 원인을 찾는다. 한컴 없이 돈다.
//   - 패키지: mimetype이 첫 항목·비압축·내용 / version.xml 비압축 / 필수 파일
//   - XML: 태그 짝
//   - header: itemCnt와 실제 개수, 글자·문단 모양 id가 0부터 빈틈없는지
//   - 참조: 본문의 charPrIDRef·paraPrIDRef·borderFillIDRef·styleIDRef가 header에 있는지
//   - 표: rowCnt·colCnt, 칸이 격자를 빈틈·겹침 없이 덮는지, 칸마다 문단이 있는지
//   - 구역 설정(secPr)이 첫 문단에 있는지 / 낡은 줄바꿈 캐시(linesegarray) 경고
//   - 글꼴: 문서가 쓰는 글꼴이 이 PC에 있는지(경고)
//
// 사용: node check-hwpx.mjs <파일.hwpx> [--json]
// 종료 코드: 0 = 문제 없음(경고만 있을 수 있음), 2 = 오류 있음, 1 = 읽기 실패
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readZip } from "./lib/zip.mjs";
import { missingFonts } from "./lib/fonts.mjs";

// 태그 짝 검사(주석·CDATA·선언 건너뜀). 엄격한 XML 파서는 아니다
export function xmlBalanced(s) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[2]) continue;
    if (m[1]) {
      const top = stack.pop();
      if (top !== m[2]) return `닫는 태그 </${m[2]}>가 열린 <${top ?? "없음"}>와 맞지 않음(위치 ${m.index})`;
    } else if (!m[4]) stack.push(m[2]);
  }
  return stack.length ? `닫히지 않은 태그 <${stack.at(-1)}>` : null;
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

export function checkHwpx(buf) {
  const errors = [], warnings = [];
  const E = (code, msg) => errors.push({ code, msg }), W = (code, msg) => warnings.push({ code, msg });
  let entries;
  try { entries = readZip(buf); } catch (e) { return { errors: [{ code: "zip", msg: e.message }], warnings, fonts: [] }; }
  const get = (n) => entries.find((e) => e.name === n);
  if (entries[0]?.name !== "mimetype") E("mimetype", "mimetype이 zip의 첫 항목이 아님");
  const mt = get("mimetype");
  if (!mt) E("mimetype", "mimetype 없음");
  else {
    if (mt.method !== 0) E("mimetype", "mimetype이 압축돼 있음(비압축이어야 함)");
    if (mt.data.toString("utf8") !== "application/hwp+zip") E("mimetype", `mimetype 내용이 다름: ${mt.data.toString("utf8").slice(0, 40)}`);
  }
  const ver = get("version.xml");
  if (!ver) E("package", "version.xml 없음");
  else if (ver.method !== 0) W("package", "version.xml이 압축돼 있음(한컴 저장본은 비압축)");
  for (const n of ["Contents/header.xml", "Contents/content.hpf", "META-INF/container.xml"]) if (!get(n)) E("package", `${n} 없음`);
  const sections = entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e.name));
  if (!sections.length) E("package", "Contents/section0.xml 없음");
  for (const e of entries.filter((x) => /\.(xml|hpf|rdf)$/.test(x.name))) {
    const bad = xmlBalanced(e.data.toString("utf8"));
    if (bad) E("xml", `${e.name}: ${bad}`);
  }
  const header = get("Contents/header.xml")?.data.toString("utf8") ?? "";
  // itemCnt와 실제 개수
  const lists = [["fontfaces", "fontface"], ["borderFills", "borderFill"], ["charProperties", "charPr"], ["tabProperties", "tabPr"], ["numberings", "numbering"], ["bullets", "bullet"], ["paraProperties", "paraPr"], ["styles", "style"]];
  const ids = {};
  for (const [list, item] of lists) {
    const m = header.match(new RegExp(`<hh:${list}\\b([^>]*?)(/?)>([\\s\\S]*?)(?:</hh:${list}>|$)`));
    if (!m) continue;
    const declared = Number(attr(m[1], "itemCnt"));
    const body = m[2] ? "" : m[3];
    const found = [...body.matchAll(new RegExp(`<hh:${item}\\b([^>]*)>`, "g"))].map((x) => x[1]);
    if (!Number.isNaN(declared) && declared !== found.length) E("header", `${list}: itemCnt=${declared}인데 실제 ${found.length}개`);
    ids[item] = new Set(found.map((a) => attr(a, "id")).filter((x) => x != null).map(Number));
  }
  for (const item of ["charPr", "paraPr"]) {
    const s = [...(ids[item] ?? [])].sort((a, b) => a - b);
    s.forEach((v, i) => { if (v !== i) E("header", `${item} id가 0부터 빈틈없지 않음(${i}번째가 ${v}) — 한컴은 목록 순서로 해석해서 서식이 밀린다`); });
  }
  const fonts = [...new Set([...header.matchAll(/<hh:font\b[^>]*\sface="([^"]+)"/g)].map((m) => m[1]))];
  for (const sec of sections) {
    const s = sec.data.toString("utf8");
    const refCheck = (name, set, label) => {
      for (const m of s.matchAll(new RegExp(`\\s${name}="(\\d+)"`, "g"))) if (set && !set.has(Number(m[1]))) { E("ref", `${sec.name}: ${name}=${m[1]}이 header의 ${label}에 없음`); break; }
    };
    refCheck("charPrIDRef", ids.charPr, "charPr");
    refCheck("paraPrIDRef", ids.paraPr, "paraPr");
    refCheck("borderFillIDRef", ids.borderFill, "borderFill");
    refCheck("styleIDRef", ids.style, "style");
    if (sec.name === "Contents/section0.xml") {
      const firstP = s.match(/<hp:p\b[\s\S]*?<\/hp:p>/)?.[0] ?? "";
      if (!/<hp:secPr\b/.test(firstP)) E("section", "첫 문단에 구역 설정(secPr)이 없음");
    }
    if (/<hp:linesegarray\b/.test(s)) W("lineseg", `${sec.name}: 줄바꿈 캐시(linesegarray)가 있음 — 내용을 고친 문단에 남아 있으면 한컴이 그 문단부터 내용을 버릴 수 있다`);
    // 표 검사: 중첩 표를 고려해 tbl 단위로 자른다
    const tblRe = /<hp:tbl\b([^>]*)>/g;
    let tm, ti = 0;
    while ((tm = tblRe.exec(s))) {
      ti++;
      let depth = 1, i = tblRe.lastIndex;
      const tagRe = /<(\/?)hp:tbl\b[^>]*>/g;
      tagRe.lastIndex = i;
      let t2;
      while (depth && (t2 = tagRe.exec(s))) depth += t2[1] ? -1 : 1;
      const inner = s.slice(i, t2 ? t2.index : s.length);
      const own = inner.replace(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/g, ""); // 안쪽 표는 따로 검사된다
      const rowCnt = Number(attr(tm[1], "rowCnt")), colCnt = Number(attr(tm[1], "colCnt"));
      const where = `${sec.name} 표 ${ti}`;
      if (Number.isNaN(rowCnt) || Number.isNaN(colCnt)) { E("table", `${where}: rowCnt·colCnt 없음 — 한컴이 격자를 못 만들어 문서가 열리지 않는다`); continue; }
      const grid = Array.from({ length: rowCnt }, () => Array(colCnt).fill(0));
      for (const tc of own.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)) {
        const addr = tc[0].match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/);
        const span = tc[0].match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/);
        if (!addr || !span) { E("table", `${where}: cellAddr·cellSpan이 없는 칸`); continue; }
        if (!/<hp:cellSz\b/.test(tc[0])) E("table", `${where}: cellSz가 없는 칸(${addr[2]},${addr[1]})`);
        if (!/<hp:p\b/.test(tc[0])) E("table", `${where}: 문단이 없는 칸(${addr[2]},${addr[1]}) — 빈 칸에도 문단 하나가 있어야 한다`);
        const [c, r, cs, rs] = [addr[1], addr[2], span[1], span[2]].map(Number);
        for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) {
          if (y >= rowCnt || x >= colCnt) { E("table", `${where}: 칸(${r},${c})이 격자 밖으로 나감`); continue; }
          grid[y][x]++;
        }
      }
      grid.forEach((row, y) => row.forEach((v, x) => {
        if (v === 0) E("table", `${where}: (${y},${x})를 덮는 칸이 없음(구멍)`);
        if (v > 1) E("table", `${where}: (${y},${x})를 칸 ${v}개가 겹쳐 덮음`);
      }));
    }
  }
  const lost = missingFonts(fonts);
  if (lost.length) W("font", `이 PC에 없는 글꼴: ${lost.join(", ")} — 한컴이 다른 글꼴로 바꾸면 줄·쪽 나눔이 달라진다`);
  return { errors, warnings, fonts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("사용: node check-hwpx.mjs <파일.hwpx> [--json]"); process.exit(1); }
  let r;
  try { r = checkHwpx(fs.readFileSync(file)); } catch (e) { console.error(`읽기 실패: ${e.message}`); process.exit(1); }
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    for (const e of r.errors) console.log(`오류 [${e.code}] ${e.msg}`);
    for (const w of r.warnings) console.log(`경고 [${w.code}] ${w.msg}`);
    console.log(r.errors.length ? `오류 ${r.errors.length}개` : "구조 오류 없음");
  }
  process.exit(r.errors.length ? 2 : 0);
}
