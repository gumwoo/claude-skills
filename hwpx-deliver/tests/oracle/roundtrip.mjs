#!/usr/bin/env node
// 개발 검증용(한컴오피스가 깔린 Windows에서만): fixture를 빌드하고, 한컴으로 열어 다시 저장한 PDF와 우리 PDF를 비교한다.
// 필요: 한컴오피스(HWPFrame.HwpObject), Python + PyMuPDF. skill 실행에는 쓰지 않는다.
//
// 사용: node tests/oracle/roundtrip.mjs <doc.json> [이름]
// 결과는 %TEMP%/hwpx-deliver-oracle/out 에 남는다(<이름>.hwpx, .pdf, .hancom.pdf, .hancom.txt, -cmp-p*.png)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../scripts/build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [docFile, nameArg] = process.argv.slice(2);
if (!docFile) { console.error("사용: node tests/oracle/roundtrip.mjs <doc.json> [이름]"); process.exit(1); }
const name = nameArg ?? path.basename(docFile).replace(/\.json$/i, "");
const out = path.join(os.tmpdir(), "hwpx-deliver-oracle", "out");
build(JSON.parse(fs.readFileSync(docFile, "utf8")), { outDir: out, name });

// 한컴은 임시 폴더 밖 파일을 열 때 확인 창을 띄우므로 결과 폴더를 %TEMP% 아래에 둔다
const ps = spawnSync("powershell", ["-NoProfile", "-Command", `$j = Start-Job -ScriptBlock { param($s,$h,$o) & $s -Hwpx $h -OutDir $o } -ArgumentList '${path.join(here, "hancom-open.ps1")}','${path.join(out, `${name}.hwpx`)}','${out}'; if (Wait-Job $j -Timeout 120) { Receive-Job $j } else { 'TIMEOUT'; Stop-Job $j }`], { encoding: "utf8" });
console.log(ps.stdout.trim());
const py = spawnSync("python", ["-P", path.join(here, "compare_pdf.py"), path.join(out, `${name}.hancom.pdf`), path.join(out, `${name}.pdf`), "--png", path.join(out, `${name}-cmp.png`)], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
const r = JSON.parse(py.stdout);
console.log(JSON.stringify({ pages: r.pages, lines_per_page: r.lines, matched_lines: r.matched_lines, baseline_diff_mm: r.y_diff_mm, line_end_differs: r.line_end_differs.length, same_page_breaks: r.same_page_breaks }, null, 1));
for (const d of r.line_end_differs) console.log("줄 끝 다름:", JSON.stringify(d));
console.log(`비교 이미지: ${out}`);
