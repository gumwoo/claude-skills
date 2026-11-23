#!/usr/bin/env node
// Terraform/OpenTofu plan을 읽어 위험한 변경을 찾는다. 인프라에는 아무것도 하지 않는다(읽기 전용).
//
// 사용:
//   node plan-check.mjs <plan.json>          terraform show -json 결과 파일
//   node plan-check.mjs <tfplan>             저장된 plan 파일. 현재 디렉터리에서 terraform show -json 을 실행한다
//   node plan-check.mjs -                    표준 입력으로 plan JSON
//   옵션: --json (결과를 JSON으로), --tool tofu (show에 쓸 실행 파일)
//
// 종료 코드: 0 = HIGH 없음, 2 = HIGH 있음(사람 승인 필요), 1 = 읽기 실패
import { spawnSync } from "node:child_process";
import fs from "node:fs";

// 데이터를 가진(삭제·교체 시 복구가 어렵거나 불가능한) 리소스 종류
const STATEFUL = [
  /^aws_(db_instance|rds_cluster|rds_global_cluster|docdb_cluster|neptune_cluster|redshift_cluster|redshiftserverless_namespace)$/,
  /^aws_(dynamodb_table|dynamodb_global_table|keyspaces_table|timestreamwrite_table)$/,
  /^aws_(s3_bucket|s3_directory_bucket|glacier_vault|efs_file_system|ebs_volume|fsx_\w+|ebs_snapshot|db_snapshot|db_cluster_snapshot)$/,
  /^aws_(elasticache_cluster|elasticache_replication_group|elasticache_serverless_cache|memorydb_cluster|opensearch_domain|elasticsearch_domain)$/,
  /^aws_(kinesis_stream|msk_cluster|msk_serverless_cluster|mq_broker|sqs_queue)$/,
  /^aws_(kms_key|secretsmanager_secret|backup_vault|ecr_repository|cognito_user_pool|route53_zone|eks_cluster|cloudwatch_log_group)$/,
  /^google_(sql_database_instance|sql_database|storage_bucket|bigquery_dataset|bigquery_table|compute_disk|container_cluster|spanner_\w+|bigtable_\w+|firestore_database|kms_crypto_key|redis_instance|filestore_instance)$/,
  /^azurerm_(storage_account|mssql_\w+|postgresql_\w*server|mysql_\w*server|cosmosdb_\w+|key_vault|kubernetes_cluster|managed_disk|redis_cache)$/,
  /^kubernetes_(namespace|persistent_volume_claim|persistent_volume|stateful_set)(_v1)?$/,
];
const isStateful = (type) => STATEFUL.some((re) => re.test(type));

// 켜져 있으면 삭제를 막는 속성. true → false 가 되면 위험
const PROTECT_ON = ["deletion_protection", "deletion_protection_enabled", "enable_deletion_protection", "termination_protection", "disable_api_termination", "prevent_destroy"];
// 켜지면 데이터 손실 위험이 커지는 속성. false → true 가 되면 위험
const RISK_ON = ["force_destroy", "skip_final_snapshot", "force_delete", "delete_automated_backups"];
// provider 기본값이 true라서 생성 시에는 보지 않는 속성(변경으로 새로 켜질 때만 지적)
const RISK_ON_UPDATE_ONLY = new Set(["delete_automated_backups"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const toolIdx = args.indexOf("--tool");
const tool = toolIdx >= 0 ? args[toolIdx + 1] : "terraform";
const input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tool");

function fail(msg) {
  process.stderr.write(`[plan-check] ${msg}\n`);
  process.exit(1);
}

function loadPlan() {
  if (!input) fail("plan 파일 경로가 필요합니다. 예: node plan-check.mjs tfplan");
  let text;
  if (input === "-") text = fs.readFileSync(0, "utf8");
  else if (!fs.existsSync(input)) fail(`파일이 없습니다: ${input}`);
  else {
    const raw = fs.readFileSync(input);
    const head = raw.subarray(0, 64).toString("utf8").trimStart();
    if (head.startsWith("{")) text = raw.toString("utf8");
    else {
      const r = spawnSync(tool, ["show", "-json", input], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: process.platform === "win32" });
      if (r.status !== 0) fail(`${tool} show -json 실패: ${(r.stderr || String(r.error)).trim()}`);
      text = r.stdout;
    }
  }
  try { return JSON.parse(text); } catch (e) { fail(`plan JSON을 읽지 못했습니다: ${e.message}`); }
}

const plan = loadPlan();
if (!Array.isArray(plan.resource_changes) && !plan.format_version) fail("Terraform plan JSON 형식이 아닙니다(resource_changes 없음).");

const counts = { create: 0, update: 0, delete: 0, replace: 0, "no-op": 0, read: 0 };
const findings = [];
const add = (level, address, message) => findings.push({ level, address, message });

function kindOf(actions) {
  const a = actions.join(",");
  if (a === "delete,create" || a === "create,delete") return "replace";
  return actions[0] || "no-op";
}

function policyDocs(value) {
  const docs = [];
  for (const key of ["policy", "assume_role_policy", "inline_policy"]) {
    const v = value?.[key];
    const list = Array.isArray(v) ? v.map((x) => x?.policy ?? x) : [v];
    for (const s of list) {
      if (typeof s !== "string" || !s.trim().startsWith("{")) continue;
      try { docs.push(JSON.parse(s)); } catch { /* 계산 전 값 */ }
    }
  }
  return docs;
}
const asArray = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

function checkIngress(address, rules) {
  for (const r of rules) {
    const cidrs = [...asArray(r.cidr_blocks), ...asArray(r.cidr_ipv4), ...asArray(r.ipv6_cidr_blocks), ...asArray(r.cidr_ipv6)];
    const open = cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0");
    if (!open) continue;
    const from = Number(r.from_port ?? 0), to = Number(r.to_port ?? 65535);
    const webOnly = [80, 443].includes(from) && from === to;
    if (!webOnly) add("MEDIUM", address, `인터넷 전체(0.0.0.0/0)에 포트 ${from === to ? from : `${from}-${to}`}를 엽니다`);
  }
}

for (const rc of plan.resource_changes ?? []) {
  if (rc.mode === "data") continue;
  const actions = rc.change?.actions ?? ["no-op"];
  const kind = kindOf(actions);
  counts[kind] = (counts[kind] ?? 0) + 1;
  const before = rc.change?.before ?? {};
  const after = rc.change?.after ?? {};
  const addr = rc.address;

  if (kind === "delete" || kind === "replace") {
    const verb = kind === "delete" ? "삭제" : "교체(삭제 후 재생성)";
    const why = kind === "replace" && rc.change?.replace_paths ? ` — 교체 원인 속성: ${rc.change.replace_paths.map((p) => p.join(".")).join(", ")}` : "";
    const reason = rc.action_reason ? ` (${rc.action_reason})` : "";
    if (isStateful(rc.type)) add("HIGH", addr, `데이터를 가진 리소스를 ${verb}합니다${why}${reason}`);
    else add("MEDIUM", addr, `${verb}합니다${why}${reason}`);
  }

  if (kind === "update" || kind === "create") {
    for (const k of PROTECT_ON) {
      if (kind === "update" && before?.[k] === true && after?.[k] === false) add("HIGH", addr, `삭제 보호(${k})를 끕니다`);
    }
    for (const k of RISK_ON) {
      if (kind === "create" && RISK_ON_UPDATE_ONLY.has(k)) continue;
      if (after?.[k] === true && before?.[k] !== true) add(kind === "update" ? "HIGH" : "MEDIUM", addr, `${k} = true (${kind === "update" ? "새로 켜짐" : "생성 시 켜져 있음"}) — 삭제 시 데이터가 함께 지워질 수 있습니다`);
    }
    if (kind === "create" && isStateful(rc.type) && PROTECT_ON.some((k) => k in after) && !PROTECT_ON.some((k) => after[k] === true)) {
      add("LOW", addr, "데이터를 가진 리소스를 삭제 보호 없이 만듭니다");
    }
    // 버전 관리 끄기
    if (rc.type === "aws_s3_bucket_versioning" && kind === "update") {
      const st = (v) => v?.versioning_configuration?.[0]?.status;
      if (st(before) === "Enabled" && st(after) !== "Enabled") add("HIGH", addr, "S3 버전 관리를 끕니다(이전 버전으로 복구 불가)");
    }
    // 공개 접근 허용
    if (rc.type === "aws_s3_bucket_public_access_block" && ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].some((k) => after?.[k] === false)) {
      add("MEDIUM", addr, "S3 공개 접근 차단 설정 중 일부가 꺼져 있습니다");
    }
    // 보안 그룹
    if (rc.type === "aws_security_group") checkIngress(addr, asArray(after?.ingress));
    if (rc.type === "aws_security_group_rule" && after?.type === "ingress") checkIngress(addr, [after]);
    if (rc.type === "aws_vpc_security_group_ingress_rule") checkIngress(addr, [{ ...after, from_port: after?.from_port, to_port: after?.to_port }]);
    // IAM 와일드카드
    for (const doc of policyDocs(after)) {
      for (const st of asArray(doc.Statement)) {
        if (st?.Effect !== "Allow") continue;
        const acts = asArray(st.Action), ress = asArray(st.Resource);
        if (acts.includes("*") && ress.includes("*")) add("HIGH", addr, "IAM 정책이 모든 리소스에 모든 동작(Action \"*\", Resource \"*\")을 허용합니다");
        else if (acts.some((a) => a === "*" || /^[a-z0-9-]+:\*$/i.test(a))) add("MEDIUM", addr, `IAM 정책에 넓은 권한이 있습니다: ${acts.filter((a) => a === "*" || /:\*$/.test(a)).join(", ")}`);
      }
    }
  }
}

for (const d of plan.resource_drift ?? []) {
  add("INFO", d.address, `Terraform 밖에서 바뀐 것이 감지됨(drift): ${(d.change?.actions ?? []).join(",")}`);
}
if (plan.errored) add("HIGH", "(plan)", "plan이 오류로 중단된 상태입니다. 이 plan으로 적용하면 안 됩니다");

const order = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
findings.sort((a, b) => order[a.level] - order[b.level] || a.address.localeCompare(b.address));
const high = findings.filter((f) => f.level === "HIGH").length;

if (asJson) {
  process.stdout.write(JSON.stringify({ counts, findings, high }, null, 2) + "\n");
} else {
  const lines = [];
  lines.push(`## Terraform plan 검토${input && input !== "-" ? ` (${input})` : ""}`);
  lines.push("");
  lines.push(`생성 ${counts.create} · 변경 ${counts.update} · 교체 ${counts.replace} · 삭제 ${counts.delete} · 변화 없음 ${counts["no-op"]}`);
  lines.push("");
  if (!findings.length) lines.push("위험 신호 없음.");
  else {
    lines.push("| 수준 | 리소스 | 내용 |");
    lines.push("|---|---|---|");
    for (const f of findings) lines.push(`| ${f.level} | \`${f.address}\` | ${f.message.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push(high ? `판정: HIGH ${high}건 — 사람이 이 plan을 직접 승인하기 전에는 적용하지 않는다.` : "판정: HIGH 없음 — 그래도 적용 전에 사람에게 요약을 보이고 승인을 받는다.");
  process.stdout.write(lines.join("\n") + "\n");
}
process.exit(high ? 2 : 0);
