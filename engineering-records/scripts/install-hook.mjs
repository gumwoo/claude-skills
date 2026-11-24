#!/usr/bin/env node
// 작업 끝 알림 hook을 프로젝트에 설치한다. 기존 설정은 지우지 않고 Stop hook 하나만 더한다.
// 사용법: node install-hook.mjs <프로젝트 경로> [local|commit] [observe|nudge]
//   local: .claude/settings.local.json에 넣고, hook 파일과 그 설정 파일을 .git/info/exclude로 git에서 뺀다(나만 씀)
//   commit: .claude/settings.json에 넣는다(팀과 공유)
// 한쪽에 설치하면 다른 쪽 설정에 남아 있던 이 hook은 지운다(두 개가 같이 돌지 않게).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [projectArg, where = "local", mode = "observe"] = process.argv.slice(2);
if (!projectArg || !["local", "commit"].includes(where) || !["observe", "nudge"].includes(mode)) {
  console.error("사용법: node install-hook.mjs <프로젝트 경로> [local|commit] [observe|nudge]");
  process.exit(1);
}
const project = path.resolve(projectArg);
if (!fs.existsSync(project)) { console.error(`프로젝트 경로가 없습니다: ${project}`); process.exit(1); }

const hookRel = ".claude/hooks/records-reminder.mjs";
const isOurs = (h) => typeof h?.command === "string" && h.command.includes("records-reminder.mjs");
const target = path.join(project, ".claude", where === "local" ? "settings.local.json" : "settings.json");
const other = path.join(project, ".claude", where === "local" ? "settings.json" : "settings.local.json");

function readJson(f) {
  if (!fs.existsSync(f)) return {};
  let v;
  // PowerShell 5.1이 쓴 파일은 BOM으로 시작할 수 있다. 빈 파일은 빈 설정으로 본다
  const text = fs.readFileSync(f, "utf8").replace(/^﻿/, "");
  try { v = text.trim() ? JSON.parse(text) : {}; }
  catch (e) { console.error(`${f}를 읽을 수 없어 아무것도 바꾸지 않았습니다: ${e.message}`); process.exit(1); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) { console.error(`${f}가 JSON 객체가 아니라 아무것도 바꾸지 않았습니다`); process.exit(1); }
  if (v.hooks !== undefined && (typeof v.hooks !== "object" || Array.isArray(v.hooks) || (v.hooks.Stop !== undefined && !Array.isArray(v.hooks.Stop)))) {
    console.error(`${f}의 hooks.Stop 형식이 예상과 달라(배열이 아님) 아무것도 바꾸지 않았습니다`); process.exit(1);
  }
  return v;
}
// 두 설정 파일을 먼저 다 읽어서, 하나라도 깨져 있으면 아무것도 쓰지 않는다
const settings = readJson(target);
const otherSettings = fs.existsSync(other) ? readJson(other) : null;

fs.mkdirSync(path.join(project, ".claude", "hooks"), { recursive: true });
fs.copyFileSync(path.join(HERE, "remind-hook.mjs"), path.join(project, hookRel));

const command = `node "$CLAUDE_PROJECT_DIR/${hookRel}" ${mode}`;
settings.hooks ??= {};
settings.hooks.Stop ??= [];
let replaced = false;
for (const group of settings.hooks.Stop) for (const h of group.hooks ?? []) if (isOurs(h)) { h.command = command; replaced = true; }
if (!replaced) settings.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 15 }] });
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");

let removedOther = false;
if (otherSettings?.hooks?.Stop) {
  const before = JSON.stringify(otherSettings.hooks.Stop);
  otherSettings.hooks.Stop = otherSettings.hooks.Stop
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);
  if (!otherSettings.hooks.Stop.length) delete otherSettings.hooks.Stop;
  if (JSON.stringify(otherSettings.hooks.Stop ?? []) !== before) { fs.writeFileSync(other, JSON.stringify(otherSettings, null, 2) + "\n"); removedOther = true; }
}

// git의 exclude 파일. 프로젝트가 저장소의 하위 폴더일 수 있고, worktree면 .git이 파일이다
function gitInfo() {
  let top = project;
  for (;;) {
    const dotgit = path.join(top, ".git");
    if (fs.existsSync(dotgit)) {
      let gitDir = dotgit;
      if (fs.statSync(dotgit).isFile()) {
        const m = fs.readFileSync(dotgit, "utf8").match(/gitdir:\s*(.+)/);
        if (!m) return null;
        gitDir = path.resolve(top, m[1].trim());
        const common = path.join(gitDir, "commondir");
        if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
      }
      return { exclude: path.join(gitDir, "info", "exclude"), prefix: path.relative(top, project).split(path.sep).join("/") };
    }
    const up = path.dirname(top);
    if (up === top) return null;
    top = up;
  }
}
const git = gitInfo();
if (git) {
  const p = (rel) => (git.prefix ? `${git.prefix}/${rel}` : rel);
  fs.mkdirSync(path.dirname(git.exclude), { recursive: true });
  const cur = fs.existsSync(git.exclude) ? fs.readFileSync(git.exclude, "utf8").split(/\r?\n/) : [];
  // local: hook 파일과 설정 파일을 뺀다. commit: 예전 local 설치가 남긴 hook 파일 제외를 푼다(팀원도 받아야 하므로)
  let lines = cur.filter((l) => !(where === "commit" && l === p(hookRel)));
  if (where === "local") for (const w of [p(hookRel), p(".claude/settings.local.json")]) if (!lines.includes(w)) lines.push(w);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.join("\n") !== cur.join("\n").replace(/\n+$/, "")) fs.writeFileSync(git.exclude, lines.join("\n") + "\n");
} else if (where === "local") {
  console.log("git 저장소를 찾지 못해 exclude 설정은 건너뛰었습니다.");
}
console.log(`${replaced ? "갱신" : "설치"}: ${path.relative(project, target)} Stop hook (${mode}) → ${hookRel}${removedOther ? ` (${path.basename(other)}에 있던 같은 hook은 지움)` : ""}`);
