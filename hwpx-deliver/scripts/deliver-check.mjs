#!/usr/bin/env node
// 납품 전 검사: 고객 문서에 대화체·자리표시자·내부 메모가 섞였는지, 공문서 표기, 원자료와 숫자가 맞는지, 근거가 붙었는지 본다.
//
// 사용: node deliver-check.mjs <doc.json | fill.json | 문서.hwpx | 문서.hwp> [--sources <sources.json>] [--report <내부 폴더>] [--json]
//   doc.json: 문서 모델(src로 원자료 조각을 가리킴). --sources를 주면 숫자 대조와 근거 검사를 한다
//   fill.json: 양식 채우기 값(fill-template.mjs 입력). op마다 넣는 글자를 검사하고 src를 대조한다
//   문서.hwpx: 이미 만든(또는 양식을 채운) HWPX. 글자 규칙과 구조를 보고, --sources를 주면 숫자를 원자료 전체에서 찾는다
//   --report: 근거표.md, 미결·확인필요.md, 검사결과.md를 쓴다. 고객에게 보낼 폴더와 다른 곳을 준다
// 종료 코드: 0 = 오류 없음(경고는 있을 수 있음), 2 = 오류 있음, 1 = 실행 실패
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, normalizePending } from "./lib/model.mjs";
import { readHwpx } from "./lib/hwpx-read.mjs";
import { readHwp } from "./lib/hwp-read.mjs";
import { unitIndex } from "./lib/sources.mjs";
import { docUnits, hwpxUnits, fillUnits, textRules, sourceChecks, isLabel, LEVEL_KO, RULE_KO } from "./lib/checks.mjs";
import { checkHwpx } from "./check-hwpx.mjs";

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const ORDER = { error: 0, warn: 1, info: 2 };

export function deliverCheck(file, { sources } = {}) {
  const index = sources ? unitIndex(sources) : null;
  if (/\.hwpx$/i.test(file)) {
    const buf = fs.readFileSync(file);
    const s = checkHwpx(buf);
    const findings = s.errors.map((e) => ({ id: "S1", level: "error", where: e.code, msg: e.msg, text: "" }));
    if (!s.errors.length) {
      const units = hwpxUnits(readHwpx(buf));
      findings.push(...textRules(units));
      if (index) findings.push(...sourceChecks(units, index, { requireSrc: false }));
    }
    return { kind: "hwpx", findings: sort(findings) };
  }
  // 바이너리 HWP: 구조 검사(S1)는 HWPX용이라 하지 않고, 글자 규칙과 원자료 대조만 한다
  if (/\.hwp$/i.test(file)) {
    const units = hwpxUnits(readHwp(fs.readFileSync(file)));
    const findings = textRules(units);
    if (index) findings.push(...sourceChecks(units, index, { requireSrc: false }));
    return { kind: "hwpx", findings: sort(findings) };
  }
  const json = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  // 양식 채우기(fill.json, 또는 ops 배열만 있는 파일): 넣는 값마다 검사하고 근거를 대조한다
  if (Array.isArray(json) || Array.isArray(json.ops)) {
    const ops = Array.isArray(json) ? json : json.ops;
    const units = fillUnits(ops);
    const findings = textRules(units);
    if (index) findings.push(...sourceChecks(units, index));
    return { kind: "fill", model: { pending: normalizePending(Array.isArray(json) ? [] : json.pending), meta: { title: Array.isArray(json) ? undefined : json.title } }, units, findings: sort(findings), sourced: Boolean(index) };
  }
  const m = normalize(json);
  const units = docUnits(m);
  const findings = textRules(units);
  if (index) findings.push(...sourceChecks(units, index));
  return { kind: "doc", model: m, units, findings: sort(findings), sourced: Boolean(index) };
}

const sort = (f) => f.sort((a, b) => ORDER[a.level] - ORDER[b.level]);

export function summary(findings) {
  const n = (l) => findings.filter((f) => f.level === l).length;
  return `오류 ${n("error")}개, 경고 ${n("warn")}개, 참고 ${n("info")}개`;
}

export function resultMd(r, title) {
  const out = [`# 검사 결과: ${title}`, "", summary(r.findings), ""];
  for (const level of ["error", "warn", "info"]) {
    const fs_ = r.findings.filter((f) => f.level === level);
    if (!fs_.length) continue;
    out.push(`## ${LEVEL_KO[level]}`, "");
    for (const f of fs_) out.push(`- [${f.id} ${RULE_KO[f.id] ?? ""}] ${f.where}: ${f.msg}${f.text ? ` — "${f.text}"` : ""}`);
    out.push("");
  }
  return out.join("\n");
}

// 근거표: 문서 조각마다 가리킨 원자료 조각의 글을 옆에 붙인다
export function evidenceMd(r, index, title) {
  const out = [`# 근거표: ${title}`, "", "문서의 각 부분이 원자료의 어디에서 왔는지 적은 내부 자료입니다. 고객에게 보내지 않습니다.", ""];
  for (const u of r.units) {
    if (!u.text.trim() || (isLabel(u) && !u.src?.length)) continue;
    out.push(`## ${u.where}`, "", `> ${u.text.replace(/\n/g, "\n> ")}`, "");
    if (u.src?.length) for (const id of u.src) {
      const s = index?.get(id);
      const who = s ? [s.speaker, s.time].filter(Boolean).join(" ") : "";
      out.push(s ? `- ${id} (${s.file}${who ? `, ${who}` : ""}): ${s.text.replace(/\n/g, " / ")}` : `- ${id}: ${index ? "(원자료 목록에 없음)" : "(원자료 목록을 받지 않아 대조하지 않음)"}`);
    }
    if (u.calc) out.push(`- 계산: ${u.calc}`);
    if (!u.src?.length && !u.calc) out.push("- 근거 없음");
    out.push("");
  }
  return out.join("\n");
}

export function pendingMd(r, title) {
  const out = [`# 미결·확인필요: ${title}`, "", "원자료에 근거가 없어 문서에 넣지 않았거나, 확인이 필요한 항목입니다. 고객에게 보내지 않습니다.", ""];
  const p = r.model?.pending ?? [];
  out.push("## 넣지 않은 내용", "");
  if (p.length) for (const x of p) out.push(`- ${x.item}${x.reason ? `: ${x.reason}` : ""}${x.src?.length ? ` (${x.src.join(", ")})` : ""}`);
  else out.push("- 없음");
  out.push("", "## 검사에서 확인이 필요하다고 나온 것", "");
  const need = r.findings.filter((f) => f.level !== "info" && (f.id === "N1" || f.id === "C1"));
  if (!r.sourced) out.push("- 원자료 목록(--sources)을 받지 않아 숫자 대조와 근거 검사를 하지 않았습니다");
  else if (need.length) for (const f of need) out.push(`- ${f.where}: ${f.msg} — "${f.text}"`);
  else out.push("- 없음");
  return out.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && !["--sources", "--report"].includes(args[i - 1]));
  if (!file) { console.error("사용: node deliver-check.mjs <doc.json | 문서.hwpx> [--sources sources.json] [--report 폴더] [--json]"); process.exit(1); }
  let r, sources = null;
  try {
    if (opt("--sources")) sources = JSON.parse(fs.readFileSync(opt("--sources"), "utf8"));
    r = deliverCheck(file, { sources });
  } catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
  const title = path.basename(file);
  if (args.includes("--json")) console.log(JSON.stringify(r.findings, null, 1));
  else console.log(resultMd(r, title));
  const dir = opt("--report");
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "검사결과.md"), resultMd(r, title));
    if (r.kind !== "hwpx") {
      fs.writeFileSync(path.join(dir, "근거표.md"), evidenceMd(r, sources ? unitIndex(sources) : null, r.model.meta.title ?? title));
      fs.writeFileSync(path.join(dir, "미결·확인필요.md"), pendingMd(r, r.model.meta.title ?? title));
    }
    console.error(`내부 자료: ${path.resolve(dir)}`);
  }
  process.exit(r.findings.some((f) => f.level === "error") ? 2 : 0);
}
