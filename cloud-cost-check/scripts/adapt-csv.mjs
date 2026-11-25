#!/usr/bin/env node
// 견적·사이징 표(CSV)를 매핑 파일에 따라 공통 항목표(items.json)로 바꾼다.
// 엑셀 양식은 제각각이라 열 위치를 추측하지 않는다. 매핑(mapping.json)은 Claude가 표를 보고 쓰고, 사용자가 확인한다.
// CSV는 UTF-8과 CP949(엑셀 기본 "CSV" 저장) 둘 다 읽는다.
//
// 사용: node adapt-csv.mjs <견적.csv> --mapping <mapping.json> [--out items.json]
//       node adapt-csv.mjs <견적.csv> --preview [줄수]     매핑을 쓰기 전에 표 앞부분과 열 글자를 본다
// 종료 코드: 0 = 성공, 1 = 읽기 실패
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envOf, envClassOf } from "./aws-map.mjs";

export function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8-bom" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("euc-kr").decode(buf), encoding: "cp949" };
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export const colLetter = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const letterIdx = (s) => [...s.toUpperCase()].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1;

// "1,200,000원", "₩ 3,000", "(5,000)", "$12.5", "-" 를 숫자로. 숫자가 아니면 null
export function toNum(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s || /^[-–—]$/.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  // 엑셀 한국어 서식의 음수(△1,000 ▲1,000)와 유니코드 빼기 기호(−)
  if (/^[△▲−]/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[₩$€¥,\s]|원|KRW|USD|달러/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

// 수량·기간 칸의 단위 글자를 뗀다: "2대", "1식", "12개월", "730시간". "1년"은 12개월
export function countNum(v, field) {
  if (v == null) return null;
  const s = String(v).trim();
  const y = /^(\d+(?:\.\d+)?)\s*(년|year|yr)s?$/i.exec(s);
  if (y && field === "months") return Number(y[1]) * 12;
  return toNum(s.replace(/\s*(대|개|식|EA|set|copies|명|회|개월|월|months?|시간|hrs?|hours?|h)$/i, ""));
}

// 이름으로 범주를 추정한다. 앞에 있는 규칙이 우선한다("DB 접근제어"는 security, "백업 스토리지"는 backup)
const CATEGORY_RULES = [
  ["tax", /부가세|부가가치세|VAT|세금/i],
  ["support", /기술지원|서포트|support|운영대행|관리\s*서비스|MSP/i],
  ["security", /방화벽|WAF|IPS|IDS|DDoS|백신|접근제어|암호화|보안|개인정보\s*(필터링|접속기록|보호|암호화)|망연계|firewall/i],
  ["backup", /백업|backup|스냅샷|snapshot/i],
  ["traffic", /트래픽|전송|outbound|아웃바운드|egress|data\s*transfer|zone\s*간|존\s*간/i],
  ["nat", /\bNAT\b/i],
  ["public_ip", /공인\s*IP|EIP|public\s*ip|IPv4|탄력적\s*IP/i],
  ["lb", /로드\s*밸런서|\bLB\b|\bALB\b|\bNLB\b|\bELB\b|load\s*balancer/i],
  ["log", /로그|\blogs?\b|CloudWatch/i],
  ["object_storage", /오브젝트|\bS3\b|object/i],
  ["cache", /캐시|redis|elasticache|memcache/i],
  ["db", /\bDB\b|데이터베이스|database|RDS|aurora|mysql|postgre|oracle|maria|tibero|cubrid/i],
  ["storage", /스토리지|디스크|블록|EBS|storage|disk|볼륨|NAS|SSD|HDD/i],
  ["network", /VPC|VPN|IPSec|피어링|peering|전용선|direct\s*connect/i],
  ["compute", /워커\s*노드|노드\s*그룹|worker\s*node|node\s*group/i],
  ["managed", /관리형|매니지드|managed|EKS|쿠버네티스|kubernetes/i],
  // "Windows Server 2022"처럼 OS 이름이 붙은 서버는 compute로 간다. 라이선스는 라이선스라고 적힌 행만
  ["license", /라이선스|license|소프트웨어|\bSW\b/i],
  ["compute", /서버|\bserver\b|\bVM\b|인스턴스|instance|EC2|컴퓨트|compute|\bWEB\b|\bWAS\b|노드|node|컨테이너|\bpod\b|vcore|vcpu/i],
];
export function guessCategory(...texts) {
  const t = texts.filter(Boolean).join(" ");
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return "other";
}

// "4vCore/16GB/100GB", "m5.large", "2 vCPU 8 GiB" 에서 규격을 뽑는다
export function parseSpec(s) {
  const out = {};
  if (!s) return out;
  const t = String(s);
  const ty = /\b((?:db\.|cache\.)?[a-z][a-z0-9-]*\d[a-z0-9-]*\.(?:nano|micro|small|medium|\d*x?large|metal[\w-]*))\b/i.exec(t);
  if (ty) out.type = ty[1].toLowerCase();
  const cpu = /(\d+(?:\.\d+)?)\s*(?:v\s*core|vcpu|v코어|코어|core|c\b)/i.exec(t) ?? /\bv?cpu\s*:?\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (cpu) out.vcpu = Number(cpu[1]);
  // 크기마다 앞뒤 글자로 메모리·디스크를 가린다("SSD 100GB, 4vCPU 16GB"). 단서가 없으면 순서대로(첫째 메모리, 둘째 디스크)
  // 규격 이름 속 숫자("r6g.large"의 6g)는 크기로 보지 않는다
  const sizes = [...t.matchAll(/(?<![A-Za-z\d.])(\d+(?:\.\d+)?)\s*(TB|GB|GiB|TiB|T|G)\b/gi)].map((m) => {
    const around = t.slice(Math.max(0, m.index - 8), m.index + m[0].length + 6);
    const kind = /ssd|hdd|disk|디스크|스토리지|storage|볼륨|nvme/i.test(around) ? "disk" : /mem|메모리|ram/i.test(around) ? "mem" : null;
    return { gb: Number(m[1]) * (/^T/i.test(m[2]) ? 1024 : 1), kind };
  });
  for (const x of sizes) if (x.kind === "mem" && out.mem_gb == null) out.mem_gb = x.gb; else if (x.kind === "disk" && out.disk_gb == null) out.disk_gb = x.gb;
  const rest = sizes.filter((x) => !x.kind).map((x) => x.gb);
  if (out.mem_gb == null && rest.length && (cpu || rest.length >= 2 || out.disk_gb != null)) out.mem_gb = rest.shift();
  if (out.disk_gb == null && rest.length) out.disk_gb = rest.shift();
  return out;
}

const UNIT = (u) => {
  const s = String(u ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^(시간|hr|hour|hours|h|시간당)$/.test(s) || /시간|hour/.test(s)) return "hour";
  if (/월|month|mo/.test(s)) return "month";
  if (/년|연|year|annual/.test(s)) return "year";
  if (/tb/.test(s)) return "tb";
  if (/gb/.test(s)) return "gb";
  return s;
};

export function csvToItems(text, mapping, file = "estimate.csv") {
  const rows = parseCsv(text);
  const hr = (mapping.header_row ?? 1) - 1;
  const header = rows[hr] ?? [];
  const cols = {};
  const warnings = [];
  for (const [field, ref] of Object.entries(mapping.columns ?? {})) {
    if (ref == null || ref === "") continue;
    // 같은 이름의 머리글("CPU", "QTY")이 있으면 그것이 먼저다. 없을 때만 열 글자(A, B, …)로 본다
    const byName = header.findIndex((h) => h.trim() === String(ref).trim());
    const idx = byName >= 0 ? byName : /^[A-Z]{1,3}$/.test(ref) ? letterIdx(ref) : -1;
    if (idx < 0) { warnings.push(`열을 찾지 못함: ${field} = "${ref}"`); continue; }
    if (byName < 0 && idx >= header.length) warnings.push(`${field} = ${ref}: 머리글 행보다 오른쪽 열`);
    cols[field] = idx;
  }
  const d = mapping.defaults ?? {};
  const subRe = new RegExp(mapping.subtotal_pattern ?? "소계|subtotal", "i");
  // 합계 단어는 이름 맨 앞에서만 본다("통합계정관리"의 "합계"는 합계 행이 아니다)
  const totRe = new RegExp(mapping.total_pattern ?? "^\\s*(공급가액\\s*|총\\s*)?(합계|총계|총액)|grand\\s*total|^\\s*total", "i");
  const fillDown = new Set(mapping.fill_down ?? []);
  const last = {};
  const skipRe = mapping.skip_pattern ? new RegExp(mapping.skip_pattern, "i") : null;
  const base = path.basename(file);
  const items = [], totals = [];
  let sinceSub = [], sinceTot = [];
  // 병합 셀로 내보낸 표는 첫 행에만 값이 있다. fill_down에 적은 열은 빈 칸이면 위 값을 이어받는다
  const cell = (r, f) => {
    if (cols[f] == null) return undefined;
    const v = (r[cols[f]] ?? "").trim();
    return v === "" && fillDown.has(f) ? last[f] ?? "" : v;
  };
  const end = mapping.last_row ? mapping.last_row : rows.length;
  for (let ri = hr + 1; ri < end; ri++) {
    const r = rows[ri];
    if (!r || r.every((c) => !String(c).trim())) continue;
    const rowNo = ri + 1;
    const rowText = r.join(" ");
    if (skipRe && skipRe.test(rowText)) continue;
    const raw = (f) => (cols[f] == null ? "" : (r[cols[f]] ?? "").trim());
    const labelText = [raw("name"), raw("category"), raw("env")].filter(Boolean).join(" ") || rowText;
    const amount = toNum(cell(r, "amount"));
    // 단가나 수량이 적힌 행은 품목이다(이름에 "소계"·"합계"가 들어 있어도)
    const priced = toNum(raw("unit_price")) != null || countNum(raw("qty"), "qty") != null;
    const isSub = !priced && subRe.test(labelText), isTot = !priced && !isSub && totRe.test(labelText);
    if (isSub || isTot) {
      for (const f of fillDown) delete last[f];
      totals.push({ row: rowNo, label: labelText.trim(), kind: isSub ? "subtotal" : "total", amount_stated: amount, ref: cols.amount != null ? `${base}!${colLetter(cols.amount)}${rowNo}` : `${base}!${rowNo}행`, covers: [...(isSub ? sinceSub : sinceTot)] });
      sinceSub = [];
      if (isTot) sinceTot = [];
      continue;
    }
    for (const f of fillDown) if (raw(f) !== "") last[f] = raw(f);
    const name = cell(r, "name") || labelText;
    const specText = cell(r, "spec");
    const spec = { ...parseSpec(specText) };
    if (cell(r, "type")) spec.type = cell(r, "type");
    for (const f of ["vcpu", "mem_gb", "disk_gb"]) if (toNum(cell(r, f)) != null) spec[f] = toNum(cell(r, f));
    const envLabel = cell(r, "env") || d.env || null;
    const env = envLabel ? { env: envLabel, env_class: envClassOf(envLabel) } : envOf(name);
    const it = {
      id: `${base}#${rowNo}`,
      row: rowNo,
      env: env.env,
      env_class: env.env_class,
      category: mapping.category_map?.[cell(r, "category")] ?? guessCategory(cell(r, "category"), name, specText),
      name,
      spec,
      unit_price: toNum(cell(r, "unit_price")),
      unit: UNIT(cell(r, "unit")) ?? UNIT(d.unit) ?? "month",
      qty: countNum(cell(r, "qty"), "qty") ?? (cols.qty == null ? d.qty ?? null : null),
      months: countNum(cell(r, "months"), "months") ?? (cols.months == null ? d.months ?? null : null),
      hours_per_month: countNum(cell(r, "hours_per_month"), "hours") ?? d.hours_per_month ?? null,
      amount_stated: amount,
      currency: cell(r, "currency") || d.currency || null,
      pricing: cell(r, "pricing") || d.pricing || "unknown",
      sizing: cols.required != null ? { required: toNum(cell(r, "required")), capacity_per_unit: toNum(cell(r, "capacity_per_unit")), provided_units: toNum(cell(r, "provided_units")) } : null,
      cells: Object.fromEntries(Object.entries(cols).map(([f, i]) => [f, `${base}!${colLetter(i)}${rowNo}`])),
      source: "estimate",
      source_ref: `${base}!${rowNo}행`,
      extracted_by: "script",
      confirmed: mapping.confirmed === true,
    };
    items.push(it);
    sinceSub.push(it.id);
    sinceTot.push(it.id);
  }
  return { source: "estimate-csv", file: base, currency: d.currency ?? null, items, totals, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith("--") && !["--mapping", "--out", "--preview"].includes(args[i - 1]));
  if (!file) {
    console.error("사용: node adapt-csv.mjs <견적.csv> --mapping <mapping.json> [--out items.json] | --preview [줄수]");
    process.exit(1);
  }
  try {
    const { text, encoding } = decode(fs.readFileSync(file));
    if (args.includes("--preview")) {
      const n = Number(opt("--preview")) || 15;
      const rows = parseCsv(text).slice(0, n);
      const width = Math.max(...rows.map((r) => r.length));
      console.log(`인코딩: ${encoding}`);
      console.log(["행", ...Array.from({ length: width }, (_, i) => colLetter(i))].join("\t"));
      rows.forEach((r, i) => console.log([i + 1, ...r].join("\t")));
      process.exit(0);
    }
    const mpath = opt("--mapping");
    if (!mpath) throw new Error("--mapping 이 필요합니다. 먼저 --preview로 표를 보고 매핑을 쓰세요.");
    const mapping = JSON.parse(fs.readFileSync(mpath, "utf8").replace(/^\uFEFF/, ""));
    const res = { ...csvToItems(text, mapping, file), encoding };
    const out = JSON.stringify(res, null, 1);
    if (opt("--out")) fs.writeFileSync(opt("--out"), out);
    else console.log(out);
    console.error(`항목 ${res.items.length}개 · 소계/합계 행 ${res.totals.length}개 · 인코딩 ${encoding}${res.warnings.length ? " · 경고 " + res.warnings.join("; ") : ""}`);
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
}
