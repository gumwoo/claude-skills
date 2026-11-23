// Stop hook: 코드가 바뀐 상태로 Claude가 턴을 끝내려 하면 검증 명령을 실행한다.
// 설정: 같은 폴더의 check-on-stop.json (+ 있으면 check-on-stop.local.json이 덮어씀. 이 PC 전용 값용, git에 올리지 않음)
//   { "mode": "observe", "command": "npm test", "watch": ["src", "test", "package.json"], "timeoutSec": 120 }
// mode (환경변수 CLAUDE_VERIFY_MODE가 있으면 그 값이 우선)
//   observe : 실패해도 막지 않고 사용자에게만 경고(systemMessage)를 보이고 .claude/verify-observe.log에 기록
//   enforce : 실패하면 Stop hook feedback(additionalContext)으로 Claude에게 돌려보내 계속 고치게 함.
//             같은 턴에서 3회 연속 실패하면 더 막지 않고 사용자에게 알림
//   off     : 아무것도 하지 않음
// 시험용: 환경변수 CLAUDE_VERIFY_COMMAND가 있으면 command 대신 실행한다.
// 공통: watch 경로에 변경이 없거나, 이미 판정한 변경 상태와 같으면 다시 돌리지 않는다(.claude/.verify-cache.json).
// 어떤 오류가 나도 exit 0으로 끝나며 턴을 막지 않는다(막는 것은 enforce 모드의 피드백뿐).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ROUNDS = 3;

function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
const notice = (message) => out({ systemMessage: message });

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || String(r.error)).trim()}`);
  return r.stdout;
}

let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* 입력 없음 */ }

const hookDir = path.dirname(fileURLToPath(import.meta.url));
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(hookDir, "check-on-stop.json"), "utf8"));
} catch (e) {
  notice(`[check-on-stop] 설정 파일(check-on-stop.json)을 읽지 못해 검사를 건너뜀: ${e.message}`);
}
try {
  Object.assign(config, JSON.parse(fs.readFileSync(path.join(hookDir, "check-on-stop.local.json"), "utf8")));
} catch (e) {
  if (e.code !== "ENOENT") notice(`[check-on-stop] check-on-stop.local.json을 읽지 못해 검사를 건너뜀: ${e.message}`);
}

const mode = (process.env.CLAUDE_VERIFY_MODE || config.mode || "observe").toLowerCase();
if (mode === "off") out();
if (!["observe", "enforce"].includes(mode)) notice(`[check-on-stop] 알 수 없는 mode "${mode}" (observe|enforce|off). 검사를 건너뜀`);
const command = process.env.CLAUDE_VERIFY_COMMAND || config.command;
const watch = Array.isArray(config.watch) && config.watch.length ? config.watch : ["."];
const timeoutMs = Math.max(60, Number(config.timeoutSec) || 120) * 1000;
if (!command) notice("[check-on-stop] check-on-stop.json에 command가 없어 검사를 건너뜀");

let root, status, fingerprint;
try {
  root = process.env.CLAUDE_PROJECT_DIR || git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  // Git Bash 형식(/c/Users/...)으로 들어오면 Windows 경로로 바꾼다
  if (process.platform === "win32") root = root.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...watch], root)
    .split("\n")
    .filter((line) => line && !line.includes("node_modules/"))
    .join("\n");
  if (!status) out();

  // 변경 내용 지문: 검사 명령 + 추적 파일 diff + 새 파일 내용. 커밋이 아직 없는 저장소는 HEAD 대신 index 기준.
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root }).status === 0;
  const hash = createHash("sha256");
  hash.update(command);
  if (hasHead) {
    hash.update(git(["diff", "HEAD", "--", ...watch], root));
  } else {
    hash.update(git(["diff", "--cached", "--", ...watch], root));
    hash.update(git(["diff", "--", ...watch], root));
  }
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    hash.update(line);
    try { hash.update(fs.readFileSync(path.join(root, line.slice(3).replace(/^"|"$/g, "")))); } catch { /* 무시 */ }
  }
  fingerprint = hash.digest("hex");
} catch (e) {
  notice(`[check-on-stop] 저장소 상태를 확인하지 못해 검사를 건너뜀: ${e.message}`);
}

const cacheFile = path.join(root, ".claude", ".verify-cache.json");
let state = {};
try { state = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* 캐시 없음 */ }
const save = () => {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(state) + "\n");
  } catch { /* 캐시를 못 써도 검사 결과는 그대로 */ }
};

if (state.fingerprint === fingerprint) out(); // 통과했던 상태
if (mode === "observe" && state.observedFail === fingerprint) out(); // 이미 경고한 실패 상태

const run = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });

if (run.error && run.error.code === "ETIMEDOUT") {
  notice(`[check-on-stop] \`${command}\`가 ${timeoutMs / 1000}초 안에 끝나지 않아 검사를 건너뜀. 직접 실행해 확인하세요.`);
}
if (run.error) notice(`[check-on-stop] \`${command}\`를 실행하지 못해 검사를 건너뜀: ${run.error.message}`);

if (run.status === 0) {
  state = { fingerprint, passedAt: new Date().toISOString() };
  save();
  out();
}

const lines = `${run.stdout || ""}${run.stderr || ""}`.trim().split("\n");
const meaningful = lines.filter((l) => l.trim() && !/^\s*>/.test(l)); // npm이 출력하는 "> 명령" 줄 제외
const firstError =
  meaningful.find((l) => /^\s*(✗|✖|×|FAIL\b|ERROR\b|\[ERROR\])/.test(l)) ||
  meaningful.find((l) => /fail|error|오류|실패/i.test(l)) ||
  meaningful[meaningful.length - 1] || "";
const tail = lines.slice(-60).join("\n");

if (mode === "observe") {
  state.observedFail = fingerprint;
  save();
  try {
    fs.appendFileSync(path.join(root, ".claude", "verify-observe.log"),
      `${new Date().toISOString()}\texit=${run.status}\t${firstError.trim()}\n`);
  } catch { /* 로그를 못 써도 경고는 보냄 */ }
  notice(`[check-on-stop 관찰 모드] \`${command}\` 실패(exit ${run.status}) — 막지 않음: ${firstError.trim()}`);
}

// enforce
state.failStreak = input.stop_hook_active ? (state.failStreak || 0) + 1 : 1;
save();
if (state.failStreak > MAX_ROUNDS) {
  state.failStreak = 0;
  save();
  notice(`[check-on-stop] \`${command}\`가 ${MAX_ROUNDS}회 고쳐도 실패해서 더 막지 않습니다. 사람 확인이 필요합니다: ${firstError.trim()}`);
}
out({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: [
      `코드 변경 후 \`${command}\`가 실패했습니다(exit ${run.status}, ${state.failStreak}/${MAX_ROUNDS}회째). 원인을 고친 뒤 끝내세요.`,
      "검사 명령, 테스트 기대값, 기준선 파일을 고쳐서 통과시키지 마세요. 꼭 필요하면 사용자에게 먼저 물으세요.",
      "",
      tail,
    ].join("\n"),
  },
});
