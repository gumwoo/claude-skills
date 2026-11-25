#!/usr/bin/env node
// HWPX 양식의 지도(문단·표·칸 주소와 글자)와 채울 칸 후보를 보여 준다. 양식 파일은 바꾸지 않는다.
//
// 사용: node scan-template.mjs <양식.hwpx> [--json]
// 종료 코드: 0 = 성공, 1 = 읽기 실패
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTemplate, scanTemplate, scanText } from "./lib/hwpx-template.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("사용: node scan-template.mjs <양식.hwpx> [--json]"); process.exit(1); }
  if (/\.hwp$/i.test(file)) { console.error("바이너리 HWP 양식은 아직 못 읽습니다. 한컴에서 HWPX로 저장해 주세요"); process.exit(1); }
  try {
    const doc = parseTemplate(fs.readFileSync(file));
    console.log(args.includes("--json") ? JSON.stringify(scanTemplate(doc), null, 1) : scanText(doc));
  } catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
}
