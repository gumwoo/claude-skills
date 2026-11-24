#!/usr/bin/env node
// engineering-records 시험. 사용법: node tests/run-tests.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "../scripts/scan.mjs";
import { verifyDoc, jsonPick, matches, checkChange, parseSrc } from "../scripts/verify-numbers.mjs";
import { analyze, decide, fromGitStatus } from "../scripts/remind-hook.mjs";
import { makeRepo } from "./make-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = (f) => path.join(HERE, "..", "scripts", f);
let pass = 0, fail = 0;
const ok = (c, name, detail = "") => { if (c) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const repo = makeRepo();
const cleanup = [repo];

console.log("\n# 저장소 규칙 읽기");
{
  const r = scan(repo);
  const by = Object.fromEntries(r.types.map((t) => [t.kind, t]));
  ok(by.troubleshooting?.nextId === "TS-003" && by.troubleshooting.dir === "docs/troubleshooting", "트러블슈팅: 폴더와 다음 번호 TS-003", JSON.stringify(by.troubleshooting));
  ok(by.improvement?.template === "docs/improvements/_TEMPLATE.md" && by.improvement.nextId === "IMP-003", "개선: 템플릿과 다음 번호 IMP-003");
  ok(by.decision?.nextId === "0003" && by.decision.index === "docs/decisions/README.md", "결정: 0001-제목.md 형식과 README 목록 인식, 다음 0003", JSON.stringify(by.decision));
  ok(JSON.stringify(by.troubleshooting.missingInIndex) === '["TS-002-cache-stale.md"]', "목록에서 빠진 TS-002를 찾음");
  ok(!r.types.some((t) => t.dir.includes("node_modules")), "node_modules 안의 문서는 보지 않음");
  const chk = spawnSync(process.execPath, [S("scan.mjs"), repo, "--check"], { encoding: "utf8" });
  ok(chk.status === 2, "--check: 목록 누락이 있으면 종료 코드 2");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "records-empty-")); cleanup.push(empty);
  const e = spawnSync(process.execPath, [S("scan.mjs"), empty], { encoding: "utf8" });
  ok(e.status === 0 && /찾지 못했습니다/.test(e.stdout), "기록 문서가 없는 저장소에서는 기본 템플릿을 쓰라고 안내");
  fs.writeFileSync(path.join(repo, ".records.json"), JSON.stringify({ types: { INC: { dir: "docs/troubleshooting", kind: "troubleshooting" } }, triggers: { improvement_min_change_pct: 20 } }));
  const r2 = scan(repo);
  ok(r2.types.find((t) => t.dir === "docs/troubleshooting")?.name === "INC" && r2.triggers.improvement_min_change_pct === 20, ".records.json의 이름·기준을 읽음");
  fs.rmSync(path.join(repo, ".records.json"));
}

console.log("\n# 원자료 꺼내기");
{
  const o = { metrics: { d: { values: { "p(95)": 1.5 } } }, runs: [{ ms: 3 }, { ms: 4 }] };
  ok(jsonPick(o, 'metrics.d.values["p(95)"]') === 1.5, '대괄호 키 ["p(95)"]');
  ok(jsonPick(o, "$.runs[1].ms") === 4, "$.배열[인덱스].키");
  ok(throws(() => jsonPick(o, "metrics.nope.x"), /값이 없습니다/), "없는 경로는 오류(0으로 읽지 않음)");
  const p = parseSrc('a.json :: x.y *1000 ~2%');
  ok(p.file === "a.json" && p.selector === "x.y" && p.scale === 1000 && p.tol === 2, "배율·허용 범위 해석");
  ok(matches("850", 849.6) && !matches("850", 848.4) && matches("118.4", 118.42) && !matches("118", 118.6), "문서 자릿수로 반올림해 비교");
  ok(matches("125", 120.9, 5) && !matches("125", 110, 5), "~허용% 비교");
  ok(checkChange("850ms", "210ms", "-75%").ok && !checkChange("850", "210", "-60%").ok, "변화율 %: -75% 맞음, -60% 틀림");
  ok(checkChange("118.4", "1,380.7", "11.7배").ok && checkChange("2,412", "618", "3.9배").ok && !checkChange("10", "20", "3배").ok, "배수(늘어난 쪽·줄어든 쪽 모두)");
  ok(checkChange("19", "0", "-100%").ok && checkChange("5", "6", "↑20%").ok, "-100%, ↑ 표기");
  ok(checkChange("0", "5", "+∞%") === null && checkChange("3", "4", "정확") === null, "before 0이나 숫자 아닌 변화는 건너뜀");
}

console.log("\n# 문서 숫자 검사");
{
  const good = verifyDoc(path.join(repo, "docs/improvements/IMP-001-search-index.md"), repo);
  ok(good.findings.length === 0, `잘 쓴 문서: 문제 없음 (출처 ${good.checked}/${good.sourced}개 확인)`, JSON.stringify(good.findings));
  ok(good.sourced === 9 && good.checked === 9, "출처 표시 9개를 모두 원자료와 대조");
  const bad = verifyDoc(path.join(repo, "docs/improvements/IMP-002-bad-numbers.md"), repo);
  const has = (rule, re) => bad.findings.some((f) => f.rule === rule && re.test(f.message));
  ok(has("mismatch", /900 ≠ 원자료 849.6/), "원자료와 다른 숫자(900 vs 849.6)를 ERROR로", JSON.stringify(bad.findings, null, 1));
  ok(has("source-error", /p\(99\.9\)/), "원자료에 없는 경로를 ERROR로");
  ok(has("source-error", /nope\.json/), "없는 출처 파일을 ERROR로");
  ok(has("change", /\+40,000%/), "틀린 변화율(+40,000%)을 ERROR로");
  ok(has("change", /-90%/), "틀린 변화율(-90%, 실제 -100%)을 ERROR로");
  const avgLine = fs.readFileSync(bad.file, "utf8").split(/\r?\n/).findIndex((l) => l.startsWith("| 평균")) + 1;
  ok(avgLine > 0 && !bad.findings.some((f) => f.line === avgLine), "~허용% 안의 근사값은 통과", `평균 행 ${avgLine}: ${JSON.stringify(bad.findings.filter((f) => f.line === avgLine))}`);
  ok(has("unsourced", /118, 1,381/), "출처 없는 측정 숫자를 WARN으로");
  ok(has("unsourced", /0\.4/), "결과 절 문장 속 출처 없는 숫자도 WARN");
  ok(!bad.findings.some((f) => /예측/.test(lineOf(bad.file, f.line))), "\"예측\"이 붙은 줄은 출처를 요구하지 않음");
  const cli = spawnSync(process.execPath, [S("verify-numbers.mjs"), bad.file], { encoding: "utf8" });
  ok(cli.status === 2, "ERROR가 있으면 종료 코드 2");
  const cliGood = spawnSync(process.execPath, [S("verify-numbers.mjs"), good.file, "--strict"], { encoding: "utf8" });
  ok(cliGood.status === 0, "잘 쓴 문서는 --strict에서도 0");
  const warnOnly = path.join(repo, "docs/improvements/IMP-003-warn.md");
  fs.writeFileSync(warnOnly, "# IMP-003\n## 결과\n오류율은 0.4%였다.\n");
  ok(spawnSync(process.execPath, [S("verify-numbers.mjs"), warnOnly], { encoding: "utf8" }).status === 0, "WARN만 있으면 기본은 0");
  ok(spawnSync(process.execPath, [S("verify-numbers.mjs"), warnOnly, "--strict"], { encoding: "utf8" }).status === 2, "--strict에서는 WARN도 2");
  ok(spawnSync(process.execPath, [S("verify-numbers.mjs"), path.join(repo, "nope.md")], { encoding: "utf8" }).status === 1, "없는 문서는 1");
}
function lineOf(file, n) { return fs.readFileSync(file, "utf8").split(/\r?\n/)[n - 1] ?? ""; }

console.log("\n# 리뷰에서 찾은 거짓 통과·오탐 회귀");
{
  const d = (name, body) => { const f = path.join(repo, "docs/improvements", name); fs.writeFileSync(f, body); return verifyDoc(f, repo); };
  const B = "../../benchmarks";
  const p95b = `<!-- src: ${B}/search-before.json :: metrics.http_req_duration.values["p(95)"] -->`;
  // 1) 숫자와 표시 사이에 다른 글자가 끼어도 표시를 빠뜨리지 않는다
  const r1 = d("R1.md", `# R1\n## 상황\n**999ms** ${p95b}\n999μs ${p95b}\n(999ms) ${p95b}\n`);
  ok(r1.sourced === 3 && r1.findings.filter((f) => f.rule === "mismatch").length === 3, "굵게·괄호·μ 단위가 끼어도 표시 3개 모두 검사하고 불일치 3건", JSON.stringify(r1));
  const r1b = d("R1b.md", `# R1b\n## 상황\n출처만 있음 ${p95b}\n`);
  ok(r1b.findings.some((f) => /앞에 숫자가 없습니다/.test(f.message)), "숫자 없는 출처 표시는 ERROR");
  // 2) 7자리 이상 정수를 커밋 해시로 지우지 않는다
  const r2 = d("R2.md", "# R2\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| 바이트 | 1500000 | 10 | -10% |\n");
  ok(r2.findings.some((f) => f.rule === "change"), "1500000 같은 큰 정수도 변화율 계산에 씀", JSON.stringify(r2.findings));
  // 3) 방향 표시
  const r3 = d("R3.md", "# R3\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| a | 1000 | 500 | 50% 증가 |\n| b | 1000 | 500 | 50%↓ |\n| c | 1000 | 500 | - 50% |\n| d | 1000 | 250 | 0.25x |\n| e | 1000 | 500 | 50% |\n");
  const ch = (row) => r3.findings.some((f) => f.rule === "change" && f.line === 4 + row);
  ok(ch(1) && !ch(2) && !ch(3) && !ch(4) && !ch(5), "\"50% 증가\"(실제 감소)는 ERROR, 50%↓·- 50%·0.25x·부호 없는 50%는 통과", JSON.stringify(r3.findings.filter((f) => f.rule === "change")));
  // 4) 열 이름을 단어 일부로 잡지 않는다
  const r4 = d("R4.md", "# R4\n## 결과\n| 지표 | 전체 요청 | before | after | 변화 |\n|---|---|---|---|---|\n| p95 | 100 | 850 | 210 | -75% |\n");
  ok(!r4.findings.some((f) => f.rule === "change"), "\"전체 요청\" 열을 before로 잡지 않음", JSON.stringify(r4.findings));
  // 5) 정규식 안의 \| 와 주석 안의 파이프로 열이 밀리지 않는다
  const r5 = d("R5.md", `# R5\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| 시간 | 2,412ms <!-- src: ${B}/batch-before.txt :: /elapsed: (\\d+\\.\\d+)s\\|x/ *1000 --> | 1,206ms | -40% |\n`);
  ok(r5.findings.some((f) => f.rule === "change"), "파이프가 든 선택자가 있어도 열이 밀리지 않고 틀린 변화율(-40%, 실제 -50%)을 잡음", JSON.stringify(r5.findings));
  // 6) 다른 이름의 변화 열
  const r6 = d("R6.md", "# R6\n## 결과\n| 지표 | Baseline | Optimized | Δ |\n|---|---|---|---|\n| p95 | 1000 | 10 | -50% |\n| p99 | 1000 | 500 | -50% |\n");
  ok(r6.findings.filter((f) => f.rule === "change").length === 1, "Baseline·Optimized·Δ 열도 재계산", JSON.stringify(r6.findings));
  // 7) 예측 표시가 단어 일부·\"추정 원인\"에 걸리지 않는다
  const r7 = d("R7.md", "# R7\n## 결과\nunexpected spike: 오류율 12%\n추정 원인: 커넥션 풀 고갈, 오류율 9%\n처리량은 2배가 될 것으로 예측\n");
  const w7 = r7.findings.filter((f) => f.rule === "unsourced").map((f) => f.line);
  ok(w7.includes(3) && w7.includes(4) && !w7.includes(5), "unexpected·추정 원인 줄의 실측 숫자는 검사하고, 예측 줄만 뺌", JSON.stringify(r7.findings));
  // 8) 0도 출처를 요구한다
  const r8 = d("R8.md", "# R8\n## 결과\n중복 결제는 0건이 됐다.\n");
  ok(r8.findings.some((f) => f.rule === "unsourced" && /0/.test(f.message)), "\"0건\"도 출처 없는 측정값으로 WARN");
  // 9) 결정 기록의 \"결과\" 절, \"측정 조건\" 절은 측정 맥락이 아니다
  const adrDir = path.join(repo, "docs/decisions");
  fs.writeFileSync(path.join(adrDir, "0003-cache.md"), "# 3. 캐시\n## 결과\n트래픽이 지금의 10배가 되면 다시 본다.\n");
  ok(verifyDoc(path.join(adrDir, "0003-cache.md"), repo).findings.length === 0, "결정 기록의 \"결과\" 절은 측정으로 보지 않음");
  const r9 = d("R9.md", "# R9\n## 문제와 측정 조건\n30 VU, 3분\n");
  ok(r9.findings.length === 0, "\"측정 조건\" 절의 숫자는 조건으로 봄");
  const r9b = d("R9b.md", "# R9b\n## 7. 결과 (재측정, 동일 조건)\n오류율은 0.2%로 줄었다.\n");
  ok(r9b.findings.some((f) => f.rule === "unsourced"), "\"결과 (재측정, 동일 조건)\" 절은 여전히 검사함");
  fs.rmSync(path.join(repo, "docs/improvements/R9b.md"));
  // 10) 기타
  ok(throws(() => jsonPick({ a: "abcd" }, "a.length"), /값이 없습니다/), "문자열의 length 같은 내장 속성으로 빠지지 않음");
  ok(jsonPick({ items: [{ v: 7 }] }, "items.0.v") === 7, "items.0.v 형식도 읽음");
  const p2 = parseSrc("a.json :: x.y ~1% *1000");
  ok(p2.selector === "x.y" && p2.tol === 1 && p2.scale === 1000, "배율·허용 범위 순서가 바뀌어도 해석");
  const r10 = d("R10.md", "# R10\n## 결과\n~~~\n오류율 50%\n~~~\n");
  ok(r10.findings.length === 0, "~~~ 코드 블록 안은 검사하지 않음");
  // 2차 리뷰
  const r11 = d("R11.md", "# R11\n## 결과\n| 지표 | 수정 전 | 수정 후 | 변화 |\n|---|---|---|---|\n| p95 | 1000 | 10 | -50% |\n\n| 지표 | Before p95 | After p95 | 개선 |\n|---|---|---|---|\n| a | 1000 | 10 | -50% |\n");
  ok(r11.findings.filter((f) => f.rule === "change").length === 2, "\"수정 전/후\", \"Before p95\" 열도 알아보고 틀린 변화율을 잡음", JSON.stringify(r11.findings));
  const r12 = d("R12.md", "# R12\n## 측정 (운영 환경)\n오류율 12.5%\n");
  ok(r12.findings.some((f) => f.rule === "unsourced"), "\"측정 (운영 환경)\" 절도 검사함");
  const r13 = d("R13.md", `# R13\n## 결과\n850ms (p95 기준) ${p95b}\n`);
  ok(r13.findings.length === 0, "\"850ms (p95 기준) <!-- src -->\"는 대조만 하고 출처 없음 WARN을 내지 않음", JSON.stringify(r13.findings));
  const r14 = d("R14.md", "# R14\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| 처리량 | 100 | 140 | 40% 빨라짐 |\n| x | 100 | 150 | 50% (regardless) |\n| y | 100 | 150 | 50% 감소 |\n");
  const e14 = r14.findings.filter((f) => f.rule === "change").map((f) => f.line);
  ok(e14.length === 1 && e14[0] === 7, "\"빨라짐\"·regardless는 방향으로 보지 않고, \"감소\"(실제 증가)만 ERROR", JSON.stringify(r14.findings));
  // 3차 리뷰(처음 보는 리뷰어)
  const bad3 = (name, body) => { const r = d(name, body); return r.findings.some((f) => f.level === "ERROR"); };
  ok(bad3("R16.md", "# R16\n## 결과\n| 지표 | 전(ms) | 후(ms) | 변화율(%) |\n|---|---|---|---|\n| p95 | 850 | 210 | -10% |\n"), "\"전(ms)·후(ms)·변화율(%)\"처럼 괄호가 붙은 열 이름도 알아봄");
  ok(bad3("R17.md", "# R17\n## 결과\n| 지표 | before<br>(ms) | after<br>(ms) | change |\n|---|---|---|---|\n| p95 | 850 | 210 | -10% |\n"), "<br>이 낀 열 이름도 알아봄");
  ok(bad3("R18.md", "# R18\n## 결과\n| 지표 | 기존 | 개선 | 개선율 |\n|---|---|---|---|\n| p95 | 850 | 210 | 10% |\n"), "\"기존 | 개선 | 개선율\"에서 개선을 after로 봄");
  ok(bad3("R19.md", `# R19\n## 배경\n999ms <!-- SRC: ${B}/search-before.json :: metrics.http_req_duration.values["p(95)"] -->\n`), "대문자 SRC 표시도 검사");
  ok(bad3("R20.md", `# R20\n## 배경\n999ms <!-- src :\n${B}/search-before.json :: x -->\n`), "여러 줄에 걸친 출처 표시는 오류로 알림");
  ok(bad3("R21.md", `# R21\n\`\`\`\`md\n\`\`\`js\nx\n\`\`\`\n\`\`\`\`\n## 결과\n999ms ${p95b}\n`), "긴 코드 펜스 안의 짧은 펜스에 속지 않고 뒤의 숫자를 검사");
  ok(bad3("R22.md", "# R22\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| p95 | 850 | 210 | ▲75% |\n| q | 100 | 175 | –75% |\n"), "▲(증가)·en dash(–) 방향 표시도 검사");
  fs.writeFileSync(path.join(repo, "benchmarks/rate.json"), JSON.stringify({ rate: 0.3 }));
  ok(bad3("R23.md", `# R23\n## 배경\n실패율 0% <!-- src: ${B}/rate.json :: rate -->\n`), "문서는 %, 원자료는 0~1 비율이면 배율을 적으라고 오류");
  ok(!bad3("R23b.md", `# R23b\n## 배경\n실패율 30% <!-- src: ${B}/rate.json :: rate *100 -->\n`), "배율 *100을 적으면 통과");
  ok(bad3("R24.md", "# R24\n## 결과\n지표 | before | after | 변화\n---|---|---|---\np95 | 850 | 210 | -10%\n"), "앞에 |가 없는 GFM 표도 검사");
  ok(bad3("R25.md", "# R25\n## 결과\n> | 지표 | before | after | 변화 |\n> |---|---|---|---|\n> | p95 | 850 | 210 | -10% |\n"), "인용(>) 안의 표도 검사");
  ok(bad3("R26.md", "# R26\n## 결과\n| 지표 | a | b |\n|---|---|---|\n| x | 1 | 2 |\n**표 2**\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| p95 | 850 | 210 | -10% |\n"), "빈 줄 없이 이어진 두 번째 표는 자기 머리 행으로 검사");
  ok(bad3("R27.md", "# R27\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| p95 | (n=3) 850 | (n=3) 210 | 0% |\n"), "셀 앞의 (n=3)이 아니라 실제 값으로 계산");
  // 실제 문서에서 나온 오탐
  ok(!bad3("R28.md", "# R28\n## 결과\n| 지표 | AS-IS | TO-BE | 변화 |\n|---|---|---|---|\n| 잡 (median) | **9m46s** (586s) | **3m08s** (188s) | **-68%** |\n"), "9m46s 같은 시간 표기를 초로 바꿔 계산(실제 문서 오탐)");
  ok(bad3("R29.md", "# R29\n## 결과\n| 지표 | AS-IS | TO-BE | 변화 |\n|---|---|---|---|\n| 잡 | 9m46s | 3m08s | -40% |\n"), "시간 표기에서도 틀린 변화율은 잡음");
  ok(!bad3("R30.md", "# R30\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| p95 | 0.635 | 0.498 / 0.482 / 0.426 | −24.1% |\n"), "한 칸의 여러 실행값 중 하나(중앙값)와 맞으면 통과(실제 문서 오탐)");
  ok(bad3("R31.md", "# R31\n## 결과\n| 지표 | before | after | 변화 |\n|---|---|---|---|\n| p95 | 0.635 | 0.498 / 0.482 / 0.426 | −5% |\n"), "여러 실행값 어느 것과도 안 맞으면 오류");
  for (const f of ["R28", "R29", "R30", "R31", "R1", "R1b", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R16", "R17", "R18", "R19", "R20", "R21", "R22", "R23", "R23b", "R24", "R25", "R26", "R27"]) fs.rmSync(path.join(repo, "docs/improvements", f + ".md"));
  fs.rmSync(path.join(adrDir, "0003-cache.md"));

  // scan
  const s = fs.mkdtempSync(path.join(os.tmpdir(), "records-scan-adrian-")); cleanup.push(s);
  const w = (rel, t = "x") => { fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true }); fs.writeFileSync(path.join(s, rel), t); };
  w("docs/adr/adr-0001-x.md"); w("docs/adr/adr-0002-y.md");
  w("guide/001-intro.md");
  w("ts/2024/TS-001-a.md"); w("ts/2025/TS-002-b.md");
  w("imp/IMP-1-a.md"); w("imp/IMP-10-b.md"); w("imp/_index.md", "| [IMP-10](IMP-10-b.md) |\n");
  const sr = scan(s);
  ok(sr.types.some((t) => t.prefix === "adr" && t.nextId === "adr-0003"), "소문자 접두어 adr-0001도 찾음", JSON.stringify(sr.types.map((t) => t.nextId)));
  ok(!sr.types.some((t) => t.dir === "guide"), "루트 경로에 adr이 들어가도(adrian) 일반 문서 001-intro.md를 기록으로 잡지 않음");
  ok(sr.types.filter((t) => t.prefix === "TS").every((t) => t.nextId === "TS-003"), "연도별 폴더로 나뉜 TS는 번호가 전체에서 이어짐(TS-003)");
  ok(sr.types.find((t) => t.prefix === "IMP")?.missingInIndex.includes("IMP-1-a.md"), "목록에 IMP-10만 있으면 IMP-1은 빠진 것으로 봄");
  w("imp2/IMP-020 결과.md"); w("imp2/IMP-021-b.md"); w("imp2/_index.md", "| [IMP-020](IMP-020%20결과.md) | p95 75% 감소 |\n| [IMP-021](IMP-021-b.md) | x |\n");
  w("docs/tutorial/step-1.md"); w("docs/tutorial/step-2.md"); w("docs/tutorial/README.md", "# 튜토리얼\n");
  w("docs/adr2/adr-0001-a.md"); w("docs/adr2/ADR-0001-b.md");
  const sr2 = scan(s);
  ok(!sr2.types.find((t) => t.dir === "imp2")?.missingInIndex.length, "목록 본문에 %가 있어도 %20 인코딩 링크를 읽음", JSON.stringify(sr2.types.find((t) => t.dir === "imp2")));
  ok(!sr2.types.some((t) => t.dir === "docs/tutorial"), "step-1.md 같은 일반 문서는 기록으로 잡지 않음");
  ok(sr2.types.find((t) => t.dir === "docs/adr2")?.duplicateNumbers.includes(1), "adr-0001과 ADR-0001의 번호 중복을 잡음");
  w("lb/docs/adr/20240115-use-kafka.md"); w("lb/docs/adr/20240302-drop-redis.md");
  w("madr/docs/decisions/0000-template.md"); w("madr/docs/decisions/0001-a.md"); w("madr/docs/decisions/index.md", "- [0001](0001-a.md)\n");
  w("readme-only/docs/adr/0001-a.md"); w("readme-only/docs/adr/README.md", "# 결정 기록\n이 폴더에는 결정을 적는다.\n");
  w("ids/docs/troubleshooting/TS-001-slow-query.md"); w("ids/docs/troubleshooting/_index.md", "| TS-001 | 느린 쿼리 |\n");
  w("mono/docs/adr/0001-a.md"); w("mono/docs/adr/0005-b.md"); w("mono/services/pay/docs/adr/0001-c.md");
  w("docs/notes/UTF-8.md"); w("docs/notes/README.md", "# 노트\n");
  const sr3 = scan(s);
  const at = (dir) => sr3.types.find((t) => t.dir === dir);
  ok(at("lb/docs/adr")?.count === 2 && /날짜형/.test(at("lb/docs/adr").nextId), "log4brains 날짜형(20240115-x.md)도 읽음", JSON.stringify(at("lb/docs/adr")));
  ok(at("madr/docs/decisions")?.count === 1 && !at("madr/docs/decisions").missingInIndex.length, "0000-template.md는 기록으로 세지 않음");
  ok(!at("readme-only/docs/adr")?.index, "설명만 있는 README는 목록으로 쓰지 않음(--check 오탐 없음)");
  ok(!at("ids/docs/troubleshooting")?.missingInIndex.length, "링크 없이 ID(TS-001)만 적은 목록도 인정");
  ok(at("mono/services/pay/docs/adr")?.nextId === "0002", "접두어 없는 번호는 폴더마다 따로(monorepo 서비스별 adr)", JSON.stringify(at("mono/services/pay/docs/adr")));
  ok(!at("docs/notes"), "UTF-8.md 같은 대문자 일반 문서는 기록으로 세지 않음");
  fs.writeFileSync(path.join(s, ".records.json"), JSON.stringify({ types: { PM: { dir: "docs/postmortems", kind: "troubleshooting" } } }));
  ok(scan(s).types.some((t) => t.name === "PM" && t.nextId === "PM-001" && t.count === 0), "설정에만 있는 종류는 PM-001부터");

  // hook
  const tl = (name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  const k6 = tl("Bash", { command: "k6 run --summary-export benchmarks/x-after.json t.js" });
  ok(decide(analyze([k6, tl("Write", { file_path: "docs/troubleshooting/TS-012.md" })])) === null, "slug 없는 TS-012.md도 기록으로 인정");
  ok(decide(analyze([k6, tl("Write", { file_path: "docs/트러블슈팅/TS-3-x.md" })])) === null, "한글 폴더(트러블슈팅)의 기록도 인정");
  ok(decide(analyze([k6, tl("Bash", { command: "cat > docs/improvements/IMP-004-x.md <<'EOF'" })])) === null, "셸로 쓴 기록 문서도 인정");
  ok(decide(analyze([tl("Edit", { file_path: "src/common/result/ApiResult.java" }), tl("Bash", { command: "ls benchmarks && cat benchmarks/a.json" })])) === null, "result 폴더 코드 수정·ls benchmarks는 측정으로 보지 않음");
  ok(decide(fromGitStatus("?? benchmarks/q-after.json\n M src/a.ts\n", analyze([tl("Bash", { command: "node bench.mjs after benchmarks/q-after.json" })])))?.length >= 1, "스크립트가 인자로 받은 경로에 쓴 벤치 파일도 git 작업 트리에서 찾아 알림");
  ok(decide(fromGitStatus("?? benchmarks/q-after.json\n?? docs/improvements/IMP-009-q.md\n", analyze([]))) === null, "작업 트리에 기록 문서가 새로 있으면 알리지 않음");
  ok(decide(analyze([tl("Bash", { command: "cat gatling.conf && cat hyperfine-notes.md" })])) === null, "cat gatling.conf처럼 도구 이름만 나온 명령은 측정이 아님");
  ok(decide(analyze([tl("Bash", { command: "docker run --rm -i grafana/k6 run - < load.js" })]))?.length >= 1, "도커로 돌린 k6(grafana/k6 run)도 측정");
  ok(decide(analyze([k6, tl("Write", { file_path: "docs/performance/PERF-003-x.md" })])) === null && decide(analyze([k6, tl("Write", { file_path: "docs/records/TS-001-x.md" })])) === null, "performance·records 폴더의 기록도 인정");
  ok(decide(analyze([tl("Bash", { command: "node scripts/trace.mjs" })])) === null, "trace.mjs를 race.mjs로 오인하지 않음");
  ok(decide(analyze([k6, tl("PowerShell", { command: "Set-Content -Path docs/improvements/IMP-010-x.md -Value $t" })])) === null, "PowerShell Set-Content로 쓴 기록도 인정");
  const cwdA = path.join(os.tmpdir(), "adrian", "shop");
  ok(decide(analyze([k6, tl("Write", { file_path: path.join(cwdA, "docs", "week-01.md") })], cwdA))?.length >= 1, "사용자 폴더 이름(adrian)에 걸려 일반 문서를 기록으로 오인하지 않음");
}

console.log("\n# 작업 끝 알림 hook");
{
  const tl = (name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  const measured = [tl("Bash", { command: "k6 run --summary-export benchmarks/search-after.json load.js" }), tl("Edit", { file_path: "src/search/Repo.java" })];
  ok(decide(analyze(measured))?.length >= 1, "k6를 돌리고 원자료를 남겼는데 기록이 없으면 알림");
  ok(decide(analyze([...measured, tl("Write", { file_path: "docs/improvements/IMP-003-search.md" })])) === null, "기록 문서를 썼으면 알리지 않음");
  ok(decide(analyze([tl("Edit", { file_path: "src/a.ts" }), tl("Bash", { command: "npm test" })])) === null, "평범한 수정과 테스트만 했으면 알리지 않음");
  ok(decide(analyze([tl("Edit", { file_path: "db/migration/V12__add_index.sql" })]))?.[0]?.includes("설계"), "마이그레이션을 바꾸면 결정 기록 후보로 알림");
  ok(decide(analyze([tl("Write", { file_path: "notes/IMP-1-x.md" }), tl("Bash", { command: "hyperfine ./a" })]))?.length >= 1, "기록 폴더 밖의 비슷한 이름은 기록으로 치지 않음");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "records-hook-")); cleanup.push(tmp);
  const transcript = path.join(tmp, "t.jsonl");
  fs.writeFileSync(transcript, measured.join("\n") + "\n");
  const sid = "test-" + process.pid + "-" + Date.now();
  const run = (mode, extra = {}) => spawnSync(process.execPath, [S("remind-hook.mjs"), mode], { input: JSON.stringify({ session_id: sid + mode, transcript_path: transcript, ...extra }), encoding: "utf8" });
  const o1 = run("observe");
  ok(/systemMessage/.test(o1.stdout) && o1.status === 0, "observe: 사용자에게 알림만(종료 코드 0)", o1.stdout + o1.stderr);
  ok(run("observe").stdout === "", "같은 세션에서는 한 번만 알림");
  const n1 = run("nudge");
  ok(/"decision":"block"/.test(n1.stdout) && /기록 불필요/.test(n1.stdout), "nudge: 한 번 이어서 판정하게 함");
  ok(run("nudge", { session_id: sid + "x", stop_hook_active: true }).stdout === "", "hook 때문에 이어진 턴에서는 다시 막지 않음");
  ok(run("off", { session_id: sid + "off" }).stdout === "", "off 모드는 아무것도 하지 않음");
  ok(spawnSync(process.execPath, [S("remind-hook.mjs")], { input: "not json", encoding: "utf8" }).status === 0, "입력이 깨져도 작업을 막지 않음(종료 코드 0)");
  for (const m of ["observe", "nudge", "off"]) fs.rmSync(path.join(os.tmpdir(), "engineering-records", `${sid}${m}.done`), { force: true });
}

console.log("\n# hook 설치");
{
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "records-install-")); cleanup.push(p);
  fs.mkdirSync(path.join(p, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(p, ".claude"));
  fs.writeFileSync(path.join(p, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "node other.mjs" }] }] } }));
  const i1 = spawnSync(process.execPath, [S("install-hook.mjs"), p, "local", "observe"], { encoding: "utf8" });
  const s1 = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf8"));
  ok(i1.status === 0 && s1.permissions.allow[0] === "Bash(npm test)" && s1.hooks.Stop.length === 2, "기존 권한·hook을 지우지 않고 Stop hook을 더함", i1.stderr);
  ok(fs.existsSync(path.join(p, ".claude/hooks/records-reminder.mjs")), "hook 파일을 프로젝트에 복사");
  ok(fs.readFileSync(path.join(p, ".git/info/exclude"), "utf8").includes(".claude/hooks/records-reminder.mjs"), "local 설치는 hook 파일을 git에서 뺌");
  spawnSync(process.execPath, [S("install-hook.mjs"), p, "local", "nudge"], { encoding: "utf8" });
  const s2 = JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf8"));
  ok(s2.hooks.Stop.length === 2 && /nudge$/.test(s2.hooks.Stop[1].hooks[0].command), "다시 설치하면 중복 없이 모드만 바꿈");
  ok(fs.readFileSync(path.join(p, ".git/info/exclude"), "utf8").includes(".claude/settings.local.json"), "local 설치는 settings.local.json도 git에서 뺌");
  const i4 = spawnSync(process.execPath, [S("install-hook.mjs"), p, "commit"], { encoding: "utf8" });
  ok(i4.status === 0 && !fs.readFileSync(path.join(p, ".git/info/exclude"), "utf8").split(/\r?\n/).includes(".claude/hooks/records-reminder.mjs"), "commit으로 다시 설치하면 hook 파일 제외를 풀어 팀원도 받게 함");
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "records-wt-")); cleanup.push(wt);
  const common = path.join(wt, "main.git"); fs.mkdirSync(path.join(common, "worktrees", "w1"), { recursive: true });
  fs.writeFileSync(path.join(common, "worktrees", "w1", "commondir"), "../..");
  const wdir = path.join(wt, "w1"); fs.mkdirSync(wdir);
  fs.writeFileSync(path.join(wdir, ".git"), `gitdir: ${path.join(common, "worktrees", "w1")}`);
  spawnSync(process.execPath, [S("install-hook.mjs"), wdir, "local"], { encoding: "utf8" });
  ok(fs.existsSync(path.join(common, "info", "exclude")) && fs.readFileSync(path.join(common, "info", "exclude"), "utf8").includes("records-reminder"), "worktree(.git이 파일)에서는 공용 git 폴더의 exclude에 씀");
  ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(p, ".claude", "settings.local.json"), "utf8"))).includes("records-reminder"), "commit으로 옮기면 settings.local.json의 같은 hook은 지움(두 개가 같이 돌지 않게)");
  const sub = path.join(p, "services", "api"); fs.mkdirSync(sub, { recursive: true });
  const i5 = spawnSync(process.execPath, [S("install-hook.mjs"), sub, "local"], { encoding: "utf8" });
  ok(i5.status === 0 && fs.readFileSync(path.join(p, ".git/info/exclude"), "utf8").includes("services/api/.claude/hooks/records-reminder.mjs"), "저장소 하위 폴더 프로젝트도 루트의 exclude에 경로를 붙여 씀", i5.stdout);
  const bom = fs.mkdtempSync(path.join(os.tmpdir(), "records-bom-")); cleanup.push(bom);
  fs.mkdirSync(path.join(bom, ".claude"));
  fs.writeFileSync(path.join(bom, ".claude", "settings.local.json"), "﻿" + JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
  const ib = spawnSync(process.execPath, [S("install-hook.mjs"), bom, "local"], { encoding: "utf8" });
  ok(ib.status === 0 && JSON.parse(fs.readFileSync(path.join(bom, ".claude", "settings.local.json"), "utf8")).permissions.allow[0] === "Bash(ls)", "BOM이 붙은 설정 파일도 읽고 기존 내용을 지키며 설치", ib.stderr);
  const odd = fs.mkdtempSync(path.join(os.tmpdir(), "records-odd-")); cleanup.push(odd);
  fs.mkdirSync(path.join(odd, ".claude"));
  fs.writeFileSync(path.join(odd, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: { hooks: [] } } }));
  const io = spawnSync(process.execPath, [S("install-hook.mjs"), odd, "local"], { encoding: "utf8" });
  ok(io.status === 1 && !fs.existsSync(path.join(odd, ".claude/hooks/records-reminder.mjs")), "hooks.Stop이 배열이 아니면 hook 파일도 복사하지 않고 1");
  fs.writeFileSync(path.join(p, ".claude", "settings.json"), "{ broken");
  const i3 = spawnSync(process.execPath, [S("install-hook.mjs"), p, "commit"], { encoding: "utf8" });
  ok(i3.status === 1 && fs.readFileSync(path.join(p, ".claude", "settings.json"), "utf8") === "{ broken", "설정 파일이 깨져 있으면 고치지 않고 1");
  ok(spawnSync(process.execPath, [S("install-hook.mjs"), p, "everywhere"], { encoding: "utf8" }).status === 1, "잘못된 인자는 1");
}

for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
