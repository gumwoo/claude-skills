#!/usr/bin/env node
// race-check 시험. 예시 서버를 직접 띄워서 돌린다.
// 사용법: node tests/run-tests.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHost, fill, loadConfig, runRace } from "../scripts/race.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const RACE = path.join(ROOT, "scripts", "race.mjs");
const SERVER = path.join(ROOT, "examples", "ticket-server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "race-check-test-"));
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

function writeConfig(name, obj) {
  const f = path.join(TMP, name + ".json");
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
const ticketConfig = (port, extra = {}) => ({
  target: `http://localhost:${port}/events/1/buy`,
  body: { userId: "user-{{i % 150}}" },
  concurrency: 200,
  rounds: 3,
  reset: { http: { method: "POST", url: `http://localhost:${port}/reset`, body: { stock: 100 } } },
  invariants: [
    { name: "판매 수량 <= 재고", http: { url: `http://localhost:${port}/events/1/stats` }, path: "orders", expect: "<= 100" },
    { name: "중복 구매 없음", http: { url: `http://localhost:${port}/events/1/stats` }, path: "duplicateUsers", expect: "== 0" },
    { name: "성공 응답 <= 재고", source: "success", expect: "<= 100" },
  ],
  ...extra,
});

async function startServer(mode, port) {
  const proc = spawn(process.execPath, [SERVER, "--mode", mode, "--port", String(port), "--db", path.join(TMP, `${mode}.sqlite`)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${mode} 서버가 10초 안에 뜨지 않음`)), 10000);
    proc.stdout.on("data", (d) => { if (String(d).includes("ticket-server")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`${mode} 서버 종료 code ${c}`)); });
  });
  return proc;
}

console.log("\n# 대상 확인");
ok(checkHost("http://localhost:3000/x").ok, "localhost 허용");
ok(checkHost("http://127.0.0.1:3000/x").ok && checkHost("http://[::1]:3000/x").ok, "127.0.0.1, ::1 허용");
ok(checkHost("http://api.dev.localhost/x").ok && checkHost("http://shop.test/x").ok, "*.localhost, *.test 허용");
ok(!checkHost("https://api.example.com/x").ok, "외부 호스트는 기본 거부");
ok(checkHost("https://staging-api.example.com/x", ["staging-api.example.com"]).ok, "--allow-host로 지정한 호스트 허용");
ok(!checkHost("https://api.prod.example.com/x", ["api.prod.example.com"]).ok, "이름에 prod가 있으면 --allow-host로도 거부");
ok(!checkHost("https://live-shop.example.com/x", ["live-shop.example.com"]).ok, "이름에 live가 있으면 거부");
ok(checkHost("https://productivity.example.com/x", ["productivity.example.com"]).ok, "productivity처럼 단어 일부인 prod는 거부하지 않음");

console.log("\n# 설정 검사");
ok(throws(() => loadConfig(writeConfig("no-reset", { target: "http://localhost:1/x", rounds: 3, invariants: [{ name: "a", source: "success", expect: "<= 1" }] })), /reset/), "여러 회차인데 reset이 없으면 거부");
ok(throws(() => loadConfig(writeConfig("no-inv", { target: "http://localhost:1/x" })), /invariants/), "불변식이 없으면 거부");
ok(throws(() => loadConfig(writeConfig("bad-exp", { target: "http://localhost:1/x", invariants: [{ name: "a", source: "success", expect: "약 100" }] })), /expect/), "expect 형식이 틀리면 거부");
ok(throws(() => loadConfig(writeConfig("one", { target: "http://localhost:1/x", concurrency: 1, invariants: [{ name: "a", source: "success", expect: "<= 1" }] })), /concurrency/), "동시 요청 1개는 거부");

console.log("\n# 요청 채우기");
ok(fill("user-{{i % 3}}", { i: 7, round: 1, vars: {} }) === "user-1", "{{i % 3}}");
ok(fill({ a: ["{{i}}", "{{round}}"] }, { i: 4, round: 2, vars: {} }).a.join() === "4,2", "중첩 객체·배열의 {{i}}, {{round}}");
ok(fill("Bearer {{var.token}}", { i: 3, round: 1, vars: { token: ["t0", "t1"] } }) === "Bearer t1", "{{var.token}}은 i번째 값을 돌려 씀");
ok(throws(() => fill("{{nope}}", { i: 0, round: 1, vars: {} }), /자리표시/), "모르는 자리표시는 오류");

ok(!checkHost("https://api-prod1.example.com/x", ["api-prod1.example.com"]).ok && !checkHost("https://production2.example.com/x", ["production2.example.com"]).ok, "prod1, production2처럼 숫자가 붙어도 거부");
ok(checkHost("http://localhost./x").ok, "끝에 점이 붙은 localhost.도 로컬로 인정");
ok(throws(() => loadConfig(writeConfig("bad-src", { target: "http://localhost:1/x", invariants: [{ name: "a", source: "status:2xx", expect: "<= 0" }] })), /source/), "source \"status:2xx\"처럼 잘못 쓰면 거부 (조용히 0으로 세지 않음)");
ok(throws(() => loadConfig(writeConfig("two-kinds", { target: "http://localhost:1/x", invariants: [{ name: "a", source: "success", cmd: "echo 1", expect: "<= 0" }] })), /정확히 하나/), "불변식에 source와 cmd를 같이 쓰면 거부");

console.log("\n# 이상한 서버 앞에서 거짓 통과·무한 대기가 없어야 한다");
const EDGE = 4581;
const edgeProc = spawn(process.execPath, [path.join(HERE, "fixtures", "edge-server.mjs"), String(EDGE)], { stdio: ["ignore", "pipe", "pipe"] });
process.on("exit", () => edgeProc.kill());
await new Promise((resolve) => edgeProc.stdout.once("data", resolve));
const E = (p) => `http://localhost:${EDGE}${p}`;
const quick = (extra) => ({ target: E("/ok"), body: { a: 1 }, concurrency: 10, timeoutMs: 3000, invariants: [{ name: "x", source: "success", expect: "<= 1000" }], ...extra });
{
  const t = Date.now();
  const r = await runRace(quick({ target: E("/cut") }));
  ok(Date.now() - t < 20000 && r.rounds[0].failedReq === 10, `본문 도중 끊기는 응답: 멈추지 않고 실패로 셈 (${Date.now() - t}ms)`);
  ok(r.rounds[0].invalid, "본문 도중 끊긴 회차는 무효");
  const t2 = Date.now();
  const s = await runRace(quick({ target: E("/cut"), sequential: true, concurrency: 3 }));
  ok(Date.now() - t2 < 20000 && s.rounds[0].failedReq === 3, "순차 실행도 끊긴 응답에서 멈추지 않음");

  const empty = await runRace(quick({ invariants: [{ name: "빈 출력", cmd: `"${process.execPath}" -e ""`, expect: "== 0" }] }));
  ok(empty.rounds[0].checkError && !empty.rounds[0].checks[0].ok, "명령 출력이 비어 있으면 0으로 읽지 않고 확인 실패", JSON.stringify(empty.rounds[0].checks));
  const nul = await runRace(quick({ invariants: [{ name: "null", http: { url: E("/null") }, path: "v", expect: "== 0" }] }));
  ok(nul.rounds[0].checkError, "조회 값이 null이면 0으로 읽지 않고 확인 실패");
  const emp = await runRace(quick({ invariants: [{ name: "빈 문자열", http: { url: E("/empty") }, path: "v", expect: "== 0" }] }));
  ok(emp.rounds[0].checkError, "조회 값이 빈 문자열이면 확인 실패");
  const num = await runRace(quick({ invariants: [{ name: "숫자", http: { url: E("/num") }, path: "v", expect: "== 3" }] }));
  ok(!num.rounds[0].checkError && num.rounds[0].checks[0].ok, "정상 숫자 값은 그대로 읽음");

  const rs = await runRace(quick({ rounds: 2, reset: { http: { method: "POST", url: E("/json-only"), body: { stock: 100 } } } }));
  ok(rs.rounds.length === 2, "reset 본문을 JSON content-type으로 보냄 (JSON만 받는 서버에서 415가 나지 않음)");
  const rd = await runRace(quick({ invariants: [{ name: "리다이렉트", http: { url: E("/redirect") }, path: "v", expect: "== 0" }] }));
  ok(rd.rounds[0].checkError && /리다이렉트/.test(rd.rounds[0].checks[0].error), "조회 API가 리다이렉트하면 따라가지 않고, 이유를 적어 확인 실패", rd.rounds[0].checks[0].error);

  const t3 = Date.now();
  const drip = await runRace(quick({ target: E("/drip"), sequential: true, concurrency: 2, timeoutMs: 1000 }));
  ok(Date.now() - t3 < 30000 && drip.rounds[0].failedReq === 2, `조금씩 끝없이 흘려보내는 서버: 순차 실행도 마감 시간에 끝남 (${Date.now() - t3}ms)`);

  let roundHost = null;
  try { await runRace(quick({ target: "http://{{var.h}}/x", rounds: 2, reset: { cmd: `"${process.execPath}" -e ""` }, vars: { h: ["localhost:" + EDGE] }, body: { r: "{{round}}" } })); } catch (e) { roundHost = e; }
  ok(!roundHost, "{{round}}를 본문에 쓰는 정상 설정은 사전 검사를 통과", roundHost?.message);
  let roundHost2 = null;
  try { await runRace(quick({ target: `http://r{{round}}.localhost:${EDGE}/x`, rounds: 2, reset: { cmd: `"${process.execPath}" -e ""` } })); } catch (e) { roundHost2 = e; }
  ok(!roundHost2 || roundHost2.code !== "HOST", "{{round}}가 호스트에 있어도 로컬이면 허용");
  let roundHost3 = null;
  try { await runRace(quick({ target: `http://{{var.h}}/x`, rounds: 2, reset: { cmd: `"${process.execPath}" -e ""` }, vars: { h: ["localhost"] }, invariants: [{ name: "x", http: { url: "http://shop-{{round}}.prod.example.com/stats" }, path: "v", expect: "== 0" }] })); } catch (e) { roundHost3 = e; }
  ok(roundHost3?.code === "HOST", "2회차 이후에만 운영 호스트가 되는 설정도 보내기 전에 거부");

  const drop = await runRace(quick({ target: E("/drop-third"), concurrency: 30 }));
  ok(drop.rounds[0].invalid && drop.invalidRounds === 1, `요청 셋 중 하나가 끊기면 그 회차는 통과가 아니라 무효 (${drop.rounds[0].failedReq}건 실패)`);
  const fail = await runRace(quick({ target: E("/fail") }));
  ok(fail.rounds[0].invalid, "전부 500이면 무효");

  let blocked = null;
  try { await runRace(quick({ target: "http://{{var.h}}.localhost/x", vars: { h: ["a", "api.prod.example.com/x?"] } })); } catch (e) { blocked = e; }
  ok(blocked?.code === "HOST", "{{}}로 호스트를 바꿔 운영으로 보내는 설정은 보내기 전에 거부", blocked?.message);
  let blocked2 = null;
  try { await runRace(quick({ invariants: [{ name: "x", http: { url: "http://{{var.h}}/stats" }, path: "v", expect: "== 0" }], vars: { h: ["shop.prod.example.com"] } })); } catch (e) { blocked2 = e; }
  ok(blocked2?.code === "HOST", "불변식 조회 URL도 채운 값으로 호스트 확인");
}

console.log("\n# 예시 서버로 실제 실행");
const naive = await startServer("naive", 4191);
const fixed = await startServer("fixed", 4192);
process.on("exit", () => { naive.kill(); fixed.kill(); }); // 시험이 중간에 죽어도 서버를 남기지 않는다
try {
  const n = await runRace(ticketConfig(4191));
  ok(n.violatedRounds >= 1, `naive 서버 동시 요청: 위반 발견 (${n.violatedRounds}/3회)`, JSON.stringify(n.rounds.map((r) => r.checks.map((x) => x.value))));
  const maxSold = Math.max(...n.rounds.map((r) => r.checks[0].value));
  ok(maxSold > 100, `naive 서버: 재고 100인데 최대 ${maxSold}개 판매`);
  ok(n.rounds.every((r) => r.spreadMs < 50), `요청 출발 간격 50ms 미만 (최대 ${Math.max(...n.rounds.map((r) => r.spreadMs)).toFixed(1)}ms)`);

  const s = await runRace(ticketConfig(4191, { sequential: true, rounds: 2 }));
  ok(s.violatedRounds === 0, "같은 naive 서버도 순차 요청이면 통과 (경쟁 상태라는 근거)", JSON.stringify(s.rounds.map((r) => r.checks)));

  const f = await runRace(ticketConfig(4192));
  ok(f.violatedRounds === 0 && f.rounds.every((r) => r.success === 100), "fixed 서버 동시 요청: 3회 모두 통과, 정확히 100개 판매", JSON.stringify(f.rounds.map((r) => [r.success, r.checks.map((x) => x.value)])));

  console.log("\n# CLI 종료 코드");
  const run = (cfg, ...args) => spawnSync(process.execPath, [RACE, cfg, ...args], { encoding: "utf8" });
  ok(run(writeConfig("cli-naive", ticketConfig(4191, { rounds: 1 }))).status === 2, "위반이 있으면 2");
  ok(run(writeConfig("cli-fixed", ticketConfig(4192, { rounds: 1 }))).status === 0, "모두 통과하면 0");
  const remote = run(writeConfig("cli-remote", { ...ticketConfig(4192, { rounds: 1 }), target: "https://shop.prod.example.com/buy" }));
  ok(remote.status === 1 && /운영/.test(remote.stderr), "운영으로 보이는 호스트는 요청 없이 1", remote.stderr);
  const zero = run(writeConfig("cli-zero", ticketConfig(4192, { rounds: 1 })), "--rounds", "0");
  ok(zero.status === 1 && /정수/.test(zero.stderr), "--rounds 0은 무시하지 않고 거부", zero.stderr);
  const dropCli = run(writeConfig("cli-drop", { target: `http://localhost:${EDGE}/drop-third`, body: { a: 1 }, concurrency: 30, invariants: [{ name: "x", source: "success", expect: "<= 1000" }] }));
  ok(dropCli.status === 1 && /판단할 수 없습니다/.test(dropCli.stdout), "일부 요청이 끊긴 회차만 있으면 통과(0)가 아니라 1", dropCli.stdout.slice(-200));
  const none = run(writeConfig("cli-404", { ...ticketConfig(4192, { rounds: 1 }), target: "http://localhost:4192/no-such-path" }));
  ok(none.status === 1 && /성공한 요청이 0개/.test(none.stdout), "성공이 하나도 없으면 시험이 무의미하다고 경고하고 1", none.stdout.slice(-300));
  const j = run(writeConfig("cli-json", ticketConfig(4192, { rounds: 1 })), "--json");
  let parsed = null; try { parsed = JSON.parse(j.stdout); } catch { /* 아래에서 실패 */ }
  ok(parsed?.rounds?.length === 1, "--json 출력은 파싱 가능한 JSON");
} finally {
  naive.kill(); fixed.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
