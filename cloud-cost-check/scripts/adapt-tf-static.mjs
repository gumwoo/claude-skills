#!/usr/bin/env node
// plan을 만들 수 없을 때, .tf 코드만 읽어 공통 항목표(items.json)로 바꾼다(근사). 클라우드·state에 접근하지 않는다.
// HCL을 완전히 해석하지 않는다. 리터럴 값과 variable의 리터럴 default만 쓰고, 나머지는 모름(null)으로 둔다.
// .tfvars는 비밀 값이 들어 있을 수 있어 읽지 않는다.
//
// 사용: node adapt-tf-static.mjs <디렉터리> [--out items.json] [--env 이름]
// 종료 코드: 0 = 성공, 1 = 읽기 실패
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toItem, link, SUPPORTED_TYPES } from "./aws-map.mjs";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".terraform", ".git", "node_modules"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tf")) out.push(p);
  }
  return out;
}

// 주석을 공백으로 바꾼다(줄 번호 유지). 문자열·heredoc 안은 건드리지 않는다
export function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"') {
      let j = i + 1, depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (src[j] === '"' && depth === 0) break;
        if (src[j] === "\n" && depth === 0) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const hd = /^<<-?([A-Za-z_]\w*)[ \t]*\n/.exec(src.slice(i, i + 80));
    if (hd) {
      const endRe = new RegExp(`\\n[ \\t]*${hd[1]}[ \\t]*(\\n|$)`, "g");
      endRe.lastIndex = i + hd[0].length - 1;
      const m = endRe.exec(src);
      const stop = m ? m.index + m[0].length - (m[1] ? 1 : 0) : src.length;
      // heredoc 본문은 값으로 쓰지 않는다. 중괄호가 섞여도 파싱이 흔들리지 않게 빈 문자열로 바꾸고 줄 수만 유지한다
      out += '""' + src.slice(i, stop).replace(/[^\n]/g, "").replace(/\n/g, "\n");
      i = stop;
      continue;
    }
    if (c === "#" || (c === "/" && n === "/")) {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      const stop = e < 0 ? src.length : e + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// 표현식 끝 찾기: 깊이 0에서 줄바꿈·쉼표·닫는 중괄호를 만나면 끝
function readExpr(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      j++;
      let d = 0;
      while (j < s.length) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "$" && s[j + 1] === "{") { d++; j += 2; continue; }
        if (s[j] === "}" && d > 0) { d--; j++; continue; }
        if (s[j] === '"' && d === 0) break;
        j++;
      }
      j++;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === "\n" || c === ",") && depth === 0) break;
    j++;
  }
  return { text: s.slice(i, j).trim(), end: j };
}

function splitTop(s) {
  const parts = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === "\\") { cur += s[++i] ?? ""; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function literal(text, vars = {}) {
  const t = text.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t) && !t.includes("${")) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  if (t === "null") return null;
  const v = /^var\.([\w-]+)$/.exec(t);
  if (v && Object.prototype.hasOwnProperty.call(vars, v[1])) return vars[v[1]];
  if (t.startsWith("[") && t.endsWith("]")) {
    const arr = splitTop(t.slice(1, -1).replace(/\n/g, " ")).map((p) => literal(p, vars));
    if (arr.every((x) => !(x && typeof x === "object" && "__expr" in x))) return arr;
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    const { obj } = parseBody(t.slice(1, -1), 0, vars);
    return obj;
  }
  return { __expr: t };
}

// 블록 본문을 읽는다. 속성은 obj[key] = 값, 중첩 블록은 obj[이름] = [본문...]으로 둔다
export function parseBody(s, start = 0, vars = {}, blocks = null) {
  const obj = {};
  let i = start;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === "}") return { obj, end: i + 1 };
    const km = /^("(?:[^"\\]|\\.)*"|[A-Za-z_][\w-]*)/.exec(s.slice(i, i + 200));
    if (!km) { // 알 수 없는 문법은 그 줄을 건너뛴다
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    const key = km[1].startsWith('"') ? JSON.parse(km[1]) : km[1];
    const at = i;
    i += km[1].length;
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === "=" || s[i] === ":") {
      const { text, end } = readExpr(s, i + 1);
      obj[key] = literal(text, vars);
      i = end;
      continue;
    }
    const labels = [];
    while (i < s.length && s[i] !== "{") {
      const lm = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z_][\w-]*)/.exec(s.slice(i, i + 200));
      if (!lm) break;
      labels.push(lm[1].startsWith('"') ? JSON.parse(lm[1]) : lm[1]);
      i += lm[0].length;
      while (s[i] === " " || s[i] === "\t") i++;
    }
    if (s[i] !== "{") { i++; continue; }
    const inner = parseBody(s, i + 1, vars);
    if (blocks) blocks.push({ kind: key, labels, body: inner.obj, raw: s.slice(i + 1, inner.end - 1), at });
    (obj[key] ??= []).push(inner.obj);
    i = inner.end;
  }
  return { obj, end: s.length };
}

const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;

export function staticToItems(root, opts = {}) {
  const files = walk(root);
  const byDir = new Map();
  for (const f of files) {
    const d = path.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  const items = [], modules = [], skipped = {}, unknownCount = [], tfvarsDirs = [];
  const rootName = path.basename(path.resolve(root));
  const isOverride = (f) => /(^|_)override\.tf$/.test(path.basename(f));
  for (const [dir, fs_] of byDir) {
    // override 파일은 같은 리소스를 덮어쓰므로 맨 뒤에 읽어 합친다
    fs_.sort((a, b) => Number(isOverride(a)) - Number(isOverride(b)));
    const parsed = fs_.map((f) => {
      const src = stripComments(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
      return { f, src };
    });
    // 1차: 같은 디렉터리(모듈) 안 variable의 리터럴 default
    const vars = {};
    for (const p of parsed) {
      const blocks = [];
      parseBody(p.src, 0, {}, blocks);
      for (const b of blocks) if (b.kind === "variable" && b.labels[0] && "default" in b.body && !(b.body.default && typeof b.body.default === "object" && "__expr" in b.body.default)) vars[b.labels[0]] = b.body.default;
    }
    const rel = path.relative(root, dir).replace(/\\/g, "/") || ".";
    // .tfvars가 있으면 그 값이 default를 덮으므로 default를 확정값으로 쓰지 않는다(파일 내용은 읽지 않음)
    if (fs.readdirSync(dir).some((n) => /\.tfvars(\.json)?$/.test(n))) {
      for (const k of Object.keys(vars)) delete vars[k];
      tfvarsDirs.push(rel);
    }
    const pre = rel === "." ? "" : `${rel}::`;
    const byId = new Map();
    for (const p of parsed) {
      const blocks = [];
      parseBody(p.src, 0, vars, blocks);
      const relFile = path.relative(root, p.f).replace(/\\/g, "/");
      for (const b of blocks) {
        if (isOverride(p.f) && b.kind === "resource" && byId.has(b.labels.join("."))) {
          const base = byId.get(b.labels.join("."));
          Object.assign(base.body, b.body);
          base.raw += "\n" + b.raw;
          continue;
        }
        if (b.kind === "module" && b.labels[0]) {
          const inputs = {};
          for (const [k, v] of Object.entries(b.body)) if (!(v && typeof v === "object")) inputs[k] = v;
          modules.push({ name: b.labels[0], source: typeof b.body.source === "string" ? b.body.source : null, file: `${relFile}:${lineOf(p.src, b.at)}`, literal_inputs: inputs });
          continue;
        }
        if (b.kind !== "resource" || b.labels.length < 2) continue;
        const [type, name] = b.labels;
        if (!SUPPORTED_TYPES.includes(type)) { skipped[type] = (skipped[type] ?? 0) + 1; continue; }
        byId.set(b.labels.join("."), { ...b, relFile, src: p.src });
      }
    }
    for (const b of byId.values()) {
      const [type, name] = b.labels;
      const relFile = b.relFile;
      {
        const refs = [...new Set([...b.raw.matchAll(/\b([a-z0-9]+_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g)].filter((m) => !/^(var|local|data|module|each|count|path|terraform|self)$/.test(m[1])).map((m) => `${pre}${m[1]}.${m[2]}`))];
        const it = toItem({ address: `${pre}${type}.${name}`, type, values: b.body, refs, source_ref: `${relFile}:${lineOf(b.src, b.at)}` }, { env: opts.env, pathHint: `${rootName}/${relFile}` }); // 환경 폴더를 직접 지정해도 판정되게 root 이름을 붙인다
        if (!it) continue;
        const c = b.body.count;
        if (typeof c === "number") {
          it.attrs.count = c;
          if (it.qty != null) it.qty *= c;
        } else if (c !== undefined || b.body.for_each !== undefined) {
          it.attrs.count = "unknown";
          it.qty = null; // 몇 개인지 모른다
          unknownCount.push(it.id);
        }
        items.push(it);
      }
    }
  }
  return { source: "terraform-static", items: link(items), modules, unsupported_types: skipped, unknown_count: unknownCount, tfvars_dirs: tfvarsDirs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const dir = args.find((a, i) => !a.startsWith("--") && !["--out", "--env"].includes(args[i - 1])) ?? ".";
  try {
    const res = staticToItems(path.resolve(dir), { env: opt("--env") });
    const out = JSON.stringify({ ...res, dir }, null, 1);
    if (opt("--out")) fs.writeFileSync(opt("--out"), out);
    else console.log(out);
    console.error(`항목 ${res.items.length}개 · 모듈 호출 ${res.modules.length}개(펼치지 않음) · count/for_each 모름 ${res.unknown_count.length}개`);
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
}
