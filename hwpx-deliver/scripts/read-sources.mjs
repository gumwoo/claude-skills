#!/usr/bin/env node
// 원자료를 읽어 번호 붙은 조각으로 나눈다. 문서 모델의 src는 여기서 나온 id("S1:12")를 가리킨다.
//
// 사용: node read-sources.mjs <파일...> --out <폴더>
//   <폴더>/sources.json  조각 전체(deliver-check가 쓴다)
//   <폴더>/sources.txt   Claude가 읽을 목록(조각 id와 글자)
// 종료 코드: 0 = 성공, 1 = 읽지 못한 파일이 있음(이유를 알린다)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, listing } from "./lib/sources.mjs";

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const oi = args.indexOf("--out");
  const out = oi >= 0 ? args[oi + 1] : null;
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!files.length || !out) { console.error("사용: node read-sources.mjs <파일...> --out <폴더>"); process.exit(1); }
  const sources = [], failed = [];
  files.forEach((f) => {
    try { sources.push(readSource(f, sources.length + failed.length + 1)); }
    catch (e) { failed.push(`${f}: ${e.code === "ENOENT" ? "파일이 없습니다" : e.message}`); }
  });
  const src = { sources };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "sources.json"), JSON.stringify(src, null, 1));
  fs.writeFileSync(path.join(out, "sources.txt"), listing(src));
  for (const s of sources) console.log(`${s.id} ${s.file}: ${s.kind}, 조각 ${s.units.length}개`);
  console.log(`목록: ${path.join(out, "sources.txt")}`);
  if (failed.length) { console.error(`읽지 못함:\n- ${failed.join("\n- ")}`); process.exit(1); }
}
