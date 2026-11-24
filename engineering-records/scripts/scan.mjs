#!/usr/bin/env node
// 저장소에 이미 있는 기록 문서(트러블슈팅·개선·결정)의 규칙을 읽는다: 폴더, 접두어, 다음 번호, 템플릿, 목록 파일.
// 사용법: node scan.mjs [저장소 경로] [--json] [--check]
//   --check: 목록 파일에 빠진 문서, 겹치는 번호가 있으면 종료 코드 2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set([".git", "node_modules", ".next", "build", "dist", "target", ".gradle", "vendor", ".venv", "venv", "out", "coverage", "fixtures", "__fixtures__", "testdata", "test-data"]);
const KIND_HINTS = [
  ["troubleshooting", /^(TS|TRB|INC|PM|BUG)$|troubleshoot|incident|postmortem|post-mortem|장애|트러블/i],
  ["improvement", /^(IMP|PERF|OPT)$|improve|perf|optimi|개선|성능/i],
  ["decision", /^(ADR|DEC|RFC)$|decision|adr|결정/i],
];

function guessKind(prefix, dir) {
  for (const [kind, re] of KIND_HINTS) if (re.test(prefix ?? "")) return kind;
  for (const [kind, re] of KIND_HINTS) if (re.test(path.basename(dir))) return kind;
  return "other";
}

function walk(root, depth = 0, acc = []) {
  if (depth > 5) return acc;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(path.join(root, e.name), depth + 1, acc); }
    else if (e.name.toLowerCase().endsWith(".md")) acc.push(path.join(root, e.name));
  }
  return acc;
}

// TS-001-slug.md / IMP-12.md / ADR-0003-title.md / (결정 폴더 안의) 0001-title.md
const PREFIXED = /^([A-Za-z]{2,6})-(\d{1,5})([-_ ].*)?\.md$/;
// 0001-title.md(adr-tools, MADR) 또는 20240115-title.md(log4brains, 날짜형)
const BARE = /^(\d{3,5}|\d{8})-.+\.md$/;
const TEMPLATE_FILE = /template/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 목록 파일에 그 문서가 있는지: 부분 문자열(IMP-1이 IMP-10 안에 있음)로 판단하지 않는다
function listedIn(indexText, fileName) {
  // %20 같은 URL 인코딩은 그 부분만 푼다(본문의 "75% 감소" 때문에 전체 디코딩이 실패하지 않게)
  const decoded = indexText.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
  const text = indexText + "\n" + decoded;
  const stem = fileName.replace(/\.md$/, "");
  if (new RegExp(`(^|[^\\w-])${escapeRe(stem)}(\\.md)?(?![\\w-])`).test(text)) return true;
  // 링크 없이 ID만 적은 목록(| TS-001 | 느린 쿼리 |)도 인정한다. 접두어가 있는 ID만(숫자만 있는 0001은 너무 흔하다)
  const id = stem.match(/^([A-Za-z]{2,6}-\d{1,5})(?:[-_ ]|$)/)?.[1];
  return !!id && new RegExp(`(^|[^\\w-])${escapeRe(id)}(?![\\w]|-\\d)`, "i").test(text);
}

// 목록 파일: _index.md·index.md는 이름만으로 인정하고, README.md는 이 문서들을 실제로 싣고 있을 때만 쓴다(설명만 있는 README 제외).
// 같은 폴더에 없으면 한 단계 위 폴더에서 같은 방식으로 찾는다
function findIndex(dir, root, files) {
  for (const d of [dir, path.dirname(dir)]) {
    if (d !== dir && (d === dir || path.relative(root, d).startsWith(".."))) break;
    const names = fs.readdirSync(d);
    const explicit = names.find((x) => /^(_index|index)\.md$/i.test(x));
    if (explicit && d === dir) return path.join(d, explicit);
    for (const f of [explicit, names.find((x) => /^readme\.md$/i.test(x))].filter(Boolean)) {
      const text = fs.readFileSync(path.join(d, f), "utf8");
      if (files.some((x) => listedIn(text, x.file))) return path.join(d, f);
    }
  }
  return null;
}

function loadConfig(root) {
  const f = path.join(root, ".records.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function scan(root) {
  root = path.resolve(root);
  const config = loadConfig(root);
  const groups = new Map();
  for (const file of walk(root)) {
    const base = path.basename(file);
    const dir = path.dirname(file);
    let prefix = null, num = null;
    const relDir = path.relative(root, dir);
    if (TEMPLATE_FILE.test(base)) continue; // 0000-template.md는 기록이 아니다
    let m = base.match(PREFIXED);
    // 일반 문서(step-1.md, UTF-8.md, day-2.md)를 기록으로 세지 않는다. 기록으로 보는 경우:
    //   접두어나 폴더가 기록 종류로 보이거나, .records.json에 있는 접두어이거나, 대문자 접두어에 0으로 채운 번호 또는 제목이 붙은 경우
    if (m) {
      const known = guessKind(m[1], "") !== "other" || guessKind("", dir) !== "other" || Object.entries(config?.types ?? {}).some(([k, v]) => (v.prefix ?? k).toUpperCase() === m[1].toUpperCase());
      const looksRecord = m[1] === m[1].toUpperCase() && (/^0\d/.test(m[2]) || !!m[3]);
      if (!known && !looksRecord) m = null;
    }
    if (m) { prefix = m[1]; num = m[2]; }
    else if ((m = base.match(BARE)) && /(^|[\\/])(adrs?|decisions?|architecture[-_]?decisions?|결정)([\\/]|$)/i.test(relDir)) { prefix = ""; num = m[1]; }
    else continue;
    const key = dir + "|" + prefix.toUpperCase(); // adr-0001과 ADR-0001은 같은 묶음(번호 중복을 잡으려고)
    if (!groups.has(key)) groups.set(key, { dir, prefix, files: [] });
    groups.get(key).files.push({ file: base, num: Number(num), width: num.length });
  }

  // 같은 접두어가 여러 폴더(연도별 하위 폴더 등)에 나뉘어 있으면 번호는 전체에서 이어진다
  const maxByPrefix = new Map();
  for (const g of groups.values()) {
    const k = g.prefix.toUpperCase();
    if (!k) continue;
    for (const f of g.files) maxByPrefix.set(k, Math.max(maxByPrefix.get(k) ?? 0, f.num));
  }

  const types = [];
  const findCfg = (rel, prefix) => config?.types && Object.entries(config.types).find(([k, v]) => v.dir === rel || (prefix && (v.prefix ?? k).toUpperCase() === prefix.toUpperCase()));
  for (const g of groups.values()) {
    g.files.sort((a, b) => a.num - b.num);
    const rel = path.relative(root, g.dir).split(path.sep).join("/");
    const cfg = findCfg(rel, g.prefix);
    const nums = g.files.map((f) => f.num);
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    const width = Math.max(...g.files.map((f) => f.width));
    // 접두어가 있으면 저장소 전체에서 이어지고, 접두어 없는 번호(0001-x.md)는 폴더마다 따로 매긴다(monorepo의 서비스별 adr 폴더)
    const dateStyle = !g.prefix && width === 8;
    const next = dateStyle ? null : (g.prefix ? maxByPrefix.get(g.prefix.toUpperCase()) : Math.max(...nums)) + 1;
    const dirFiles = fs.readdirSync(g.dir);
    const template = dirFiles.find((f) => /^(_?template|0000[-_]template)\.md$/i.test(f)) ?? null;
    const indexFile = findIndex(g.dir, root, g.files);
    let missingInIndex = [];
    let indexSample = null;
    if (indexFile) {
      const idx = fs.readFileSync(indexFile, "utf8");
      missingInIndex = g.files.filter((f) => !listedIn(idx, f.file)).map((f) => f.file);
      indexSample = idx.split(/\r?\n/).filter((l) => g.files.some((f) => listedIn(l, f.file))).slice(-2);
    }
    const otherDirs = [...groups.values()].filter((o) => o !== g && o.prefix.toUpperCase() === g.prefix.toUpperCase() && g.prefix).map((o) => path.relative(root, o.dir).split(path.sep).join("/"));
    types.push({
      kind: cfg?.[1]?.kind ?? guessKind(g.prefix, g.dir),
      name: cfg?.[0] ?? (g.prefix || path.basename(g.dir)),
      dir: rel,
      prefix: g.prefix,
      count: g.files.length,
      last: g.files[g.files.length - 1].file,
      nextId: dateStyle ? new Date().toISOString().slice(0, 10).replace(/-/g, "") + " (날짜형)" : (g.prefix ? g.prefix + "-" : "") + String(next).padStart(width, "0"),
      alsoIn: otherDirs,
      template: template ? `${rel}/${template}` : null,
      index: indexFile ? path.relative(root, indexFile).split(path.sep).join("/") : null,
      indexSample,
      missingInIndex,
      duplicateNumbers: [...new Set(dup)],
    });
  }
  // 설정에는 있지만 아직 문서가 하나도 없는 종류(새 저장소)
  for (const [name, v] of Object.entries(config?.types ?? {})) {
    if (types.some((t) => t.dir === v.dir || t.name === name)) continue;
    const dir = path.join(root, v.dir ?? "");
    const prefix = v.prefix ?? name;
    const dirFiles = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const template = dirFiles.find((f) => /^(_?template|0000[-_]template)\.md$/i.test(f)) ?? null;
    const indexName = dirFiles.find((f) => /^(_index|index|readme)\.md$/i.test(f)) ?? null;
    types.push({
      kind: v.kind ?? guessKind(prefix, dir), name, dir: v.dir, prefix, count: 0, last: null,
      nextId: `${prefix}-${String(1).padStart(v.width ?? 3, "0")}`, alsoIn: [],
      template: template ? `${v.dir}/${template}` : null, index: indexName ? `${v.dir}/${indexName}` : null,
      indexSample: null, missingInIndex: [], duplicateNumbers: [], fromConfigOnly: true,
    });
  }
  types.sort((a, b) => b.count - a.count);
  return { root, config: config ? ".records.json" : null, triggers: config?.triggers ?? null, types };
}

function printText(r) {
  console.log(`저장소: ${r.root}${r.config ? " (설정: .records.json)" : ""}`);
  if (!r.types.length) {
    console.log("\n기록 문서를 찾지 못했습니다. 처음 만드는 저장소라면 templates/의 기본 템플릿과 docs/<종류>/ 폴더를 씁니다.");
    return;
  }
  for (const t of r.types) {
    console.log(`\n[${t.kind}] ${t.name}  ${t.dir}/  ${t.count ? `${t.count}개, 마지막 ${t.last}` : "아직 없음(.records.json)"} → 다음 ${t.nextId}`);
    if (t.alsoIn?.length) console.log(`  같은 접두어가 다른 폴더에도 있음(번호는 전체에서 이어짐): ${t.alsoIn.join(", ")}`);
    console.log(`  템플릿: ${t.template ?? "없음(같은 폴더의 최근 문서 구조를 따른다)"}`);
    console.log(`  목록: ${t.index ?? "없음"}`);
    if (t.indexSample?.length) console.log(`  목록 형식 예: ${t.indexSample[t.indexSample.length - 1].trim().slice(0, 160)}`);
    if (t.missingInIndex.length) console.log(`  목록에 없는 문서 ${t.missingInIndex.length}개: ${t.missingInIndex.slice(0, 5).join(", ")}${t.missingInIndex.length > 5 ? " …" : ""}`);
    if (t.duplicateNumbers.length) console.log(`  겹치는 번호: ${t.duplicateNumbers.join(", ")}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  if (!fs.existsSync(root)) { console.error(`경로가 없습니다: ${root}`); process.exit(1); }
  let r;
  try { r = scan(root); } catch (e) { console.error(`스캔 실패: ${e.message}`); process.exit(1); }
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else printText(r);
  if (args.includes("--check")) process.exit(r.types.some((t) => t.missingInIndex.length || t.duplicateNumbers.length) ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
