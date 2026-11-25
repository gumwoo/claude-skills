#!/usr/bin/env node
// Terraform/OpenTofu plan JSON을 공통 항목표(items.json)로 바꾼다. 인프라에는 접근하지 않는다(읽기 전용).
//
// 사용:
//   node adapt-tf-plan.mjs <plan.json>            terraform show -json 결과
//   node adapt-tf-plan.mjs <tfplan>               저장된 plan 파일. 현재 디렉터리에서 terraform show -json 을 실행한다
//   node adapt-tf-plan.mjs -                      표준 입력
//   옵션: --out <파일>  --env <환경이름>(모든 항목에 강제)  --tool tofu
// 종료 코드: 0 = 성공, 1 = 읽기 실패
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { toItem, link, SUPPORTED_TYPES } from "./aws-map.mjs";

function opt(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function readPlan(src, tool = "terraform") {
  if (src === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  const buf = fs.readFileSync(src);
  // plan 파일은 zip(PK)이다. JSON이 아니면 show -json으로 읽는다
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const r = spawnSync(tool, ["show", "-json", src], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${tool} show -json 실패: ${(r.stderr || r.error?.message || "").trim()}`);
    return JSON.parse(r.stdout);
  }
  return JSON.parse(buf.toString("utf8").replace(/^\uFEFF/, ""));
}

// configuration 블록에서 리소스별로 참조하는 주소를 모은다(모듈 경로를 붙여서)
function collectRefs(mod, prefix, out) {
  for (const r of mod?.resources ?? []) {
    const refs = new Set();
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        if (Array.isArray(x.references)) for (const ref of x.references) if (/^[a-z0-9]+_[a-z0-9_]+\.[\w-]+/.test(ref)) refs.add(prefix + ref.replace(/\.(id|arn|name|latest_version)$/, ""));
        Object.values(x).forEach(walk);
      }
    };
    walk(r.expressions);
    out.set(prefix + r.address, [...refs]);
  }
  for (const [name, call] of Object.entries(mod?.module_calls ?? {})) collectRefs(call.module, `${prefix}module.${name}.`, out);
  return out;
}

const configAddr = (addr) => addr.replace(/\[[^\]]*\]/g, "");

export function planToItems(plan, opts = {}) {
  if (plan.errored) throw new Error("plan이 오류로 끝났습니다(errored=true). 오류를 먼저 고쳐야 합니다.");
  const refs = collectRefs(plan.configuration?.root_module, "", new Map());
  const items = [];
  const skipped = {};
  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode !== "managed") continue;
    const actions = rc.change?.actions ?? [];
    if (actions.length === 1 && actions[0] === "delete") continue; // 사라질 리소스는 비용 대상이 아니다
    if (!SUPPORTED_TYPES.includes(rc.type)) {
      skipped[rc.type] = (skipped[rc.type] ?? 0) + 1;
      continue;
    }
    // configuration의 참조는 모듈 인덱스가 없다(module.db.x). 이 인스턴스의 모듈 주소(module.db[0].x)로 바꿔 끼운다
    const modInst = rc.module_address ?? (rc.address.match(/^(.*)\.[^.[]+\.[^.[]+(\[[^\]]*\])?$/)?.[1] ?? "");
    const modCfg = configAddr(modInst);
    const own = (refs.get(configAddr(rc.address)) ?? []).map((ref) => (modCfg && ref.startsWith(modCfg + ".") ? modInst + ref.slice(modCfg.length) : ref));
    const it = toItem({ address: rc.address, type: rc.type, values: rc.change.after ?? {}, refs: own }, { env: opts.env, pathHint: opts.pathHint });
    if (it) items.push(it);
  }
  return { source: "terraform-plan", items: link(items), unsupported_types: skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const src = args.find((a, i) => !a.startsWith("--") && !["--out", "--env", "--tool"].includes(args[i - 1]));
  if (!src) {
    console.error("사용: node adapt-tf-plan.mjs <plan.json|tfplan|-> [--out items.json] [--env 이름] [--tool tofu]");
    process.exit(1);
  }
  try {
    const plan = readPlan(src, opt(args, "--tool") ?? "terraform");
    const res = planToItems(plan, { env: opt(args, "--env"), pathHint: src === "-" ? "" : src });
    const out = JSON.stringify({ ...res, file: src }, null, 1);
    if (opt(args, "--out")) fs.writeFileSync(opt(args, "--out"), out);
    else console.log(out);
    console.error(`항목 ${res.items.length}개 · 다루지 않는 리소스 종류 ${Object.keys(res.unsupported_types).length}개`);
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
}
