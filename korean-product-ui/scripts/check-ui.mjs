#!/usr/bin/env node
// 화면을 실제 브라우저로 그려 놓고 한국어 서비스 화면에서 자주 틀리는 것들을 검사한다.
// 사용법: node check-ui.mjs <html 파일|URL> [--viewport mobile|desktop|both] [--shot 파일.png] [--full] [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, openPage } from "./lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORTS = {
  mobile: { width: 390, height: 844, mobile: true, dpr: 2 },
  desktop: { width: 1440, height: 900, mobile: false, dpr: 1 },
};

function parseArgs(argv) {
  const o = { target: null, viewport: "both", shot: null, full: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--viewport") o.viewport = argv[++i];
    else if (a === "--shot") o.shot = argv[++i];
    else if (a === "--full") o.full = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!o.target) o.target = a;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!["mobile", "desktop", "both"].includes(o.viewport)) throw new Error(`--viewport는 mobile|desktop|both 중 하나: ${o.viewport}`);
  return o;
}

function toUrl(target) {
  if (/^(https?|file):\/\//i.test(target)) return target;
  const p = path.resolve(target);
  if (!fs.existsSync(p)) throw new Error(`파일이 없습니다: ${p}`);
  return pathToFileURL(p).href;
}

function shotPath(base, name, both) {
  if (!base) return null;
  if (!both) return base;
  const ext = path.extname(base) || ".png";
  return base.slice(0, base.length - path.extname(base).length) + "-" + name + ext;
}

/** browser를 넘기면 그 브라우저를 재사용하고 닫지 않는다(여러 화면을 연달아 검사할 때) */
export async function checkUi(target, { viewport = "both", shot = null, full = false, browser: shared = null } = {}) {
  const url = toUrl(target);
  const names = viewport === "both" ? ["mobile", "desktop"] : [viewport];
  const auditSrc = fs.readFileSync(path.join(HERE, "lib", "audit-page.js"), "utf8").trim();
  const browser = shared ?? await launch();
  const results = [];
  try {
    for (const name of names) {
      const vp = VIEWPORTS[name];
      const page = await openPage(browser, vp);
      await page.goto(url);
      const r = await page.evaluate(`(${auditSrc})(${JSON.stringify({ mobile: vp.mobile, width: vp.width, height: vp.height })})`);
      const file = shotPath(shot, name, names.length > 1);
      if (file) await page.screenshot(file, { fullPage: full });
      await page.close();
      results.push({ ...r, name, screenshot: file });
    }
  } finally {
    if (!shared) await browser.close();
  }
  return { url, results };
}

const ORDER = { ERROR: 0, WARN: 1, INFO: 2 };

function printText({ url, results }) {
  console.log(`검사 대상: ${url}`);
  for (const r of results) {
    const counts = { ERROR: 0, WARN: 0, INFO: 0 };
    for (const f of r.findings) counts[f.level]++;
    console.log(`\n[${r.name} ${r.viewport.width}×${r.viewport.height}] ERROR ${counts.ERROR} · WARN ${counts.WARN} · INFO ${counts.INFO}`);
    for (const f of [...r.findings].sort((a, b) => ORDER[a.level] - ORDER[b.level])) {
      console.log(`  ${f.level.padEnd(5)} ${f.rule.padEnd(20)} ${f.message}${f.where ? `  (${f.where})` : ""}`);
    }
    if (r.screenshot) console.log(`  스크린샷: ${r.screenshot}`);
  }
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  if (o.help || !o.target) {
    console.log("사용법: node check-ui.mjs <html 파일|URL> [--viewport mobile|desktop|both] [--shot out.png] [--full] [--json]");
    process.exit(o.help ? 0 : 1);
  }
  let out;
  try { out = await checkUi(o.target, o); } catch (e) { console.error(`검사 실패: ${e.message}`); process.exit(1); }
  if (o.json) console.log(JSON.stringify(out, null, 2));
  else printText(out);
  const hasError = out.results.some((r) => r.findings.some((f) => f.level === "ERROR"));
  process.exit(hasError ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
