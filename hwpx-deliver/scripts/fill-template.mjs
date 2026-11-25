#!/usr/bin/env node
// HWPX 양식에 값을 넣는다. 양식 파일은 바꾸지 않고 새 파일을 쓴다.
//
// 사용: node fill-template.mjs <양식.hwpx> <fill.json> --out <결과.hwpx>
//
// fill.json: { "ops": [ ... ] }  (주소는 scan-template.mjs가 보여 준 것)
//   { "at": "T1.r2c1.p5", "text": "..." }                    문단 글자를 바꾼다("\n"이면 문단을 늘린다)
//   { "at": "T1.r6c2", "text": "..." }                       칸 글자를 바꾼다(줄마다 칸 안 문단에 차례로)
//   { "at": "T1.r2c1", "find": "제목 ", "text": "제목 ..." } 문단·칸 안의 글자를 찾아 바꾼다(한 번만 있어야 함. 여러 번이면 "all": true. 탭을 걸칠 수는 없다. text의 "\n"은 줄바꿈)
//   { "table": "T2", "from_row": 3, "rows": [["1", "..."], ...] }   반복 행: 3행부터 채우고 모자라면 3행을 복제해 늘린다
//   { "delete_row": "T1.r11" }                                행을 지운다(서식 안내 행 등)
//   어느 op에나 "src": ["S1:3"]를 붙여 근거를 적을 수 있다. 결과 파일에는 들어가지 않는다
// 종료 코드: 0 = 성공, 1 = 실패(주소를 못 찾음, 찾을 글자가 없거나 여러 번 등), 2 = 결과 HWPX에 구조 오류
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fillTemplate } from "./lib/hwpx-template.mjs";
import { checkHwpx } from "./check-hwpx.mjs";

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function readOps(file) {
  const j = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  const ops = Array.isArray(j) ? j : j.ops;
  if (!Array.isArray(ops)) throw new Error('fill.json은 { "ops": [...] } 형식이어야 합니다');
  return ops;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const out = oi >= 0 ? args[oi + 1] : null;
  const [tmpl, fill] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!tmpl || !fill || !out) { console.error("사용: node fill-template.mjs <양식.hwpx> <fill.json> --out <결과.hwpx>"); process.exit(1); }
  // Windows·macOS는 파일 이름의 대소문자를 구분하지 않는다
  const same = (a, b) => (process.platform === "linux" ? path.resolve(a) === path.resolve(b) : path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());
  if (same(out, tmpl)) { console.error("결과 파일이 양식 파일과 같습니다. 양식은 덮어쓰지 않습니다"); process.exit(1); }
  let r;
  try { r = fillTemplate(fs.readFileSync(tmpl), readOps(fill)); }
  catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, r.buf);
  for (const l of r.log) console.log(`- ${l}`);
  const chk = checkHwpx(r.buf);
  for (const e of chk.errors) console.log(`구조 오류 [${e.code}] ${e.msg}`);
  console.log(`결과: ${out} (${r.log.length}개 적용, ${chk.errors.length ? `구조 오류 ${chk.errors.length}개` : "구조 오류 없음"})`);
  process.exit(chk.errors.length ? 2 : 0);
}
