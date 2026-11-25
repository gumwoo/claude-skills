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

// ---------- 2단계: 원자료 읽기 ----------
const { readSource, readSources, listing, unitIndex, decodeText } = await imp("lib/sources.mjs");
const { facts, koreanNumber, docUnits, textRules, sourceChecks, fillUnits, isLabel } = await imp("lib/checks.mjs");
const { deliverCheck } = await imp("deliver-check.mjs");
const srcFiles = [fx("src/meeting-clova.txt"), fx("src/rfp.pdf.txt")];
const SRC = readSources(srcFiles);
const IDX = unitIndex(SRC);
{
  const s1 = SRC.sources[0];
  ok("sources: 클로바노트 회의록을 발언 단위로", s1.kind === "transcript" && s1.units.filter((u) => /^S1:\d+$/.test(u.id)).length === 6);
  const u2 = IDX.get("S1:2");
  ok("sources: 발언의 화자·시각·여러 줄 내용", u2.speaker === "박책임" && u2.time === "00:21" && /6개월/.test(u2.text) && /둘째 주/.test(u2.text), JSON.stringify(u2));
  ok("sources: 첫 발언 앞 줄(제목·일시·작성자)도 조각 h1~h3", IDX.get("S1:h2")?.text.startsWith("2026.11.20") && IDX.get("S1:h3")?.text === "김주무관" && !IDX.has("S1:h4"));
  ok("sources: 클로바노트 꼬리말(clovanote.naver.com)은 발언에 붙지 않음", IDX.get("S1:6")?.text === "좋습니다. 다음 회의는 12월 4일 오후 3시에 하죠." && !/clovanote/.test(listing(SRC)));
  const plain = readSource(fx("src/meeting-clova-plain.txt"), 1);
  const pu = plain.units.filter((u) => !u.id.includes(":h"));
  ok("sources: 작성자·시간을 뺀 클로바노트도 발언 단위로(빈 줄로 나눔)", plain.kind === "transcript" && plain.units[1].text.startsWith("2026.11.27") && pu.length === 4 && pu.every((u) => u.speaker === null) && pu[2].text.includes("\n검색 결과도"), JSON.stringify(plain.units));
  ok("sources: 이름을 바꾼 화자와 '참석자 3'", IDX.get("S1:3").speaker === "김주무관" && IDX.get("S1:4").speaker === "참석자 3");
  ok("sources: 쪽 표시 텍스트(=== p.2 ===)를 쪽.문단으로", IDX.get("S2:p2.4")?.text.includes("12개월") && IDX.get("S2:p1.1")?.text.includes("제안요청서"));
  ok("sources: 목록 줄은 한 줄씩 나눔", IDX.get("S2:p2.2")?.text === "- 웹 접근성 품질인증을 받을 것");
  ok("sources: 목록에 조각 id와 화자", /S1:2 \(박책임 00:21\): 네\. 사업 기간/.test(listing(SRC)));
}
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-src-"));
const put = (name, data) => { const p = path.join(tmp2, name); fs.writeFileSync(p, data); return p; };
try {
  const t1 = readSource(put("a.txt", "00:00\n안녕하세요.\n\n00:15\n다음 안건입니다.\n"), 1);
  ok("sources: 시각만 있는 회의록(참석자 옵션 끔)", t1.kind === "transcript" && t1.units.length === 2 && t1.units[1].time === "00:15" && t1.units[1].speaker === null);
  // 클로바노트에서 작성자만 / 시간만 넣은 모양(실제 파일로는 아직 확인하지 못함): 발언 앞 줄이 "참석자 1" 또는 "00:00"
  const head = "회의\n2026.11.27 금 오전 10:05 ・ 1분\n김주무관\n\n\n";
  const foot = "\n\nclovanote.naver.com\n";
  const so = readSource(put("so.txt", head + "참석자 1\n네 시작하겠습니다.\n\n참석자 2\n네.\n\n참석자 1\n그럼 B안으로 하죠.\n둘째 줄" + foot), 1);
  ok("sources: 작성자만 넣은 클로바노트", so.units.filter((u) => u.speaker).map((u) => `${u.speaker}:${u.text}`).join("|") === "참석자 1:네 시작하겠습니다.|참석자 2:네.|참석자 1:그럼 B안으로 하죠.\n둘째 줄", JSON.stringify(so.units));
  const to = readSource(put("to.txt", head + "00:00\n네 시작하겠습니다.\n\n00:12\n네." + foot), 1);
  ok("sources: 시간만 넣은 클로바노트", to.units.filter((u) => u.time).map((u) => `${u.time}:${u.text}`).join("|") === "00:00:네 시작하겠습니다.|00:12:네." && to.units[0].id === "S1:h1", JSON.stringify(to.units));
  const t2 = readSource(put("b.txt", "회의는 10:30\n에 시작했다.\n\n둘째 문단\n"), 1);
  ok("sources: 시각이 한 번 나오는 글은 회의록으로 보지 않음", t2.kind === "text" && t2.units.length === 2);
  const md = readSource(put("c.md", "# 제목\n\n- 첫째\n- 둘째\n\n일반 문단\n이어지는 줄\n"), 1);
  ok("sources: 마크다운 문단과 목록", md.units.map((u) => u.text).join("|") === "# 제목|- 첫째|- 둘째|일반 문단\n이어지는 줄");
  ok("sources: CP949 텍스트", decodeText(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])) === "한글");
  ok("sources: UTF-16 BOM 텍스트", decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("회의", "utf16le")])) === "회의");
  ok("sources: UTF-8 BOM 제거", decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])) === "a");

  // DOCX: 가로 병합(gridSpan), 세로 병합(vMerge), 지운 글자(delText), 탭
  const tc = (inner, pr = "") => `<w:tc><w:tcPr>${pr}</w:tcPr>${inner}</w:tc>`;
  const wp = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const docXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${wp("첫 문단")}<w:p><w:r><w:t>남김</w:t></w:r><w:r><w:delText>지운 글</w:delText></w:r><w:r><w:tab/><w:t xml:space="preserve">탭 뒤</w:t></w:r></w:p>`
    + `<w:tbl><w:tr>${tc(wp("구분"), '<w:gridSpan w:val="2"/>')}${tc(wp("값"))}</w:tr><w:tr>${tc(wp("A"), '<w:vMerge w:val="restart"/>')}${tc(wp("B"))}${tc(wp("1,000원"))}</w:tr><w:tr>${tc(wp(""), "<w:vMerge/>")}${tc(wp("C"))}${tc(wp("2,000원"))}</w:tr></w:tbl>${wp("표 다음")}<w:sectPr/></w:body></w:document>`;
  const dx = readSource(put("d.docx", writeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: docXml }])), 3);
  const dm = Object.fromEntries(dx.units.map((u) => [u.id, u.text]));
  ok("sources: DOCX 문단(지운 글자 제외, 탭)", dm["S3:1"] === "첫 문단" && dm["S3:2"] === "남김\t탭 뒤" && dm["S3:3"] === "표 다음", JSON.stringify(dm));
  ok("sources: DOCX 표 칸 위치(가로·세로 병합)", dm["S3:t1.r1c1"] === "구분" && dm["S3:t1.r1c3"] === "값" && dm["S3:t1.r2c1"] === "A" && dm["S3:t1.r3c3"] === "2,000원" && !("S3:t1.r3c1" in dm), JSON.stringify(Object.keys(dm)));

  // XLSX: 공유 문자열(읽기 표시 rPh 제외), 인라인 문자열, 숫자, 날짜 서식, 논리값
  const xl = writeZip([
    { name: "xl/workbook.xml", data: `<workbook xmlns:r="r"><sheets><sheet name="견적" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/sharedStrings.xml", data: `<sst><si><t>항목</t></si><si><r><t>금</t></r><r><t>액</t></r><rPh><t>きん</t></rPh></si></sst>` },
    { name: "xl/styles.xml", data: `<styleSheet><numFmts><numFmt numFmtId="176" formatCode="yyyy&quot;년&quot; m&quot;월&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="176"/></cellXfs></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>1</v></c><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>서버</t></is></c><c r="B2"><v>1200000</v></c><c r="C2" s="1"><v>46023</v></c><c r="D2" s="2"><v>46388</v></c><c r="E2" t="b"><v>1</v></c><c r="F2"/></row></sheetData></worksheet>` },
  ]);
  const xs = readSource(put("e.xlsx", xl), 4);
  const xm = Object.fromEntries(xs.units.map((u) => [u.id, u.text]));
  ok("sources: XLSX 셀(공유·인라인 문자열, 숫자, 순서)", xs.units[0].id === "S4:견적!A1" && xm["S4:견적!B1"] === "금액" && xm["S4:견적!A2"] === "서버" && xm["S4:견적!B2"] === "1200000", JSON.stringify(xm));
  ok("sources: XLSX 날짜 서식(기본·사용자) 셀은 날짜로", xm["S4:견적!C2"] === "2026-01-01" && xm["S4:견적!D2"] === "2027-01-01" && xm["S4:견적!E2"] === "TRUE" && !("S4:견적!F2" in xm), JSON.stringify(xm));

  // HWPX: 1단계로 만든 문서를 원자료로 읽기
  const hx = readSource(put("f.hwpx", buildHwpx(normalize(load("doc-basic.json")))), 5);
  ok("sources: HWPX 문단과 표 칸(머리 칸 표시)", hx.units.some((u) => /^S5:\d+$/.test(u.id)) && hx.units.some((u) => u.id === "S5:t1.r1c1" && u.header), JSON.stringify(hx.units.slice(0, 3)));

  ok("sources: PDF는 읽지 않고 방법을 알림", throws(() => readSource(put("g.pdf", "%PDF-1.4"), 6), /=== p\.3 ===/));
  ok("sources: 바이너리 HWP는 아직 못 읽는다고 알림", throws(() => readSource(put("h.hwp", "x"), 6), /HWPX로 저장/));
  const cli = spawnSync(process.execPath, [path.join(scripts, "read-sources.mjs"), fx("src/meeting-clova.txt"), path.join(tmp2, "없음.txt"), "--out", path.join(tmp2, "out")], { encoding: "utf8" });
  ok("read-sources: 읽지 못한 파일이 있으면 1, 읽은 것은 남김", cli.status === 1 && /없음\.txt: 파일이 없습니다/.test(cli.stderr) && fs.existsSync(path.join(tmp2, "out", "sources.txt")), cli.stderr);
} finally {
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ---------- 2단계: 숫자 사실 ----------
{
  const k = (t) => facts(t).map((f) => f.key).join(" ");
  ok("facts: 한국어 금액(억·만·쉼표) 같은 값", k("1억 2,000만 원") === "q:120000000:원" && k("120,000,000원") === "q:120000000:원" && k("1.5억 원") === "q:150000000:원" && k("3백만 원") === "q:3000000:원");
  ok("facts: 4만 5천 명, 68%", k("4만 5천 명") === "q:45000:명" && k("68퍼센트") === "q:68:%");
  ok("facts: 날짜 표기 여러 가지를 같은 값으로", k("2027년 1월 5일") === "d:2027-01-05" && k("2027. 1. 5.") === "d:2027-01-05" && k("2027-01-05") === "d:2027-01-05" && k("6월 30일") === "md:06-30");
  ok("facts: 시각(오후 3시, 오후 2:00, 14:30)", k("오후 3시") === "t:15:00" && k("오후 2:00") === "t:14:00" && k("14:30") === "t:14:30" && k("오전 12:30") === "t:00:30");
  ok("facts: 식별자·목록 번호·작은 수는 대조하지 않음", k("REQ-001 항목") === "" && k("1. 사업 개요") === "" && k("2단계") === "q:2:단계");
  ok("facts: koreanNumber", koreanNumber("3억 5천만") === 350000000 && koreanNumber("1,234") === 1234);
}

// ---------- 2단계: 납품 전 검사 ----------
{
  const base = load("doc-sourced.json");
  const run = (doc, idx = IDX) => { const m = normalize(doc); const u = docUnits(m); return [...textRules(u), ...sourceChecks(u, idx)]; };
  const clean = run(base);
  ok("check: 근거를 붙인 정상 문서는 오류·경고 없음", !clean.some((f) => f.level !== "info"), JSON.stringify(clean));
  const withBlock = (b) => ({ ...base, blocks: [...base.blocks, b] });
  const has = (fs_, id, level, re) => fs_.some((f) => f.id === id && f.level === level && (!re || re.test(f.msg + " " + f.text)));
  ok("check L1: 대화체 문장", has(run(withBlock({ type: "para", text: "말씀하신 대로 일정을 정리해 드렸습니다.", src: ["S1:2"] })), "L1", "error"));
  ok("check L1: 1인칭(제가)", has(run(withBlock({ type: "para", text: "제가 보기에는 일정이 촉박하다.", src: ["S1:2"] })), "L1", "error"));
  ok("check L1: 회의록 말투(해요체) 경고", has(run(withBlock({ type: "para", text: "모바일 비율이 68%예요.", src: ["S1:4"] })), "L1", "warn", /해요체/));
  ok("check L1: '필요.'로 끝나는 개조식은 해요체로 보지 않음", !run(withBlock({ type: "list", text: "추가 인력 투입 필요.", src: ["S1:5"] })).some((f) => f.id === "L1"));
  ok("check L2: 자리표시자 {{ }}", has(run({ ...base, blocks: base.blocks.map((b, i) => (i === 2 ? { ...b, rows: [...b.rows, ["장소", "{{장소}}"]] } : b)) }), "L2", "error"));
  ok("check L2: 작성 필요 표시", has(run(withBlock({ type: "para", text: "추진 체계: 작성 필요", src: ["S1:2"] })), "L2", "error"));
  ok("check L2: '확인 필요'는 경고", has(run(withBlock({ type: "para", text: "예산 세부 내역 확인 필요", src: ["S1:3"] })), "L2", "warn"));
  ok("check F1: 2026-12-04 표기", has(run(withBlock({ type: "para", text: "차기 회의는 2026-12-04에 연다.", src: ["S1:6"] })), "F1", "warn", /온점/));
  ok("check F1: 천 단위 쉼표 빠짐", has(run(withBlock({ type: "para", text: "사업비 120000000원", src: ["S1:3"] })), "F1", "warn", /쉼표/));
  ok("check N1: 원자료에 없는 금액은 오류", has(run(withBlock({ type: "para", text: "사업비는 1억 3,000만 원이다.", src: ["S1:3"] })), "N1", "error", /1억 3,000만 원/));
  ok("check N1: 다른 조각에 있는 숫자는 src를 고치라고", has(run(withBlock({ type: "para", text: "월 방문자 45,000명", src: ["S1:3"] })), "N1", "warn", /S1:4에 있음/));
  ok("check N1: 계산식(calc)에 있는 숫자는 근거로 침", !run(base).some((f) => f.id === "N1") && has(run(withBlock({ type: "para", text: "월 평균 30,000,000원", calc: "120,000,000원 ÷ 6개월 = 20,000,000원" })), "N1", "error"));
  ok("check N1: 원자료의 '6월 30일'은 문서의 2027. 6. 30.과 같음", !run(base).some((f) => /6\. 30/.test(f.text)));
  ok("check C1: 숫자가 있는데 근거 없음은 경고", has(run(withBlock({ type: "para", text: "하자보수 12개월" })), "C1", "warn"));
  ok("check C1: 없는 조각 id는 오류", has(run(withBlock({ type: "para", text: "x", src: ["S9:1"] })), "C1", "error", /S9:1/));
  ok("check L3: 군더더기 말이 3번 이상", has(run(withBlock({ type: "para", text: "다양한 기능, 다양한 화면, 다양한 서비스", src: ["S1:5"] })), "L3", "info"));
  ok("model: src 형식 검사", throws(() => normalize({ blocks: [{ type: "para", text: "x", src: [1] }] }), /src는/) && throws(() => normalize({ pending: ["x"], blocks: [] }), /pending/));
}

// ---------- 2단계: 명령줄과 고객 문서 분리 ----------
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-check-"));
  try {
    const sj = path.join(tmp3, "sources.json");
    fs.writeFileSync(sj, JSON.stringify(SRC));
    const dc = (args) => spawnSync(process.execPath, [path.join(scripts, "deliver-check.mjs"), ...args], { encoding: "utf8" });
    const r0 = dc([fx("doc-sourced.json"), "--sources", sj, "--report", path.join(tmp3, "internal")]);
    ok("deliver-check: 정상 문서 0", r0.status === 0 && /오류 0개, 경고 0개/.test(r0.stdout), r0.stdout + r0.stderr);
    const ev = fs.readFileSync(path.join(tmp3, "internal", "근거표.md"), "utf8");
    ok("deliver-check: 근거표에 원자료 발언과 화자", /S1:3 \(meeting-clova\.txt, 김주무관 01:05\): 예산은 1억 2,000만 원/.test(ev) && /계산: 120,000,000원 ÷ 6개월/.test(ev) && !/## blocks\[2\] 2행 1열/.test(ev), ev.slice(0, 400));
    const pend = fs.readFileSync(path.join(tmp3, "internal", "미결·확인필요.md"), "utf8");
    ok("deliver-check: 미결 목록", /회의 장소: 회의록과 제안요청서에 없음/.test(pend) && fs.existsSync(path.join(tmp3, "internal", "검사결과.md")));
    const bad = { ...load("doc-sourced.json") };
    bad.blocks = [...bad.blocks, { type: "para", text: "말씀하신 사업비 1억 3,000만 원", src: ["S1:3"] }];
    fs.writeFileSync(path.join(tmp3, "bad.json"), JSON.stringify(bad));
    const r1 = dc([path.join(tmp3, "bad.json"), "--sources", sj]);
    ok("deliver-check: 오류가 있으면 2", r1.status === 2 && /\[L1/.test(r1.stdout) && /\[N1/.test(r1.stdout), r1.stdout);
    // 고객 문서에는 근거·미결·계산식이 들어가지 않는다
    const out = build(load("doc-sourced.json"), { outDir: tmp3, name: "고객", pdf: false });
    const sec = entry(fs.readFileSync(out.hwpx), "Contents/section0.xml");
    const html = fs.readFileSync(out.html, "utf8");
    ok("build: 근거 id·미결·계산식은 HWPX·HTML에 없음", !/S1:|S2:|회의 장소|÷/.test(sec) && !/S1:|S2:|회의 장소|÷/.test(html) && /120,000,000원/.test(sec));
    const rh = dc([out.hwpx, "--sources", sj]);
    ok("deliver-check: HWPX도 검사(구조·글자·숫자)", rh.status === 0 && /오류 0개/.test(rh.stdout), rh.stdout);
    const trap = build({ ...load("doc-sourced.json"), blocks: [{ type: "para", text: "장소: {{장소}}, 예산 9억 원" }] }, { outDir: tmp3, name: "함정", pdf: false });
    const rt = dc([trap.hwpx, "--sources", sj]);
    ok("deliver-check: HWPX의 자리표시자는 오류, 원자료에 없는 숫자는 경고", rt.status === 2 && /\[L2/.test(rt.stdout) && /찾지 못한 숫자: 9억 원/.test(rt.stdout), rt.stdout);
  } finally {
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
}

// ---------- 3단계: HWPX 양식 ----------
// form1-giannmun.hwpx: 「행정업무의 운영 및 혁신에 관한 규정 시행규칙」 별지 제1호서식(기안문)을 한컴 2022로 HWPX 저장한 것(마지막 저장자 지움)
// ledger.hwpx: 반복 행이 있는 대장 양식을 만들어 한컴 2022로 다시 저장한 것
const { parseTemplate, scanTemplate, fillTemplate, replaceInPara, setParaText } = await imp("lib/hwpx-template.mjs");
const FORM1 = fs.readFileSync(fx("forms/form1-giannmun.hwpx"));
const LEDGER = fs.readFileSync(fx("forms/ledger.hwpx"));
const opsOf = (f) => load(f).ops;
const sec0 = (buf) => entry(buf, "Contents/section0.xml");
{
  const d = readHwpx(FORM1);
  const t = d.blocks.find((b) => b.type === "table");
  const body = t.cells.find((c) => c.row === 2 && c.col === 0);
  ok("read: 표 안의 표 — 바깥 문단에 칸 글자가 새지 않음", d.blocks.filter((b) => b.type === "para").every((b) => !b.text.trim()), JSON.stringify(d.blocks.filter((b) => b.type === "para").map((b) => b.text.slice(0, 30))));
  ok("read: 하위 표가 있는 칸의 주소·병합은 그 칸 자신의 것", body && body.colspan === 15 && body.tables.length === 2 && body.tables[1].cells[0].text === "발신명의", JSON.stringify(t.cells.slice(0, 4).map((c) => [c.row, c.col, c.colspan])));

  const doc = parseTemplate(FORM1);
  const s = doc.sections[0];
  const p = (id) => s.paras.find((x) => x.id === id);
  ok("template: 주소(칸·칸 안 문단·하위 표)", p("T1.r2c1.p5")?.text === "제목 " && p("T1.r3c1.T2.r1c1.p1")?.text === "발신명의" && s.tables.find((x) => x.id === "T1")?.rowCnt === 11);
  const sug = scanTemplate(doc);
  const hasS = (kind, f) => sug.some((x) => x.kind === kind && f(x));
  ok("scan: 항목 이름 뒤에 적는 칸(수신·경유·제목)", ["T1.r2c1.p3", "T1.r2c1.p4", "T1.r2c1.p5"].every((at) => hasS("label-inline", (x) => x.at === at)), JSON.stringify(sug));
  ok("scan: 본문 자리, 항목 이름 옆 빈 칸, 서식 안내문", hasS("body-area", (x) => x.at === "T1.r3c1" && x.empty === 20) && hasS("label-cell", (x) => x.at === "T1.r6c2" && x.label === "협조자") && hasS("guide", (x) => x.at === "T1.r11c1.p1"));
  const lsug = scanTemplate(parseTemplate(LEDGER));
  ok("scan: 자리표시자·○○○·반복 행", lsug.some((x) => x.kind === "placeholder" && x.key === "회의명") && lsug.some((x) => x.kind === "marker" && x.find === "○○○") && lsug.some((x) => x.kind === "repeat-rows" && x.table === "T1" && x.from_row === 2 && x.count === 4), JSON.stringify(lsug));
}
{
  const r = fillTemplate(FORM1, opsOf("forms/fill-form1.json"));
  const lines = textLines(readHwpx(r.buf));
  const sx = sec0(r.buf), orig = sec0(FORM1);
  ok("fill: 값이 들어가고 바꾼 자리표시 글자는 사라짐", ["한빛시립도서관", "수신  내부결재", "제목  도서관 누리집 개편 사업 착수 보고", "  나. 사업비: 120,000,000원(부가세 포함)", "한빛시립도서관장", "전화번호(031)123-4567"].every((l) => lines.includes(l)) && !lines.some((l) => /행 정 기 관 명|발신명의|도로명주소/.test(l)), JSON.stringify(lines.slice(0, 12)));
  ok("fill: 서식 안내 행·머리 줄을 지우고 행 수 갱신", !/별지 제1호서식|이 난은 서식에/.test(sx) && /rowCnt="8"/.test(sx));
  ok("fill: 구조 검사 통과, header.xml·mimetype 그대로", checkHwpx(r.buf).errors.length === 0 && entry(r.buf, "Contents/header.xml") === entry(FORM1, "Contents/header.xml") && readZip(r.buf)[0].name === "mimetype" && readZip(r.buf)[0].method === 0);
  const paraOf = (xml, text) => { const i = xml.indexOf(text); return xml.slice(xml.lastIndexOf("<hp:p ", i), xml.indexOf("</hp:p>", i) + 7); };
  ok("fill: 바꾼 문단만 줄 배치 정보(linesegarray)를 지움", !/linesegarray/.test(paraOf(sx, "한빛시립도서관</hp:t>")) && /linesegarray/.test(paraOf(sx, "협조자")), paraOf(sx, "한빛시립도서관</hp:t>").slice(0, 200));
  const prOf = (xml, text) => paraOf(xml, text).match(/paraPrIDRef="(\d+)"/)[1];
  ok("fill: like로 다른 문단 모양을 빌림(본문 = 제목 줄 모양)", prOf(sx, "1. 관련:") === prOf(sx, "제목  도서관") && prOf(orig, "제목 </hp:t>") === prOf(sx, "제목  도서관"));
  // 하위 표(직인 상자)가 든 문단에 like를 써도 하위 표 안 글자 모양은 그대로
  const lk = sec0(fillTemplate(FORM1, [{ at: "T1.r3c1.p21", text: "가", like: "T1.r2c1.p5" }]).buf);
  const charOf = (xml, text) => paraOf(xml, text).match(/charPrIDRef="(\d+)"/)[1];
  const styleCharOf = (xml) => charOf(xml, "제목 </hp:t>");
  ok("fill: like는 문단 안 하위 표(직인)의 모양을 바꾸지 않음", charOf(lk, ">직인<") === charOf(orig, ">직인<") && charOf(orig, ">직인<") !== styleCharOf(orig), `${charOf(lk, ">직인<")} ${charOf(orig, ">직인<")}`);
  ok("fill: 많이 길어진 글자는 기록에 경고", r.log.some((l) => /"발신명의" 바꿈 — 원래보다 4자 길어짐/.test(l)) && r.log.some((l) => l === 'T1.r4c1 "직위(직급) 서명" 바꿈'), r.log.join("\n"));
}
{
  const r = fillTemplate(LEDGER, opsOf("forms/fill-ledger.json"));
  const t = readHwpx(r.buf).blocks.find((b) => b.type === "table");
  const rowText = (k) => t.cells.filter((c) => c.row === k).map((c) => c.text).join("|");
  ok("fill: 반복 행 — 빈 행 4개를 채우고 2행을 더함", t.rowCnt === 8 && rowText(1) === "1|착수 보고 일정 확정|박책임|2027. 1. 15." && rowText(6) === "6|하자보수 기간 계약서 반영|김주무관|2027. 1. 10.", JSON.stringify([t.rowCnt, rowText(6)]));
  ok("fill: 합계 행은 아래로 밀리고 행 주소가 차례대로", rowText(7) === "합계|6건" && [...new Set(t.cells.map((c) => c.row))].join(",") === "0,1,2,3,4,5,6,7");
  ok("fill: 자리표시자·○○○ 바꿈", textLines(readHwpx(r.buf)).includes("회의명: 도서관 누리집 개편 착수 회의") && textLines(readHwpx(r.buf)).includes("작성자: 김주무관"));
  const few = fillTemplate(LEDGER, [{ table: "T1", from_row: 2, rows: [["1", "a", "b", "c"]] }]);
  const ft = readHwpx(few.buf).blocks.find((b) => b.type === "table");
  ok("fill: 행이 남으면 그대로 두고 행 수 유지", ft.rowCnt === 6 && ft.cells.filter((c) => c.row === 5).map((c) => c.text).join("|") === "합계|");
}
{
  // 글자가 run 두 개에 나뉜 경우, 탭이 섞인 경우
  const p = '<hp:p id="0" paraPrIDRef="1" styleIDRef="0"><hp:run charPrIDRef="3"><hp:t>제</hp:t></hp:run><hp:run charPrIDRef="4"><hp:t>목 끝</hp:t></hp:run><hp:linesegarray><hp:lineseg/></hp:linesegarray></hp:p>';
  const r = replaceInPara(p, "제목", "보고서");
  ok("fill: run에 나뉜 글자 바꾸기(첫 run 모양을 따름)", r.count === 1 && r.xml.includes('<hp:run charPrIDRef="3"><hp:t>보고서</hp:t></hp:run><hp:run charPrIDRef="4"><hp:t> 끝</hp:t></hp:run>') && !r.xml.includes("linesegarray"), r.xml);
  ok("fill: 탭이 섞인 글자는 바꾸지 않고 알림", throws(() => replaceInPara('<hp:p id="0"><hp:run charPrIDRef="1"><hp:t>가<hp:tab width="10"/>나</hp:t></hp:run></hp:p>', "가\t나", "x"), /탭·줄바꿈/));
  ok("fill: 빈 run 문단에 글자 넣기", setParaText('<hp:p id="0" paraPrIDRef="1"><hp:run charPrIDRef="7"/></hp:p>', "a<b") === '<hp:p id="0" paraPrIDRef="1"><hp:run charPrIDRef="7"><hp:t>a&lt;b</hp:t></hp:run></hp:p>');
  ok("fill: 없는 주소·없는 글자·여러 번 있는 글자는 멈춤", throws(() => fillTemplate(FORM1, [{ at: "T9.r1c1", text: "x" }]), /주소를 찾지 못했습니다: T9\.r1c1/) && throws(() => fillTemplate(FORM1, [{ at: "T1.r2c1", find: "없는 글자", text: "x" }]), /찾지 못했습니다/) && throws(() => fillTemplate(FORM1, [{ at: "T1.r5c1.p1", find: " ", text: "x" }]), /번 있습니다/));
  const span = buildHwpx(normalize({ blocks: [{ type: "table", rows: [["가", { text: "나", rowspan: 2 }], ["다"]] }] }));
  ok("fill: 세로 병합이 걸친 행은 지우지 않음", throws(() => fillTemplate(span, [{ delete_row: "T1.r2" }]), /세로로 병합/));
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-tmpl-"));
  try {
    const sc = spawnSync(process.execPath, [path.join(scripts, "scan-template.mjs"), fx("forms/form1-giannmun.hwpx")], { encoding: "utf8" });
    ok("scan-template: 명령줄", sc.status === 0 && /T1\.r3c1\.p1~p20: \(빈 문단 20개\)/.test(sc.stdout) && /본문 자리/.test(sc.stdout), sc.stderr);
    const out = path.join(tmp4, "채움.hwpx");
    const fl = spawnSync(process.execPath, [path.join(scripts, "fill-template.mjs"), fx("forms/ledger.hwpx"), fx("forms/fill-ledger.json"), "--out", out], { encoding: "utf8" });
    ok("fill-template: 명령줄 0, 결과 파일", fl.status === 0 && fs.existsSync(out) && /구조 오류 없음/.test(fl.stdout), fl.stdout + fl.stderr);
    const same = spawnSync(process.execPath, [path.join(scripts, "fill-template.mjs"), out, fx("forms/fill-ledger.json"), "--out", out], { encoding: "utf8" });
    ok("fill-template: 양식 파일을 덮어쓰지 않음", same.status === 1 && /덮어쓰지 않습니다/.test(same.stderr));
    const dc = spawnSync(process.execPath, [path.join(scripts, "deliver-check.mjs"), out], { encoding: "utf8" });
    ok("deliver-check: 채운 양식도 검사(오류 없음)", dc.status === 0, dc.stdout);
    // fill.json도 근거와 대조: 본문은 회의록 조각과 맞고, 근거 없는 시행일 숫자는 경고
    const sj = path.join(tmp4, "sources.json");
    fs.writeFileSync(sj, JSON.stringify(SRC));
    const fc = spawnSync(process.execPath, [path.join(scripts, "deliver-check.mjs"), fx("forms/fill-form1.json"), "--sources", sj, "--report", path.join(tmp4, "internal")], { encoding: "utf8" });
    ok("deliver-check: fill.json 검사(본문 숫자는 근거와 맞음, 근거 없는 숫자는 경고)", fc.status === 0 && /오류 0개/.test(fc.stdout) && /ops\[9\] T1\.r6c2: 근거\(src\) 없음 — 숫자가 있는 내용/.test(fc.stdout) && !/ops\[6\][^\n]*N1|N1[^\n]*ops\[6\]/.test(fc.stdout), fc.stdout);
    const ev = fs.readFileSync(path.join(tmp4, "internal", "근거표.md"), "utf8");
    ok("deliver-check: 양식 채우기 근거표·미결 목록", /## ops\[6\] T1\.r2c1/.test(ev) && /S1:3 \(meeting-clova\.txt, 김주무관 01:05\)/.test(ev) && /검토자·결재권자: 회의록에 없음/.test(fs.readFileSync(path.join(tmp4, "internal", "미결·확인필요.md"), "utf8")));
  } finally {
    fs.rmSync(tmp4, { recursive: true, force: true });
  }
}

// ---------- 두 번째 검증에서 나온 경우(양식은 한컴 2022로 저장한 변형) ----------
{
  const V = (n) => fs.readFileSync(fx(`forms/variants/${n}.hwpx`));
  const paras = (buf) => readHwpx(buf).blocks.filter((b) => b.type === "para" && b.text.trim()).map((b) => (b.sub ? `${b.sub}:` : "") + b.text);
  const hdr = fillTemplate(V("ledger-header"), [{ at: "P1", text: "새 제목" }]);
  ok("검증2: 머리말이 든 문단에 값을 넣어도 머리말은 그대로", JSON.stringify(paras(hdr.buf).slice(0, 2)) === JSON.stringify(["새 제목", "header:한빛시 내부 문서"]), JSON.stringify(paras(hdr.buf)));
  ok("검증2: 머리말 글자는 본문 문단 글자에 붙지 않음(읽기·양식 지도)", paras(V("ledger-header"))[0] === "회의 결과 조치 관리대장" && parseTemplate(V("ledger-header")).sections[0].paras[0].text === "회의 결과 조치 관리대장");
  const box = fillTemplate(V("ledger-textbox"), [{ at: "P2", find: "{{회의명}}", text: "착수 회의" }]);
  ok("검증2: 글상자가 든 문단도 자기 글자만 바뀜", paras(box.buf).includes("회의명: 착수 회의") && paras(box.buf).includes("drawText:접수번호"), JSON.stringify(paras(box.buf)));
  const tab = fillTemplate(V("ledger-tab"), [{ at: "P2", find: "{{회의명}}", text: "착수 회의" }]);
  ok("검증2: 한컴이 hp:t 안에 둔 탭 옆 자리표시자도 바꿈(탭 유지)", /<hp:t>회의명:<hp:tab [^>]*\/>착수 회의<\/hp:t>/.test(sec0(tab.buf)) && paras(tab.buf).includes("회의명:\t착수 회의"));
  ok("검증2: hp:t 안의 탭·줄바꿈을 읽음", readHwpx(V("ledger-tab")).blocks.some((b) => b.text === "회의명:\t{{회의명}}"));
  const tot = fillTemplate(V("ledger-total-same-shape"), [{ table: "T1", from_row: 2, rows: [1, 2, 3, 4, 5, 6].map((n) => [String(n), "a", "b", "c"]) }]);
  const tt = readHwpx(tot.buf).blocks.find((b) => b.type === "table");
  ok("검증2: 반복 행 채우기가 같은 모양의 합계 행을 덮어쓰지 않음", tt.rowCnt === 8 && tt.cells.filter((c) => c.row === 7).map((c) => c.text).join("|") === "합계|||", JSON.stringify([tt.rowCnt, tt.cells.filter((c) => c.row === 7).map((c) => c.text)]));
  ok("검증2: 위에서 세로 병합된 칸이 걸친 행은 반복 행으로 쓰지 않음(scan·fill)", !scanTemplate(parseTemplate(V("ledger-vmerge-above"))).some((x) => x.kind === "repeat-rows" && x.from_row <= 5) && throws(() => fillTemplate(V("ledger-vmerge-above"), [{ table: "T1", from_row: 3, rows: [["a", "b", "c"]] }]), /위 행에서 세로로 병합/));
  const p1 = fillTemplate(LEDGER, [{ at: "P1", text: "제목1\n제목2" }]);
  ok("검증2: 첫 문단에 여러 줄을 넣어도 구역 설정을 복제하지 않음", (sec0(p1.buf).match(/<hp:secPr\b/g) ?? []).length === 1 && paras(p1.buf).slice(0, 2).join("|") === "제목1|제목2");
  const body = fillTemplate(FORM1, [{ at: "T1.r3c1", text: Array.from({ length: 23 }, (_, i) => `본문 ${i + 1}줄`).join("\n") }]);
  const bc = readHwpx(body.buf).blocks.find((b) => b.type === "table").cells.find((c) => c.row === 2);
  const bl = bc.text.split("\n");
  ok("검증2: 본문 칸이 넘쳐도 직인·발신명의 상자 앞에 줄을 더함", bl.indexOf("본문 23줄") === 22 && bl.slice(23).every((l) => !l.trim()) && bc.tables.length === 2, JSON.stringify(bl.slice(18)));
  const nl = fillTemplate(LEDGER, [{ at: "P2", find: "{{회의명}}", text: "첫줄\n둘째줄" }]);
  ok("검증2: find로 넣는 글자의 줄바꿈은 <hp:lineBreak/>", sec0(nl.buf).includes("회의명: 첫줄<hp:lineBreak/>둘째줄") && paras(nl.buf).includes("회의명: 첫줄\n둘째줄"));
  const dol = fillTemplate(LEDGER, [{ at: "T1.r2c2", text: "R$&D 예산 $' US$$ 100" }, { at: "P2", find: "{{회의명}}", text: "$1 $& 회의" }]);
  ok("검증2: 값의 $&·$'·$$를 그대로 넣음", textLines(readHwpx(dol.buf)).includes("R$&D 예산 $' US$$ 100") && textLines(readHwpx(dol.buf)).includes("회의명: $1 $& 회의") && checkHwpx(dol.buf).errors.length === 0);
  ok("검증2: find가 글자가 아니면 바로 멈춤", throws(() => fillTemplate(FORM1, [{ at: "T1.r1c1", find: 2016, text: "2026" }]), /find는 비어 있지 않은 글자/));
  const pv = entry(fillTemplate(LEDGER, opsOf("forms/fill-ledger.json")).buf, "Preview/PrvText.txt");
  ok("검증2: 미리보기 글도 채운 내용으로", /회의명: 도서관 누리집 개편 착수 회의\r\n/.test(pv) && /<1><착수 보고 일정 확정><박책임><2027\. 1\. 15\.>/.test(pv) && !/\{\{/.test(pv), pv.slice(0, 120));
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-v2-"));
  try {
    const up = path.join(tmp5, "Ledger.hwpx");
    fs.copyFileSync(fx("forms/ledger.hwpx"), up);
    const r = spawnSync(process.execPath, [path.join(scripts, "fill-template.mjs"), up, fx("forms/fill-ledger.json"), "--out", path.join(tmp5, "ledger.hwpx")], { encoding: "utf8" });
    ok("검증2: 대소문자만 다른 결과 경로로 양식을 덮어쓰지 않음(Windows·macOS)", process.platform === "linux" || (r.status === 1 && fs.readFileSync(up).equals(LEDGER)), r.stdout + r.stderr);
  } finally {
    fs.rmSync(tmp5, { recursive: true, force: true });
  }
  // 읽기·검사
  const k = (t) => facts(t).map((f) => f.key).join(" ");
  ok("검증2: 제출 부수·식 수는 대조, '붙임 … 1부'만 건너뜀", k("제안서 7부, 서버 5식") === "q:7:부 q:5:식" && k("붙임  회의 결과 1부.  끝.") === "");
  const schedFile = path.join(os.tmpdir(), `hd-sched-${process.pid}.txt`);
  fs.writeFileSync(schedFile, "착수 회의 일정\n\n개회 14:00\n사업 개요 보고 14:10\n질의응답 15:00\n\n장소: 3층 회의실\n");
  const sched = readSource(schedFile, 1);
  fs.rmSync(schedFile, { force: true });
  ok("검증2: 시각이 붙은 일정표는 회의록으로 보지 않음", sched.kind === "text" && sched.units.some((u) => u.text.includes("개회 14:00")), JSON.stringify(sched.units));
  ok("검증2: row_src를 문자열로 주면 형식 오류", throws(() => fillUnits([{ table: "T1", rows: [["가"]], row_src: "S1:3" }]), /row_src는 행마다/));
  ok("검증2: 반복 행에 넣은 짧은 값도 검사·근거표 대상", fillUnits(opsOf("forms/fill-ledger.json")).filter((u) => u.text === "박책임").every((u) => !isLabel(u)));
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-v2b-"));
  try {
    const w = (n, j) => { const p = path.join(tmp6, n); fs.writeFileSync(p, JSON.stringify(j)); return p; };
    const dc = (args) => spawnSync(process.execPath, [path.join(scripts, "deliver-check.mjs"), ...args], { encoding: "utf8" });
    ok("검증2: fill.json의 pending 형식도 검사", dc([w("a.json", { pending: ["검토자 미정"], ops: [{ at: "P1", text: "x" }] })]).status === 1);
    const r2 = dc([w("b.json", { pending: [{ item: "x", src: "S1:3" }], ops: [{ at: "P1", text: "x 120,000원", src: ["S1:3"] }] }), "--report", path.join(tmp6, "r")]);
    const pend = fs.readFileSync(path.join(tmp6, "r", "미결·확인필요.md"), "utf8");
    ok("검증2: pending src가 문자열이어도 미결 목록을 씀, 원자료 없이 낸 보고는 그렇게 적음", r2.status === 0 && /- x \(S1:3\)/.test(pend) && /--sources\)을 받지 않아/.test(pend) && /원자료 목록을 받지 않아 대조하지 않음/.test(fs.readFileSync(path.join(tmp6, "r", "근거표.md"), "utf8")), r2.stderr + pend);
    ok("검증2: ops 배열만 있는 fill.json도 검사", dc([w("c.json", [{ at: "P1", text: "말씀하신 내용" }])]).status === 2);
  } finally {
    fs.rmSync(tmp6, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
