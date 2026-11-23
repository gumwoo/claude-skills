// 설치된 Chrome·Edge·Chromium을 headless로 띄워 DevTools Protocol로 조종한다. 외부 패키지 없이 Node 22+ 내장 WebSocket만 쓴다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pf = process.env["ProgramFiles"] || "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = {
    win32: [
      `${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${local}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`,
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"],
  }[process.platform] ?? [];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export async function launch() {
  const exe = findBrowser();
  if (!exe) throw new Error("Chrome·Edge·Chromium을 찾지 못했습니다. CHROME_PATH 환경변수로 실행 파일 경로를 지정하세요.");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpui-"));
  const proc = spawn(exe, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
    "--force-color-profile=srgb", "--lang=ko-KR", "--font-render-hinting=none", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("브라우저가 20초 안에 시작되지 않았습니다")), 20000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`브라우저가 종료됨(code ${code})`)); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("DevTools 연결 실패")); });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function close() {
    let t1, t2;
    try { await Promise.race([send("Browser.close"), new Promise((r) => { t1 = setTimeout(r, 3000); })]); } catch { /* 이미 닫힘 */ }
    clearTimeout(t1);
    try { ws.close(); } catch { /* 무시 */ }
    if (proc.exitCode === null) { proc.kill(); await new Promise((r) => { proc.on("exit", r); t2 = setTimeout(r, 3000); }); }
    clearTimeout(t2);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(userDir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
  return { send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn), close, exe };
}

/** 새 탭을 열고 화면 크기를 맞춘다. viewport: { width, height, mobile, dpr } */
export async function openPage(browser, viewport) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr ?? 1, mobile: !!viewport.mobile });
  if (viewport.mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  async function goto(url, timeoutMs = 30000) {
    let onMsg;
    const loaded = new Promise((resolve) => {
      onMsg = (m) => { if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) resolve(); };
      browser.on(onMsg);
    });
    await s("Page.navigate", { url });
    let timer;
    await Promise.race([loaded, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer); // 남은 타이머가 프로세스 종료를 붙잡지 않게
    browser.off(onMsg);
    // 웹폰트까지 그려진 뒤에 측정한다
    await evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true");
    await new Promise((r) => setTimeout(r, 400));
  }

  async function evaluate(expression) {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`페이지 스크립트 오류: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** fullPage면 문서 전체 높이로 캡처한다 */
  async function screenshot(file, { fullPage = false } = {}) {
    let restore = null;
    if (fullPage) {
      const m = await s("Page.getLayoutMetrics");
      const h = Math.min(Math.ceil(m.cssContentSize?.height ?? m.contentSize.height), 12000);
      if (h > viewport.height) {
        await s("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: h, deviceScaleFactor: viewport.dpr ?? 1, mobile: !!viewport.mobile });
        await new Promise((r) => setTimeout(r, 250));
        restore = () => s("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr ?? 1, mobile: !!viewport.mobile });
      }
    }
    const { data } = await s("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    if (restore) await restore();
    return file;
  }

  return { goto, evaluate, screenshot, close: () => browser.send("Target.closeTarget", { targetId }) };
}
