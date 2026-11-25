#!/usr/bin/env node
// cloud-cost-check 시험: node tests/run-tests.mjs
// 외부 의존성 없음. 클라우드나 실제 인프라에 접근하지 않는다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const fx = (p) => path.join(here, "fixtures", p);
const imp = (m) => import(new URL(`../scripts/${m}`, import.meta.url));
const { envOf } = await imp("aws-map.mjs");
const { planToItems, readPlan } = await imp("adapt-tf-plan.mjs");
const { staticToItems } = await imp("adapt-tf-static.mjs");
const { csvToItems, decode, guessCategory, parseSpec, toNum } = await imp("adapt-csv.mjs");
const { computeLoad } = await imp("load-model.mjs");
const { check, parseMetrics, recompute, render } = await imp("check.mjs");
const { scanIds } = await imp("scan-ids.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? " — " + detail : ""}`); } };
const node = (script, args, input) => spawnSync(process.execPath, [path.join(scripts, script), ...args], { input, encoding: "utf8" });
const csv = (file, mapping) => csvToItems(decode(fs.readFileSync(fx(file))).text, JSON.parse(fs.readFileSync(fx(mapping), "utf8")), file);
const req = (f) => JSON.parse(fs.readFileSync(fx(f), "utf8"));
const find = (res, code, re = /./, kind) => res.findings.filter((f) => f.check === code && (!kind || f.kind === kind) && re.test(`${f.where} ${f.message}`));

// ---------- 환경 이름 ----------
ok("env: my-prod-db → prod", envOf("my-prod-db").env_class === "prod");
ok("env: product-api는 prod가 아님", envOf("product-api").env_class === "unknown");
ok("env: staging → nonprod", envOf("module.staging.aws_db_instance.x").env_class === "nonprod");
ok("env: tests/fixtures 경로는 test로 보지 않음", envOf("tests/fixtures/plan.json").env_class === "unknown");
ok("env: 한글 운영·개발", envOf("운영").env_class === "prod" && envOf("개발").env_class === "nonprod");

// ---------- plan 입구 ----------
const traps = planToItems(readPlan(fx("plan-traps.json")));
{
  const ids = traps.items.map((i) => i.id);
  ok("plan: 지원 리소스 11개", traps.items.length === 11, String(traps.items.length));
  ok("plan: 삭제될 리소스·data 소스는 제외", !ids.some((i) => /gone|caller_identity/.test(i)));
  ok("plan: 다루지 않는 종류 집계", traps.unsupported_types.aws_iam_role === 1);
  const asg = traps.items.find((i) => i.id === "module.prod.aws_autoscaling_group.app");
  ok("plan: 모듈 안 ASG에 launch template 규격을 이어 붙임", asg.spec.type === "m5.large", asg.spec.type);
  ok("plan: ASG 탄력 범위", JSON.stringify(asg.elastic) === JSON.stringify({ min: 4, normal: 4, max: 4 }));
  ok("plan: 모듈 이름으로 환경 판정", traps.items.filter((i) => i.env === "dev").length === 5);
  ok("plan: 태그가 있으면 태그로 환경 판정", traps.items.find((i) => i.id === "module.prod.aws_db_instance.main").env === "prod");
}
{
  // hashicorp/aws 5.100.0 provider가 오프라인으로 만든 실제 plan(infra-change-guard와 같은 파일)
  const real = planToItems(readPlan(fx("real-aws-offline-create.json")));
  const db = real.items.find((i) => i.type === "aws_db_instance");
  ok("실제 plan: DB 규격", db?.spec.type === "db.t4g.micro" && db.spec.disk_gb === 20);
  ok("실제 plan: S3 버킷", real.items.some((i) => i.category === "object_storage"));
  ok("실제 plan: IAM·SG는 비용 항목이 아님", real.unsupported_types.aws_iam_policy === 1 && real.unsupported_types.aws_security_group === 1);
  ok("실제 plan: 환경 정보가 없으면 unknown", real.items.every((i) => i.env_class === "unknown"));
}
{
  const r = node("adapt-tf-plan.mjs", ["-"], JSON.stringify({ format_version: "1.2", errored: true, resource_changes: [] }));
  ok("plan: errored plan은 종료 코드 1", r.status === 1 && /errored/.test(r.stderr));
}

// ---------- .tf 정적 입구 ----------
const stat = staticToItems(fx("tf-traps"));
{
  const by = (id) => stat.items.find((i) => i.id === id);
  ok("static: 리소스 9개(주석 처리된 리소스 제외)", stat.items.length === 9, String(stat.items.length));
  ok("static: heredoc 안의 중괄호에 흔들리지 않음", by("envs/prod::aws_autoscaling_group.app")?.elastic?.max === 4);
  ok("static: launch_template 참조로 규격 연결", by("envs/prod::aws_autoscaling_group.app")?.spec.type === "m5.large");
  ok("static: variable default로 값 채움", by("envs/prod::aws_db_instance.main")?.ha.multi_az === false);
  ok("static: 리터럴 count는 수량에 반영", by("envs/dev::aws_nat_gateway.this")?.qty === 2);
  ok("static: 변수 count는 모름(null)", by("envs/prod::aws_instance.batch")?.qty === null && stat.unknown_count.length === 1);
  ok("static: 중첩 블록(scaling_config)", JSON.stringify(by("envs/dev::aws_eks_node_group.workers")?.elastic) === JSON.stringify({ min: 2, normal: 2, max: 2 }));
  ok("static: 경로로 환경 판정", by("envs/dev::aws_db_instance.main")?.env === "dev" && by("envs/prod::aws_db_instance.main")?.env === "prod");
  ok("static: 모듈 호출은 펼치지 않고 입력값만 보고", stat.modules.length === 1 && stat.modules[0].literal_inputs.single_nat_gateway === false);
  ok("static: 위치는 파일:줄", by("envs/prod::aws_db_instance.main")?.source_ref === "envs/prod/main.tf:11");
}

// ---------- CSV 입구 ----------
const bad = csv("estimate-bad.csv", "mapping-bad.json");
{
  ok("csv: 항목 6개, 소계·합계 3개", bad.items.length === 6 && bad.totals.length === 3);
  const was = bad.items.find((i) => i.name === "WAS 서버");
  ok("csv: 규격 문자열 분해", was.spec.vcpu === 8 && was.spec.mem_gb === 32 && was.spec.disk_gb === 100);
  ok("csv: 범주 추정", bad.items.find((i) => i.name === "웹방화벽").category === "security" && bad.items.find((i) => i.name === "DB 서버(이중화)").category === "db");
  ok("csv: 셀 위치", was.cells.amount === "estimate-bad.csv!H5");
  ok("csv: 매핑 확인 전이면 confirmed=false", bad.items.every((i) => i.confirmed === false));
}
{
  const cp = csvToItems(decode(fs.readFileSync(fx("estimate-cp949.csv"))).text, { header_row: 1, columns: { name: "품목", spec: "사양", unit_price: "월단가", qty: "수량", months: "개월", amount: "금액" }, defaults: { currency: "KRW" } }, "estimate-cp949.csv");
  ok("csv: CP949(엑셀 기본 CSV) 읽기", decode(fs.readFileSync(fx("estimate-cp949.csv"))).encoding === "cp949" && cp.items[0].name === "운영 WEB 서버");
  ok("csv: 열을 머리글 이름으로 지정", cp.items[1].unit_price === 200000 && cp.totals[0].amount_stated === 4800000);
}
ok("범주: DB 접근제어 → security", guessCategory("DB 접근제어") === "security");
ok("범주: 백업 스토리지 → backup", guessCategory("백업 스토리지") === "backup");
ok("범주: Outbound 트래픽 → traffic", guessCategory("Outbound 트래픽") === "traffic");
ok("범주: 공인 IP → public_ip", guessCategory("공인 IP") === "public_ip");
ok("규격: m5.large", parseSpec("m5.large (2 vCPU)").type === "m5.large");
ok("숫자: 괄호 음수·원화 기호·대시", toNum("(5,000)") === -5000 && toNum("₩ 3,000") === 3000 && toNum("-") === null && toNum("1,200원") === 1200);
ok("재계산: 시간 단가", recompute({ unit_price: 100, unit: "hour", hours_per_month: 730, qty: 2, months: 1 }).value === 146000);

// ---------- 부하 모델 ----------
{
  const L = computeLoad(req("req-traps.json").load);
  // 동시 사용자 500명은 피크 값이다. 평상 = 피크 ÷ 2, 설계 피크 = 피크 × 여유 2
  ok("부하: 피크 사용자에 피크 계수를 또 곱하지 않음", L.result.tx_per_s === 50 && L.result.normal_tx_per_s === 25 && L.result.peak_api_rps === 200 && L.result.api_rps === 100);
  ok("부하: 여유 계수는 설계 피크에만", L.result.design_api_rps === 400);
  ok("부하: 필요 대수(AZ 하나 장애 포함)", L.result.units_for_peak === 4 && L.result.units_for_peak_with_az_loss === 8 && L.result.units_for_normal === 1);
  const N = computeLoad({ users_basis: "normal", concurrent_users: 250, request_interval_s: 10, api_per_tx: 4, peak_factor: 2 });
  ok("부하: 평상 사용자로 받으면 피크 = 평상 × 계수", N.result.tx_per_s === 50 && N.result.api_rps === 100 && N.result.peak_api_rps === 200);
  const M = computeLoad({ concurrent_users: 500 });
  ok("부하: 요청 간격 없으면 계산하지 않음", M.result.tx_per_s === undefined && M.missing.some((m) => /request_interval_s/.test(m)));
  const T = computeLoad({ concurrent_users: 500, assumed_tps: 500, request_interval_s: 10, api_per_tx: 1 });
  ok("부하: 동시 사용자를 TPS로 쓴 문서", T.notes.some((n) => /그대로 TPS/.test(n)));
}

// ---------- 검사: 함정을 심은 견적 + 구성 ----------
const res = check({ estimate: bad, infra: traps, req: req("req-traps.json") });
ok("A1: 금액 계산 오류 위치", find(res, "A1", /H5.*7,200,000/, "error").length === 1);
ok("A1: 맞는 행은 지적 안 함", find(res, "A1").length === 1);
ok("A2: 소계 오류", find(res, "A2", /H11.*7,080,000/, "error").length === 1 && find(res, "A2").length === 1);
ok("B1: 전송·백업 누락", find(res, "B1", /전송/).length === 1 && find(res, "B1", /백업/).length === 1);
ok("B2: 세금·지원 포함 여부", find(res, "B2", /부가세/, "unknown").length === 1);
ok("C1: 요구 시간 176 대비 상시 가동", find(res, "C1", /176/, "over").length === 2);
ok("D1: 비운영 Multi-AZ(구성)·이중화(견적)·NAT 2개", find(res, "D1", /dev\.aws_db_instance/).length === 1 && find(res, "D1", /개발 DB/).length === 1 && find(res, "D1", /NAT Gateway 2개/).length === 1);
ok("D2: 운영 단일 NAT·단일 AZ DB", find(res, "D2", /NAT/, "under").length === 1 && find(res, "D2", /단일 AZ/, "under").length === 1);
ok("E1: 최소=최대", find(res, "E1", /prod\.aws_autoscaling_group/, "under").length === 1);
ok("E3: 운영 최대 < 피크(AZ 장애 포함)", find(res, "E3", /최대 4대 < 피크 필요 8대/, "under").length === 1);
ok("E3: 비운영은 부하 모델에 대지 않음", find(res, "E3", /dev\./).length === 0);
ok("E4: 운영 최소 > 평상 필요", find(res, "E4", /최소 4대 > 평상 필요 2대/, "over").length === 1);
ok("E5: 고정 예산에 피크 구간 없음", find(res, "E5", /견적 2대 < 피크 필요 4대/, "under").length === 1);
ok("E5: 견적이 구성의 최소값에 맞춰짐", find(res, "E5", /비운영 컴퓨팅: 견적 1대 = 구성의 최소값/).length === 1);
ok("F1: 온프레미스식 계수 중복", find(res, "F1", /성장률 ×1.3, 이중화 ×2/, "over").length === 1);
ok("H1: 구성에만 있는 NAT·LB·로그", ["nat", "lb", "log"].every((c) => find(res, "H1", new RegExp(`${c} \\d+개`), "missing").length === 1));
ok("H2: DB 개수 불일치는 '견적·구성 불일치'", find(res, "H2", /(^|\s)운영 db: 견적 2개, 구성 1개/, "mismatch").length === 1);
ok("J1~J4: gp2·구세대·무기한 로그·S3 endpoint", find(res, "J1").length === 1 && find(res, "J2", /db\.m4\.large/).length === 1 && find(res, "J3").length === 1 && find(res, "J4").length === 1);
ok("J5: 약정 계획 없음", find(res, "J5", /약정/, "unknown").length === 1);

// ---------- 오탐 방지 ----------
{
  const good = check({ infra: planToItems(readPlan(fx("plan-good.json"))), req: req("req-good.json") });
  ok("정상 구성: 아무것도 나오지 않음", good.findings.length === 0, good.findings.map((f) => f.check + " " + f.message).join(" / "));
}
{
  // NIA 「클라우드컴퓨팅서비스 비용 최적화 가이드라인」 사례 표(기존·최적화 이후) — 공개 자료의 맞는 합계
  const nia = csv("estimate-nia.csv", "mapping-nia.json");
  const r = check({ estimate: nia, req: { include_tax: false, include_support: false, commitment: "none" } });
  ok("NIA 사례: 합계 2개를 읽음", nia.totals.length === 2 && nia.totals.every((t) => t.covers.length === 3));
  ok("NIA 사례: 맞는 합계는 지적 안 함", find(r, "A1").length === 0 && find(r, "A2").length === 0, JSON.stringify(r.findings.map((f) => f.check)));
}
{
  // 블로그에 공개된 TTA 지침 산정 사례: 요구 성능 ÷ 코어당 성능과 최종 코어 수
  const tta = csv("sizing-tta-blog.csv", "mapping-sizing.json");
  const r = check({ estimate: tta });
  ok("TTA 사례: WEB 121코어 필요 vs 32코어", find(r, "A5", /WEB.*= 121 단위.*32 단위/, "under").length === 1);
  ok("TTA 사례: WAS 376코어 필요 vs 96코어", find(r, "A5", /WAS.*= 376 단위.*96 단위/, "under").length === 1);
  ok("TTA 사례: DB는 21 필요 vs 24로 충분", find(r, "A5", /DB/).length === 0);
}

// ---------- 그 밖의 검사 ----------
{
  const r = check({ estimate: { items: [{ id: "a", name: "VM", category: "compute", unit_price: 1, qty: 1, months: 1, currency: "USD", env_class: "prod" }, { id: "b", name: "DB", category: "db", unit_price: 1, qty: 1, months: 1, currency: "KRW", env_class: "prod" }] }, req: { currency: "KRW" } });
  ok("A3: 통화 혼재와 환율 없음", find(r, "A3", /USD/, "error").length === 1);
  const r2 = check({ estimate: { items: [{ id: "a", name: "VM", category: "compute", unit_price: 0.1, unit: "hour", qty: 1, months: 1, amount_stated: 73, env_class: "prod" }] } });
  ok("A4: 시간 단가인데 사용 시간 없음", find(r2, "A4", /월 사용 시간/, "unknown").length === 1);
  const r3 = check({ infra: traps, req: { sizing_factors: { growth: 1.3 } } });
  ok("F1: 어디에 곱했는지 없으면 정보 부족", find(r3, "F1", /어디에/, "unknown").length === 1);
  const r5 = check({ infra: traps, req: { load: { concurrent_users: 500, assumed_tps: 500, request_interval_s: 10, api_per_tx: 1 } } });
  ok("G2: 동시 사용자를 TPS로 쓴 산정", find(r5, "G2", /그대로 TPS/, "over").length === 1);
  const r6 = check({ infra: traps, req: { load: { concurrent_users: 500 } } });
  ok("G1: 부하 모델 계산 불가", find(r6, "G1", /request_interval_s/, "unknown").length === 1);
  const r4 = check({ estimate: { items: [{ id: "s", name: "보안관제", category: "security", env_class: "prod" }] }, req: { common_infra_exists: true } });
  ok("B3: 기관 공통 인프라 중복", find(r4, "B3", /공통 인프라/, "over").length === 1);
}
{
  const r = check({ infra: staticToItems(fx("tf-traps")), req: { availability: "multi-az" } });
  ok("static→검사: 비운영 NAT 2개", find(r, "D1", /dev 환경 NAT Gateway 2개/).length === 1);
  ok("static→검사: EKS 노드 그룹 최소=최대", find(r, "E1", /eks_node_group/).length === 1);
  ok("static→검사: 구세대 t2", find(r, "J2", /t2\.large/).length === 1);
  ok("static→검사: 운영 NAT 1개(count=1)", find(r, "D2", /NAT/, "under").length === 1);
}
{
  const m = parseMetrics(fs.readFileSync(fx("metrics.csv"), "utf8"));
  const r = check({ estimate: { items: [] }, metrics: m });
  ok("I1: 저사용", find(r, "I1", /vm-low.*저사용/, "over").length === 1);
  ok("I1: 고사용", find(r, "I1", /vm-hot.*고사용/, "under").length === 1);
  ok("I1: 메모리 지표 없으면 판정 못 함", find(r, "I1", /vm-nomem.*메모리 지표 없음/, "unknown").length === 1);
  ok("I1: 측정 기간 짧음", find(r, "I1", /vm-short.*7일/, "info").length === 1 && find(r, "I1", /vm-short/).length === 1);
}

{
  // 빈 템플릿(모든 값 null)을 그대로 넣어도 깨지지 않고, 빈 값은 "모름"으로 다룬다
  const tpl = JSON.parse(fs.readFileSync(path.join(here, "..", "templates", "requirements.json"), "utf8"));
  const r = check({ estimate: bad, infra: traps, req: tpl });
  ok("템플릿: null 값은 모름으로 다룸", find(r, "J5").length === 1 && find(r, "B2").length === 1 && find(r, "G1").length === 1);
  ok("템플릿: 가용성 null이면 단일 NAT는 판정 못 함", find(r, "D3", /NAT/, "unknown").length === 1 && find(r, "D2").length === 0);
}

// ---------- 식별자 검사 ----------
{
  const hits = scanIds("계정 987654321098 · arn:aws:iam::987654321098:role/x · 10.1.2.3 · ops@corp.co.kr · 0.0.0.0/0 · 83,372,153원 · 111122223333");
  const kinds = hits.map((h) => h.kind).sort().join(",");
  ok("식별자: 계정·ARN·IP·이메일", kinds === "ARN,AWS 계정 ID,IPv4,이메일", kinds);
  ok("식별자: 예시 값과 금액은 제외", !hits.some((h) => /0\.0\.0\.0|83,372|111122223333/.test(h.value)));
}

// ---------- 두 번째 검증에서 나온 경우 ----------
{
  // 환경 이름: 운영 단어를 품은 비운영 이름, 경로의 뒤쪽 조각, tags_all
  ok("env2: 비운영·non-prod·pre-prod·Non-Production은 비운영", ["비운영", "non-prod", "pre-prod", "Non-Production"].every((t) => envOf(t).env_class === "nonprod"));
  ok("env2: 개발(운영 미러)은 앞 단어(개발)", envOf("개발(운영 미러)").env_class === "nonprod");
  ok("env2: infrastructure-live/dev 경로는 dev", envOf("infrastructure-live/dev/plan.json").env_class === "nonprod");
  ok("env2: uat·nonprod", envOf("uat").env_class === "nonprod" && envOf("nonprod").env_class === "nonprod");
  const rc = (address, type, after, extra = {}) => ({ address, mode: "managed", type, name: "x", change: { actions: ["create"], after }, ...extra });
  const tagPlan = planToItems({ resource_changes: [rc("aws_db_instance.a", "aws_db_instance", { tags: { Name: "a" }, tags_all: { Name: "a", Environment: "dev" } }), rc("aws_db_instance.b", "aws_db_instance", { tags: { ENV: "uat" } })] });
  ok("env2: tags에 없으면 tags_all, 키 대소문자 무시", tagPlan.items.every((i) => i.env_class === "nonprod"));
}
{
  // count가 있는 모듈 안의 참조, 클러스터 인스턴스 수
  const plan = {
    configuration: { root_module: { module_calls: { db: { module: { resources: [{ address: "aws_rds_cluster_instance.this", expressions: { cluster_identifier: { references: ["aws_rds_cluster.this.id", "aws_rds_cluster.this"] } } }] } } } } },
    resource_changes: [
      { address: "module.db[0].aws_rds_cluster.this", module_address: "module.db[0]", mode: "managed", type: "aws_rds_cluster", name: "this", change: { actions: ["create"], after: { engine: "aurora-postgresql" } } },
      { address: "module.db[0].aws_rds_cluster_instance.this[0]", module_address: "module.db[0]", mode: "managed", type: "aws_rds_cluster_instance", name: "this", index: 0, change: { actions: ["create"], after: { instance_class: "db.r6g.large" } } },
      { address: "module.db[0].aws_rds_cluster_instance.this[1]", module_address: "module.db[0]", mode: "managed", type: "aws_rds_cluster_instance", name: "this", index: 1, change: { actions: ["create"], after: { instance_class: "db.r6g.large" } } },
    ],
  };
  const items = planToItems(plan).items.filter((i) => i.type === "aws_rds_cluster_instance");
  ok("plan2: count 모듈 안에서도 클러스터와 연결", items.every((i) => i.ha?.multi_az === true && i.ha.replicas === 1));
}
{
  // 정적 입구: count=2 Aurora 인스턴스, 변수로 정한 multi_az, tfvars, override, 환경 폴더 직접 지정
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-tf-"));
  const prod = path.join(tmp, "prod");
  fs.mkdirSync(prod);
  fs.writeFileSync(path.join(prod, "main.tf"), [
    'variable "maz" { type = bool }',
    'variable "web_count" { default = 1 }',
    'resource "aws_rds_cluster" "main" { engine = "aurora-postgresql" }',
    'resource "aws_rds_cluster_instance" "main" {\n  count = 2\n  cluster_identifier = aws_rds_cluster.main.id\n  instance_class = "db.r6g.large"\n}',
    'resource "aws_db_instance" "legacy" {\n  instance_class = "db.m5.large"\n  multi_az = var.maz\n}',
    'resource "aws_instance" "web" {\n  count = var.web_count\n  instance_type = "t3.large"\n}',
    'resource "aws_cloudwatch_log_group" "app" { retention_in_days = var.keep }',
    'resource "aws_vpc_endpoint" "s3" { service_name = "com.amazonaws.${var.region}.s3" }',
    'resource "aws_nat_gateway" "a" { count = 2 }',
  ].join("\n\n"));
  fs.writeFileSync(path.join(prod, "override.tf"), 'resource "aws_instance" "web" {\n  instance_type = "m5.large"\n}\n');
  fs.writeFileSync(path.join(prod, "terraform.tfvars"), "web_count = 4\n");
  const s = staticToItems(prod);
  const by = (t) => s.items.filter((i) => i.type === t);
  ok("static2: count=2 클러스터 인스턴스는 이중화", by("aws_rds_cluster_instance")[0]?.ha?.multi_az === true);
  ok("static2: 변수로 정한 multi_az는 모름(null)", by("aws_db_instance")[0]?.ha?.multi_az === null);
  ok("static2: tfvars가 있으면 default를 확정값으로 안 씀", by("aws_instance")[0]?.qty === null && s.tfvars_dirs.length === 1);
  ok("static2: override.tf는 같은 리소스에 합침", by("aws_instance").length === 1 && by("aws_instance")[0].spec.type === "m5.large");
  ok("static2: 환경 폴더를 직접 지정해도 환경 판정", s.items.every((i) => i.env_class === "prod"));
  const r = check({ infra: s, req: { availability: "multi-az" } });
  ok("static2: 모르는 multi_az는 D2가 아니라 D3", find(r, "D3", /legacy.*모름/, "unknown").length === 1 && find(r, "D2", /legacy/).length === 0);
  ok("static2: 변수 보존 기간은 무기한이라 단정 안 함", find(r, "J3", /변수/, "unknown").length === 1 && find(r, "J3", /무기한/).length === 0);
  ok("static2: 변수 섞인 S3 endpoint 이름도 인식", find(r, "J4").length === 0);
  fs.rmSync(tmp, { recursive: true, force: true });
}
{
  // CSV: 이름 속 "합계", 영문 머리글, 단위 글자, 연 단가, △ 음수, db. 접두사, 병합 셀, 공급가액→부가세→총계
  const m = (columns, extra = {}) => ({ header_row: 1, columns, defaults: { currency: "KRW", env: "운영" }, ...extra });
  const t1 = csvToItems("품목,단가,수량,개월,금액\n통합계정관리(IAM) 서버,300000,1,12,3600000\n공급가액 합계,,,,3600000\n부가세,,,,360000\n총계(VAT 포함),,,,3960000\n", m({ name: "품목", unit_price: "단가", qty: "수량", months: "개월", amount: "금액" }));
  ok("csv2: 이름에 '합계'가 든 품목은 품목", t1.items.some((i) => /통합계정관리/.test(i.name)) && t1.totals.length === 2);
  const r1 = check({ estimate: t1, req: { include_tax: true, include_support: false, commitment: "none" } });
  ok("csv2: 공급가액 합계 → 부가세 → 총계는 지적 안 함", find(r1, "A2").length === 0, JSON.stringify(find(r1, "A2")));
  const t2 = csvToItems("NAME,CPU,MEM,QTY,PRICE\nWAS server,8,32,4,300000\n", m({ name: "NAME", vcpu: "CPU", mem_gb: "MEM", qty: "QTY", unit_price: "PRICE" }));
  ok("csv2: 'CPU'·'QTY' 같은 머리글은 열 글자보다 먼저", t2.items[0].spec.vcpu === 8 && t2.items[0].qty === 4);
  const t3 = csvToItems("품목,단가,단위,수량,기간,금액\nWEB 서버,300000,월,2대,12개월,7200000\nDBMS 라이선스,12000000,연,1식,12개월,12000000\n장기계약 할인,,,,,\"△1,000,000\"\n", m({ name: "품목", unit_price: "단가", unit: "단위", qty: "수량", months: "기간", amount: "금액" }));
  ok("csv2: '2대'·'12개월'·'1식'", t3.items[0].qty === 2 && t3.items[0].months === 12 && t3.items[1].qty === 1);
  ok("csv2: 단위 '연'은 연 단가", t3.items[1].unit === "year" && find(check({ estimate: t3 }), "A1").length === 0);
  ok("csv2: △는 음수", t3.items[2].amount_stated === -1000000);
  ok("csv2: db.r6g.large는 접두사까지, 6g를 크기로 안 읽음", JSON.stringify(parseSpec("db.r6g.large 500GB")) === JSON.stringify({ type: "db.r6g.large", disk_gb: 500 }));
  ok("csv2: 'SSD 100GB, 4vCPU 16GB'는 메모리 16·디스크 100", parseSpec("SSD 100GB, 4vCPU 16GB").mem_gb === 16 && parseSpec("SSD 100GB, 4vCPU 16GB").disk_gb === 100);
  ok("csv2: '4C/16G/100G'", JSON.stringify(parseSpec("4C/16G/100G")) === JSON.stringify({ vcpu: 4, mem_gb: 16, disk_gb: 100 }));
  ok("csv2: 범주(워커 노드·Windows Server·개인정보 DB 서버)", guessCategory("EKS 워커 노드") === "compute" && guessCategory("Windows Server 2022") === "compute" && guessCategory("개인정보 DB 서버") === "db");
  const t4 = csvToItems("환경,품목,금액\n개발,WEB 서버,100\n,DB 서버,200\n소계,,300\n,운영 WEB,400\n", { header_row: 1, columns: { env: "환경", name: "품목", amount: "금액" }, fill_down: ["env"] });
  ok("csv2: 병합 셀(fill_down)은 위 값을 이어받고 소계에서 끊음", t4.items[1].env_class === "nonprod" && t4.items[2].env_class === "prod", JSON.stringify(t4.items.map((i) => i.env)));
  const t5 = csvToItems("품목,금액\nWEB,100\n모니터링,-\n소계,999\n", { header_row: 1, columns: { name: "품목", amount: "금액" } });
  ok("csv2: 읽지 못한 금액이 있으면 합계 검증 못 함을 알림", find(check({ estimate: t5 }), "A2", /읽지 못해/, "unknown").length === 1);
}
{
  // 판정 로직
  const L = computeLoad({ tps: 450, api_per_tx: 1, peak_factor: 1, unit_rps: 100, azs: 2 }).result;
  ok("logic2: AZ 장애 대수는 대수 단위로(450 RPS·대당 100·2AZ → 10대)", L.units_for_peak_with_az_loss === 10, String(L.units_for_peak_with_az_loss));
  ok("logic2: 3AZ·420 RPS → 8대", computeLoad({ tps: 420, api_per_tx: 1, unit_rps: 100, azs: 3 }).result.units_for_peak_with_az_loss === 8);
  const asg = (min, n, max, env = "prod", id = "asg") => ({ id, type: "aws_autoscaling_group", category: "compute", env_class: env, spec: {}, qty: n, elastic: { min, normal: n, max }, source_ref: id });
  const est1 = (q, env = "prod") => ({ items: [{ id: "e", name: "WAS", category: "compute", env_class: env, qty: q, source_ref: "e" }] });
  ok("logic2: 견적 < 구성 최소", find(check({ estimate: est1(1), infra: { items: [asg(3, 3, 6)] } }), "E7", /견적 1대 < 구성의 최소 3대/, "mismatch").length === 1);
  ok("logic2: 견적 > 구성 최대", find(check({ estimate: est1(8), infra: { items: [asg(3, 3, 6)] } }), "E7", /견적 8대 > 구성의 최대 6대/, "mismatch").length === 1);
  const unk = check({ estimate: est1(2), infra: { items: [{ id: "i", type: "aws_instance", category: "compute", env_class: "unknown", qty: 6, spec: {}, source_ref: "i" }] } });
  ok("logic2: 구성에 환경이 없으면 전체로 대조하고 알림", find(unk, "H2", /전체 compute: 견적 2개, 구성 6개/).length === 1 && find(unk, "H4").length === 1);
  const two = check({ infra: { items: [asg(2, 2, 4, "prod", "app_a"), asg(2, 2, 4, "prod", "app_c")] }, req: { load: { target: "app", tps: 200, api_per_tx: 4, unit_rps: 100, unit_rps_measured: true } } });
  ok("logic2: 같은 계층의 그룹 둘은 합쳐서 비교", find(two, "E3").length === 0);
  ok("logic2: 연 단가에 개월이 없으면 12개월", find(check({ estimate: { items: [{ id: "y", name: "L", category: "license", unit: "year", unit_price: 1200000, qty: 1, amount_stated: 1200000 }] } }), "A1").length === 0);
  const envDev = check({ estimate: { items: [{ id: "d", name: "개발 WAS", env: "개발", env_class: "nonprod", category: "compute", unit: "hour", hours_per_month: 400, qty: 1, source_ref: "d" }] }, req: { environments: { dev: { hours_per_month: 176 } } } });
  ok("logic2: 요구사항 키 dev ↔ 견적 라벨 개발", find(envDev, "C1", /176/).length === 1);
  const db = { items: [{ id: "db", type: "aws_db_instance", category: "db", env_class: "prod", env: "prod", ha: { multi_az: false }, source_ref: "db" }] };
  ok("logic2: 가용성 '다중 AZ(이중화)'는 multi", find(check({ infra: db, req: { availability: "다중 AZ(이중화)" } }), "D2").length === 1);
  ok("logic2: 가용성 single-az면 단일 AZ DB를 지적 안 함", check({ infra: db, req: { availability: "single-az" } }).findings.length === 0);
  ok("logic2: 비운영 read replica", find(check({ infra: { items: [{ id: "rr", type: "aws_db_instance", category: "db", env_class: "nonprod", env: "dev", ha: { multi_az: false, replica: true }, source_ref: "rr" }] } }), "D1").length === 1);
  ok("logic2: 지표의 % 표기", parseMetrics("id,cpu_pct,mem_pct\nvm,12%,25%\n")[0].mem_pct === 25);
  ok("logic2: thresholds의 null은 기본값", check({ estimate: { items: [] }, metrics: [{ id: "v", cpu_pct: 30, mem_pct: 40 }], req: { thresholds: { cpu_high: null } } }).findings.length === 0);
  ok("logic2: mapping 템플릿은 올바른 JSON", (() => { try { JSON.parse(fs.readFileSync(path.join(here, "..", "templates", "mapping.json"), "utf8")); return true; } catch { return false; } })());
  ok("logic2: load.target 없음은 알리고, 잘못된 정규식은 깨지지 않음", find(check({ infra: traps, req: { load: { tps: 10, api_per_tx: 1, unit_rps: 5 } } }), "G1", /target이 없어/).length === 1 && find(check({ infra: traps, req: { load: { target: "(", tps: 10, api_per_tx: 1, unit_rps: 5 } } }), "G1", /정규식/).length === 1);
  {
    const out = render(check({ estimate: { items: [{ id: "n", name: "WAS 서버\n(이중화)", category: "compute", env_class: "nonprod", env: "dev", qty: 1 }], totals: [{ label: "합계", kind: "total", amount_stated: 5 }] } }));
    const rows = out.split("\n").filter((l) => l.startsWith("| D1") || l.startsWith("| C1"));
    ok("logic2: 위치 없는 항목·줄바꿈 이름도 표가 깨지지 않음", rows.length >= 1 && rows.every((l) => l.split(" | ").length === 4 && !/undefined/.test(l)), out);
  }
  ok("logic2: 'RI 1년' 약정 표기는 정가로 안 봄", find(check({ estimate: { items: [{ id: "c", name: "WAS", category: "compute", env_class: "prod", pricing: "RI 1년" }] } }), "J5").length === 0);
  const ids = (t) => scanIds(t).map((h) => h.value);
  ok("scan2: 문장 끝·목록 쉼표 앞 계정 ID", ids("운영 계정 ID는 987654321098.").length === 1 && ids("계정: 987654321098, 210987654321").length === 2);
  ok("scan2: 콘솔 표기 계정 ID, 계정 없는 S3 ARN", ids("1234-5678-9012").length === 1 && ids("arn:aws:s3:::acme-prod-backup").length === 1);
  ok("scan2: 카드 번호·큰 금액·소수는 계정 ID 아님", ids("1234-5678-9012-3456").length === 0 && ids("1,234,567,890,123원").length === 0 && ids("0.987654321098").length === 0);
  ok("scan2: 192.168.0.0 같은 대역 표기는 허용", ids("192.168.0.0/16").length === 0);
}

// ---------- 명령줄 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-"));
  const est = path.join(tmp, "est.json"), inf = path.join(tmp, "inf.json"), good = path.join(tmp, "good.json");
  ok("CLI: adapt-csv", node("adapt-csv.mjs", [fx("estimate-bad.csv"), "--mapping", fx("mapping-bad.json"), "--out", est]).status === 0);
  ok("CLI: adapt-csv 매핑 없으면 1", node("adapt-csv.mjs", [fx("estimate-bad.csv")]).status === 1);
  ok("CLI: adapt-tf-plan", node("adapt-tf-plan.mjs", [fx("plan-traps.json"), "--out", inf]).status === 0);
  const r = node("check.mjs", ["--estimate", est, "--infra", inf, "--req", fx("req-traps.json")]);
  ok("CLI: 확인할 항목 있으면 2", r.status === 2 && /\| A1 \| 계산 불일치 \|/.test(r.stdout));
  node("adapt-tf-plan.mjs", [fx("plan-good.json"), "--out", good]);
  ok("CLI: 정상 구성이면 0", node("check.mjs", ["--infra", good, "--req", fx("req-good.json")]).status === 0);
  ok("CLI: 입력 없으면 1", node("check.mjs", []).status === 1);
  ok("CLI: load-model 빠진 값이면 2", node("load-model.mjs", [fx("req-good.json")]).status === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
