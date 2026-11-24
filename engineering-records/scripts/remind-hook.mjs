#!/usr/bin/env node
// Claude Code Stop hook: 이번 세션에 측정·장애 조사·설계 변경의 흔적이 있는데 기록 문서를 안 썼으면 알린다.
// 막지 않는다. 세션마다 한 번만 알린다.
//   observe(기본): 사용자에게 한 줄 알림만 띄운다(Claude는 계속 멈춘다)
//   nudge: 한 번 Claude를 이어서 일하게 하고 "기록이 필요한지 판정하라"고 전한다. 필요 없으면 Claude가 그렇게 답하고 끝낸다
//   off: 아무것도 하지 않는다
// 환경변수 RECORDS_REMINDER_MODE가 있으면 인자보다 우선한다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODE = (process.env.RECORDS_REMINDER_MODE || process.argv[2] || "observe").toLowerCase();

// 측정을 돌렸다는 신호(도구를 실제로 실행한 명령만. "ls benchmarks" 같은 건 세지 않는다)
// 도구 이름 뒤에 공백·인자가 오는 실제 실행만 센다("cat gatling.conf"는 아님). 도커 이미지(grafana/k6 run)도 센다
const MEASURE_CMD = /(^|[\s;&|(/])(k6\s+run\s|jmeter\s+-n|gatling(\.sh|\.bat)?\s+-|gatlingRun|gatling:test|hey\s+-|wrk\s+-|ab\s+-n|hyperfine\s|vegeta\s+attack|locust\s+-|artillery\s+run|autocannon\s|pgbench\s|sysbench\s|node\s+(?:\S*[\\/])?race\.mjs|go\s+test\s+[^;&|]*-bench|cargo\s+bench|\S*gradlew?\s+[^;&|]*jmh|npm\s+run\s+bench|pnpm\s+(run\s+)?bench|pytest\s+[^;&|]*--benchmark)|EXPLAIN\s+(ANALYZE\s+)?SELECT/i;
// 측정 원자료를 남겼다는 신호
const BENCH_FILE = /(^|[\\/])(benchmarks?|bench|perf|loadtests?|load-tests?|k6-results?)[\\/][^\\/]+\.(json|csv|txt|log|html)$|[-_](before|after)\.(json|csv|txt|log)$|summary\.json$/i;
// 이미 기록 문서를 썼다는 신호(스캐너와 같은 이름 규칙: TS-012.md, TS-012-slug.md, adr-0003-x.md, 0003-x.md)
const RECORD_FILE = /(^|[\\/])([A-Za-z]{2,6}-\d{1,5}([-_ ][^\\/]*)?|(\d{3,5}|\d{8})-[^\\/]+)\.md$/;
// 스캐너의 종류 판정(KIND_HINTS)과 같은 낱말 + 흔한 기록 폴더 이름
const RECORD_DIR = /troubleshoot|incident|postmortem|post-mortem|improve|perf|optimi|decision|adr|rfc|records?|장애|트러블|개선|성능|결정|회고|기록/i;
// 설계 결정이 바뀌었다는 신호(새 의존성·마이그레이션·인프라 설정)
const DESIGN_FILE = /(^|[\\/])(migrations?|db[\\/]migration|flyway|liquibase|terraform|k8s|helm|charts)[\\/]|(^|[\\/])(package\.json|build\.gradle(\.kts)?|pom\.xml|go\.mod|Cargo\.toml|requirements\.txt|docker-compose[^\\/]*\.ya?ml)$/i;

// 긴 세션은 끝부분(8MB)만 읽는다. 그보다 앞에 쓴 기록 문서는 못 볼 수 있어, 그때는 알림이 날 수 있다
function readTail(file, bytes = 8 * 1024 * 1024) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  const len = Math.min(bytes, st.size);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  return buf.toString("utf8").split("\n").slice(st.size > len ? 1 : 0);
}

// 폴더 이름 판정은 프로젝트 안의 상대 경로로만 한다(사용자 폴더 C:\Users\adrian\ 같은 데 걸리지 않게)
function relPath(p, cwd) {
  const norm = (x) => x.replace(/\\/g, "/");
  if (cwd && path.isAbsolute(p)) {
    const r = norm(path.relative(cwd, p));
    if (!r.startsWith("..")) return r;
    return norm(p).split("/").slice(-3).join("/"); // 프로젝트 밖이면 끝의 세 부분만 본다
  }
  return norm(p);
}

export function analyze(lines, cwd = null) {
  const s = { measured: [], benchFiles: [], designFiles: [], recordFiles: [] };
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type !== "tool_use") continue;
      const inp = c.input || {};
      if (typeof inp.command === "string" && MEASURE_CMD.test(inp.command)) s.measured.push(inp.command.slice(0, 80));
      const fpRaw = inp.file_path || inp.path || inp.notebook_path;
      const fp = typeof fpRaw === "string" ? relPath(fpRaw, cwd) : fpRaw;
      if (typeof fp === "string" && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) {
        if (RECORD_FILE.test(fp) && RECORD_DIR.test(fp)) s.recordFiles.push(fp);
        else if (BENCH_FILE.test(fp)) s.benchFiles.push(fp);
        else if (DESIGN_FILE.test(fp)) s.designFiles.push(fp);
      }
      // 셸로 쓴 파일(k6 --summary-export, > before.json, tee docs/.../TS-012.md 등)
      if (typeof inp.command === "string") {
        for (const mm of inp.command.matchAll(/(?:--summary-export[= ]|--out[= ]json=|>>?\s*|\btee\s+(?:-a\s+)?|\b(?:Set-Content|Add-Content|Out-File)\s+(?:-(?:Path|FilePath|LiteralPath)\s+)?)["']?([^\s"';|&]+)/gi)) {
          const f = relPath(mm[1], cwd);
          if (RECORD_FILE.test(f) && RECORD_DIR.test(f)) s.recordFiles.push(f);
          else if (BENCH_FILE.test(f)) s.benchFiles.push(f);
        }
      }
    }
  }
  return s;
}

// 세션 기록만으로는 스크립트가 인자로 받은 경로에 쓴 파일(node bench.mjs after benchmarks/x.json)을 알 수 없다.
// 그래서 작업 트리에서 아직 커밋하지 않은 파일도 본다
export function fromGitStatus(porcelain, s) {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let f = line.slice(3).trim();
    if (f.includes(" -> ")) f = f.split(" -> ").pop();
    f = f.replace(/^"|"$/g, "");
    if (RECORD_FILE.test(f) && RECORD_DIR.test(f)) s.recordFiles.push(f);
    else if (BENCH_FILE.test(f) && !s.benchFiles.includes(f)) s.benchFiles.push(f);
  }
  return s;
}

function gitStatus(cwd) {
  if (!cwd) return "";
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; } // git이 없거나 저장소가 아니면 세션 기록만 본다
}

export function decide(s) {
  if (s.recordFiles.length) return null;
  const reasons = [];
  if (s.measured.length) reasons.push(`측정 명령을 ${s.measured.length}번 실행함(${s.measured[0]}…)`);
  if (s.benchFiles.length) reasons.push(`측정 원자료를 남김(${path.basename(s.benchFiles[0])})`);
  if (s.designFiles.length) reasons.push(`설계에 영향을 주는 파일을 바꿈(${path.basename(s.designFiles[0])})`);
  if (!reasons.length) return null;
  return reasons;
}

async function main() {
  if (MODE === "off") return;
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let ev; try { ev = JSON.parse(input || "{}"); } catch { return; }
  if (ev.stop_hook_active) return; // 이 hook 때문에 이어진 턴이면 다시 막지 않는다
  if (!ev.transcript_path || !fs.existsSync(ev.transcript_path)) return;

  const stateDir = path.join(os.tmpdir(), "engineering-records");
  fs.mkdirSync(stateDir, { recursive: true });
  // 7일 지난 세션 표시는 지운다
  for (const f of fs.readdirSync(stateDir)) {
    try { const p = path.join(stateDir, f); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.rmSync(p); } catch { /* 무시 */ }
  }
  const stateFile = path.join(stateDir, `${String(ev.session_id || "x").replace(/[^\w-]/g, "")}.done`);
  if (fs.existsSync(stateFile)) return; // 세션마다 한 번만

  const cwd = ev.cwd || process.env.CLAUDE_PROJECT_DIR || null;
  const reasons = decide(fromGitStatus(gitStatus(cwd), analyze(readTail(ev.transcript_path), cwd)));
  if (!reasons) return;
  fs.writeFileSync(stateFile, new Date().toISOString());

  const why = reasons.join(", ");
  if (MODE === "nudge") {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[engineering-records] 이번 작업에서 ${why}. 트러블슈팅·개선·결정 기록이 필요한지 engineering-records 기준으로 판정하라. 필요 없으면 "기록 불필요: <이유>" 한 줄만 쓰고 끝낸다. 필요하면 쓰기 전에 사용자에게 묻는다.`,
    }));
  } else {
    process.stdout.write(JSON.stringify({ systemMessage: `기록 후보: 이번 작업에서 ${why}. 문서로 남길지 보려면 /engineering-records` }));
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === path.basename(new URL(import.meta.url).pathname)) {
  main().catch(() => {}); // hook 오류가 작업을 막지 않게 조용히 끝낸다
}
