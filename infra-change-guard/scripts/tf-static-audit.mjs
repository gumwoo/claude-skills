#!/usr/bin/env node
// Terraform 코드(.tf)를 읽기만 해서, 데이터를 가진 리소스의 삭제 보호가 빠진 곳을 찾는다.
// 클라우드나 state에 접근하지 않는다. HCL을 완전히 해석하지 않고 resource 블록 단위로 속성을 찾는 근사 점검이다.
//
// 사용: node tf-static-audit.mjs [디렉터리] [--json]
// 종료 코드: 항상 0(권고용). 결과는 표 또는 JSON.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".terraform" || e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tf")) out.push(p);
  }
  return out;
}

// 주석과 문자열을 고려해 { } 짝을 맞춰 resource 블록 본문을 잘라낸다
function stripComments(src) {
  let out = "", i = 0, inStr = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "#" || (c === "/" && n === "/")) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 2; continue; }
    out += c; i++;
  }
  return out;
}

function blocks(src) {
  const res = [];
  const re = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex, inStr = false;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}") depth--;
    }
    const line = src.slice(0, m.index).split("\n").length;
    res.push({ type: m[1], name: m[2], body: src.slice(re.lastIndex, i - 1), line });
    re.lastIndex = i;
  }
  return res;
}

const attr = (body, key) => {
  const m = body.match(new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*([^\\n]+)`));
  return m ? m[2].trim() : undefined;
};
const isTrue = (v) => v === "true";
const isRef = (v) => typeof v === "string" && /^(var|local|module|each|data)\.|^\(|^\$\{|\?/.test(v);
const preventDestroy = (body) => /lifecycle\s*\{[^}]*prevent_destroy\s*=\s*true/.test(body);
// 보호 속성이 true가 아닐 때의 지적. 값이 변수·표현식이면 단정하지 않고 확인을 요청한다
const needTrue = (b, key) => {
  const v = attr(b, key);
  if (isTrue(v)) return false;
  if (isRef(v)) return ["LOW", `${key} = ${v}: 변수·표현식으로 정해집니다. 환경별 실제 값이 true인지 확인하세요`];
  return ["MEDIUM", `${key} = true가 아닙니다${v === undefined ? "(설정 없음)" : ""}`];
};

const RULES = {
  aws_db_instance: (b) => [
    needTrue(b, "deletion_protection"),
    isTrue(attr(b, "skip_final_snapshot")) && ["MEDIUM", "skip_final_snapshot = true: 삭제 시 마지막 스냅샷을 남기지 않습니다"],
    attr(b, "backup_retention_period") === "0" && ["MEDIUM", "backup_retention_period = 0: 자동 백업이 꺼져 있습니다"],
  ],
  aws_rds_cluster: (b) => [
    needTrue(b, "deletion_protection"),
    isTrue(attr(b, "skip_final_snapshot")) && ["MEDIUM", "skip_final_snapshot = true: 삭제 시 마지막 스냅샷을 남기지 않습니다"],
  ],
  aws_dynamodb_table: (b) => [
    needTrue(b, "deletion_protection_enabled"),
    !/point_in_time_recovery\s*\{[^}]*enabled\s*=\s*true/.test(b) && ["LOW", "point_in_time_recovery가 켜져 있지 않습니다"],
  ],
  aws_s3_bucket: (b) => [isTrue(attr(b, "force_destroy")) && ["MEDIUM", "force_destroy = true: 객체가 있어도 버킷과 함께 지워집니다"]],
  aws_lb: (b) => [!isTrue(attr(b, "enable_deletion_protection")) && ["LOW", "enable_deletion_protection = true가 아닙니다"]],
  aws_instance: (b) => [!isTrue(attr(b, "disable_api_termination")) && ["LOW", "disable_api_termination(종료 보호)이 꺼져 있습니다"]],
  aws_elasticache_replication_group: (b) => [!attr(b, "snapshot_retention_limit") || attr(b, "snapshot_retention_limit") === "0" ? ["LOW", "snapshot_retention_limit이 없거나 0입니다(자동 스냅샷 없음)"] : false],
  aws_kms_key: (b) => [Number(attr(b, "deletion_window_in_days") ?? 30) < 30 && ["LOW", `deletion_window_in_days = ${attr(b, "deletion_window_in_days")}: 삭제 예약 기간이 짧습니다`]],
  google_sql_database_instance: (b) => [attr(b, "deletion_protection") === "false" && ["MEDIUM", "deletion_protection = false"]],
  google_storage_bucket: (b) => [isTrue(attr(b, "force_destroy")) && ["MEDIUM", "force_destroy = true"]],
};
const PREVENT_DESTROY_WANTED = /^(aws_(db_instance|rds_cluster|dynamodb_table|s3_bucket|efs_file_system|ebs_volume|elasticache_replication_group|kms_key|backup_vault)|google_(sql_database_instance|storage_bucket)|azurerm_(storage_account|key_vault|mssql_database))$/;

const findings = [];
const files = fs.existsSync(root) ? walk(root) : [];
const all = [];
for (const f of files) {
  const src = stripComments(fs.readFileSync(f, "utf8"));
  for (const b of blocks(src)) all.push({ ...b, file: path.relative(root, f).replace(/\\/g, "/") });
}
const versioned = new Set(all.filter((b) => b.type === "aws_s3_bucket_versioning" && /status\s*=\s*"Enabled"/.test(b.body))
  .map((b) => (attr(b.body, "bucket") ?? "").match(/aws_s3_bucket\.([\w-]+)/)?.[1]).filter(Boolean));

for (const b of all) {
  const where = `${b.file}:${b.line}`;
  const id = `${b.type}.${b.name}`;
  for (const r of (RULES[b.type]?.(b.body) ?? []).filter(Boolean)) findings.push({ level: r[0], resource: id, where, message: r[1] });
  if (PREVENT_DESTROY_WANTED.test(b.type) && !preventDestroy(b.body)) findings.push({ level: "LOW", resource: id, where, message: "lifecycle { prevent_destroy = true }가 없습니다" });
  if (b.type === "aws_s3_bucket" && !versioned.has(b.name)) findings.push({ level: "LOW", resource: id, where, message: "이 버킷을 가리키는 aws_s3_bucket_versioning(Enabled)을 찾지 못했습니다" });
}

const order = { MEDIUM: 0, LOW: 1 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.where.localeCompare(b.where));
if (asJson) process.stdout.write(JSON.stringify({ root, files: files.length, resources: all.length, findings }, null, 2) + "\n");
else {
  console.log(`## Terraform 정적 점검: ${root}`);
  console.log(`\n.tf 파일 ${files.length}개, resource 블록 ${all.length}개\n`);
  if (!findings.length) console.log("찾은 항목 없음.");
  else {
    console.log("| 수준 | 리소스 | 위치 | 내용 |\n|---|---|---|---|");
    for (const f of findings) console.log(`| ${f.level} | \`${f.resource}\` | ${f.where} | ${f.message} |`);
  }
  console.log("\n이 점검은 코드만 본 근사치다. 변수·모듈 입력으로 넘어오는 값은 판단하지 못한다.");
}
