#!/usr/bin/env node
// PreToolUse hook: Bash/PowerShell 명령 중 인프라를 바꾸거나 지우는 것을 막거나(deny) 사람 확인(ask)으로 돌린다.
//
// 판정 원칙
//   deny : 되돌릴 수 없는 명령(destroy, -auto-approve, plan 없는 apply, 백업·스냅샷·버킷 삭제 등). 대상 환경과 상관없이 항상.
//   ask  : 검토 절차의 승인 지점(저장된 plan 적용, state 변경)은 항상.
//          그 밖의 변경 명령(kubectl apply, helm upgrade, aws 변경 등)은 대상이 운영으로 보이거나 판단할 수 없을 때만.
//          대상이 로컬·개발 환경으로 확인되면 묻지 않는다(확인 창이 잦으면 읽지 않고 누르게 된다).
//   대상 판단: kube context·namespace, aws/gcloud/az profile·project, Terraform workspace·디렉터리·var-file 이름.
//
// 설정(선택): 이 스크립트 옆 infra-guard.json
//   { "mode": "enforce" | "observe" | "off",
//     "prodPatterns": [...], "nonProdPatterns": [...], "unknownTarget": "ask" | "allow" }
//   prodPatterns·nonProdPatterns는 기본 목록에 더해진다(바꾸지 않는다). 두 쪽에 다 걸리면 운영으로 본다.
//
// 한계: 명령 문자열만 본다. 스크립트 파일 안의 명령, 변수로 조립한 명령, eval은 보지 못한다.
// 에이전트의 실수를 막는 장치이지 보안 경계가 아니다. 최종 방어선은 클라우드 권한(IAM 등)이다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = {
  mode: "enforce",
  prodPatterns: ["prod", "production", "prd", "live"],
  nonProdPatterns: ["dev", "develop", "development", "local", "test", "testing", "qa", "stage", "staging", "stg", "sandbox", "sbx",
    "kind", "minikube", "docker-desktop", "docker-for-desktop", "k3d", "rancher-desktop", "colima", "orbstack"],
  unknownTarget: "ask",
};

// ---------- 셸 명령 쪼개기 ----------
function tokenize(s) {
  const segs = [[]];
  let cur = null;
  const push = () => { if (cur !== null) { segs[segs.length - 1].push(cur); cur = null; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { const j = s.indexOf("'", i + 1); const end = j < 0 ? s.length : j; cur = (cur ?? "") + s.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      let j = i + 1, buf = "";
      while (j < s.length && s[j] !== '"') { if (s[j] === "\\" && j + 1 < s.length) { buf += s[j + 1]; j += 2; } else buf += s[j++]; }
      cur = (cur ?? "") + buf; i = j; continue;
    }
    if (c === "\\" && i + 1 < s.length && s[i + 1] !== "\n") { cur = (cur ?? "") + s[i + 1]; i++; continue; }
    if (/\s/.test(c) && c !== "\n") { push(); continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      push();
      // "&" 단독(PowerShell 호출 연산자)은 명령 맨 앞에서만 의미가 있다: 세그먼트가 비어 있으면 무시
      if (c === "&" && s[i + 1] !== "&" && segs[segs.length - 1].length === 0) continue;
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
      segs.push([]);
      continue;
    }
    if (c === ">" || c === "<") { // 리다이렉션 대상은 버린다
      push();
      let j = i + 1; if (s[j] === ">" || s[j] === "&") j++; while (j < s.length && /\s/.test(s[j]) && s[j] !== "\n") j++;
      while (j < s.length && !/[\s;|&]/.test(s[j])) j++; i = j - 1; continue;
    }
    cur = (cur ?? "") + c;
  }
  push();
  return segs.filter((t) => t.length);
}

const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "builtin", "call", "&", ".", "xargs", "watch", "timeout"]);
const baseName = (p) => path.basename(String(p)).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

function expandSegments(command, depth = 0) {
  const out = [];
  // $( ... ) 와 `...` 안의 명령도 검사한다
  for (const m of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) if (depth < 3) out.push(...expandSegments(m[1] ?? m[2], depth + 1));
  for (let toks of tokenize(command)) {
    const env = {};
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || WRAPPERS.has(baseName(toks[0])))) {
      const eq = toks[0].indexOf("=");
      if (eq > 0 && /^[A-Za-z_]/.test(toks[0])) env[toks[0].slice(0, eq)] = toks[0].slice(eq + 1);
      const w = baseName(toks[0]);
      toks = toks.slice(1);
      if (w === "timeout" && toks.length && /^\d/.test(toks[0])) toks = toks.slice(1);
      while (toks.length && toks[0].startsWith("-") && (w === "sudo" || w === "env" || w === "xargs")) toks = toks.slice(1);
    }
    if (!toks.length) continue;
    const prog = baseName(toks[0]);
    if (depth < 3 && ["bash", "sh", "zsh", "dash"].includes(prog)) {
      const k = toks.findIndex((t) => t === "-c" || /^-[a-z]*c$/.test(t));
      if (k >= 0 && toks[k + 1] !== undefined) { out.push(...expandSegments(toks[k + 1], depth + 1)); continue; }
    }
    if (depth < 3 && ["pwsh", "powershell"].includes(prog)) {
      const k = toks.findIndex((t) => /^-(c|command)$/i.test(t));
      if (k >= 0) { out.push(...expandSegments(toks.slice(k + 1).join(" "), depth + 1)); continue; }
    }
    if (depth < 3 && prog === "cmd") {
      const k = toks.findIndex((t) => /^\/[ck]$/i.test(t));
      if (k >= 0) { out.push(...expandSegments(toks.slice(k + 1).join(" "), depth + 1)); continue; }
    }
    // PowerShell: $env:AWS_PROFILE="x"; aws ...  같은 할당은 다음 세그먼트에 쓰이도록 남긴다
    out.push({ prog, args: toks.slice(1), env, raw: toks });
  }
  return out;
}

// ---------- 공통 도구 ----------
function positional(args, valueFlags) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) { if (!a.includes("=") && valueFlags.has(a.replace(/^-+/, ""))) i++; continue; }
    pos.push(a);
  }
  return pos;
}
const hasFlag = (args, ...names) => args.some((a) => names.some((n) => a === n || a.startsWith(n + "=")));
const flagTrue = (args, name) => args.some((a) => a === name || a === name + "=true");
function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}
const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// 대상 이름들(context, profile, workspace ...)을 보고 운영/비운영/판단 불가로 나눈다
function classify(labels, cfg) {
  const named = labels.filter((l) => l.value);
  for (const l of named) {
    const hit = words(l.value).find((w) => cfg.prodPatterns.includes(w));
    if (hit) return { cls: "prod", why: `${l.kind} "${l.value}"` };
  }
  for (const l of named) {
    if (l.decides === false) continue;
    const hit = words(l.value).find((w) => cfg.nonProdPatterns.includes(w));
    if (hit) return { cls: "nonprod", why: `${l.kind} "${l.value}"` };
  }
  const first = named.find((l) => l.decides !== false);
  return { cls: "unknown", why: first ? `${first.kind} "${first.value}"` : "대상 정보 없음" };
}

function currentKubeContext(segEnv, ctx) {
  const kc = segEnv.KUBECONFIG ?? ctx.env.KUBECONFIG;
  const file = kc ? kc.split(process.platform === "win32" ? ";" : ":")[0] : path.join(ctx.env.HOME || ctx.env.USERPROFILE || os.homedir(), ".kube", "config");
  try {
    const m = fs.readFileSync(file, "utf8").match(/^current-context:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
    return m?.[1];
  } catch { return undefined; }
}

function terraformWorkspace(segEnv, ctx, dir) {
  const ws = segEnv.TF_WORKSPACE ?? ctx.env.TF_WORKSPACE;
  if (ws) return ws;
  try { return fs.readFileSync(path.join(dir, ".terraform", "environment"), "utf8").trim() || "default"; } catch { return "default"; }
}
const lastSegments = (p, n = 3) => p.replace(/\\/g, "/").split("/").filter(Boolean).slice(-n).join("/");

// ---------- 판정 ----------
const deny = (reason) => ({ decision: "deny", reason });
const always = (reason) => ({ decision: "ask", reason });
const gated = (reason, labels) => ({ decision: "ask", reason, gate: labels });
const HOW_TO_APPLY = "적용하려면: terraform plan -out=tfplan 로 plan을 저장하고, infra-change-guard skill의 plan-check로 검토해 사람에게 보인 뒤, 사람이 승인하면 terraform apply tfplan 을 실행한다(확인 창이 뜬다).";

function checkTerraform(seg, ctx) {
  const { prog, args } = seg;
  let rest = args;
  if (prog === "terragrunt") {
    const p = positional(rest, new Set());
    if (p[0] === "run-all" || p[0] === "run") rest = rest.slice(rest.indexOf(p[0]) + 1).filter((a) => a !== "--all" && a !== "--");
  }
  const tfValue = new Set(["chdir", "var", "var-file", "target", "replace", "lock-timeout", "parallelism", "state", "state-out", "backup", "out", "generate-config-out"]);
  const pos = positional(rest, tfValue);
  const sub = pos[0];
  if (!sub) return null;
  const subArgs = rest.slice(rest.indexOf(sub) + 1);
  const subPos = positional(subArgs, tfValue);
  const chdir = flagValue(rest, "-chdir");
  const dir = chdir ? path.resolve(ctx.cwd, chdir) : ctx.cwd;
  const ws = terraformWorkspace(seg.env, ctx, dir);
  const target = classify([
    { kind: "workspace", value: ws === "default" ? undefined : ws },
    { kind: "디렉터리", value: lastSegments(dir) },
    { kind: "var-file", value: flagValue(subArgs, "-var-file") },
  ], ctx.cfg);
  const where = target.cls === "prod" ? ` 대상이 운영으로 보입니다(${target.why}).` : "";

  if (sub === "destroy") return deny(`${prog} destroy는 에이전트가 실행하지 않는다. 삭제가 필요하면 사람에게 plan -destroy 결과를 보이고 사람이 직접 실행하게 한다.`);
  if (sub === "apply") {
    if (flagTrue(subArgs, "-destroy")) return deny(`${prog} apply -destroy는 destroy와 같다. 사람이 직접 실행한다.`);
    if (flagTrue(subArgs, "-auto-approve")) return deny(`-auto-approve로 적용하지 않는다. ${HOW_TO_APPLY}`);
    if (!subPos.length) return deny(`저장된 plan 없이 apply하지 않는다(검토하지 않은 변경이 적용될 수 있다). ${HOW_TO_APPLY}`);
    return always(`저장된 plan(${subPos[0]})을 적용합니다.${where} plan-check 결과와 대상 환경을 사람이 확인했는지 확인하세요.`);
  }
  if (sub === "state") {
    const op = subPos[0];
    if (["rm", "push", "replace-provider"].includes(op)) return deny(`${prog} state ${op}는 state를 직접 바꿔 되돌리기 어렵다. 사람이 직접 실행한다.`);
    if (op === "mv") return always(`${prog} state mv로 state 주소를 옮깁니다.${where} 리팩터링 목적인지 확인하세요(가능하면 moved 블록을 쓴다).`);
    return null;
  }
  if (sub === "force-unlock") return deny(`${prog} force-unlock은 다른 사람의 작업 중인 lock을 깰 수 있다. 사람이 상황을 확인하고 직접 실행한다.`);
  if (sub === "workspace" && subPos[0] === "delete") return deny(`${prog} workspace delete는 사람이 직접 실행한다.`);
  if (["import", "taint", "untaint"].includes(sub)) return always(`${prog} ${sub}는 state를 바꿉니다.${where}`);
  return null;
}

const KUBE_VALUE = new Set(["n", "namespace", "context", "cluster", "user", "kubeconfig", "s", "server", "token", "as", "l", "selector", "o", "output", "f", "filename", "k", "kustomize", "c", "container", "field-selector", "grace-period", "timeout", "replicas", "type", "image", "port", "p", "patch"]);
const KUBE_PROTECTED = /^(namespaces?|ns|pv|persistentvolumes?|pvc|persistentvolumeclaims?|crds?|customresourcedefinitions?(\.apiextensions\.k8s\.io)?|nodes?|no)$/i;
const KUBE_MUTATING = new Set(["apply", "create", "replace", "patch", "edit", "scale", "autoscale", "drain", "cordon", "uncordon", "taint", "label", "annotate", "set", "expose", "run", "exec", "cp"]);

function kubeLabels(seg, ctx, contextFlags) {
  const context = flagValue(seg.args, ...contextFlags) ?? currentKubeContext(seg.env, ctx);
  return [
    { kind: "context", value: context ?? undefined },
    { kind: "namespace", value: flagValue(seg.args, "-n", "--namespace"), decides: false },
  ];
}

function checkKubectl(seg, ctx) {
  const { args } = seg;
  const pos = positional(args, KUBE_VALUE);
  const verb = pos[0];
  if (!verb) return null;
  const vArgs = args.slice(args.indexOf(verb) + 1);
  if (vArgs.some((a) => /^--dry-run(=(client|server))?$/.test(a))) return null;
  const labels = kubeLabels(seg, ctx, ["--context"]);
  if (verb === "delete") {
    if (hasFlag(vArgs, "--all", "-A", "--all-namespaces")) return deny("kubectl delete --all / -A는 범위가 너무 넓다. 사람이 직접 실행한다.");
    const targets = positional(vArgs, KUBE_VALUE);
    const kinds = targets.flatMap((t) => t.split("/")[0].split(","));
    if (kinds.some((k) => KUBE_PROTECTED.test(k))) return deny(`kubectl delete ${targets.join(" ")}: namespace·PV·PVC·CRD·node 삭제는 데이터나 하위 리소스를 함께 지운다. 사람이 직접 실행한다.`);
    return gated(`kubectl delete ${targets.join(" ") || "(파일 지정)"}를 실행합니다.`, labels);
  }
  if (verb === "rollout") {
    const op = positional(vArgs, KUBE_VALUE)[0];
    if (["status", "history"].includes(op)) return null;
    return gated(`kubectl rollout ${op ?? ""}로 실행 중인 워크로드를 바꿉니다.`, labels);
  }
  if (KUBE_MUTATING.has(verb)) return gated(`kubectl ${verb}로 클러스터를 바꿉니다(먼저 kubectl diff 또는 --dry-run=server 권장).`, labels);
  return null;
}

function checkHelm(seg, ctx) {
  const { args } = seg;
  const pos = positional(args, new Set(["n", "namespace", "kube-context", "kubeconfig", "f", "values", "set", "version", "timeout", "repo"]));
  const verb = pos[0];
  if (!verb || args.some((a) => a.startsWith("--dry-run"))) return null;
  const labels = kubeLabels(seg, ctx, ["--kube-context"]);
  if (["uninstall", "delete", "del", "un"].includes(verb)) return gated(`helm ${verb} ${pos[1] ?? ""}로 릴리스를 지웁니다. 남는 PVC·CRD를 확인하세요.`, labels);
  if (["install", "upgrade", "rollback"].includes(verb)) return gated(`helm ${verb}로 클러스터를 바꿉니다(먼저 helm diff 또는 --dry-run 권장).`, labels);
  return null;
}

function checkArgocd(seg) {
  const pos = positional(seg.args, new Set(["server", "auth-token", "grpc-web-root-path", "project", "revision"]));
  if (pos[0] !== "app") return null;
  if (pos[1] === "delete") return deny("argocd app delete는 관리하던 리소스를 함께 지울 수 있다(cascade). 사람이 직접 실행한다.");
  if (["sync", "rollback", "set", "patch", "terminate-op"].includes(pos[1])) return gated(`argocd app ${pos[1]}로 클러스터 상태를 바꿉니다.`, [{ kind: "app", value: pos[2] }, { kind: "server", value: flagValue(seg.args, "--server") }]);
  return null;
}

const AWS_DENY = {
  s3: ["rb"], s3api: ["delete-bucket", "delete-bucket-replication", "delete-bucket-lifecycle"],
  rds: ["delete-db-instance", "delete-db-cluster", "delete-db-snapshot", "delete-db-cluster-snapshot", "delete-global-cluster", "delete-db-instance-automated-backup"],
  dynamodb: ["delete-table", "delete-backup"], backup: ["delete-backup-vault", "delete-recovery-point", "delete-backup-plan"],
  ec2: ["terminate-instances", "delete-volume", "delete-snapshot"], eks: ["delete-cluster", "delete-nodegroup"],
  kms: ["schedule-key-deletion", "disable-key"], efs: ["delete-file-system"], elasticache: ["delete-replication-group", "delete-cache-cluster", "delete-serverless-cache"],
  secretsmanager: ["delete-secret"], route53: ["delete-hosted-zone"], ecr: ["delete-repository"], logs: ["delete-log-group"],
  cloudformation: ["delete-stack"], redshift: ["delete-cluster"], opensearch: ["delete-domain"], es: ["delete-elasticsearch-domain"],
};
const AWS_ASK_OP = /^(delete|terminate|remove|deregister|detach|disable|stop|revoke|cancel|purge|reset|restore|reboot|modify|update|put|attach|create|run|start|associate|disassociate|authorize|import|copy|tag|untag)-/;

function checkAws(seg, ctx) {
  const { args } = seg;
  const pos = positional(args, new Set(["profile", "region", "output", "endpoint-url", "query", "cli-input-json", "color"]));
  const [svc, op] = pos;
  if (!svc || !op) return null;
  const labels = [{ kind: "profile", value: flagValue(args, "--profile") ?? seg.env.AWS_PROFILE ?? ctx.env.AWS_PROFILE }];
  if (svc === "s3") {
    if (op === "rb") return deny("aws s3 rb는 버킷을 지운다. 사람이 직접 실행한다.");
    if (op === "rm" && hasFlag(args, "--recursive")) return deny("aws s3 rm --recursive는 객체를 대량으로 지운다. 사람이 직접 실행한다.");
    if (op === "rm" || (op === "sync" && hasFlag(args, "--delete")) || op === "mv") return gated(`aws s3 ${op}로 객체를 지우거나 옮깁니다.`, labels);
    if (op === "cp" || op === "sync") return gated(`aws s3 ${op}로 객체를 덮어쓸 수 있습니다.`, labels);
    return null;
  }
  if (svc === "s3api" && op === "put-bucket-versioning" && args.some((a) => /Suspended/.test(a))) return deny("S3 버전 관리를 끄면 이전 버전으로 복구할 수 없다. 사람이 직접 실행한다.");
  if (svc === "s3api" && op === "delete-object" && hasFlag(args, "--version-id")) return deny("특정 버전 삭제는 복구 수단을 지운다. 사람이 직접 실행한다.");
  if (AWS_DENY[svc]?.includes(op)) return deny(`aws ${svc} ${op}는 데이터나 백업을 지워 되돌리기 어렵다. 사람이 직접 실행한다.`);
  if (AWS_ASK_OP.test(op)) return gated(`aws ${svc} ${op}로 클라우드 리소스를 바꿉니다.`, labels);
  return null;
}

function checkGcloudAz(seg) {
  const { prog, args } = seg;
  const pos = positional(args, new Set(["project", "region", "zone", "subscription", "resource-group", "g", "format"]));
  const verbs = ["delete", "remove", "purge", "stop", "reset", "update", "create", "deploy", "set", "apply"];
  const v = pos.find((p) => verbs.includes(p));
  if (!v) return null;
  const labels = [
    { kind: prog === "gcloud" ? "project" : "subscription", value: flagValue(args, "--project", "--subscription") },
    { kind: "resource group", value: flagValue(args, "--resource-group", "-g") },
  ];
  return gated(`${prog} ... ${v}로 클라우드 리소스를 ${v === "delete" || v === "purge" ? "지웁" : "바꿉"}니다.`, labels);
}

function checkLocalState({ prog, args }) {
  if (!["rm", "del", "erase", "remove-item", "ri", "rd", "rmdir"].includes(prog)) return null;
  if (args.some((a) => /\.tfstate(\.backup)?$|terraform\.tfstate\.d/i.test(a))) return deny("Terraform state 파일을 지우면 실제 인프라와의 연결을 잃는다. 사람이 직접 처리한다.");
  return null;
}

function judge(seg, ctx) {
  const { prog } = seg;
  let r = null;
  if (["terraform", "tofu", "terragrunt"].includes(prog)) r = checkTerraform(seg, ctx);
  else if (prog === "kubectl" || prog === "oc") r = checkKubectl(seg, ctx);
  else if (prog === "helm") r = checkHelm(seg, ctx);
  else if (prog === "argocd") r = checkArgocd(seg, ctx);
  else if (prog === "aws") r = checkAws(seg, ctx);
  else if (prog === "gcloud" || prog === "az") r = checkGcloudAz(seg, ctx);
  else r = checkLocalState(seg);
  if (!r || !r.gate) return r;
  // 대상 환경에 따라 묻거나 통과시킨다
  const t = classify(r.gate, ctx.cfg);
  if (t.cls === "prod") return { decision: "ask", reason: `${r.reason} 대상이 운영으로 보입니다(${t.why}).` };
  if (t.cls === "nonprod") return null;
  if (ctx.cfg.unknownTarget === "allow") return null;
  return { decision: "ask", reason: `${r.reason} 대상이 운영인지 판단할 수 없습니다(${t.why}). 개발 환경이면 infra-guard.json의 nonProdPatterns에 이름을 추가하세요.` };
}

/** command 문자열을 판정한다. opts: { cwd, env, config } */
export function evaluate(command, opts = {}) {
  const user = opts.config ?? {};
  // 이름 규칙은 기본 목록에 더한다(설정에 적은 단어 때문에 기본 규칙이 사라지지 않게)
  const cfg = {
    ...DEFAULTS, ...user,
    prodPatterns: [...DEFAULTS.prodPatterns, ...(user.prodPatterns ?? [])].map((w) => String(w).toLowerCase()),
    nonProdPatterns: [...DEFAULTS.nonProdPatterns, ...(user.nonProdPatterns ?? [])].map((w) => String(w).toLowerCase()),
  };
  const ctx = { cwd: opts.cwd ?? process.cwd(), env: opts.env ?? process.env, cfg };
  const results = [];
  for (const seg of expandSegments(String(command ?? ""))) {
    // cd / Set-Location 은 이어지는 명령의 디렉터리를 바꾼다
    if (["cd", "set-location", "sl", "pushd", "chdir"].includes(seg.prog)) {
      const to = seg.args.find((a) => !a.startsWith("-"));
      if (to) ctx.cwd = path.resolve(ctx.cwd, to);
      continue;
    }
    // PowerShell $env:NAME="value" 할당
    const ps = seg.raw.join(" ").match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)/i);
    if (ps) { ctx.env = { ...ctx.env, [ps[1]]: ps[2] }; continue; }
    const r = judge(seg, ctx);
    if (r) results.push(r);
  }
  return results.find((r) => r.decision === "deny") ?? results.find((r) => r.decision === "ask") ?? null;
}

// ---------- hook 진입점 ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
  if (!["Bash", "PowerShell"].includes(input.tool_name)) process.exit(0);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "infra-guard.json"), "utf8")); } catch { /* 기본값 */ }
  const mode = config.mode ?? DEFAULTS.mode;
  if (mode === "off") process.exit(0);
  const command = input.tool_input?.command;
  const result = evaluate(command, { cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), env: process.env, config });
  if (!result) process.exit(0);
  const reason = `[infra-guard] ${result.reason}`;
  if (mode === "observe") {
    try {
      const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.appendFileSync(path.join(root, ".claude", "infra-guard.log"), `${new Date().toISOString()}\t${result.decision}\t${String(command).replace(/\s+/g, " ").slice(0, 300)}\t${result.reason}\n`);
    } catch { /* 기록 실패는 무시 */ }
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: reason } }));
  process.exit(0);
}
