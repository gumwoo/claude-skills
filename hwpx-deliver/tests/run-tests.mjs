#!/usr/bin/env node
// hwpx-deliver 시험: node tests/run-tests.mjs
// 외부 의존성 없음. 한컴오피스 없이 돈다(한컴 대조 결과는 tests/oracle/expected에 저장해 둔 것을 쓴다).
// PDF 시험은 Edge·Chrome이 있을 때만 돈다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const fx = (p) => path.join(here, "fixtures", p);
const imp = (m) => import(new URL(`../scripts/${m}`, import.meta.url));
const { readZip, writeZip, crc32 } = await imp("lib/zip.mjs");
const { normalize, runsOf, mm2hu } = await imp("lib/model.mjs");
const { buildHwpx } = await imp("lib/hwpx-write.mjs");
const { buildHtml } = await imp("lib/html-render.mjs");
const { readHwpx, textLines } = await imp("lib/hwpx-read.mjs");
const { checkHwpx, xmlBalanced } = await imp("check-hwpx.mjs");
const { build, findBrowser } = await imp("build.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? " — " + detail : ""}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const load = (f) => JSON.parse(fs.readFileSync(fx(f), "utf8"));
const entry = (buf, name) => readZip(buf).find((e) => e.name === name)?.data.toString("utf8");

// ---------- zip ----------
{
  const z = writeZip([{ name: "mimetype", data: "application/hwp+zip", store: true }, { name: "a/b.xml", data: "<x>한글</x>" }]);
  const e = readZip(z);
  ok("zip: 순서·이름·내용 보존", e[0].name === "mimetype" && e[1].data.toString("utf8") === "<x>한글</x>");
  ok("zip: mimetype 비압축, 나머지 압축", e[0].method === 0 && e[1].method === 8);
  ok("zip: CRC", e[1].crc === crc32(Buffer.from("<x>한글</x>")));
  ok("zip: zip이 아니면 오류", throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /zip/));
}

// ---------- 모델 ----------
{
  ok("model: 알 수 없는 블록", throws(() => normalize({ blocks: [{ type: "chart" }] }), /blocks\[0\].*chart/));
  ok("model: heading level", throws(() => normalize({ blocks: [{ type: "heading", level: 4, text: "x" }] }), /level/));
  ok("model: 표의 구멍", throws(() => normalize({ blocks: [{ type: "table", rows: [["a", "b"], ["c"]] }] }), /2행 2열이 비었/));
  ok("model: 열 너비 개수", throws(() => normalize({ blocks: [{ type: "table", widths_mm: [10], rows: [["a", "b"]] }] }), /widths_mm는 2개/));
  const m = normalize({ blocks: [{ type: "table", rows: [[{ text: "a", rowspan: 2 }, "b"], ["c"], [{ text: "d", colspan: 2 }]] }] });
  const t = m.blocks[0];
  ok("model: 병합 칸 배치", t.rows === 3 && t.cols === 2 && t.cells.map((c) => `${c.row}${c.col}`).join(",") === "00,01,11,20");
  ok("model: run 형식", JSON.stringify(runsOf([{ t: "a", b: true }, "c"])) === JSON.stringify([{ t: "a", b: true }, { t: "c", b: false }]));
  ok("model: 단위", mm2hu(210) === 59528 && mm2hu(297) === 84189);
}

// ---------- HWPX 쓰기 ----------
const basic = normalize(load("doc-basic.json"));
const hwpx = buildHwpx(basic);
{
  const r = checkHwpx(hwpx);
  ok("write: 구조 검사 통과", r.errors.length === 0, JSON.stringify(r.errors));
  const e = readZip(hwpx);
  ok("write: mimetype 첫 항목·비압축", e[0].name === "mimetype" && e[0].method === 0 && e[1].name === "version.xml" && e[1].method === 0);
  const header = entry(hwpx, "Contents/header.xml"), section = entry(hwpx, "Contents/section0.xml");
  ok("write: 굵은 글씨는 <hh:bold/>", /<hh:bold\/>/.test(header));
  ok("write: 글꼴 이름", /face="함초롬바탕"/.test(header) && /face="함초롬돋움"/.test(header));
  ok("write: 한글 줄 나눔은 BREAK_WORD(한컴 2022에서 어절 단위로 확인)", /breakNonLatinWord="BREAK_WORD"/.test(header) && !/KEEP_WORD"[^>]*widowOrphan/.test(header.replace(/breakLatinWord="KEEP_WORD"/g, "")));
  ok("write: 내어쓰기는 left=첫 줄 위치, intent=음수", /<hc:intent value="-1417" unit="HWPUNIT"\/><hc:left value="0" unit="HWPUNIT"\/>/.test(header));
  ok("write: 표는 쪽을 넘길 수 있게(treatAsChar=0), 바깥 여백 0", /<hp:pos treatAsChar="0"/.test(section) && /<hp:outMargin left="0" right="0" top="0" bottom="0"\/>/.test(section));
  {
    // 표 위아래 간격은 빈 간격 문단(4pt·8pt 글자, 줄 간격 100%)으로
    const ref = (pt) => header.match(new RegExp(`<hh:charPr id="(\\d+)" height="${pt * 100}"`))?.[1];
    const empty = (id) => `<hp:run charPrIDRef="${id}"/></hp:p>`;
    const i = section.indexOf("<hp:tbl"), j = section.indexOf("</hp:tbl>");
    ok("write: 표 앞뒤 빈 간격 문단(4pt·8pt)", ref(4) && ref(8) && section.slice(0, i).replace(/<hp:p [^>]*><hp:run charPrIDRef="\d+">$/, "").endsWith(empty(ref(4))) && section.slice(j).startsWith(`</hp:tbl><hp:t/></hp:run></hp:p><hp:p id="0" paraPrIDRef="`) && section.slice(j).replace(/^<\/hp:tbl><hp:t\/><\/hp:run><\/hp:p><hp:p [^>]*>/, "").startsWith(empty(ref(8))));
  }
  ok("write: 쪽 번호(가운데 아래, - 1 -)와 '쪽 번호' 글자 스타일", /<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"\/>/.test(section) && /<hh:style id="\d+" type="CHAR" name="쪽 번호"/.test(header));
  ok("write: page.number=false면 쪽 번호 없음", !/pageNum/.test(entry(buildHwpx(normalize({ page: { number: false }, blocks: [{ type: "para", text: "x" }] })), "Contents/section0.xml")));
  ok("model: 대조하지 않은 쪽 번호 위치는 받지 않음", throws(() => normalize({ page: { number: { pos: "top-center" } }, blocks: [] }), /bottom-center/));
  ok("write: 표 rowCnt·colCnt·병합", /rowCnt="6" colCnt="4"/.test(section) && /rowSpan="2"/.test(section));
  ok("write: 첫 문단에 secPr", /^[^]*?<hp:p\b[^>]*><hp:run charPrIDRef="0"><hp:secPr/.test(section));
  ok("write: 줄바꿈 캐시를 쓰지 않음", !/linesegarray/.test(section));
  ok("write: 같은 입력이면 같은 바이트", Buffer.compare(hwpx, buildHwpx(normalize(load("doc-basic.json")))) === 0);
  ok("write: 작성자 정보를 넣지 않음", /<opf:meta name="creator" content="text"\/>/.test(entry(hwpx, "Contents/content.hpf")));
  const esc = buildHwpx(normalize({ blocks: [{ type: "para", text: 'A&B <C> "D"' }] }));
  ok("write: XML 특수문자", entry(esc, "Contents/section0.xml").includes("A&amp;B &lt;C&gt; &quot;D&quot;") && checkHwpx(esc).errors.length === 0);
  ok("write: 빈 문서도 열리는 구조", checkHwpx(buildHwpx(normalize({ blocks: [] }))).errors.length === 0);
}

// ---------- 한컴 대조(저장해 둔 결과) ----------
{
  // 한컴오피스 2022(12.0.0.535)로 같은 fixture를 열어 GetTextFile("UNICODE")로 뽑은 텍스트
  const hancomLines = (n) => fs.readFileSync(path.join(here, "oracle", "expected", `${n}.hancom.txt`), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  for (const n of ["basic", "long", "mixed"]) {
    const ours = textLines(readHwpx(buildHwpx(normalize(load(`doc-${n}.json`)))));
    const han = hancomLines(n);
    const i = ours.findIndex((l, k) => l !== han[k]);
    ok(`oracle: ${n} — 한컴이 읽은 텍스트와 같음(${han.length}줄)`, ours.length === han.length && i === -1, i >= 0 ? JSON.stringify([ours[i], han[i]]) : `${ours.length} vs ${han.length}`);
  }
  // 한컴이 다시 저장한 HWPX(작성자 정보 제거)는 구조 검사를 통과해야 한다(검사가 진짜 한컴 파일을 오류로 보지 않는지)
  const r = checkHwpx(fs.readFileSync(fx("basic.hancom-resaved.hwpx")));
  ok("oracle: 한컴 저장본은 구조 오류 없음", r.errors.length === 0, JSON.stringify(r.errors));
  ok("oracle: 한컴 저장본의 줄바꿈 캐시는 경고로만", r.warnings.some((w) => w.code === "lineseg"));
  ok("oracle: 한컴 저장본에도 굵은 글씨·병합·음영이 남음", (() => { const h = entry(fs.readFileSync(fx("basic.hancom-resaved.hwpx")), "Contents/header.xml"), s = entry(fs.readFileSync(fx("basic.hancom-resaved.hwpx")), "Contents/section0.xml"); return /<hh:bold\/>/.test(h) && /faceColor="#E5E5E5"/i.test(h) && /rowSpan="2"/.test(s); })());
  ok("oracle: 한컴 저장본을 다시 읽어도 같은 텍스트", textLines(readHwpx(fs.readFileSync(fx("basic.hancom-resaved.hwpx")))).join("\n") === hancomLines("basic").join("\n"));
}

// ---------- 구조 검사가 잡아야 하는 것 ----------
{
  const mutate = (fn) => {
    const e = readZip(hwpx).map((x) => ({ name: x.name, data: x.data.toString("utf8"), store: x.method === 0 }));
    fn(e);
    return writeZip(e);
  };
  const codes = (buf) => checkHwpx(buf).errors.map((x) => `${x.code}:${x.msg}`).join(" / ");
  const sec = (e) => e.find((x) => x.name === "Contents/section0.xml");
  const hdr = (e) => e.find((x) => x.name === "Contents/header.xml");
  ok("check: 압축된 mimetype", /mimetype이 압축/.test(codes(mutate((e) => { e[0].store = false; }))));
  ok("check: mimetype이 첫 항목이 아님", /첫 항목이 아님/.test(codes(mutate((e) => { e.push(e.shift()); }))));
  ok("check: rowCnt 없음", /rowCnt·colCnt 없음/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/ rowCnt="\d+"/, ""); }))));
  ok("check: 표의 구멍", /구멍/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/rowSpan="2"/, 'rowSpan="1"'); }))));
  ok("check: 칸 겹침", /겹쳐/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/colSpan="1" rowSpan="1"/, 'colSpan="2" rowSpan="1"'); }))));
  ok("check: 문단 없는 칸", /문단이 없는 칸/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/(<hp:subList\b[^>]*>)<hp:p\b[\s\S]*?<\/hp:p>(<\/hp:subList>)/, "$1$2"); }))));
  ok("check: 없는 글자 모양 참조", /charPrIDRef=99/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/charPrIDRef="\d+"/,'charPrIDRef="99"'); }))));
  ok("check: itemCnt 불일치", /itemCnt/.test(codes(mutate((e) => { hdr(e).data = hdr(e).data.replace(/<hh:charProperties itemCnt="\d+"/, '<hh:charProperties itemCnt="42"'); }))));
  ok("check: 글자 모양 id 빈틈", /빈틈없지 않음/.test(codes(mutate((e) => { hdr(e).data = hdr(e).data.replace(/<hh:charPr id="1"/, '<hh:charPr id="7"'); }))));
  ok("check: secPr 없음", /secPr/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace(/<hp:secPr\b[\s\S]*?<\/hp:secPr>/, ""); }))));
  ok("check: 태그 짝", /닫는 태그|닫히지 않은/.test(codes(mutate((e) => { sec(e).data = sec(e).data.replace("</hp:run>", ""); }))));
  ok("check: 줄바꿈 캐시 경고", checkHwpx(mutate((e) => { sec(e).data = sec(e).data.replace("</hp:p>", '<hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>'); })).warnings.some((w) => w.code === "lineseg"));
  ok("check: 없는 글꼴 경고", checkHwpx(mutate((e) => { hdr(e).data = hdr(e).data.replace(/face="함초롬바탕"/g, 'face="없는글꼴체"'); })).warnings.some((w) => /없는글꼴체/.test(w.msg)));
  ok("xml: 짝 검사", xmlBalanced("<a><b/><c></c></a>") === null && xmlBalanced("<a><b></a>") !== null);
}

// ---------- HTML ----------
{
  const html = buildHtml(basic);
  ok("html: 쪽 크기·여백", /@page\{size:210mm 297mm;margin:20mm 20mm 15mm 20mm\}/.test(html));
  ok("html: 어절 단위 줄 나눔", /word-break:keep-all/.test(html));
  ok("html: 문단 간격은 padding", /\.s-body\{[^}]*padding:0pt 0 4pt 0mm/.test(html));
  ok("html: 머리 행은 thead(쪽마다 반복)", /<thead><tr><td class="h"/.test(html));
  ok("html: 한컴 보정 스크립트(기준선 0.85, 공백 0.5em)", /-0\.85\)/.test(html) && /\(0\.5-m\.sp\)/.test(html));
  ok("html: 병합 칸", /rowspan="2"/.test(html));
  ok("html: 표 앞뒤 간격 문단, 표 여백 0", /<p class="tsb"><\/p><table/.test(html) && /<\/table><p class="tsa"><\/p>/.test(html) && /\.tsb\{height:4pt/.test(html) && /\.tsa\{height:8pt/.test(html) && /table\{[^}]*margin:0\}/.test(html));
  // 테두리 0.12mm는 브라우저에서 1픽셀(0.2646mm)로 그려지므로 칸 위아래 여백 0.5mm에서 그 절반을 뺀다
  ok("html: 칸 여백은 테두리 두께만큼 줄임", /td\{border:0\.12mm solid #000;[^}]*padding:0\.368mm 1\.8mm 0\.368mm 1\.8mm\}/.test(html));
  ok("html: 칸 문단 보정은 위쪽 여백으로(줄 상자가 칸 아래로 삐져나오지 않게)", /td p\[data-k="'\+k\+'"\]\{margin-top:/.test(html) && !/margin-bottom:'\+/.test(html));
  ok("html: 쪽 번호", /@page\{@bottom-center\{content:"- " counter\(page\) " -";font-family:"함초롬돋움";font-size:10pt/.test(html) && /data-pn='/.test(html));
  ok("html: page.number=false면 쪽 번호 없음", !/counter\(page\)/.test(buildHtml(normalize({ page: { number: false }, blocks: [{ type: "para", text: "x" }] }))));
}

// ---------- 빌드 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-test-"));
  try {
    ok("build: 없는 글꼴이면 대체하지 않고 멈춤", throws(() => build({ fonts: { body: "없는글꼴체" }, blocks: [{ type: "para", text: "x" }] }, { outDir: tmp, name: "x", pdf: false }), /없는 글꼴: 없는글꼴체/) && !fs.existsSync(path.join(tmp, "x.hwpx")));
    const r = build(load("doc-basic.json"), { outDir: tmp, name: "basic", pdf: false });
    ok("build: HWPX 생성", fs.existsSync(r.hwpx) && checkHwpx(fs.readFileSync(r.hwpx)).errors.length === 0);
    const cli = spawnSync(process.execPath, [path.join(scripts, "build.mjs"), fx("doc-basic.json"), "--out", tmp, "--name", "cli", "--no-pdf"], { encoding: "utf8" });
    ok("build: 명령줄", cli.status === 0 && fs.existsSync(path.join(tmp, "cli.hwpx")), cli.stderr);
    const bad = spawnSync(process.execPath, [path.join(scripts, "build.mjs"), fx("doc-basic.json")], { encoding: "utf8" });
    ok("build: --out 없으면 1", bad.status === 1);
    const chk = spawnSync(process.execPath, [path.join(scripts, "check-hwpx.mjs"), r.hwpx], { encoding: "utf8" });
    ok("check: 명령줄 0", chk.status === 0 && /구조 오류 없음/.test(chk.stdout));
    if (findBrowser()) {
      const p = build(load("doc-basic.json"), { outDir: tmp, name: "pdf", pdf: true });
      ok("build: PDF 생성(브라우저 있음)", fs.existsSync(p.pdf) && fs.readFileSync(p.pdf).subarray(0, 5).toString() === "%PDF-");
    } else console.log("(브라우저가 없어 PDF 시험은 건너뜀)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
