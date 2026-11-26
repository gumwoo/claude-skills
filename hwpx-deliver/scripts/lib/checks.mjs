// 납품 전 검사. 고객 문서에 섞이면 안 되는 문장, 공문서 표기, 원자료와 숫자 대조, 근거 표시를 본다.
// 규칙이 판정하는 것은 "의심"이다. 오탐이면 문서를 억지로 바꾸지 말고 보고에 그대로 남긴다.
//
// 결과 항목: { id, level: "error"|"warn"|"info", where, msg, text }
//   L1 대화·설명형 문장   L2 자리표시자·내부 메모   L3 군더더기·AI 티 나는 표현
//   F1 공문서 표기        N1 원자료와 숫자 대조      C1 근거 표시
import { plainText } from "./model.mjs";

const snippet = (t, n = 50) => (t.length > n ? t.slice(0, n) + "…" : t).replace(/\n/g, " / ");

// 문서 모델 → 검사할 글 조각. 표는 칸마다(머리 행 표시)
export function docUnits(m) {
  const out = [];
  m.blocks.forEach((b, i) => {
    if (b.type === "pagebreak") return;
    if (b.type !== "table") { out.push({ where: `blocks[${i}]`, kind: b.type, text: plainText(b.runs), src: b.src, calc: b.calc }); return; }
    for (const c of b.cells) out.push({ where: `blocks[${i}] ${c.row + 1}행 ${c.col + 1}열`, kind: "cell", header: c.row < b.header_rows, text: plainText(c.runs), src: c.src ?? b.src, calc: c.calc ?? b.calc });
  });
  return out;
}

// HWPX(양식을 채운 문서 등) → 검사할 글 조각
export function hwpxUnits(doc) {
  const out = [];
  let p = 0, t = 0;
  for (const b of doc.blocks) {
    if (b.type === "para") { if (b.text.trim()) out.push({ where: `문단 ${++p}`, kind: "para", text: b.text }); continue; }
    t++;
    const walk = (tbl, label) => tbl.cells.forEach((c) => {
      if (c.text.trim()) out.push({ where: `${label} ${c.row + 1}행 ${c.col + 1}열`, kind: "cell", header: c.header, text: c.text });
      c.tables.forEach((x, k) => walk(x, `${label} ${c.row + 1}행 ${c.col + 1}열 안 표${k + 1}`));
    });
    walk(b, `표 ${t}`);
  }
  return out;
}

// 양식 채우기(fill.json의 ops) → 검사할 글 조각. 반복 행은 칸마다. 행별 근거는 row_src, 아니면 op의 src
export function fillUnits(ops) {
  const out = [];
  const arr = (x) => (x == null ? undefined : Array.isArray(x) ? x : [x]);
  ops.forEach((op, i) => {
    if (op.row_src != null && !(Array.isArray(op.row_src) && op.row_src.every((x) => x == null || typeof x === "string" || Array.isArray(x)))) throw new Error(`ops[${i}]: row_src는 행마다 조각 id 배열이어야 합니다(예: [["S1:3"], ["S1:4"]]). 모든 행에 같은 근거면 src를 쓰세요`);
    if (Array.isArray(op.rows)) {
      op.rows.forEach((row, r) => (row ?? []).forEach((v, c) => {
        if (v != null && String(v).trim()) out.push({ where: `ops[${i}] ${op.table} ${Number(op.from_row ?? 1) + r}행 ${c + 1}열`, kind: "value", text: String(v), src: arr(op.row_src?.[r]) ?? arr(op.src), calc: op.calc });
      }));
    } else if (op.text != null && String(op.text).trim()) out.push({ where: `ops[${i}] ${op.at}`, kind: "para", text: String(op.text), src: arr(op.src), calc: op.calc });
  });
  return out;
}

// ---------- L1·L2·L3·F1: 글자 규칙 ----------
const RULES = [
  // L1 대화·설명형: 대화에서 고객 문서로 흘러든 문장
  ["L1", "error", /말씀(하신|드린|드리|해 ?주신)/, "대화체(말씀하신·말씀드린)"],
  ["L1", "error", /(요청|문의|원)하신/, "대화 상대를 가리키는 높임(요청하신 등)"],
  ["L1", "error", /(정리|작성|요약|준비)해 ?드(렸|립|릴)/, "대화체(정리해 드렸습니다 등)"],
  ["L1", "error", /도움이 되(셨|었)으면|궁금하신|편하게 (말씀|알려)/, "대화체"],
  ["L1", "error", /(^|[\s(])(제가|저는|제 생각)(?=[\s,])/, "1인칭(제가·저는): 문서 작성 주체로 바꾼다(당사, 수행기관 등)"],
  ["L1", "warn", /(^|[\s(])저희(가|는|의)?(?=[\s,])/, "1인칭(저희): 제안서라면 당사·수행사 등으로"],
  ["L1", "warn", /(이|본) (보고서|문서|자료|표)는 .{0,40}(바탕으로|토대로|참고하여) .{0,20}(정리|요약|작성)/, "문서를 만든 과정을 설명하는 문장"],
  ["L1", "warn", /(어요|아요|해요|예요|이에요|에요|네요|거든요|는데요|세요|군요|래요|대요|게요|까요|죠)[.!?]?(?=\s|$)/, "해요체·구어 끝맺음"],
  ["L1", "warn", /(^|\s)(근데|그니까|그러니까요|뭐랄까|되게|진짜|완전히?)(?=\s)/, "구어 표현(회의록 말투)"],
  // L2 자리표시자·내부 메모
  ["L2", "error", /\{\{|\}\}/, "자리표시자 {{ }}"],
  ["L2", "error", /○○|ㅇㅇ|△△|(?<![A-Za-z])(OO|XX)(?=[가-힣\s]|$)/, "자리표시 문자(○○, OO, XX)"],
  ["L2", "error", /(?<![A-Za-z])(TODO|TBD|FIXME)(?![A-Za-z])|\?\?\?/, "작업 메모(TODO 등)"],
  ["L2", "error", /(작성|입력|기재|보완) ?(필요|요망)|추후 ?(작성|기재|보완)|내용 ?추가 ?예정/, "작성 안 된 칸 표시"],
  ["L2", "warn", /(확인|검토) ?(필요|요망)|확인 ?바랍니다/, "내부 확인 메모처럼 읽힘(내용이 정말 '검토 필요'라면 그대로 둔다)"],
  ["L2", "error", /lorem ipsum|샘플 ?텍스트|예시 ?문구|텍스트를 입력/i, "예시 문구"],
  ["L2", "warn", /\(\s*\)|\[\s*\]|【\s*】/, "빈 괄호"],
  // L3
  ["L3", "warn", /되어지|되어졌|되어집/, "이중 피동(되어지다 → 되다)"],
  ["L3", "warn", /\p{Extended_Pictographic}/u, "이모지"],
  ["L3", "warn", /!/, "느낌표"],
  // F1 공문서 표기(「행정업무의 운영 및 혁신에 관한 규정」 제7조제5항, 시행규칙 제2조)
  ["F1", "warn", /(?<!\d)(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}(?!\d)/, "날짜는 온점으로(2026. 11. 25.)"],
  ["F1", "warn", /(?<![\d.])(19|20)\d{2}\.\s?\d{1,2}\.\s?\d{1,2}(?![\d.])/, "날짜 끝 온점 빠짐(2026. 11. 25.)"],
  ["F1", "info", /(19|20)\d{2}년\s*\d{1,2}월\s*\d{1,2}일/, "공문서 날짜는 연·월·일 글자 대신 온점(2026. 11. 25.). 보고서 관례라면 그대로"],
  ["F1", "info", /(오전|오후)\s*\d{1,2}시|\d{1,2}시\s*\d{1,2}분/, "공문서 시각은 24시각제와 쌍점(14:30)"],
  ["F1", "warn", /(?<![\d,.])\d{4,}(?=\s*(원|천 ?원|만 ?원|명|건|개))/, "천 단위 쉼표 빠짐"],
];

// 문서 전체에서 3번 이상 나오면 알리는 말(하나씩은 문제가 아니다)
const OVERUSE = ["혁신적", "획기적", "극대화", "시너지", "원활한", "다양한", "효과적으로", "체계적으로", "할 수 있습니다"];

export function textRules(units) {
  const out = [];
  for (const u of units) {
    for (const [id, level, re, msg] of RULES) {
      const m = u.text.match(re);
      if (m) out.push({ id, level, where: u.where, msg, text: snippet(u.text.slice(Math.max(0, m.index - 15)), 60) });
    }
  }
  const all = units.map((u) => u.text).join("\n");
  for (const w of OVERUSE) {
    const n = all.split(w).length - 1;
    if (n >= 3) out.push({ id: "L3", level: "info", where: "문서 전체", msg: `"${w}" ${n}번: 빼도 뜻이 같은 곳은 지운다`, text: w });
  }
  return out;
}

// ---------- N1: 숫자 사실 뽑기 ----------
// 한국어 수 표현의 값: "1억 2,000만" → 120000000, "3백만" → 3000000, "1.5억" → 150000000
export function koreanNumber(s) {
  const toks = s.replace(/,/g, "").match(/\d+(?:\.\d+)?|[조억만천백]/g) ?? [];
  let total = 0, section = 0, n = null;
  const big = { 조: 1e12, 억: 1e8, 만: 1e4 }, small = { 천: 1e3, 백: 1e2 };
  for (const t of toks) {
    if (/\d/.test(t)) n = Number(t);
    else if (small[t]) { section += (n ?? 1) * small[t]; n = null; }
    else { total += (section + (n ?? 0) || 1) * big[t]; section = 0; n = null; }
  }
  return Math.round((total + section + (n ?? 0)) * 1e6) / 1e6;
}

const UNIT_ALIAS = { 퍼센트: "%", 프로: "%", "％": "%", 페이지: "쪽" };
const UNITS = "원|명|건|개월|개소|개|%|％|퍼센트|일|년|주|회|대|식|시간|분|초|배|차|곳|부|권|쪽|페이지|GB|TB|MB|Mbps|Gbps|㎡|km|kg|톤|가구|세대|종|단계|점";
const QTY = new RegExp(`(?<![A-Za-z0-9_\\-/.:#])(\\d[\\d,]*(?:\\.\\d+)?(?:\\s*[조억만천백])*(?:\\s+\\d[\\d,]*(?:\\.\\d+)?(?:\\s*[조억만천백])+)*)(?:\\s*(${UNITS}))?`, "g");
const DATE_YMD = /(?<!\d)((?:19|20)\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?!\d)\s*일?\.?/g;
// 연월: "2027년 1월", "2027. 1."(공문서 표기, 뒤에 날짜가 이어지지 않을 때). 실사용 시험에서 "2027. 1. 둘째 주"를 숫자 2027로 읽은 오탐이 있었다
const DATE_YM = /(?<!\d)((?:19|20)\d{2})\s*[.년]\s*(\d{1,2})\s*(?:월|\.)?(?!\s*\d)/g;
const DATE_MD = /(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
const TIME_AMPM = /(오전|오후)\s*(\d{1,2}):([0-5]\d)(?!\d)/g;
const TIME = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;
const TIME_KO = /(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분|\s*반)?/g;

// 글 → 숫자 사실 목록. key가 같으면 같은 사실로 본다
export function facts(text) {
  const out = [];
  let rest = text;
  const cut = (re, f) => { rest = rest.replace(re, (...m) => { const r = f(m); if (r) out.push({ ...r, raw: m[0].trim() }); return " ".repeat(m[0].length); }); };
  const p2 = (x) => String(Number(x)).padStart(2, "0");
  cut(DATE_YMD, (m) => ({ key: `d:${m[1]}-${p2(m[2])}-${p2(m[3])}`, kind: "date" }));
  cut(DATE_MD, (m) => ({ key: `md:${p2(m[1])}-${p2(m[2])}`, kind: "date" }));
  cut(DATE_YM, (m) => (Number(m[2]) >= 1 && Number(m[2]) <= 12 ? { key: `ym:${m[1]}-${p2(m[2])}`, kind: "date" } : null));
  cut(TIME_AMPM, (m) => { let h = Number(m[2]); if (h > 12) return null; if (m[1] === "오후" && h < 12) h += 12; if (m[1] === "오전" && h === 12) h = 0; return { key: `t:${p2(h)}:${m[3]}`, kind: "time" }; });
  cut(TIME, (m) => ({ key: `t:${p2(m[1])}:${m[2]}`, kind: "time" }));
  cut(TIME_KO, (m) => { let h = Number(m[2]); if (h > 24) return null; if (m[1] === "오후" && h < 12) h += 12; return { key: `t:${p2(h)}:${m[0].includes("반") ? "30" : p2(m[3] ?? 0)}`, kind: "time" }; });
  for (const m of rest.matchAll(QTY)) {
    const value = koreanNumber(m[1]);
    const unit = m[2] ? (UNIT_ALIAS[m[2]] ?? m[2]) : "";
    // 단위 없는 작은 수(목록 번호, "1단계"의 1 등)는 대조하지 않는다
    if (!unit && value < 100 && !/,/.test(m[1])) continue;
    // 공문 끝의 "붙임 … 1부"는 문서 관례라 대조하지 않는다(제출 부수 같은 다른 "부"는 대조한다)
    if (unit === "부" && /붙임/.test(rest.slice(0, m.index).split("\n").pop())) continue;
    out.push({ key: `q:${value}:${unit}`, value, unit, kind: "qty", raw: m[0].trim() });
  }
  return out;
}

// 문서의 사실이 원자료 사실 목록에 있는지: 날짜는 연도를 뺀 원자료 표기(11월 25일)도 받고, 단위가 없는 쪽은 값만 본다
function matches(f, pool) {
  if (pool.has(f.key)) return true;
  if (f.key.startsWith("d:")) { const [, , m, d] = f.key.match(/^d:(\d+)-(\d+)-(\d+)$/); return pool.has(`md:${m}-${d}`); }
  if (f.key.startsWith("ym:")) { for (const k of pool) if (k.startsWith(`d:${f.key.slice(3)}-`)) return true; return false; }
  // 연도만 쓴 경우("2027년 상반기"): 원자료에 같은 해의 날짜나 연월이 있으면 근거로 친다
  if (f.kind === "qty" && f.unit === "년" && f.value >= 1900 && f.value < 2100) { for (const k of pool) if (k.startsWith(`d:${f.value}-`) || k.startsWith(`ym:${f.value}-`)) return true; }
  if (f.kind === "qty") for (const k of pool) { const [, v, u] = k.split(":"); if (Number(v) === f.value && (!u || !f.unit)) return true; }
  return false;
}

// ---------- N1·C1: 원자료 대조 ----------
// 근거가 없어도 되는 조각: 제목, 표 머리 행, 숫자 없는 짧은 표 칸(일시·참석자 같은 항목 이름)
export const isLabel = (u) => u.kind === "title" || u.kind === "heading" || u.header || (u.kind === "cell" && u.text.trim().length <= 12 && !facts(u.text).length);

export function sourceChecks(units, index, { requireSrc = true } = {}) {
  const out = [];
  const factsOf = new Map();
  const unitFacts = (id) => { if (!factsOf.has(id)) factsOf.set(id, new Set(facts(index.get(id).text).map((f) => f.key))); return factsOf.get(id); };
  const allPool = new Set();
  for (const id of index.keys()) for (const k of unitFacts(id)) allPool.add(k);
  const where = (k) => [...index.keys()].filter((id) => matches({ key: k, ...parseKey(k) }, unitFacts(id))).slice(0, 3);
  for (const u of units) {
    const fs = facts(u.text);
    const bad = (u.src ?? []).filter((id) => !index.has(id));
    if (bad.length) out.push({ id: "C1", level: "error", where: u.where, msg: `없는 조각 id: ${bad.join(", ")}`, text: snippet(u.text) });
    const cited = (u.src ?? []).filter((id) => index.has(id));
    const content = !isLabel(u) && u.text.trim();
    if (requireSrc && content && !cited.length && !u.calc) out.push({ id: "C1", level: fs.length ? "warn" : "info", where: u.where, msg: fs.length ? "근거(src) 없음 — 숫자가 있는 내용" : "근거(src) 없음", text: snippet(u.text) });
    if (!fs.length) continue;
    const pool = new Set(cited.flatMap((id) => [...unitFacts(id)]));
    const calc = new Set(u.calc ? facts(u.calc).map((f) => f.key) : []);
    for (const f of fs) {
      if (matches(f, pool) || matches(f, calc)) continue;
      if (!cited.length && !requireSrc) {
        if (!matches(f, allPool)) out.push({ id: "N1", level: "warn", where: u.where, msg: `원자료에서 찾지 못한 숫자: ${f.raw}`, text: snippet(u.text) });
        continue;
      }
      if (!cited.length && u.calc) { out.push({ id: "N1", level: "error", where: u.where, msg: `계산식(calc)에 없는 숫자 ${f.raw}`, text: snippet(u.text) }); continue; }
      if (!cited.length) continue; // 근거 없음은 C1이 알린다
      const elsewhere = where(f.key).filter((id) => !cited.includes(id));
      if (elsewhere.length) out.push({ id: "N1", level: "warn", where: u.where, msg: `인용한 조각(${cited.join(", ")})에 없는 숫자 ${f.raw} — ${elsewhere.join(", ")}에 있음(src를 고친다)`, text: snippet(u.text) });
      else if (matches(f, allPool)) out.push({ id: "N1", level: "warn", where: u.where, msg: `인용한 조각에 없는 숫자 ${f.raw} — 다른 표기로 원자료에 있음`, text: snippet(u.text) });
      else out.push({ id: "N1", level: "error", where: u.where, msg: `원자료에 없는 숫자 ${f.raw}${u.calc ? "" : " (계산한 값이면 calc에 식을 적는다)"}`, text: snippet(u.text) });
    }
  }
  return out;
}

function parseKey(k) {
  if (k.startsWith("q:")) { const [, v, u] = k.split(":"); return { kind: "qty", value: Number(v), unit: u }; }
  return { kind: k.startsWith("t:") ? "time" : "date" };
}

export const LEVEL_KO = { error: "오류", warn: "경고", info: "참고" };
export const RULE_KO = { L1: "대화·설명형 문장", L2: "자리표시자·내부 메모", L3: "군더더기·AI 티", F1: "공문서 표기", N1: "원자료와 숫자 대조", C1: "근거 표시", S1: "HWPX 구조" };
