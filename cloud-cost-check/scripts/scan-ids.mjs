#!/usr/bin/env node
// 다른 사람(고객·팀)에게 넘길 보고서에 식별자가 남았는지 찾는다: AWS 계정 ID, ARN, IP, 이메일, 액세스 키.
// 찾기만 하고 고치지 않는다.
//
// 사용: node scan-ids.mjs <보고서.md>...
// 종료 코드: 0 = 없음, 2 = 있음, 1 = 읽기 실패
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RULES = [
  ["ARN", /\barn:aws[\w-]*:[\w-]+:[\w-]*:(?:\d{12})?:[^\s|)`'",]+/g],
  // 금액의 일부(1,234,567,890,123)나 소수는 빼고, 문장 끝 마침표·목록 쉼표 앞은 잡는다
  ["AWS 계정 ID", /(?<!\d|\d[,.])\d{12}(?!\d|[,.]\d)/g],
  ["AWS 계정 ID", /(?<![\d-])\d{4}-\d{4}-\d{4}(?![\d-])/g],
  ["액세스 키", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["IPv4", /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?!\.\d)/g],
  ["이메일", /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g],
];
// 문서에 흔히 나오는 예시 값은 식별자로 보지 않는다
const ALLOW = [/^0\.0\.0\.0$/, /^127\./, /^10\.0\.0\.0$/, /^172\.16\.0\.0$/, /^192\.168\.0\.0$/, /^255\./, /^111122223333$/, /^123456789012$/, /@example\.(com|org)$/];

export function scanIds(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const arnSpans = [];
    for (const [name, re] of RULES) {
      for (const m of line.matchAll(re)) {
        const v = m[0];
        if (ALLOW.some((a) => a.test(v))) continue;
        if (name === "ARN") arnSpans.push([m.index, m.index + v.length]);
        // ARN 안에 든 계정 ID는 ARN으로 한 번만 센다
        else if (arnSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
        hits.push({ line: i + 1, kind: name, value: v });
      }
    }
  });
  return hits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("사용: node scan-ids.mjs <보고서.md>..."); process.exit(1); }
  let total = 0;
  try {
    for (const f of files) {
      const hits = scanIds(fs.readFileSync(f, "utf8"));
      total += hits.length;
      for (const h of hits) console.log(`${f}:${h.line}  ${h.kind}  ${h.value}`);
    }
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
  console.log(total ? `식별자 ${total}개 — 가리거나(예: 계정 ****1234) 지운 뒤 다시 검사` : "식별자 없음");
  process.exit(total ? 2 : 0);
}
