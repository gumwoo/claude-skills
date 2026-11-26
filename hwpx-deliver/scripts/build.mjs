#!/usr/bin/env node
// 문서 모델(doc.json) → 문서.hwpx + 문서.pdf. 한컴오피스 없이 만든다.
// PDF는 같은 모델로 그린 HTML을 설치된 Edge·Chrome으로 인쇄해서 만든다.
//
// 사용: node build.mjs <doc.json> --out <폴더> [--name 파일이름] [--work <중간 파일 폴더>] [--no-pdf]
//   PDF를 그린 HTML(중간 파일)은 --work 폴더에, 주지 않으면 임시 폴더에 둔다. 결과 폴더(고객용)에는 HWPX·PDF만 생긴다
// 종료 코드: 0 = 성공, 1 = 실패(모델 오류, 글꼴 없음, 브라우저 없음 등)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalize } from "./lib/model.mjs";
import { buildHwpx } from "./lib/hwpx-write.mjs";
import { buildHtml } from "./lib/html-render.mjs";
import { missingFonts } from "./lib/fonts.mjs";

export function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pf = process.env.ProgramFiles || "C:\\Program Files", pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", local = process.env.LOCALAPPDATA || "";
  const list = {
    win32: [`${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${local}/Google/Chrome/Application/chrome.exe`],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
  }[process.platform] ?? [];
  return list.find((p) => fs.existsSync(p)) ?? null;
}

export function printPdf(htmlFile, pdfFile) {
  const browser = findBrowser();
  if (!browser) throw new Error("PDF를 만들 브라우저(Edge·Chrome)를 찾지 못했습니다. CHROME_PATH로 지정하세요.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-browser-"));
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  pdfFile = path.resolve(pdfFile);
  fs.rmSync(pdfFile, { force: true });
  try {
    const r = spawnSync(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-pdf-header-footer", `--user-data-dir=${profile}`, `--print-to-pdf=${pdfFile}`, pathToFileURL(path.resolve(htmlFile)).href], { encoding: "utf8", timeout: 120000, windowsHide: true });
    // Windows의 Edge는 실행 파일이 곧바로 끝나고 하위 프로세스가 나중에 PDF를 쓴다. 크기가 멈출 때까지 기다린다
    let last = -1;
    for (let i = 0; i < 240; i++) {
      const size = fs.existsSync(pdfFile) ? fs.statSync(pdfFile).size : -1;
      if (size > 0 && size === last) break;
      last = size;
      sleep(250);
    }
    if (!fs.existsSync(pdfFile) || fs.statSync(pdfFile).size === 0) throw new Error(`PDF 인쇄 실패: ${(r.stderr || r.error?.message || "브라우저가 파일을 만들지 않음").trim().slice(0, 300)}`);
  } finally {
    for (let i = 0; i < 20; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { sleep(250); } }
  }
}

export function build(doc, { outDir, name = "문서", pdf = true, workDir = null }) {
  const m = normalize(doc);
  const lost = missingFonts(Object.values(m.preset.fonts));
  if (lost.length) throw new Error(`이 PC에 없는 글꼴: ${lost.join(", ")} — 설치하거나 서식의 글꼴을 바꾸세요(대체하면 한컴과 줄·쪽 나눔이 달라집니다)`);
  fs.mkdirSync(outDir, { recursive: true });
  const hwpx = path.join(outDir, `${name}.hwpx`);
  fs.writeFileSync(hwpx, buildHwpx(m));
  // 중간 파일은 고객 폴더에 두지 않는다(실사용 시험에서 매번 Claude가 옮겨야 했다)
  const work = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "hwpx-deliver-build-"));
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, `${name}.html`);
  fs.writeFileSync(html, buildHtml(m));
  let pdfFile = null;
  if (pdf) {
    pdfFile = path.join(outDir, `${name}.pdf`);
    printPdf(html, pdfFile);
  }
  return { hwpx, html, pdf: pdfFile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && !["--out", "--name", "--work"].includes(args[i - 1]));
  if (!file || !opt("--out")) { console.error("사용: node build.mjs <doc.json> --out <폴더> [--name 이름] [--work 폴더] [--no-pdf]"); process.exit(1); }
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const r = build(doc, { outDir: opt("--out"), name: opt("--name") ?? path.basename(file).replace(/\.json$/i, ""), pdf: !args.includes("--no-pdf"), workDir: opt("--work") });
    console.log(`HWPX: ${r.hwpx}${r.pdf ? `\nPDF:  ${r.pdf}` : ""}`);
  } catch (e) {
    console.error(`실패: ${e.message}`);
    process.exit(1);
  }
}
