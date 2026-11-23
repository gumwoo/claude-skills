#!/usr/bin/env node
// 검사기 테스트. 브라우저가 없으면 건너뛴다.
// 사용법: node tests/run-tests.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, launch } from "../scripts/lib/browser.mjs";
import { checkUi } from "../scripts/check-ui.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLI = path.join(ROOT, "scripts", "check-ui.mjs");
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const rules = (r, level) => new Set(r.findings.filter((f) => !level || f.level === level).map((f) => f.rule));
const list = (r) => r.findings.map((f) => `${f.level} ${f.rule}`).join(", ") || "(없음)";

if (!findBrowser()) {
  console.log("Chrome·Edge·Chromium이 없어 테스트를 건너뜁니다. CHROME_PATH로 지정할 수 있습니다.");
  process.exit(0);
}

const browser = await launch();
try {
  console.log("\n# 틀린 화면은 규칙마다 잡아야 한다");
  {
    const [m, d] = (await checkUi(path.join(HERE, "fixtures/bad.html"), { browser })).results;
    const mr = rules(m);
    for (const rule of ["ko-midword-break", "num-comma", "contrast", "dark-prechecked", "overflow-x", "ko-font-stack", "ko-line-height",
      "ko-small-text", "copy-click", "emoji-icon", "copy-double-passive", "dark-confirmshaming", "copy-tone-mix", "touch-target", "ai-gradient",
      "ko-heading-tracking", "copy-weed"]) ok(mr.has(rule), `bad.html 모바일: ${rule}`, list(m));
    ok(!rules(d).has("touch-target"), "bad.html 데스크톱: touch-target은 모바일에서만 본다");
    ok(!rules(d).has("overflow-x"), "bad.html 데스크톱: 600px 요소는 1440 화면에서 넘치지 않는다");
    const midword = m.findings.filter((f) => f.rule === "ko-midword-break");
    ok(midword.length >= 1 && midword.every((f) => f.level === "ERROR"), "어절 중간 줄바꿈은 ERROR");
  }

  console.log("\n# 오탐이 나면 안 되는 경우");
  {
    const [m] = (await checkUi(path.join(HERE, "fixtures/ok-edge-cases.html"), { viewport: "mobile", browser })).results;
    const mr = rules(m);
    ok(!mr.has("ko-midword-break"), "keep-all 문단은 어절 중간에서 끊기지 않는다", list(m));
    ok(!mr.has("num-comma"), "연도·전화번호·주문번호·쉼표 있는 금액은 num-comma 아님", list(m));
    ok(!mr.has("contrast"), "사진 위 반투명 배지는 섞은 배경으로 대비를 계산한다", list(m));
    ok(!mr.has("ai-shadow"), "inset 그림자(테두리 대용)는 그림자로 세지 않는다", list(m));
    ok(!mr.has("ko-line-height"), "제목과 키 큰 한 줄 링크는 줄 간격 검사 대상이 아니다", list(m));
    ok(!mr.has("copy-tone-mix"), "푸터의 합쇼체 법적 문구는 말투 섞임에서 빠진다", list(m));
  }

  console.log("\n# 예시 화면: before는 잡고, 나머지는 깨끗해야 한다");
  {
    const [b] = (await checkUi(path.join(ROOT, "examples/market-before.html"), { viewport: "mobile", browser })).results;
    const br = rules(b, "ERROR");
    for (const rule of ["ko-midword-break", "num-comma", "contrast", "dark-prechecked"]) ok(br.has(rule), `market-before: ERROR ${rule}`, list(b));
    for (const rule of ["ai-gradient", "emoji-icon", "copy-tone-mix", "ko-font-stack", "dark-confirmshaming"]) ok(rules(b).has(rule), `market-before: ${rule}`, list(b));
    for (const f of ["market-after", "app-home", "app-detail", "app-checkout", "web-booking"]) {
      const res = (await checkUi(path.join(ROOT, `examples/${f}.html`), { viewport: f === "web-booking" ? "both" : "mobile", browser })).results;
      for (const r of res) ok(r.findings.filter((x) => x.level !== "INFO").length === 0, `${f} ${r.name}: ERROR·WARN 없음`, list(r));
    }
  }
} finally {
  await browser.close();
}

console.log("\n# CLI 종료 코드");
{
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  ok(run(path.join(HERE, "fixtures/bad.html"), "--viewport", "mobile").status === 2, "ERROR가 있으면 2");
  ok(run(path.join(ROOT, "examples/market-after.html"), "--viewport", "mobile").status === 0, "ERROR가 없으면 0");
  ok(run(path.join(HERE, "fixtures/없는파일.html")).status === 1, "파일이 없으면 1");
  ok(run(path.join(HERE, "fixtures/bad.html"), "--viewport", "tablet").status === 1, "잘못된 --viewport는 1");
  const j = run(path.join(HERE, "fixtures/bad.html"), "--viewport", "mobile", "--json");
  let parsed = null; try { parsed = JSON.parse(j.stdout); } catch { /* 아래에서 실패 처리 */ }
  ok(parsed?.results?.[0]?.findings?.length > 0, "--json 출력은 파싱 가능한 JSON");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
