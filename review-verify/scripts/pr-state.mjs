#!/usr/bin/env node
// PR의 지금 상태를 한 번에 본다: 원격 HEAD와 로컬 HEAD, 커밋 안 한 변경, 그 HEAD에서 돈 CI, 돌지 않은 워크플로.
// 리뷰가 "CI 전부 초록", "HEAD는 abc123" 같은 전제를 깔고 있을 때 그 전제를 확인하는 데 쓴다.
// 사용법: node pr-state.mjs [PR 번호|브랜치|URL] [--repo 경로] [--body-out 파일] [--json]
//   --body-out: PR 본문을 파일로 저장한다 (anchors.mjs로 본문 속 파일·이름을 대조할 때)
//   GH_BIN 환경 변수로 gh 대신 쓸 실행 파일을 지정할 수 있다 (.mjs/.js면 node로 실행)
// 종료 코드: 0 = 로컬·원격 HEAD 같음, 커밋 안 한 변경 없음, 모든 체크 성공, 돌았어야 하는데 안 돈 워크플로 없음
//            2 = 그 밖 (진행 중, 실패, HEAD 다름, 안 돈 워크플로 있음), 1 = 실행 오류
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? r.error.message : "") };
}
const git = (cwd, args) => run("git", args, cwd);

function gh(cwd, args) {
  const bin = process.env.GH_BIN || "gh";
  return /\.(m?js|cjs)$/.test(bin) ? run(process.execPath, [bin, ...args], cwd) : run(bin, args, cwd);
}

// ---------- GitHub Actions 경로 필터 ----------

// GitHub 필터 패턴(워크플로 문법 문서의 "Filter pattern cheat sheet"):
//   * 는 / 를 넘지 않는 0글자 이상, ** 는 아무 글자 0개 이상,
//   ? 는 "앞 글자 0~1개"('*.jsx?'는 .js와 .jsx), + 는 "앞 글자 1개 이상", [] 는 영숫자 한 글자.
export function globToRe(glob) {
  const atoms = []; // 수량자를 붙일 수 있는 단위
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; atoms.push({ re: "(?:.*/)?", q: false }); } else atoms.push({ re: ".*", q: false });
      } else atoms.push({ re: "[^/]*", q: false });
    } else if (c === "\\" && i + 1 < glob.length) {
      // \ 로 특수 문자를 글자 그대로 쓴다 (app/\[id\]/**)
      i++;
      atoms.push({ re: glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), q: true });
    } else if ((c === "?" || c === "+") && atoms.length && atoms.at(-1).q) {
      atoms.at(-1).re += c;
      atoms.at(-1).q = false;
    } else if (c === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j > i + 1) { atoms.push({ re: `[${glob.slice(i + 1, j).replace(/[\\^]/g, "\\$&")}]`, q: true }); i = j; }
      else atoms.push({ re: "\\[", q: true });
    } else atoms.push({ re: c.replace(/[.+?^${}()|[\]\\]/g, "\\$&"), q: true });
  }
  return new RegExp(`^${atoms.map((a) => a.re).join("")}$`);
}

// 패턴 목록을 순서대로 적용한다. ! 로 시작하면 앞에서 걸린 것을 다시 뺀다.
export function matchList(file, patterns) {
  let hit = false;
  for (const p of patterns) {
    const neg = p.startsWith("!");
    if (globToRe(neg ? p.slice(1) : p).test(file)) hit = !neg;
  }
  return hit;
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
// 줄 전체 주석(들여쓰기와 상관없이)은 빈 줄로, 줄 끝 주석은 떼어 낸다. 빈 줄은 블록을 끊지 않는다
// 따옴표 안의 #(name: "Test #1")은 주석이 아니다. 따옴표는 값이 시작하는 자리(: - [ , { 뒤)에서만 연다
// (name: Rock 'n roll CI 의 '는 따옴표가 아니다)
function stripComment(s) {
  if (/^\s*#/.test(s)) return "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; }
    else if ((c === '"' || c === "'") && /^$|[:\[,{-]$/.test(s.slice(0, i).trimEnd())) q = c;
    else if (c === "#" && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i).trimEnd();
  }
  return s;
}
const indentOf = (s) => s.match(/^ */)[0].length;
const inlineList = (s) => s.trim().replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);

const FILTER_KEY = { branches: "branches", "branches-ignore": "branchesIgnore", paths: "paths", "paths-ignore": "pathsIgnore", types: "types", tags: "tags", "tags-ignore": "tagsIgnore" };
const FILTER_RE = "branches-ignore|branches|paths-ignore|paths|types|tags-ignore|tags";
// { types: [closed], paths: ['src/**'] } 같은 한 줄 매핑에서 필터를 읽는다
function readFlowFilters(s, res) {
  for (const f of s.matchAll(new RegExp(`(${FILTER_RE})\\s*:\\s*(\\[[^\\]]*\\]|\\*\\S+)`, "g"))) {
    if (f[2].startsWith("*")) (res.unreadable ??= []).push(f[1]); // YAML 별칭(*name)은 값을 따라가지 않는다
    else res[FILTER_KEY[f[1]]] = inlineList(f[2]);
  }
}

// on 블록 아래 이벤트 하나(pull_request:, push:)의 필터를 읽는다. at은 그 이벤트 줄의 위치
function readEventFilters(block, at, base, res) {
  const inline = block[at].replace(/^[^:]*:\s*/, "").trim();
  if (inline.startsWith("{")) { readFlowFilters(inline, res); return; } // pull_request: { types: [closed] }
  if (/^[*&]/.test(inline) && !/^&\S+$/.test(inline)) { (res.unreadable ??= []).push("이벤트 설정(YAML 앵커·별칭)"); return; }
  const sub = [];
  for (let i = at + 1; i < block.length && indentOf(block[i]) > base; i++) sub.push(block[i]);
  const keyIndent = sub.length ? indentOf(sub[0]) : 0;
  for (let i = 0; i < sub.length; i++) {
    if (/^\s*<<\s*:/.test(sub[i]) && indentOf(sub[i]) === keyIndent) { (res.unreadable ??= []).push("<<(YAML 병합 키)"); continue; }
    const m = sub[i].match(new RegExp(`^\\s*(${FILTER_RE})\\s*:\\s*(.*)$`));
    if (!m || indentOf(sub[i]) !== keyIndent) continue;
    let raw = m[2].trim().replace(/^&\S+\s*/, ""), vals = [], alias = /^\*/.test(raw); // &name은 앵커 정의라 떼고 읽는다
    if (alias) { /* 별칭: 값을 따라가지 않는다 */ }
    else if (raw.startsWith("[")) {
      // 여러 줄에 걸친 [ ... ]
      for (let j = i + 1; !raw.includes("]") && j < sub.length; j++) raw += " " + sub[j].trim();
      vals = inlineList(raw);
    } else if (raw) vals = [unquote(raw)];
    else for (let j = i + 1; j < sub.length; j++) {
      // 목록 항목은 키보다 깊게 써도, 키와 같은 깊이에 - 로 써도 된다
      const deeper = indentOf(sub[j]) > keyIndent, sameDash = indentOf(sub[j]) === keyIndent && /^\s*-\s/.test(sub[j]);
      if (!deeper && !sameDash) break;
      const v = sub[j].match(/^\s*-\s*(.+)$/);
      // - &name 'src/**' 처럼 항목에 붙은 앵커 정의는 떼고 읽는다
      if (v) { const item = v[1].trim().replace(/^&\S+\s*/, ""); if (/^\*/.test(item)) alias = true; else if (item) vals.push(unquote(item)); }
    }
    const key = FILTER_KEY[m[1]];
    if (vals.length && !alias) res[key] = vals;
    else (res.unreadable ??= []).push(m[1]); // 키는 있는데 값을 못 읽었다(별칭 포함). 필터 없음으로 치면 안 된다
  }
}

const emptyFilters = () => ({ branches: null, branchesIgnore: null, paths: null, pathsIgnore: null, types: null, tags: null, tagsIgnore: null });

// 이벤트 키는 따옴표로 감싸도 된다("pull_request":)
const EV_PR = /^\s*["']?(pull_request_target|pull_request)["']?\s*:/;
const EV_PUSH = /^\s*["']?push["']?\s*:/;

// 워크플로 파일에서 이름과 pull_request·push 조건만 읽는다. YAML 전체를 해석하지 않는다.
// push 조건은 res.push에 따로 둔다(push로만 도는 CI, pull_request 필터로는 안 돌지만 push로는 도는 경우).
// on: 안에 pull_request·push 글자가 있는데 형식을 알아보지 못하면 res.unparsed를 켠다. 목록에서 빠지면 안 되기 때문이다.
export function parseWorkflow(text, file) {
  const res = parseOn(text, file);
  // 이벤트 이름이 키나 목록 항목 자리에 있을 때만 본다("Whether to push image" 같은 설명 글은 아님)
  if (!res.pr && !res.push && /(^|[\s\[{,-])["']?(pull_request(_target)?|push)["']?\s*(:|,|\]|\}|$)/m.test(res.onText ?? "")) res.unparsed = true;
  delete res.onText;
  return res;
}

function parseOn(text, file) {
  let lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(stripComment); // Windows 편집기가 붙이는 BOM
  const nameLine = lines.find((l) => /^name:\s*\S/.test(l));
  const name = nameLine ? unquote(nameLine.replace(/^name:\s*/, "")) : file;
  const onIdx = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));
  const res = { file, name, pr: false, kind: null, ...emptyFilters(), push: null };
  if (onIdx < 0) return res;
  let head = lines[onIdx].replace(/^[^:]+:\s*/, "").trim();
  if (head.startsWith("{") || head.startsWith("[")) {
    // 여러 줄에 걸친 { ... }, [ ... ]도 한 줄로 이어 붙인다
    const open = head[0], close = open === "{" ? "}" : "]";
    let depth = 0;
    const count = (s) => { for (const c of s) depth += c === open ? 1 : c === close ? -1 : 0; };
    count(head);
    for (let i = onIdx + 1; depth > 0 && i < lines.length; i++) { head += " " + lines[i].trim(); count(lines[i]); }
  }
  res.onText = head;
  if (head.startsWith("{")) {
    // 한 줄 형식: on: { pull_request: { branches: [main], paths: ['src/**'] } }. 키의 따옴표는 지우고 본다
    const flat = head.replace(/["']/g, "");
    const m = flat.match(/\b(pull_request_target|pull_request)\s*:\s*(\{[^{}]*\}|[^,}]*)/);
    if (m) {
      res.pr = true; res.kind = m[1];
      if (/^\s*\*/.test(m[2])) (res.unreadable ??= []).push("이벤트 설정(YAML 별칭)");
      else readFlowFilters(m[2], res);
    }
    const pm = flat.match(/\bpush\s*:\s*(\{[^{}]*\}|[^,}]*)/);
    if (pm) { res.push = emptyFilters(); if (/^\s*\*/.test(pm[1])) (res.push.unreadable = ["이벤트 설정(YAML 별칭)"]); else readFlowFilters(pm[1], res.push); }
    return res;
  }
  if (head) {
    const evs = head.startsWith("[") ? inlineList(head) : [unquote(head)];
    const k = evs.find((e) => e === "pull_request" || e === "pull_request_target");
    if (k) { res.pr = true; res.kind = k; }
    if (evs.includes("push")) res.push = emptyFilters();
    return res;
  }
  // on: 블록. YAML은 목록(- x)을 키와 같은 깊이에 써도 된다(on:\n- push)
  const block = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) === 0 && !/^-\s/.test(lines[i])) break;
    block.push(lines[i]);
  }
  // 안전장치는 on 블록의 맨 위 깊이만 본다(workflow_dispatch의 input 이름 push: 같은 것은 이벤트가 아니다)
  res.onText = block.filter((l) => indentOf(l) === indentOf(block[0])).join("\n");
  // 목록 형태: on:\n  - push\n  - pull_request
  let isList = false;
  for (const l of block) {
    const m = l.match(/^\s*-\s*(\S+)/);
    if (!m || indentOf(l) !== indentOf(block[0])) continue;
    isList = true;
    const ev = unquote(m[1]);
    if (ev === "pull_request" || ev === "pull_request_target") { res.pr = true; res.kind = ev; }
    if (ev === "push") res.push = emptyFilters();
  }
  if (isList) return res;
  const base = block.length ? indentOf(block[0]) : 0;
  const prAt = block.findIndex((l) => indentOf(l) === base && EV_PR.test(l));
  if (prAt >= 0) {
    res.pr = true;
    res.kind = block[prAt].match(EV_PR)[1];
    readEventFilters(block, prAt, base, res);
  }
  const pushAt = block.findIndex((l) => indentOf(l) === base && EV_PUSH.test(l));
  if (pushAt >= 0) { res.push = emptyFilters(); readEventFilters(block, pushAt, base, res.push); }
  return res;
}

// push로만 도는 워크플로가 PR HEAD 커밋에 돌았어야 하는지. push의 paths는 직전 push와 비교하므로 PR 파일 목록으로는 확정하지 못한다
export function expectPushRun(push, headBranch, changedFiles) {
  if (push.unreadable?.length) return { expected: undefined, why: `push의 ${push.unreadable.join(", ")} 값을 읽지 못함. 워크플로 파일을 직접 읽어야 함` };
  if ((push.tags || push.tagsIgnore) && !push.branches && !push.branchesIgnore) return { expected: false, why: "push 중 태그에만 돎" };
  if (push.branches && !matchList(headBranch, push.branches)) return { expected: false, why: `push 워크플로인데 PR 브랜치 ${headBranch}가 branches 필터 밖` };
  if (push.branchesIgnore && matchList(headBranch, push.branchesIgnore)) return { expected: false, why: `push 워크플로인데 PR 브랜치 ${headBranch}가 branches-ignore에 걸림` };
  if (push.paths || push.pathsIgnore) {
    const hit = push.paths ? changedFiles.filter((f) => matchList(f, push.paths)) : changedFiles.filter((f) => !matchList(f, push.pathsIgnore));
    // 확정 못 하면 통과로 보지 않는다(undefined = 모름!)
    return hit.length ? { expected: undefined, why: `push 워크플로. paths는 직전 push와 비교라 이 HEAD에 돌았어야 하는지 확정 못 함 (PR 전체로는 걸리는 파일 ${hit.length}개). 마지막 push가 그 파일을 건드렸는지 확인해야 함` } : { expected: false, why: "push 워크플로인데 바뀐 파일이 모두 paths 필터 밖" };
  }
  return { expected: true, why: `push 워크플로. PR 브랜치 ${headBranch}에 push하면 돎` };
}

// 이 PR에서 그 워크플로가 돌아야 하는지 필터대로 계산한다
export function expectRun(wf, baseBranch, changedFiles) {
  if (!wf.pr) return { expected: false, why: "pull_request 이벤트가 없음" };
  if (wf.unreadable?.length) return { expected: undefined, why: `${wf.unreadable.join(", ")} 값을 읽지 못함. 워크플로 파일을 직접 읽어야 함` };
  // types를 안 쓰면 opened·synchronize·reopened에 돈다. push로 생기는 이벤트는 synchronize다.
  // synchronize가 없고 opened·reopened만 있으면 PR을 연 첫 커밋에만 돌아서, 지금 HEAD에 돌았어야 하는지 알 수 없다.
  if (wf.types && !wf.types.includes("synchronize")) {
    if (wf.types.some((t) => t === "opened" || t === "reopened")) return { expected: null, why: `types가 ${wf.types.join(", ")}라 PR을 열 때만 돎(그 뒤 push에는 안 돎)` };
    return { expected: false, why: `types가 ${wf.types.join(", ")}뿐이라 커밋 push에는 돌지 않음` };
  }
  if (wf.branches && !matchList(baseBranch, wf.branches)) return { expected: false, why: `기준 브랜치 ${baseBranch}가 branches 필터 밖` };
  if (wf.branchesIgnore && matchList(baseBranch, wf.branchesIgnore)) return { expected: false, why: `기준 브랜치 ${baseBranch}가 branches-ignore에 걸림` };
  if (wf.paths) {
    const hit = changedFiles.filter((f) => matchList(f, wf.paths));
    return hit.length ? { expected: true, why: `paths 필터에 걸리는 파일 ${hit.length}개 (${hit.slice(0, 3).join(", ")})` } : { expected: false, why: "바뀐 파일이 모두 paths 필터 밖" };
  }
  if (wf.pathsIgnore) {
    const left = changedFiles.filter((f) => !matchList(f, wf.pathsIgnore));
    return left.length ? { expected: true, why: `paths-ignore 밖 파일 ${left.length}개` } : { expected: false, why: "바뀐 파일이 모두 paths-ignore에 걸림" };
  }
  return { expected: true, why: "필터 없음" };
}

// ---------- 상태 모으기 ----------

// SKIPPED는 실패는 아니지만 성공도 아니다(draft, if: 조건, 경로 판별 job 때문에 테스트가 통째로 건너뛰어졌을 수 있다)
const GOOD = new Set(["SUCCESS", "NEUTRAL"]);

export function collect({ repo = ".", pr = null } = {}) {
  const topR = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!topR.ok) throw new Error("git 저장소가 아닙니다");
  const top = topR.out.trim();
  const fields = "number,url,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,baseRefName,isCrossRepository,files,statusCheckRollup,body";
  const r = gh(top, ["pr", "view", ...(pr ? [pr] : []), "--json", fields]);
  if (!r.ok) throw new Error(`gh pr view 실패: ${r.err.trim() || "출력 없음"}\n  (gh 설치·로그인, 이 브랜치에 열린 PR이 있는지 확인하세요)`);
  let p;
  try { p = JSON.parse(r.out); } catch { throw new Error("gh 출력이 JSON이 아닙니다"); }

  const localHead = git(top, ["rev-parse", "HEAD"]).out.trim();
  const branch = git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  // 새로 만들고 add 안 한 파일(새 테스트 등)도 CI가 보지 못한 변경이다. .gitignore에 걸린 것은 세지 않는다
  const dirty = git(top, ["status", "--porcelain"]).out.split("\n").filter(Boolean);
  const untracked = dirty.filter((l) => l.startsWith("??")).length;
  const hasHead = git(top, ["cat-file", "-e", `${p.headRefOid}^{commit}`]).ok;
  let headRel;
  if (localHead === p.headRefOid) headRel = { same: true, note: "로컬 HEAD와 PR HEAD가 같습니다" };
  else if (branch !== p.headRefName) headRel = { same: false, note: `로컬은 PR 브랜치(${p.headRefName})가 아니라 ${branch}입니다. PR 브랜치를 체크아웃해야 로컬 코드와 CI 결과가 같은 코드를 가리킵니다` };
  else {
    if (!hasHead) headRel = { same: false, note: `PR HEAD 커밋이 로컬에 없습니다. git fetch origin pull/${p.number}/head 후 다시 보세요(포크 PR은 브랜치를 fetch해도 받아지지 않음)` };
    else if (git(top, ["merge-base", "--is-ancestor", p.headRefOid, localHead]).ok) {
      const n = git(top, ["rev-list", "--count", `${p.headRefOid}..${localHead}`]).out.trim();
      headRel = { same: false, note: `로컬에 push 안 한 커밋이 ${n}개 있습니다. CI 결과는 그 커밋들을 포함하지 않습니다` };
    } else if (git(top, ["merge-base", "--is-ancestor", localHead, p.headRefOid]).ok) {
      const n = git(top, ["rev-list", "--count", `${localHead}..${p.headRefOid}`]).out.trim();
      headRel = { same: false, note: `원격 PR이 로컬보다 ${n}커밋 앞서 있습니다. pull 하고 다시 보세요` };
    } else headRel = { same: false, note: "로컬 HEAD와 PR HEAD가 갈라져 있습니다 (다른 브랜치이거나 force-push)" };
  }

  const checks = (p.statusCheckRollup ?? []).map((c) => c.__typename === "StatusContext"
    ? { kind: "status", name: c.context, workflow: null, state: c.state === "SUCCESS" ? "SUCCESS" : c.state === "PENDING" || c.state === "EXPECTED" ? "PENDING" : c.state, url: c.targetUrl ?? null }
    : { kind: "check", name: c.name, workflow: c.workflowName || null, state: c.status !== "COMPLETED" ? "PENDING" : (c.conclusion || "UNKNOWN"), url: c.detailsUrl ?? null });

  // 바뀐 파일 목록은 GitHub가 계산한 gh 목록을 쓴다. 100개에서 잘리므로,
  // PR HEAD와 기준 브랜치가 로컬에 있을 때만 git으로 다시 계산한다
  let changed = (p.files ?? []).map((f) => f.path), filesSource = "gh";
  if (hasHead && changed.length >= 100) {
    for (const ref of [`origin/${p.baseRefName}`, p.baseRefName]) {
      const mb = git(top, ["merge-base", ref, p.headRefOid]);
      if (!mb.ok) continue;
      const d = git(top, ["diff", "--name-only", "-z", mb.out.trim(), p.headRefOid]);
      if (d.ok) { changed = d.out.split("\0").filter(Boolean); filesSource = `git (${ref}와의 공통 조상부터)`; break; }
    }
  }
  // gh pr view의 files는 files(first: 100)으로 받고 다음 페이지를 받지 않는다(cli/cli api/query_builder.go).
  // 체크(statusCheckRollup)는 gh가 끝까지 받는다(pkg/cmd/pr/shared/finder.go의 preloadPrChecks)
  const filesMaybeCut = filesSource === "gh" && changed.length >= 100;
  // pull_request 워크플로는 PR 쪽 파일로 돈다. 그래서 작업 트리가 아니라 PR HEAD 커밋의 파일을 읽는다.
  let workflows = [], workflowSource;
  if (hasHead) {
    workflowSource = `PR HEAD ${p.headRefOid.slice(0, 7)}`;
    const ls = git(top, ["ls-tree", "--name-only", `${p.headRefOid}:.github/workflows`]);
    if (ls.ok) workflows = ls.out.split("\n").filter((f) => /\.ya?ml$/.test(f)).map((f) =>
      parseWorkflow(git(top, ["show", `${p.headRefOid}:.github/workflows/${f}`]).out, `.github/workflows/${f}`));
  } else {
    workflowSource = "작업 트리 (PR HEAD가 로컬에 없어 대신 읽음. PR과 다를 수 있음)";
    const wfDir = path.join(top, ".github", "workflows");
    try {
      workflows = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => parseWorkflow(fs.readFileSync(path.join(wfDir, f), "utf8"), `.github/workflows/${f}`));
    } catch { /* 워크플로 폴더 없음 */ }
  }
  const ran = new Set(checks.map((c) => c.workflow).filter(Boolean));
  // 체크에는 워크플로 이름만 남는다. 같은 이름의 워크플로가 둘 이상이면 어느 쪽이 돌았는지 체크로 가릴 수 없다
  // PR HEAD에서 돌 수 있는 워크플로끼리만 센다(schedule에만 도는 같은 이름 워크플로는 이 HEAD의 체크를 만들지 않는다)
  const cand = workflows.filter((w) => w.pr || w.push || w.unparsed);
  const nameCount = new Map();
  for (const w of cand) nameCount.set(w.name, (nameCount.get(w.name) ?? 0) + 1);
  const wf = cand.map((w) => {
    let e, via = w.pr ? "pr" : "push";
    if (w.unparsed) e = { expected: undefined, why: "on:에 pull_request·push가 보이는데 형식을 읽지 못함. 워크플로 파일을 직접 읽어야 함" };
    else {
      e = w.pr ? expectRun(w, p.baseRefName, changed) : null;
      // pull_request로는 안 돌아도 push로는 돌 수 있다(push 필터 없음 + pull_request branches: [main] 등)
      if (w.push && (!e || e.expected === false)) {
        let ep = expectPushRun(w.push, p.headRefName, changed);
        // 포크 PR이면 push 워크플로는 포크 저장소에서 돌아 이 PR의 체크에 보이지 않는다. 통과 근거로 쓸 수 없다
        if (ep.expected === true && p.isCrossRepository) ep = { expected: undefined, why: `${ep.why}. 다만 포크 PR이라 포크 저장소에서 돌아 이 PR 체크에 안 보임. 테스트가 돌았는지 확인 못 함` };
        if (!e) e = ep;
        else if (ep.expected !== false) { e = { ...ep, why: `pull_request로는 안 돎(${e.why}). ${ep.why}` }; via = "push"; }
      }
    }
    const byName = ran.has(w.name) || ran.has(w.file);
    const dup = nameCount.get(w.name) > 1 && !ran.has(w.file);
    const didRun = byName && !dup;
    if (byName && dup && e.expected === true) e = { expected: undefined, why: `같은 이름(${w.name})의 워크플로가 ${nameCount.get(w.name)}개라, 체크로는 이 파일(${w.file})이 돌았는지 가릴 수 없음. ${e.why}` };
    let status;
    if (didRun) status = "RAN";
    else if (e.expected === true) status = "MISSING"; // 필터대로라면 돌았어야 하는데 체크가 없다
    else if (e.expected === null) status = "UNSURE"; // types 때문에 이 HEAD에 돌았어야 하는지 알 수 없다
    else if (e.expected === undefined) status = "UNREAD"; // 필터를 못 읽었거나 돌았어야 하는지 확정 못 했다. 통과라고 하지 않는다
    else status = "FILTERED"; // 필터 때문에 안 돌았다. 필터가 맞는지는 사람이 판단한다
    return { ...w, ...e, via, status };
  });

  return {
    number: p.number, url: p.url, title: p.title, state: p.state, isDraft: p.isDraft,
    mergeable: p.mergeable, mergeState: p.mergeStateStatus,
    base: p.baseRefName, headBranch: p.headRefName, head: p.headRefOid,
    local: { head: localHead, branch, uncommitted: dirty.length, untracked, ...headRel },
    checks, workflows: wf, workflowSource, changedFiles: changed.length, filesSource, filesMaybeCut, body: p.body ?? "",
  };
}

export function verdict(s) {
  const pending = s.checks.filter((c) => c.state === "PENDING");
  const skipped = s.checks.filter((c) => c.state === "SKIPPED");
  const failed = s.checks.filter((c) => c.state !== "PENDING" && c.state !== "SKIPPED" && !GOOD.has(c.state));
  const missing = s.workflows.filter((w) => w.status === "MISSING" || w.status === "UNREAD");
  const filtered = s.workflows.filter((w) => w.status === "FILTERED" || w.status === "UNSURE");
  // 파일 목록이 잘렸을 수 있으면 "필터 밖이라 안 돈 게 정상"이라는 계산 자체를 믿을 수 없다
  const clean = s.local.same && !s.local.uncommitted && !pending.length && !failed.length && !skipped.length && !missing.length && s.checks.length > 0 && !s.filesMaybeCut;
  return { pending, failed, skipped, missing, filtered, clean };
}

function render(s) {
  const v = verdict(s);
  const o = [];
  o.push(`PR #${s.number} ${s.title}`);
  o.push(`  상태 ${s.state}${s.isDraft ? " (draft)" : ""} · mergeable ${s.mergeable} · ${s.base} ← ${s.headBranch}`);
  o.push(`  PR HEAD ${s.head.slice(0, 7)} · 로컬 ${s.local.branch} ${s.local.head.slice(0, 7)} — ${s.local.note}`);
  if (s.local.uncommitted) o.push(`  커밋 안 한 변경 ${s.local.uncommitted}개${s.local.untracked ? `(add 안 한 새 파일 ${s.local.untracked}개 포함)` : ""}: CI와 리뷰 어느 쪽도 이 변경을 보지 않았습니다`);
  o.push("", `체크 (PR HEAD ${s.head.slice(0, 7)} 기준)`);
  if (!s.checks.length) o.push("  체크가 하나도 없습니다. 'CI 통과'라고 말할 근거가 없습니다");
  for (const c of s.checks) o.push(`  ${c.state.padEnd(9)} ${c.workflow ? `${c.workflow} / ` : ""}${c.name}`);
  if (s.workflows.length) {
    o.push("", `워크플로 (pull_request·push 이벤트만 봄. 바뀐 파일 ${s.changedFiles}개, 목록은 ${s.filesSource}에서 / 워크플로 파일은 ${s.workflowSource})`);
    if (s.filesMaybeCut) o.push(`  gh는 바뀐 파일을 100개까지만 줍니다. 기준 브랜치(git fetch origin ${s.base})와 PR HEAD가 로컬에 있으면 git으로 전체를 계산합니다`);
    for (const w of s.workflows) {
      const label = { RAN: "돎", MISSING: "안 돎!", FILTERED: "안 돎", UNSURE: "안 돎?", UNREAD: "모름!" }[w.status];
      const target = w.kind === "pull_request_target" ? " (pull_request_target은 기준 브랜치 쪽 워크플로 파일로 돎. PR HEAD의 파일과 다를 수 있음)" : "";
      o.push(`  ${label.padEnd(6)} ${w.name}${w.via === "push" ? " [push]" : ""}  — ${w.why}${target}`);
    }
  }
  o.push("");
  if (v.clean) o.push(`판정: PR HEAD ${s.head.slice(0, 7)}에서 체크 ${s.checks.length}개 모두 성공`);
  else {
    const why = [];
    if (!s.local.same) why.push("로컬과 PR HEAD가 다름");
    if (s.local.uncommitted) why.push("커밋 안 한 변경");
    if (v.pending.length) why.push(`진행 중 ${v.pending.length}`);
    if (v.failed.length) why.push(`실패 ${v.failed.length}`);
    if (v.skipped.length) why.push(`건너뛴 체크 ${v.skipped.length}(왜 건너뛰었는지 확인 필요)`);
    if (v.missing.length) why.push(`돌았어야 하는데 안 돈 워크플로, 또는 돌았는지 확정 못 한 워크플로 ${v.missing.length}`);
    if (!s.checks.length) why.push("체크 없음");
    if (s.filesMaybeCut) why.push("바뀐 파일 목록이 잘렸을 수 있음");
    o.push(`판정: 아직 "CI 통과"라고 할 수 없음 — ${why.join(", ")}`);
  }
  if (v.filtered.length) o.push(`참고: 필터(paths·branches·types) 때문에 안 돈 워크플로 ${v.filtered.length}개(${v.filtered.map((w) => w.name).join(", ")}). 이번 변경을 그 워크플로가 검사해야 하는지는 필터를 읽고 판단하세요`);
  return o.join("\n");
}

function main(argv) {
  const a = { repo: ".", pr: null, bodyOut: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--repo") a.repo = argv[++i];
    else if (x === "--body-out") a.bodyOut = argv[++i];
    else if (x === "--json") a.json = true;
    else if (x === "-h" || x === "--help") { console.log("사용법: node pr-state.mjs [PR 번호|브랜치|URL] [--repo 경로] [--body-out 파일] [--json]"); return 0; }
    else if (!a.pr) a.pr = x;
    else { console.error(`알 수 없는 인자: ${x}`); return 1; }
  }
  let s;
  try { s = collect(a); } catch (e) { console.error(e.message); return 1; }
  if (a.bodyOut) { fs.mkdirSync(path.dirname(path.resolve(a.bodyOut)), { recursive: true }); fs.writeFileSync(a.bodyOut, s.body); }
  if (a.json) { const { body, ...rest } = s; console.log(JSON.stringify({ ...rest, verdict: verdict(s) }, null, 2)); }
  else console.log(render(s) + (a.bodyOut ? `\nPR 본문을 ${a.bodyOut}에 저장했습니다` : ""));
  return verdict(s).clean ? 0 : 2;
}

// 직접 실행됐을 때만 main. 링크(심볼릭 링크·정션)로 설치한 경로로 불러도 실제 경로끼리 비교한다
function isMain() {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1])), b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
