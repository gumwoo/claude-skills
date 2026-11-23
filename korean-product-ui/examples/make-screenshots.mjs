#!/usr/bin/env node
// 예시 화면을 실제 브라우저로 그려서 README용 보드 이미지를 만든다.
// 사용법: node examples/make-screenshots.mjs   → examples/screenshots/*.png
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, openPage } from "../scripts/lib/browser.mjs";
import { checkUi } from "../scripts/check-ui.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "screenshots");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kpui-shots-"));
const MOBILE = { width: 390, height: 844, mobile: true, dpr: 2 };
const DESKTOP = { width: 1440, height: 900, mobile: false, dpr: 1 };
const url = (f) => pathToFileURL(path.join(HERE, f)).href;

async function shoot(browser, file, vp, out, opts = {}) {
  const page = await openPage(browser, vp);
  await page.goto(url(file));
  await page.screenshot(out, opts);
  await page.close();
  return out;
}

/** 보드 HTML을 그려 전체 높이로 캡처한다 */
async function board(browser, name, width, body) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(path.join(HERE, "../templates/tokens.css")).href}">
<style>
  body { margin: 0; background: #f2f4f6; padding: 48px; width: ${width}px; box-sizing: border-box; }
  .row { display: flex; gap: 40px; justify-content: center; align-items: flex-start; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 16px; align-items: center; }
  figcaption { text-align: center; font-size: 18px; font-weight: 700; color: var(--text-1); letter-spacing: -0.02em; }
  figcaption span { display: block; margin-top: 4px; font-size: 14px; font-weight: 500; color: var(--text-2); text-align: center; letter-spacing: 0; }
  .phone { width: 390px; border-radius: 36px; overflow: hidden; border: 1px solid #dfe3e8; background: #fff; display: block; }
  .browser { border-radius: 12px; overflow: hidden; border: 1px solid #dfe3e8; background: #fff; display: block; }
  .bad { color: var(--danger); } .good { color: var(--accent); }
</style></head><body>${body}</body></html>`;
  const f = path.join(TMP, name + ".html");
  fs.writeFileSync(f, html);
  const page = await openPage(browser, { width, height: 800, mobile: false, dpr: 1 });
  await page.goto(pathToFileURL(f).href);
  const out = path.join(OUT, name + ".png");
  await page.screenshot(out, { fullPage: true });
  await page.close();
  return out;
}

const img = (p, cls, w) => `<img class="${cls}" src="${pathToFileURL(p).href}"${w ? ` style="width:${w}px"` : ""}>`;
const count = (r) => {
  const c = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const f of r.findings) c[f.level]++;
  return c;
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  // 1. 앱 화면 세 장
  const app = [];
  for (const f of ["app-home", "app-detail", "app-checkout"]) app.push(await shoot(browser, `${f}.html`, MOBILE, path.join(TMP, `${f}.png`)));
  const appChecks = [];
  for (const f of ["app-home", "app-detail", "app-checkout"]) appChecks.push(count((await checkUi(path.join(HERE, `${f}.html`), { viewport: "mobile", browser })).results[0]));
  const labels = ["홈", "공간 상세", "예약 확인"];
  await board(browser, "app-screens", 1386, `<div class="row">${app.map((p, i) =>
    `<figure>${img(p, "phone")}<figcaption>${labels[i]}<span>ERROR ${appChecks[i].ERROR} · WARN ${appChecks[i].WARN}</span></figcaption></figure>`).join("")}</div>`);

  // 2. 웹: 데스크톱 + 모바일
  const wd = await shoot(browser, "web-booking.html", DESKTOP, path.join(TMP, "web-d.png"));
  const wm = await shoot(browser, "web-booking.html", MOBILE, path.join(TMP, "web-m.png"));
  const webCheck = (await checkUi(path.join(HERE, "web-booking.html"), { viewport: "both", browser })).results.map(count);
  await board(browser, "web-booking", 1660, `<div class="row">
    <figure>${img(wd, "browser", 1080)}<figcaption>데스크톱 1440<span>ERROR ${webCheck[1].ERROR} · WARN ${webCheck[1].WARN}</span></figcaption></figure>
    <figure>${img(wm, "phone", 300)}<figcaption>모바일 390<span>ERROR ${webCheck[0].ERROR} · WARN ${webCheck[0].WARN}</span></figcaption></figure></div>`);

  // 3. before / after
  const before = await shoot(browser, "market-before.html", MOBILE, path.join(TMP, "before.png"), { fullPage: true });
  const after = await shoot(browser, "market-after.html", MOBILE, path.join(TMP, "after.png"), { fullPage: true });
  const b = count((await checkUi(path.join(HERE, "market-before.html"), { viewport: "mobile", browser })).results[0]);
  const a = count((await checkUi(path.join(HERE, "market-after.html"), { viewport: "mobile", browser })).results[0]);
  await board(browser, "before-after", 976, `<div class="row">
    <figure>${img(before, "phone")}<figcaption>지시 없이 만든 화면<span class="bad">ERROR ${b.ERROR} · WARN ${b.WARN} · INFO ${b.INFO}</span></figcaption></figure>
    <figure>${img(after, "phone")}<figcaption>스킬을 적용한 화면<span class="good">ERROR ${a.ERROR} · WARN ${a.WARN} · INFO ${a.INFO}</span></figcaption></figure></div>`);

  for (const f of fs.readdirSync(OUT)) console.log(path.join("examples/screenshots", f), Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + "KB");
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
