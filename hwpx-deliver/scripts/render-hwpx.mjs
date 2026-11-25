#!/usr/bin/env node
// 이미 있는 HWPX(양식을 채운 문서 등)를 그대로 그려 PDF로 만든다. 한컴오피스 없이 설치된 Edge·Chrome으로 인쇄한다.
//
// 사용: node render-hwpx.mjs <문서.hwpx> --out <결과.pdf> [--html <html 경로>] [--strict-fonts]
//   양식이 쓰는 글꼴이 PC에 없으면 알리고 대체 글꼴(명조 계열은 바탕, 나머지는 돋움)로 그린다.
//   대체하면 줄·쪽 나눔이 한컴과 달라질 수 있다. --strict-fonts를 주면 대체하지 않고 멈춘다.
// 종료 코드: 0 = 성공(그리지 못한 것이 있으면 경고를 출력), 1 = 실패
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHwpx } from "./lib/hwpx-render.mjs";
import { missingFonts } from "./lib/fonts.mjs";
import { printPdf } from "./build.mjs";

export function renderToPdf(file, { out, html, strictFonts = false }) {
  const buf = fs.readFileSync(file), title = path.basename(file).replace(/\.hwpx$/i, "");
  // 한 번 그려 필요한 글꼴을 알고, 없는 글꼴을 넘겨 다시 그린다(굵은 계열 대체)
  const lost = missingFonts(renderHwpx(buf, { title }).fonts);
  const r = renderHwpx(buf, { title, missing: new Set(lost) });
  if (lost.length && strictFonts) throw new Error(`이 PC에 없는 글꼴: ${lost.join(", ")} — 설치하거나 --strict-fonts 없이 대체 글꼴로 그리세요(줄·쪽 나눔이 한컴과 달라질 수 있습니다)`);
  const htmlFile = html ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-render-")), "doc.html");
  fs.mkdirSync(path.dirname(path.resolve(htmlFile)), { recursive: true });
  fs.writeFileSync(htmlFile, r.html);
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); printPdf(htmlFile, out); }
  return { ...r, lostFonts: lost, htmlFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && !["--out", "--html"].includes(args[i - 1]));
  if (!file || !opt("--out")) { console.error("사용: node render-hwpx.mjs <문서.hwpx> --out <결과.pdf> [--html 경로] [--strict-fonts]"); process.exit(1); }
  if (/\.hwp$/i.test(file)) { console.error("바이너리 HWP는 그리지 못합니다. HWPX로 저장한 파일을 주세요"); process.exit(1); }
  try {
    const r = renderToPdf(file, { out: opt("--out"), html: opt("--html"), strictFonts: args.includes("--strict-fonts") });
    for (const w of r.warnings) console.log(`경고: ${w}`);
    if (r.lostFonts.length) console.log(`경고: PC에 없는 글꼴을 대체해 그림(줄 나눔이 달라질 수 있음): ${r.lostFonts.join(", ")}`);
    console.log(`PDF: ${opt("--out")}`);
  } catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
}
