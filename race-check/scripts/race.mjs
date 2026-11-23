#!/usr/bin/env node
// 같은 요청 N개를 한 순간에 보내고, 끝난 뒤 지켜져야 할 조건(불변식)을 확인한다. 외부 패키지 없음.
// 사용법: node race.mjs <race.json> [--rounds N] [--concurrency N] [--sequential] [--json] [--allow-host host]
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 설정 ----------
function parseArgs(argv) {
  const o = { config: null, json: false, allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => { const v = Number(argv[++i]); if (!Number.isInteger(v) || v < 1) throw new Error(`${a} 뒤에는 1 이상 정수가 와야 합니다`); return v; };
    if (a === "--rounds") o.rounds = num();
    else if (a === "--concurrency") o.concurrency = num();
    else if (a === "--json") o.json = true;
    else if (a === "--sequential") o.sequential = true;
    else if (a === "--allow-host") {
      const h = argv[++i];
      if (!h || h.startsWith("--")) throw new Error("--allow-host 뒤에 호스트 이름이 필요합니다");
      o.allowHosts.push(h.toLowerCase().replace(/\.$/, ""));
    }
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!o.config) o.config = a;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return o;
}

const DEFAULTS = {
  method: "POST", headers: {}, body: undefined, concurrency: 50, rounds: 1,
  success: [200, 201, 202, 204], vars: {}, invariants: [], timeoutMs: 15000, holdLastByte: true,
};

export function loadConfig(file, overrides = {}) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = { ...DEFAULTS, ...raw };
  if (overrides.rounds) c.rounds = overrides.rounds;
  if (overrides.concurrency) c.concurrency = overrides.concurrency;
  if (overrides.sequential) c.sequential = true;
  if (!c.target) throw new Error("target(요청 보낼 URL)이 없습니다");
  if (!Number.isInteger(c.concurrency) || c.concurrency < 2) throw new Error("concurrency는 2 이상 정수여야 합니다");
  if (!Number.isInteger(c.rounds) || c.rounds < 1) throw new Error("rounds는 1 이상 정수여야 합니다");
  if (c.rounds > 1 && !c.reset) throw new Error("rounds가 2 이상이면 reset이 필요합니다. 회차마다 같은 시작 상태가 아니면 결과를 비교할 수 없습니다");
  if (!c.invariants.length) throw new Error("invariants가 비어 있습니다. 끝난 뒤 무엇이 지켜져야 하는지 하나 이상 적으세요");
  for (const inv of c.invariants) {
    parseExpect(inv.expect, inv.name);
    if ([inv.source, inv.cmd, inv.http].filter(Boolean).length !== 1) throw new Error(`불변식 "${inv.name}"에는 source·cmd·http 중 정확히 하나가 있어야 합니다`);
    if (inv.source && !/^(success|status:\d{3})$/.test(inv.source)) throw new Error(`불변식 "${inv.name}"의 source는 "success" 또는 "status:409" 같은 형식이어야 합니다: "${inv.source}"`);
    if (inv.http && !inv.http.url) throw new Error(`불변식 "${inv.name}"의 http에 url이 없습니다`);
  }
  return c;
}

// ---------- 대상 확인: 운영으로 보이면 보내지 않는다 ----------
const PROD = /(^|[.-])(prod|production|prd|live)\d*([.-]|$)/i;
export function checkHost(url, allowHosts = []) {
  const u = new URL(url);
  const h = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (PROD.test(h)) return { ok: false, why: `호스트 이름에 운영 표시가 있습니다(${h}). 이 도구는 운영 환경에 요청을 보내지 않습니다` };
  const local = h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".test") || h === "host.docker.internal";
  if (local) return { ok: true };
  if (allowHosts.includes(h)) return { ok: true, note: `--allow-host로 허용한 호스트: ${h}` };
  return { ok: false, why: `로컬이 아닌 호스트입니다(${h}). 개발·스테이징 환경이 확실하면 --allow-host ${h}로 허용하세요` };
}

// ---------- 요청 내용 채우기 ----------
export function fill(value, ctx) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
      if (expr === "i") return String(ctx.i);
      if (expr === "round") return String(ctx.round);
      if (expr === "uuid") return randomUUID();
      let m = expr.match(/^i\s*%\s*(\d+)$/);
      if (m) return String(ctx.i % Number(m[1]));
      m = expr.match(/^var\.(\w+)$/);
      if (m) {
        const list = ctx.vars[m[1]];
        if (!Array.isArray(list) || !list.length) throw new Error(`vars.${m[1]}가 없거나 비어 있습니다`);
        return String(list[ctx.i % list.length]);
      }
      throw new Error(`모르는 자리표시: {{${expr}}}`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, ctx)]));
  return value;
}

// ---------- 동시에 보내기 ----------
// 연결을 모두 열고 본문의 마지막 1바이트만 남겨 둔 뒤, 그 1바이트를 한꺼번에 보낸다(last-byte sync).
// 서버는 마지막 바이트를 받아야 요청을 처리하므로 처리 시작 시점이 거의 같아진다.
// 자리표시를 채운 뒤의 URL로 확인한다. {{}}로 호스트를 바꿔 운영 차단을 우회하지 못하게
function assertHost(url, c, label) {
  const h = checkHost(url, c._allowHosts || []);
  if (!h.ok) throw Object.assign(new Error(`${label}: ${h.why}`), { code: "HOST" });
}

function prepare(req, ctx, c) {
  const url = new URL(fill(c.target, ctx));
  assertHost(url.href, c, `${ctx.i}번째 요청`);
  const headers = fill(c.headers, ctx);
  let body = c.body === undefined ? null : fill(c.body, ctx);
  if (body !== null && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  }
  const buf = body === null ? Buffer.alloc(0) : Buffer.from(body);
  headers["content-length"] = String(buf.length);
  const lib = url.protocol === "https:" ? https : http;
  return { url, headers, buf, lib, method: c.method.toUpperCase() };
}

// 비교용: 같은 요청을 하나씩 차례로 보낸다. 이때 불변식이 깨지면 경쟁 상태가 아니라 로직이나 불변식이 틀린 것이다
async function fireSequential(c, round) {
  const results = [];
  for (let i = 0; i < c.concurrency; i++) {
    const p = prepare(null, { i, round, vars: c.vars }, c);
    const start = performance.now();
    results.push(await new Promise((done) => {
      // 데이터를 아주 조금씩 흘려보내는 서버에서도 끝나도록 요청마다 마감 시간을 둔다
      let req;
      const deadline = setTimeout(() => { req?.destroy(); resolve({ status: 0, error: "마감 시간 초과" }); }, c.timeoutMs + 10000);
      let settled = false;
      const resolve = (v) => { if (settled) return; settled = true; clearTimeout(deadline); done(v); };
      req = p.lib.request(p.url, { method: p.method, headers: p.headers, agent: c._agents[p.url.protocol], timeout: c.timeoutMs }, (res) => {
        let data = ""; res.setEncoding("utf8");
        res.on("data", (d) => { if (data.length < 2000) data += d; });
        res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - start, body: data.slice(0, 300) }));
        const cut = () => resolve({ status: 0, error: "응답 도중 끊김" });
        res.on("aborted", cut); res.on("error", cut);
        res.on("close", () => { if (!res.complete) cut(); });
      });
      req.on("timeout", () => req.destroy(new Error("시간 초과")));
      req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
      req.end(p.buf);
    }));
  }
  return { results, spreadMs: 0 };
}

function fireAll(c, round) {
  return new Promise((resolveAll) => {
    const n = c.concurrency;
    // 요청 내용은 타이머와 연결을 만들기 전에 전부 채운다. 여기서 오류가 나면 아무것도 보내지 않고 끝난다
    const preps = Array.from({ length: n }, (_, i) => prepare(null, { i, round, vars: c.vars }, c));
    const results = new Array(n);
    const reqs = [];
    let ready = 0, done = 0, released = false;
    const sendTimes = [];
    const release = () => {
      if (released) return;
      released = true;
      for (const r of reqs) {
        if (r.failed) continue;
        if (r.hold) sendTimes.push(performance.now());
        r.req.end(r.tail);
      }
    };
    const finish = (i, value) => {
      if (results[i]) return;
      results[i] = value;
      if (++done === n) {
        clearTimeout(guard); clearTimeout(deadline);
        const spread = sendTimes.length ? Math.max(...sendTimes) - Math.min(...sendTimes) : 0;
        resolveAll({ results, spreadMs: spread });
      }
    };
    const guard = setTimeout(() => { release(); }, 5000); // 연결이 끝내 안 열리는 요청이 있어도 출발은 시킨다
    // 어떤 이유로든 끝나지 않는 요청이 있어도 회차는 끝낸다. 끝나지 않은 요청은 실패로 센다
    const deadline = setTimeout(() => {
      for (let i = 0; i < n; i++) if (!results[i]) { reqs[i]?.req.destroy(); finish(i, { status: 0, error: "마감 시간 초과" }); }
    }, c.timeoutMs + 10000);

    for (let i = 0; i < n; i++) {
      const p = preps[i];
      const hold = c.holdLastByte && p.buf.length > 0;
      const head = hold ? p.buf.subarray(0, p.buf.length - 1) : p.buf;
      const tail = hold ? p.buf.subarray(p.buf.length - 1) : undefined;
      const req = p.lib.request(p.url, { method: p.method, headers: p.headers, agent: c._agents[p.url.protocol], timeout: c.timeoutMs });
      const entry = { req, tail, hold, failed: false, counted: false };
      reqs.push(entry);
      let start;
      req.on("socket", (s) => {
        const onReady = () => {
          if (head.length) req.write(head); else req.flushHeaders();
          if (!hold) sendTimes.push(performance.now()); // 본문이 없으면(GET 등) 붙잡을 수 없어 연결되는 즉시 요청이 다 나간다
          entry.counted = true;
          if (++ready === n) setImmediate(release);
        };
        if (s.connecting) s.once(p.url.protocol === "https:" ? "secureConnect" : "connect", onReady); else onReady();
      });
      req.on("response", (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { if (data.length < 2000) data += d; });
        res.on("end", () => finish(i, { status: res.statusCode, ms: performance.now() - start, body: data.slice(0, 300) }));
        const cut = () => finish(i, { status: 0, error: "응답 도중 끊김", ms: performance.now() - start });
        res.on("aborted", cut); res.on("error", cut);
        res.on("close", () => { if (!res.complete) cut(); });
      });
      req.on("timeout", () => req.destroy(new Error("시간 초과")));
      req.on("error", (e) => {
        entry.failed = true;
        if (!released && !entry.counted) { entry.counted = true; if (++ready === n) setImmediate(release); }
        finish(i, { status: 0, error: e.code || e.message, ms: start ? performance.now() - start : 0 });
      });
      start = performance.now();
    }
  });
}

// ---------- 조건 확인 ----------
function parseExpect(expr, name) {
  const m = String(expr ?? "").match(/^\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) throw new Error(`불변식 "${name}"의 expect 형식이 잘못됐습니다: "${expr}" (예: "<= 100", "== 0")`);
  return { op: m[1], value: Number(m[2]) };
}
const compare = (v, { op, value }) => ({ "<=": v <= value, ">=": v >= value, "==": v === value, "!=": v !== value, "<": v < value, ">": v > value })[op];

function pick(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function httpJson(spec, round, c, label) {
  const ctx = { i: 0, round, vars: c.vars || {} };
  const url = fill(spec.url, ctx);
  assertHost(url, c, label);
  const headers = { ...fill(spec.headers || {}, ctx) };
  let body;
  if (spec.body !== undefined) {
    // 객체 본문만 JSON으로 보낸다. 문자열 본문은 형식을 모르니 content-type을 직접 적게 한다
    if (typeof spec.body === "string") body = fill(spec.body, ctx);
    else {
      body = JSON.stringify(fill(spec.body, ctx));
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
  }
  // 리다이렉트는 따라가지 않는다(따라간 곳은 호스트 확인을 거치지 않으므로)
  let res;
  try {
    res = await fetch(url, { method: spec.method || "GET", headers, body, redirect: "error", signal: AbortSignal.timeout(c.timeoutMs) });
  } catch (e) {
    const why = e.name === "TimeoutError" ? `${c.timeoutMs}ms 안에 응답이 없음` : e.cause?.message?.includes("redirect") ? "리다이렉트 응답(따라가지 않음)" : e.cause?.code || e.cause?.message || e.message;
    throw new Error(`${url} 요청 실패: ${why}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → ${res.status} ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function readValue(inv, ctx) {
  if (inv.source === "success") return ctx.results.filter((r) => ctx.success.includes(r.status)).length;
  if (inv.source?.startsWith("status:")) { const s = Number(inv.source.slice(7)); return ctx.results.filter((r) => r.status === s).length; }
  if (inv.cmd) {
    const out = execSync(inv.cmd, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const last = out.split(/\s+/).pop();
    // 빈 출력(0행, NULL)을 0으로 읽으면 "== 0" 불변식이 저절로 통과한다
    if (!/^-?\d+(\.\d+)?$/.test(last ?? "")) throw new Error(`명령 출력의 마지막 값이 숫자가 아닙니다: "${out.slice(0, 80)}"`);
    return Number(last);
  }
  if (inv.http) {
    const data = await httpJson(inv.http, ctx.round, ctx.c, `불변식 "${inv.name}"`);
    const v = inv.path ? pick(data, inv.path) : data;
    // null·""·false·[]가 0으로 바뀌지 않게, 숫자나 숫자 문자열만 받는다
    const num = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(num)) throw new Error(`응답의 ${inv.path ?? "(전체)"} 값이 숫자가 아닙니다: ${JSON.stringify(v)?.slice(0, 80)}`);
    return num;
  }
  throw new Error(`불변식 "${inv.name}"에 source·cmd·http 중 하나가 필요합니다`);
}

async function reset(c, round) {
  if (!c.reset) return;
  if (c.reset.cmd) execSync(c.reset.cmd, { stdio: "ignore", timeout: 60000 });
  else if (c.reset.http) await httpJson(c.reset.http, round, c, "reset");
  else throw new Error("reset에는 cmd나 http가 필요합니다");
}

// ---------- 실행 ----------
export async function runRace(config, { allowHosts = [], onRound } = {}) {
  const c = { ...DEFAULTS, ...config };
  // 회차마다 새 연결을 200개씩 열면 OS의 임시 포트가 바닥난다(Windows에서 EADDRINUSE). 연결은 회차 사이에 재사용한다
  const agentOpts = { keepAlive: true, maxSockets: c.concurrency, maxFreeSockets: c.concurrency };
  c._agents = { "http:": new http.Agent(agentOpts), "https:": new https.Agent(agentOpts) };
  try { return await runRounds(c, allowHosts, onRound); }
  finally { c._agents["http:"].destroy(); c._agents["https:"].destroy(); }
}

async function runRounds(c, allowHosts, onRound) {
  c._allowHosts = allowHosts.map((h) => h.toLowerCase());
  // 보내기 전에 모든 요청과 조회 URL의 호스트를 채운 값으로 확인한다
  // ({{round}}가 호스트에 들어가도 2회차 이후 값까지 미리 본다)
  for (let round = 1; round <= c.rounds; round++) {
    for (let i = 0; i < c.concurrency; i++) prepare(null, { i, round, vars: c.vars }, c);
    for (const inv of c.invariants) if (inv.http) assertHost(fill(inv.http.url, { i: 0, round, vars: c.vars }), c, `불변식 "${inv.name}"`);
    if (c.reset?.http) assertHost(fill(c.reset.http.url, { i: 0, round, vars: c.vars }), c, "reset");
  }
  const host = checkHost(fill(c.target, { i: 0, round: 1, vars: c.vars }), c._allowHosts);
  const rounds = [];
  for (let round = 1; round <= c.rounds; round++) {
    await reset(c, round);
    const { results, spreadMs } = await (c.sequential ? fireSequential : fireAll)(c, round);
    const statuses = {};
    for (const r of results) { const k = r.status || r.error || "error"; statuses[k] = (statuses[k] || 0) + 1; }
    const checks = [];
    for (const inv of c.invariants) {
      const exp = parseExpect(inv.expect, inv.name);
      try {
        const value = await readValue(inv, { results, success: c.success, round, c });
        checks.push({ name: inv.name, value, expect: inv.expect, ok: compare(value, exp) });
      } catch (e) {
        checks.push({ name: inv.name, value: null, expect: inv.expect, ok: false, error: e.message });
      }
    }
    const success = results.filter((r) => c.success.includes(r.status)).length;
    const failedReq = results.filter((r) => r.status === 0).length;
    // 성공이 0건이거나 연결 오류가 10%를 넘으면 요청이 제대로 가지 않은 것이라, 그 회차의 통과는 믿을 수 없다
    const invalid = success === 0 ? "성공한 요청이 0개" : failedReq > c.concurrency * 0.1 ? `연결 오류·시간 초과 ${failedReq}건` : null;
    const r = { round, statuses, success, failedReq, invalid, spreadMs, checks, violated: checks.some((x) => !x.ok && !x.error), checkError: checks.some((x) => x.error), sample: results.find((x) => !c.success.includes(x.status)) };
    rounds.push(r);
    onRound?.(r);
  }
  const warnings = [];
  if (rounds.some((r) => r.success === 0)) warnings.push("성공한 요청이 0개인 회차가 있습니다. 인증·URL·본문이 맞는지 먼저 확인하세요. 아무것도 성공하지 않으면 그 회차는 아무것도 증명하지 않습니다");
  const errors = rounds.reduce((a, r) => a + Object.entries(r.statuses).filter(([k]) => !/^\d+$/.test(k) || k === "0").reduce((s, [, v]) => s + v, 0), 0);
  if (errors) warnings.push(`연결 오류·시간 초과가 ${errors}건 있었습니다. 서버가 동시 연결을 다 받지 못했을 수 있습니다`);
  const maxSpread = Math.max(...rounds.map((r) => r.spreadMs));
  if (!c.sequential && maxSpread > 50) warnings.push(`요청 출발 간격이 최대 ${maxSpread.toFixed(1)}ms로 벌어졌습니다. 동시성이 약해서 경쟁 상태를 놓쳤을 수 있습니다`);
  return { target: `${c.method.toUpperCase()} ${c.target}`, concurrency: c.concurrency, sequential: !!c.sequential, rounds, violatedRounds: rounds.filter((r) => r.violated).length, invalidRounds: rounds.filter((r) => r.invalid).length, checkErrors: rounds.filter((r) => r.checkError).length, warnings, hostNote: host.note };
}

function printText(out) {
  console.log(`대상 ${out.target} · ${out.sequential ? `순차 요청 ${out.concurrency}개(비교용)` : `동시 요청 ${out.concurrency}`} · ${out.rounds.length}회`);
  if (out.hostNote) console.log(out.hostNote);
  console.log("");
  for (const r of out.rounds) {
    const st = Object.entries(r.statuses).sort().map(([k, v]) => `${k}×${v}`).join(" ");
    const bad = r.checks.filter((x) => !x.ok);
    const verdict = r.violated ? "위반" : r.checkError ? "확인 실패" : r.invalid ? "무효" : "통과";
    const spread = out.sequential ? "" : `  출발 간격 ${r.spreadMs.toFixed(1)}ms`;
    console.log(`${String(r.round).padStart(3)}회  ${verdict.padEnd(5)}  응답 ${st}${spread}`);
    for (const x of bad.filter((x) => x.error)) console.log(`        확인 실패: ${x.name} — ${x.error}`);
    if (r.invalid && !r.violated) console.log(`        무효: ${r.invalid}. 이 회차의 통과는 믿을 수 없습니다`);
  }
  const last = out.rounds[out.rounds.length - 1];
  console.log("\n불변식");
  for (const inv of last.checks) {
    const failRounds = out.rounds.filter((r) => r.checks.find((x) => x.name === inv.name && !x.ok && !x.error)).length;
    const values = out.rounds.map((r) => r.checks.find((x) => x.name === inv.name)?.value).filter((v) => v != null);
    const range = values.length ? (Math.min(...values) === Math.max(...values) ? `${values[0]}` : `${Math.min(...values)}–${Math.max(...values)}`) : "-";
    console.log(`  ${failRounds ? "위반" : "통과"}  ${inv.name}  기대 ${inv.expect}, 실제 ${range}${failRounds ? `, ${out.rounds.length}회 중 ${failRounds}회 위반` : ""}`);
  }
  const sample = out.rounds.find((r) => r.sample)?.sample;
  if (sample) console.log(`\n실패 응답 예: ${sample.status || sample.error} ${sample.body ? sample.body.replace(/\s+/g, " ").slice(0, 160) : ""}`);
  for (const w of out.warnings) console.log(`\n주의: ${w}`);
  const n = out.rounds.length;
  const verdict = out.violatedRounds ? `${n}회 중 ${out.violatedRounds}회 불변식 위반`
    : out.checkErrors ? "불변식을 확인하지 못한 회차가 있습니다"
    : out.invalidRounds ? `${n}회 중 ${out.invalidRounds}회는 요청이 제대로 가지 않아 판단할 수 없습니다`
    : `${n}회 모두 통과`;
  console.log(`\n결과: ${verdict}`);
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  if (o.help || !o.config) {
    console.log("사용법: node race.mjs <race.json> [--rounds N] [--concurrency N] [--sequential] [--json] [--allow-host host]");
    process.exit(o.help ? 0 : 1);
  }
  let out;
  try {
    const c = loadConfig(o.config, o);
    out = await runRace(c, { allowHosts: o.allowHosts, onRound: o.json ? null : undefined });
  } catch (e) { console.error(`실행 실패: ${e.message}`); process.exit(1); }
  if (o.json) console.log(JSON.stringify(out, null, 2)); else printText(out);
  process.exit(out.violatedRounds ? 2 : out.checkErrors || out.invalidRounds ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
