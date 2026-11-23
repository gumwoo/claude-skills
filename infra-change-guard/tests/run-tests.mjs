#!/usr/bin/env node
// infra-change-guard 시험: node tests/run-tests.mjs
// 외부 의존성 없음. 클라우드나 실제 인프라에 접근하지 않는다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const fx = (p) => path.join(here, "fixtures", p);
const { evaluate } = await import(new URL("../scripts/guard-hook.mjs", import.meta.url));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log(`✗ ${name}${detail ? " — " + detail : ""}`); } };
const node = (script, args, input) => spawnSync(process.execPath, [path.join(scripts, script), ...args], { input, encoding: "utf8" });

// ---------- plan-check ----------
{
  const r = node("plan-check.mjs", [fx("real-terraform-data.json"), "--json"]);
  const j = JSON.parse(r.stdout);
  check("실제 plan: 종료 코드 0", r.status === 0, `exit ${r.status}`);
  check("실제 plan: 집계", JSON.stringify(j.counts) === JSON.stringify({ create: 1, update: 1, delete: 1, replace: 1, "no-op": 1, read: 0 }), JSON.stringify(j.counts));
  check("실제 plan: 교체 원인 속성", j.findings.some((f) => f.address === "terraform_data.replaced" && /triggers_replace/.test(f.message)));
  check("실제 plan: 상태 없는 리소스 삭제는 MEDIUM", j.findings.every((f) => f.level === "MEDIUM"));
}
{
  const r = node("plan-check.mjs", [fx("aws-risky-plan.json"), "--json"]);
  const j = JSON.parse(r.stdout);
  const has = (level, addr, re) => j.findings.some((f) => f.level === level && f.address === addr && re.test(f.message));
  check("위험 plan: 종료 코드 2", r.status === 2, `exit ${r.status}`);
  check("RDS 교체 → HIGH", has("HIGH", "aws_db_instance.main", /교체.*engine_version/));
  check("S3 버킷 삭제 → HIGH", has("HIGH", "aws_s3_bucket.uploads", /삭제/));
  check("삭제 보호 끄기 → HIGH", has("HIGH", "aws_db_instance.reports", /deletion_protection/));
  check("skip_final_snapshot 켜기 → HIGH", has("HIGH", "aws_db_instance.reports", /skip_final_snapshot/));
  check("S3 버전 관리 끄기 → HIGH", has("HIGH", "aws_s3_bucket_versioning.uploads", /버전 관리/));
  check("SSH 전체 공개 → MEDIUM", has("MEDIUM", "aws_security_group.bastion", /포트 22/));
  check("443 공개는 지적하지 않음", !j.findings.some((f) => /포트 443/.test(f.message)));
  check("IAM */* → HIGH", has("HIGH", "aws_iam_policy.admin", /Action "\*"/));
  check("IAM s3:* → MEDIUM", has("MEDIUM", "aws_iam_role_policy.ci", /s3:\*/));
  check("보호 없는 DB 생성 → LOW", has("LOW", "aws_db_instance.new", /삭제 보호 없이/));
  check("force_destroy 생성 → MEDIUM", has("MEDIUM", "aws_s3_bucket.scratch", /force_destroy/));
  check("IAM role 삭제 → MEDIUM", has("MEDIUM", "aws_iam_role.app", /삭제/));
  check("drift → INFO", has("INFO", "aws_s3_bucket.logs", /drift/));
  check("data 소스는 집계하지 않음", j.counts.read === 0);
  check("no-op 리소스는 지적하지 않음", !j.findings.some((f) => f.address === "aws_sqs_queue.jobs"));
}
{
  // hashicorp/aws 5.100.0 provider가 오프라인(-refresh=false)으로 만든 실제 plan
  const r = node("plan-check.mjs", [fx("real-aws-offline-create.json"), "--json"]);
  const j = JSON.parse(r.stdout);
  const has = (level, addr, re) => j.findings.some((f) => f.level === level && f.address === addr && re.test(f.message));
  check("실제 AWS plan: 생성 4", j.counts.create === 4);
  check("실제 AWS plan: IAM */* → HIGH", has("HIGH", "aws_iam_policy.admin", /Action "\*"/) && r.status === 2);
  check("실제 AWS plan: SSH 공개 → MEDIUM", has("MEDIUM", "aws_security_group.ssh", /포트 22/));
  check("실제 AWS plan: skip_final_snapshot·force_destroy → MEDIUM", has("MEDIUM", "aws_db_instance.db", /skip_final_snapshot/) && has("MEDIUM", "aws_s3_bucket.b", /force_destroy/));
  check("실제 AWS plan: provider 기본값 delete_automated_backups는 지적 안 함", !j.findings.some((f) => /delete_automated_backups/.test(f.message)));
  check("실제 AWS plan: 보호 없는 DB 생성 → LOW", has("LOW", "aws_db_instance.db", /삭제 보호 없이/));
}
{
  const r = node("plan-check.mjs", ["-"], JSON.stringify({ format_version: "1.2", resource_changes: [], errored: true }));
  check("errored plan → HIGH", r.status === 2 && /오류로 중단/.test(r.stdout));
  const bad = node("plan-check.mjs", ["-"], "not json");
  check("잘못된 입력 → 종료 코드 1", bad.status === 1);
}

// ---------- guard hook ----------
const D = "deny", A = "ask", N = null;
const cases = [
  // Terraform
  ["terraform plan -out=tfplan", N], ["terraform show -json tfplan", N], ["terraform init -upgrade", N], ["terraform validate && terraform fmt -check", N],
  ["terraform destroy", D], ["terraform destroy -target=aws_s3_bucket.x", D], ["terraform -chdir=infra/prod destroy", D],
  ["terraform apply", D], ["terraform apply -auto-approve", D], ["terraform apply -auto-approve tfplan", D], ["terraform apply -destroy tfplan", D],
  ["terraform apply tfplan", A], ["terraform -chdir=infra apply -input=false tfplan", A], ["terraform apply -var 'env=dev' -auto-approve", D],
  ["terraform plan -destroy -out=d.plan", N], ["terraform state list", N], ["terraform state rm aws_db_instance.main", D], ["terraform state mv a b", A],
  ["terraform force-unlock 1234", D], ["terraform workspace delete prod", D], ["terraform import aws_s3_bucket.x x", A],
  ["tofu destroy", D], ["terragrunt run-all apply", D], ["terragrunt run --all destroy", D], ["terraform.exe destroy", D],
  // 감싼 형태
  ["cd infra && terraform destroy", D], ["TF_LOG=debug terraform destroy", D], ["sudo terraform destroy", D],
  ["bash -c \"terraform apply -auto-approve\"", D], ["sh -c 'cd x; terraform destroy'", D], ["echo $(terraform destroy)", D],
  ["& terraform destroy", D], ["& 'C:\\tools\\terraform.exe' apply -auto-approve", D], ["pwsh -Command \"terraform destroy\"", D],
  ["terraform plan -out=tfplan | tee plan.log", N], ["terraform plan 2>&1 > out.txt", N],
  // 무해한 문자열
  ["git commit -m \"terraform destroy 막기\"", N], ["echo terraform destroy", N], ["grep -r 'kubectl delete ns' docs/", N],
  // kubectl
  ["kubectl get pods -A", N], ["kubectl describe pod x -n app", N], ["kubectl logs deploy/api -f", N], ["kubectl diff -k k8s/overlays/dev", N],
  ["kubectl delete ns staging", D], ["kubectl delete namespace/staging", D], ["kubectl -n app delete pvc data-0", D], ["kubectl delete pods --all -n app", D],
  ["kubectl delete crd widgets.example.com", D], ["kubectl delete pod api-123 -n app", A], ["kubectl delete -f job.yaml", A],
  ["kubectl apply -k k8s/overlays/prod", A], ["kubectl apply -f x.yaml --dry-run=server", N], ["kubectl --context prod scale deploy/api --replicas=0", A],
  ["kubectl rollout status deploy/api", N], ["kubectl rollout restart deploy/api", A], ["kubectl drain node-1 --ignore-daemonsets", A],
  // helm / argocd
  ["helm list -A", N], ["helm upgrade api ./chart -n app", A], ["helm upgrade api ./chart --dry-run", N], ["helm uninstall api -n app", A],
  ["argocd app get api", N], ["argocd app sync api", A], ["argocd app delete api", D],
  // aws
  ["aws sts get-caller-identity", N], ["aws s3 ls s3://bucket", N], ["aws ec2 describe-instances --region ap-northeast-2", N],
  ["aws s3 rb s3://bucket --force", D], ["aws s3 rm s3://bucket/path --recursive", D], ["aws s3 rm s3://bucket/a.txt", A], ["aws s3 sync . s3://b --delete", A],
  ["aws --profile prod rds delete-db-instance --db-instance-identifier main", D], ["aws rds delete-db-snapshot --db-snapshot-identifier s", D],
  ["aws dynamodb delete-table --table-name t", D], ["aws ec2 terminate-instances --instance-ids i-1", D], ["aws kms schedule-key-deletion --key-id k", D],
  ["aws s3api put-bucket-versioning --bucket b --versioning-configuration Status=Suspended", D], ["aws s3api delete-object --bucket b --key k --version-id v", D],
  ["aws ec2 stop-instances --instance-ids i-1", A], ["aws iam attach-role-policy --role-name r --policy-arn p", A], ["aws lambda update-function-code --function-name f", A],
  // gcloud / az / 로컬 state
  ["gcloud sql instances delete main", A], ["gcloud compute instances list", N], ["az group delete -n rg", A],
  ["rm terraform.tfstate", D], ["rm -rf .terraform", N], ["Remove-Item terraform.tfstate.backup", D],
];
// 이 PC의 실제 kube 설정·AWS_PROFILE에 영향받지 않도록 시험용 환경을 준다(현재 context: eks-main, 운영 여부 판단 불가)
const E = { cwd: fx("."), env: { KUBECONFIG: fx("kubeconfig-unknown.yaml") } };
for (const [cmd, want] of cases) {
  const got = evaluate(cmd, E)?.decision ?? null;
  check(`guard: ${cmd} → ${want ?? "통과"}`, got === want, `실제 ${got ?? "통과"}`);
}

// 대상 환경에 따른 판정: 운영이면 묻고, 로컬·개발이면 묻지 않고, 모르면 묻는다. 되돌릴 수 없는 명령은 환경과 상관없이 막는다
const KIND = { cwd: fx("."), env: { KUBECONFIG: fx("kubeconfig-kind.yaml") } };
const envCases = [
  ["kind context에서 kubectl apply → 통과", "kubectl apply -k overlays/dev", KIND, N],
  ["kind context에서 helm upgrade → 통과", "helm upgrade api ./chart", KIND, N],
  ["kind context여도 namespace 삭제 → deny", "kubectl delete ns app", KIND, D],
  ["--context로 운영 지정 → ask", "kubectl --context prod-eks apply -f x.yaml", KIND, A, /운영으로 보입니다.*prod-eks/],
  ["--context dev → 통과", "kubectl --context dev-cluster apply -f x.yaml", E, N],
  ["개발 context라도 namespace가 production이면 → ask", "kubectl --context dev-cluster -n production rollout restart deploy/api", E, A, /namespace "production"/],
  ["판단 불가 context → ask(이유 포함)", "kubectl apply -f x.yaml", E, A, /판단할 수 없습니다.*eks-main/],
  ["helm --kube-context staging → 통과", "helm upgrade api ./chart --kube-context staging", E, N],
  ["aws --profile dev → 통과", "aws --profile dev ec2 stop-instances --instance-ids i-1", E, N],
  ["aws --profile prod → ask", "aws --profile prod ec2 stop-instances --instance-ids i-1", E, A, /profile "prod"/],
  ["AWS_PROFILE=staging 접두사 → 통과", "AWS_PROFILE=staging aws lambda update-function-code --function-name f", E, N],
  ["프로세스 AWS_PROFILE=sandbox → 통과", "aws s3 cp a s3://b/a", { ...E, env: { ...E.env, AWS_PROFILE: "sandbox" } }, N],
  ["PowerShell $env:AWS_PROFILE=prod → ask", "$env:AWS_PROFILE=\"prod\"; aws ec2 stop-instances --instance-ids i-1", E, A, /profile "prod"/],
  ["개발 profile이어도 RDS 삭제 → deny", "aws --profile dev rds delete-db-instance --db-instance-identifier x", E, D],
  ["gcloud --project my-prod → ask", "gcloud run deploy api --project my-prod", E, A, /project "my-prod"/],
  ["gcloud --project my-dev → 통과", "gcloud run deploy api --project my-dev", E, N],
  ["저장된 plan 적용은 개발이어도 ask", "TF_WORKSPACE=dev terraform apply tfplan", E, A],
  ["운영 workspace에서 적용 → 이유에 표시", "TF_WORKSPACE=production terraform apply tfplan", E, A, /workspace "production"/],
  ["cd envs/prod 뒤 적용 → 이유에 디렉터리 표시", "cd envs/prod && terraform apply tfplan", E, A, /디렉터리 ".*envs\/prod"/],
  ["unknownTarget=allow 설정 → 판단 불가여도 통과", "kubectl apply -f x.yaml", { ...E, config: { unknownTarget: "allow" } }, N],
  ["nonProdPatterns에 eks-main 추가 → 통과", "kubectl apply -f x.yaml", { ...E, config: { nonProdPatterns: ["main"] } }, N],
  ["이름을 추가해도 기본 개발 규칙(kind)은 유지", "kubectl apply -f x.yaml", { ...KIND, config: { nonProdPatterns: ["main"] } }, N],
  ["이름을 추가해도 기본 운영 규칙(prod)은 유지", "kubectl --context prod-eks apply -f x.yaml", { ...E, config: { nonProdPatterns: ["main"] } }, A],
  ["prodPatterns에 flowcore 추가 → ask", "kubectl --context arn:aws:eks:ap-northeast-2:1:cluster/flowcore apply -f x.yaml", { ...E, config: { prodPatterns: ["flowcore"] } }, A, /flowcore/],
  ["대소문자 무시", "aws --profile PROD ec2 stop-instances --instance-ids i-1", E, A],
  ["'product' 같은 단어는 운영으로 보지 않음", "aws --profile product-dev ec2 stop-instances --instance-ids i-1", E, N],
];
for (const [name, cmd, opts, want, re] of envCases) {
  const r = evaluate(cmd, opts);
  const got = r?.decision ?? null;
  check(`env: ${name}`, got === want && (!re || re.test(r?.reason ?? "")), `실제 ${got ?? "통과"}${r ? " / " + r.reason : ""}`);
}
{
  const run = (obj) => node("guard-hook.mjs", [], JSON.stringify(obj));
  const r1 = run({ tool_name: "Bash", tool_input: { command: "terraform destroy" } });
  const o1 = JSON.parse(r1.stdout);
  check("hook 출력: deny JSON", o1.hookSpecificOutput?.permissionDecision === "deny" && /infra-guard/.test(o1.hookSpecificOutput.permissionDecisionReason));
  const r2 = run({ tool_name: "PowerShell", tool_input: { command: "terraform apply tfplan" } });
  check("hook 출력: PowerShell도 검사(ask)", JSON.parse(r2.stdout).hookSpecificOutput?.permissionDecision === "ask");
  const r3 = run({ tool_name: "Read", tool_input: { file_path: "x" } });
  check("hook 출력: 다른 도구는 무시", r3.status === 0 && r3.stdout === "");
  const r4 = run({ tool_name: "Bash", tool_input: { command: "terraform plan" } });
  check("hook 출력: 읽기 전용 명령은 출력 없음", r4.status === 0 && r4.stdout === "");
}

// ---------- 정적 점검 ----------
{
  const r = node("tf-static-audit.mjs", [fx("tf"), "--json"]);
  const j = JSON.parse(r.stdout);
  const has = (level, res, re) => j.findings.some((f) => f.level === level && f.resource === res && re.test(f.message));
  check("정적: resource 블록 수", j.resources === 9, `실제 ${j.resources}`);
  check("정적: 변수로 정해진 보호 값은 LOW로 확인 요청", has("LOW", "aws_rds_cluster.from_var", /var\.deletion_protection.*확인/) && !has("MEDIUM", "aws_rds_cluster.from_var", /deletion_protection/));
  check("정적: 보호 없는 RDS", has("MEDIUM", "aws_db_instance.unprotected", /deletion_protection/));
  check("정적: 주석 안의 값 무시", has("MEDIUM", "aws_db_instance.unprotected", /deletion_protection/));
  check("정적: skip_final_snapshot", has("MEDIUM", "aws_db_instance.unprotected", /skip_final_snapshot/));
  check("정적: 보호된 RDS는 지적 없음", !j.findings.some((f) => f.resource === "aws_db_instance.protected"));
  check("정적: force_destroy 버킷", has("MEDIUM", "aws_s3_bucket.assets", /force_destroy/));
  check("정적: 문자열 안의 중괄호를 견딤", has("LOW", "aws_s3_bucket.assets", /versioning/));
  check("정적: 버전 관리 있는 버킷은 지적 없음", !j.findings.some((f) => f.resource === "aws_s3_bucket.logs"));
  check("정적: DynamoDB 삭제 보호·PITR", has("MEDIUM", "aws_dynamodb_table.sessions", /deletion_protection_enabled/) && has("LOW", "aws_dynamodb_table.sessions", /point_in_time/));
  check("정적: KMS 삭제 대기 짧음", has("LOW", "aws_kms_key.data", /deletion_window/));
  check("정적: 상태 없는 리소스는 지적 없음", !j.findings.some((f) => f.resource === "aws_iam_role.app"));
}

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
