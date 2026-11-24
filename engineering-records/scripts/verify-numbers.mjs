#!/usr/bin/env node
// 기록 문서의 숫자가 원자료와 맞는지 확인한다.
//   1) <!-- src: 파일 :: 선택자 --> 표시가 있으면 바로 앞의 숫자를 그 파일의 값과 대조한다(표시는 하나도 빠짐없이 검사한다)
//   2) 측정 결과를 적는 곳(before/after 표, 증상·결과·측정 절)의 숫자에 출처도 "예측" 표시도 없으면 알린다
//   3) before·after·변화 열이 있는 표는 변화율을 다시 계산해 대조한다
// 사용법: node verify-numbers.mjs <문서.md>... [--root 저장소경로] [--json] [--strict]
//   종료 코드: 0 = 문제 없음, 2 = 불일치·출처 오류(--strict면 출처 없는 숫자도), 1 = 실행 실패
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 출처 값 꺼내기 ----------
// JSON 경로: metrics.http_req_duration.values["p(95)"] , items[0].value , items.0.value , $.a.b
export function jsonPick(obj, expr) {
  const tokens = [];
  const re = /\s*(?:\.?([A-Za-z_$][\w$-]*)|\.?(\d+)(?=\.|\[|$)|\[\s*(\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'((?:[^'\\]|\\.)*)'\s*\])/y;
  const s = expr.trim().replace(/^\$\.?/, "");
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`경로를 읽을 수 없습니다: "${expr}" (${i}번째 글자부터)`);
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : m[4] ?? m[5]));
    i = re.lastIndex;
  }
  let v = obj;
  for (const t of tokens) {
    // 문자열의 length 같은 내장 속성으로 빠지지 않게, 객체·배열의 자기 속성만 따라간다
    if (v == null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, t)) throw new Error(`경로에 값이 없습니다: "${expr}" (${String(t)}에서 끊김)`);
    v = v[t];
  }
  return v;
}

const NUM_RE = /^-?\d+(\.\d+)?$/;
function toNumber(v, where) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && NUM_RE.test(v.trim().replace(/,/g, ""))) return Number(v.trim().replace(/,/g, ""));
  throw new Error(`${where}의 값이 숫자가 아닙니다: ${JSON.stringify(v)?.slice(0, 60)}`);
}

const sourceCache = new Map();
function readSource(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, "utf8"));
  return sourceCache.get(file);
}

// "benchmarks/a.json :: x.y *1000 ~2%" — 배율과 허용 범위는 순서와 상관없이 끝에 붙인다
export function parseSrc(spec) {
  const m = spec.match(/^(.+?)\s*::\s*(.+?)\s*$/);
  if (!m) throw new Error(`출처 형식이 잘못됐습니다: "${spec}" (예: benchmarks/a.json :: metrics.p95)`);
  let rest = m[2];
  let scale = 1, tol = null, explicitScale = false;
  for (;;) {
    const tm = rest.match(/\s~(\d+(?:\.\d+)?)%$/);
    if (tm) { tol = Number(tm[1]); rest = rest.slice(0, tm.index); continue; }
    const sm = rest.match(/\s([*/])(\d+(?:\.\d+)?)$/);
    if (sm) { scale *= sm[1] === "*" ? Number(sm[2]) : 1 / Number(sm[2]); explicitScale = true; rest = rest.slice(0, sm.index); continue; }
    break;
  }
  return { file: m[1].trim(), selector: rest.trim(), scale, tol, explicitScale };
}

export function resolveSource(src, docDir, root) {
  const cands = [path.resolve(docDir, src.file), path.resolve(root, src.file)];
  const file = cands.find((f) => fs.existsSync(f));
  if (!file) throw new Error(`출처 파일이 없습니다: ${src.file}`);
  const text = readSource(file);
  let raw;
  if (/^\/.+\/[a-z]*$/.test(src.selector)) {
    const last = src.selector.lastIndexOf("/");
    const re = new RegExp(src.selector.slice(1, last), src.selector.slice(last + 1));
    const m = text.match(re);
    if (!m) throw new Error(`${src.file}에서 정규식이 맞지 않습니다: ${src.selector}`);
    raw = m[1] ?? m[0];
  } else {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${src.file}는 JSON이 아닙니다. 텍스트 파일은 /정규식/ 선택자를 쓰세요`); }
    raw = jsonPick(data, src.selector);
  }
  return toNumber(raw, `${src.file} :: ${src.selector}`) * src.scale;
}

// ---------- 문서의 숫자 ----------
const decimals = (s) => (s.includes(".") ? s.split(".")[1].length : 0);
const parseDocNum = (s) => Number(s.replace(/,/g, ""));

// 문서에 쓴 자릿수로 원자료를 반올림했을 때 같으면 일치로 본다
export function matches(docStr, actual, tolPct = null) {
  const doc = parseDocNum(docStr);
  if (tolPct != null) return Math.abs(actual - doc) <= Math.abs(actual) * tolPct / 100;
  const f = 10 ** decimals(docStr);
  return Math.round(actual * f) / f === doc || Math.abs(actual - doc) < 0.5 / f + 1e-9;
}

// 숫자를 "측정값 아님"으로 만드는 표시. 단어 일부(unexpected의 expected)나 "추정 원인"에는 걸리지 않게 한다
const PREDICTION = /예측|예상|추정치|\(추정\)|추정(?!\s*원인)|목표|가정|\b(estimated?|estimates|expected|projected|targets?|targeted|assumed|assumptions?|forecast)\b/i;
// "- 조건: 50 VU, 5분"처럼 시험 조건을 적은 줄은 측정값이 아니다
const CONDITION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:시험 조건|측정 조건|조건|환경|conditions?|setup|environment)(?:\*\*)?\s*[:：]/i;
const MEASURE_HEADING = /증상|결과|재측정|측정|before|after|result|metric|수치|성능|benchmark|벤치/i;
const NOT_MEASURE_HEADING = /조건|condition|setup|방법|method/i;
const RESULT_HEADING = /결과|재측정|증상|result|after|before|metric/i;

// 식별자·날짜·버전 등 측정값이 아닌 숫자를 걷어낸다. 글자 위치가 바뀌지 않게 같은 길이의 공백으로 바꾼다
const blank = (m) => " ".repeat(m.length);
function stripNonValues(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/`[^`]*`/g, blank)
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank)
    .replace(/\b[A-Za-z]{1,6}-\d+\b/g, blank)          // IMP-003, TS-12
    .replace(/\b[Ss]\d{1,3}\b/g, blank)                // 슬라이스 S04
    .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?\b/g, blank)
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, blank)
    .replace(/\bp\d{2,3}(\.\d+)?\b/gi, blank)          // p95, p99.9
    .replace(/\bv?\d+\.\d+\.\d+\b/g, blank)            // 버전
    .replace(/#\d+/g, blank)                           // PR #123
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, blank) // 커밋 해시(글자가 하나라도 섞인 것만)
    .replace(/\b\d+(st|nd|rd|th)\b/gi, blank);
}

// 출처 표시: <!-- src: ... --> (대소문자, 콜론 앞 공백 허용)
const MARKER_RE = /<!--\s*src\s*:\s*([\s\S]*?)\s*-->/gi;

// 출처 표시마다 짝이 되는 숫자: 이전 표시 뒤부터 이 표시 앞까지에서 마지막 숫자
function pairMarkers(line) {
  const out = [];
  const clean = stripNonValues(line.replace(/\|/g, " "));
  let prevEnd = 0;
  for (const mk of line.matchAll(MARKER_RE)) {
    let last = null;
    const seg = clean.slice(prevEnd, mk.index);
    for (const n of seg.matchAll(NUM_ANY)) last = { text: n[0], start: prevEnd + n.index, end: prevEnd + n.index + n[0].length, after: line.slice(prevEnd + n.index + n[0].length, mk.index) };
    out.push({ spec: mk[1], markerStart: mk.index, markerEnd: mk.index + mk[0].length, num: last });
    prevEnd = mk.index + mk[0].length;
  }
  return out;
}
const stripLinePrefix = (line) => line.replace(/^\s*(?:>\s*)*/, " ").replace(/^\s*(\d+\.|[-*+])\s+/, " ").replace(/^#+\s*\d+(\.\d+)*\.?/, " ");

const NUM_IN_TEXT = /(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?![\w.]*\d)/g;
const NUM_ANY = /-?\d[\d,]*(?:\.\d+)?/g;

// ---------- 표(GFM) ----------
const unquote = (line) => line.replace(/^\s*(?:>\s?)+/, "");
const DELIM_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isDelim = (line) => DELIM_ROW.test(unquote(line)) && unquote(line).includes("-");
// 표의 한 행을 나눈다. 인용 표시(>)는 떼고, 주석과 \| 안의 파이프는 구분자로 보지 않는다
function splitRow(line) {
  const saved = [];
  const protectedLine = unquote(line).replace(/<!--[\s\S]*?-->|\\\|/g, (m) => { saved.push(m); return `\u0000${saved.length - 1}\u0000`; });
  return protectedLine.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]).trim());
}

// ---------- 표의 변화율 ----------
// "9m46s", "1h 5m", "2m 3.5s" 같은 시간 표기는 초로 바꾼다(9와 46으로 따로 읽지 않게)
function durationSeconds(s) {
  // 모든 부분이 선택이라 빈 문자열도 맞으므로, 시·분이 실제로 있는 첫 일치를 찾는다
  for (const m of s.matchAll(/(?<![\w.])(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?(?![\w])/gi)) {
    if (m[1] == null && m[2] == null) continue;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }
  return null;
}
// 셀의 값 후보들: 시간 표기는 초로, 한 칸에 여러 값(실행별 0.498 / 0.482 / 0.426)이 있으면 모두.
// 괄호 안은 표본 수(n=3)·오차(±12)일 수 있어 뒤로 미루되, 괄호 안 값(586s)도 후보에 넣는다
function cellValues(cell) {
  const s = stripNonValues(cell);
  const dur = durationSeconds(s);
  if (dur != null) return [dur];
  const outside = s.replace(/\([^)]*\)/g, (x) => " ".repeat(x.length));
  const nums = (outside.match(NUM_ANY) || []).map(parseDocNum);
  if (nums.length) return nums;
  return (s.match(NUM_ANY) || []).map(parseDocNum);
}
function firstNumber(cell) {
  return cellValues(cell)[0] ?? null;
}
// 방향은 값이 늘었는지 줄었는지만 본다("빨라짐"처럼 지표에 따라 방향이 달라지는 말은 쓰지 않는다)
// ▼·△(회계식 음수)는 감소, ▲는 증가로 본다
const DOWN = /↓|▼|△|감소|줄었|줄어|줄임|\b(decrease[sd]?|decreasing|reduced|reduction|down|drop(ped)?)\b/i;
const UP = /↑|▲|증가|늘었|늘어|늘림|\b(increase[sd]?|increasing|up|grew|growth|rise|rose)\b/i;
export function checkChange(beforeCell, afterCell, changeCell) {
  // 칸에 값이 여러 개면(실행별 값) 그중 어느 짝이든 맞으면 통과로 본다. 하나도 안 맞으면 첫 값 기준으로 보고한다
  const bs = cellValues(beforeCell), as = cellValues(afterCell);
  if (bs.length > 1 || as.length > 1) {
    let first = null;
    for (const b of bs) for (const a of as) {
      const r = checkChangeValues(b, a, changeCell);
      if (!r) continue;
      if (r.ok) return r;
      first ??= r;
    }
    return first;
  }
  return checkChangeValues(bs[0] ?? null, as[0] ?? null, changeCell);
}

function checkChangeValues(b, a, changeCell) {
  const c = stripNonValues(changeCell).trim();
  if (b == null || a == null || !c || /^[-–—]$/.test(c)) return null;
  let m = c.match(/([+\-−–]?)\s*(\d[\d,]*(?:\.\d+)?)\s*%/);
  if (m) {
    if (b === 0) return null;
    const actual = ((a - b) / b) * 100;
    // 방향: 부호, 화살표·삼각형, 증가/감소 같은 말 중 하나라도 있으면 실제 방향과 맞아야 한다
    const dir = /[-−–]/.test(m[1]) ? -1 : m[1] === "+" ? 1 : DOWN.test(c) ? -1 : UP.test(c) ? 1 : 0;
    const dirOk = dir === 0 || actual === 0 || dir === Math.sign(actual);
    return { kind: "%", stated: (dir || 1) * parseDocNum(m[2]), actual, ok: dirOk && matches(m[2], Math.abs(actual)) };
  }
  m = c.match(/(\d[\d,]*(?:\.\d+)?)\s*(x|×|배)/i) || c.match(/(x|×)\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (m) {
    const num = /\d/.test(m[1]) ? m[1] : m[2];
    const stated = parseDocNum(num);
    if (b === 0 || a === 0) return null;
    // 1보다 작게 쓰면(0.25x) after/before 비율, 1 이상이면 큰 쪽/작은 쪽("3배 빨라짐")
    const actual = stated < 1 ? a / b : Math.max(a, b) / Math.min(a, b);
    return { kind: "x", stated, actual, ok: matches(num, actual) };
  }
  return null;
}

// ---------- 표 머리 ----------
// 열 이름 안의 독립된 낱말로 찾는다: "Before p95", "수정 전", "전(ms)", "before<br>(ms)"는 잡고 "전체 요청", "전송량"은 잡지 않는다
const H = (re) => new RegExp(`(?:^|[\\s(/\\[>])(?:${re})(?=$|[\\s()/\\],:·<%])`, "i");
const COL_BEFORE = H("before|baseline|as-?is|이전|기존|전|(?:수정|변경|개선|적용|도입|튜닝|최적화)\\s*전");
const COL_AFTER = H("after|optimized|improved|to-?be|이후|후|(?:수정|변경|개선|적용|도입|튜닝|최적화)\\s*후");
const COL_CHANGE = H("변화|변화율|증감|증감률|차이|개선율|개선 폭|개선폭|향상|향상률|change|diff|delta|Δ|speedup|improvement|gain");
const COL_IMPROVED = H("개선"); // "기존 | 개선 | 개선율"에서는 after, "… | 개선"만 있으면 변화 열
const plain = (c) => (c ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, " ").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

function readHeader(cells) {
  const low = cells.map(plain);
  const before = low.findIndex((c) => COL_BEFORE.test(c));
  let after = low.findIndex((c) => COL_AFTER.test(c));
  let change = low.findIndex((c) => COL_CHANGE.test(c) && !COL_BEFORE.test(c) && !COL_AFTER.test(c));
  const improved = low.findIndex((c, i) => i !== before && COL_IMPROVED.test(c) && !COL_BEFORE.test(c) && !COL_AFTER.test(c) && !COL_CHANGE.test(c));
  if (improved >= 0) {
    if (after < 0 && change >= 0) after = improved;      // 기존 | 개선 | 개선율
    else if (change < 0) change = improved;              // before | after | 개선
  }
  return { before, after, change };
}

// ---------- 코드 블록 ----------
// CommonMark: 같은 글자로, 연 것 이상 길이로, 뒤에 다른 글자 없이 닫는다
function fenceState(line, fence) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return fence;
  if (!fence) return (m[1][0] === "`" && m[2].includes("`")) ? fence : { ch: m[1][0], len: m[1].length };
  if (m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) return null;
  return fence;
}

// ---------- 문서 하나 검사 ----------
export function verifyDoc(file, root) {
  const findings = [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const docDir = path.dirname(file);
  // 결정 기록의 "결과" 절은 결정의 결과이지 측정 결과가 아니다
  const isDecision = /(^|[\\/])(adr|decisions?|결정)[\\/]|(^|[\\/])adr-?\d/i.test(file);
  let fence = null;
  let section = "";
  let table = null; // { before, after, change } — 머리 행 다음 줄이 구분선일 때만 표로 본다
  let sourced = 0, checked = 0;

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    const next = fenceState(line, fence);
    if (next !== fence || (fence && next === fence)) { const wasIn = !!fence; fence = next; if (wasIn || fence) return; }
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)/);
    if (h) { section = h[1]; table = null; }

    // 표의 시작·끝: GFM은 머리 행 + 구분선. 파이프가 없는 줄이 나오면 표가 끝난다
    const hasPipe = unquote(line).includes("|");
    if (!hasPipe) table = null;
    let isHeader = false;
    if (hasPipe && idx + 1 < lines.length && isDelim(lines[idx + 1]) && !isDelim(line)) { table = readHeader(splitRow(line)); isHeader = true; }
    const isDelimRow = hasPipe && isDelim(line);
    const isRow = !!table && hasPipe && !isHeader && !isDelimRow;

    // 닫히지 않은 출처 표시(여러 줄에 걸친 주석)는 검사할 수 없으니 오류로 알린다
    if (/<!--\s*src\s*:/i.test(line) && !/<!--\s*src\s*:[\s\S]*?-->/i.test(line)) {
      findings.push({ level: "ERROR", line: ln, rule: "source-error", message: "출처 표시가 한 줄 안에서 닫히지 않았습니다(<!-- src: ... -->를 한 줄에 쓰세요)" });
    }

    // 1) 출처 표시: 모든 표시를 찾고, 각 표시 바로 앞(이전 표시 뒤부터)의 마지막 숫자와 짝짓는다
    const pairs = pairMarkers(line);
    for (const p of pairs) {
      sourced++;
      if (!p.num) { findings.push({ level: "ERROR", line: ln, rule: "source-error", message: `출처 표시 앞에 숫자가 없습니다: <!-- src: ${p.spec} -->` }); continue; }
      const docNum = p.num.text;
      try {
        const src = parseSrc(p.spec);
        const actual = resolveSource(src, docDir, root);
        checked++;
        if (!matches(docNum, actual, src.tol)) {
          findings.push({ level: "ERROR", line: ln, rule: "mismatch", message: `문서 ${docNum} ≠ 원자료 ${+actual.toFixed(6)} (${src.file} :: ${src.selector}${src.scale !== 1 ? ` ×${+src.scale.toFixed(6)}` : ""})` });
        } else if (/^\s*%/.test(p.num.after) && !src.explicitScale && actual !== 0 && Math.abs(actual) < 1 && Math.abs(actual * 100 - parseDocNum(docNum)) > 0.5) {
          // 문서는 %인데 원자료는 0~1 비율로 보인다(k6의 rate 등). 반올림으로 우연히 맞았을 수 있다
          findings.push({ level: "ERROR", line: ln, rule: "scale", message: `문서 ${docNum}%의 원자료 값이 ${actual}입니다. 비율(0~1)이면 *100을, 이미 %면 *1을 출처 표시에 붙이세요` });
        }
      } catch (e) {
        findings.push({ level: "ERROR", line: ln, rule: "source-error", message: e.message });
      }
    }

    // 3) 변화율
    if (isRow && table.before >= 0 && table.after >= 0 && table.change >= 0) {
      const cells = splitRow(line);
      const r = checkChange(cells[table.before] ?? "", cells[table.after] ?? "", cells[table.change] ?? "");
      if (r && !r.ok) findings.push({ level: "ERROR", line: ln, rule: "change", message: `변화 "${plain(cells[table.change])}"가 before ${plain(cells[table.before])} → after ${plain(cells[table.after])}와 맞지 않습니다(계산 ${r.kind === "%" ? `${r.actual >= 0 ? "+" : ""}${r.actual.toFixed(1)}%` : `${r.actual.toFixed(2)}배`})` });
    }

    // 2) 측정 맥락의 출처 없는 숫자
    if (isHeader || isDelimRow) return;
    const measureTable = isRow && (table.before >= 0 || table.after >= 0);
    // "측정 조건" 절은 빼되, "결과 (재측정, 동일 조건)"처럼 결과 절에 조건이 언급된 것은 빼지 않는다
    const conditionOnly = NOT_MEASURE_HEADING.test(section) && !RESULT_HEADING.test(section);
    const measureSection = !isDecision && MEASURE_HEADING.test(section) && !conditionOnly;
    if ((measureTable || measureSection) && !PREDICTION.test(line) && !PREDICTION.test(section) && !CONDITION_LINE.test(unquote(line))) {
      // 출처 표시와 그 짝 숫자는 1)과 같은 방식으로 지운다(위치를 그대로 쓰므로 짝짓기가 어긋나지 않는다)
      const chars = line.split(""); // 정규식 위치(UTF-16 단위)와 맞추려고 코드 유닛 단위로 나눈다
      const wipe = (s, e) => { for (let k = s; k < e; k++) chars[k] = " "; };
      for (const p of pairs) { wipe(p.markerStart, p.markerEnd); if (p.num) wipe(p.num.start, p.num.end); }
      let target = chars.join("");
      // 변화 열은 위에서 계산으로 확인하므로 출처를 요구하지 않는다
      if (measureTable && table.change >= 0) { const cells = splitRow(target); cells[table.change] = ""; target = cells.join(" | "); }
      const nums = [...stripNonValues(stripLinePrefix(target)).matchAll(NUM_IN_TEXT)].map((m) => m[0]);
      if (nums.length) findings.push({ level: "WARN", line: ln, rule: "unsourced", message: `출처 없는 숫자 ${[...new Set(nums)].slice(0, 5).join(", ")}: 원자료를 <!-- src: 파일 :: 경로 -->로 달거나, 실측이 아니면 "예측"이라고 적으세요` });
    }
  });
  return { file, sourced, checked, findings };
}

function findRoot(start) {
  let d = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

function main() {
  const args = process.argv.slice(2);
  const files = [];
  let root = null, json = false, strict = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--strict") strict = true;
    else files.push(args[i]);
  }
  if (!files.length) { console.log("사용법: node verify-numbers.mjs <문서.md>... [--root 저장소경로] [--json] [--strict]"); process.exit(1); }
  const results = [];
  try {
    for (const f of files) {
      if (!fs.existsSync(f)) throw new Error(`파일이 없습니다: ${f}`);
      results.push(verifyDoc(f, root ? path.resolve(root) : findRoot(path.dirname(f))));
    }
  } catch (e) { console.error(`실행 실패: ${e.message}`); process.exit(1); }
  if (json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) {
    const e = r.findings.filter((x) => x.level === "ERROR").length, w = r.findings.length - e;
    console.log(`${r.file}\n  출처 표시 ${r.sourced}개 중 ${r.checked}개 확인 · ERROR ${e} · WARN ${w}`);
    for (const x of r.findings) console.log(`  ${x.level.padEnd(5)} ${String(x.line).padStart(4)}행  ${x.message}`);
  }
  const bad = results.some((r) => r.findings.some((x) => x.level === "ERROR" || (strict && x.level === "WARN")));
  process.exit(bad ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
