#!/usr/bin/env node
// 공통 항목표(견적·구성)와 요구사항을 받아, 산정 오류·누락·과설계 후보·부족 후보를 사실로 나열한다.
// 판정(줄일지 말지)은 하지 않는다. 스크립트는 "어디에 무엇이 있다/없다/계산이 다르다"만 말한다.
//
// 사용: node check.mjs [--estimate est.json] [--infra infra.json] [--req requirements.json] [--metrics metrics.csv] [--json]
// 종료 코드: 0 = 참고 항목만 있음, 2 = 확인할 항목 있음, 1 = 읽기 실패
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { computeLoad } from "./load-model.mjs";
import { COST_CATEGORIES } from "./aws-map.mjs";
import { decode, parseCsv, toNum } from "./adapt-csv.mjs";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fmt = (n) => (isNum(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100)) : String(n));

export const KIND_LABEL = { error: "계산 불일치", mismatch: "견적·구성 불일치", missing: "누락 후보", over: "과설계 후보", under: "부족 후보", unknown: "정보 부족", info: "참고" };
const ORDER = ["error", "mismatch", "missing", "under", "over", "unknown", "info"];

// 견적 한 행의 금액을 다시 계산한다. 계산할 수 없으면 이유를 돌려준다
export function recompute(it) {
  if (!isNum(it.unit_price) || !isNum(it.qty)) return { value: null, why: "단가나 수량이 없음" };
  const months = isNum(it.months) ? it.months : it.unit === "year" ? 12 : 1;
  if (it.unit === "hour") {
    if (!isNum(it.hours_per_month)) return { value: null, why: "시간 단가인데 월 사용 시간이 없음" };
    return { value: it.unit_price * it.hours_per_month * it.qty * months, formula: `${fmt(it.unit_price)} × ${it.hours_per_month}시간 × ${it.qty} × ${months}개월` };
  }
  if (it.unit === "year") return { value: it.unit_price * it.qty * (months / 12), formula: `${fmt(it.unit_price)}/년 × ${it.qty} × ${months}/12` };
  return { value: it.unit_price * it.qty * months, formula: `${fmt(it.unit_price)} × ${it.qty} × ${months}개월` };
}

// 허용 오차 = 끝자리 처리 단위 × 더한 행 수. 견적이 천 원 단위로 절사하면 requirements.json의 rounding을 1000으로
const tolerance = (currency, rounding, rows = 1) => (isNum(rounding) ? rounding : /KRW|원/i.test(currency ?? "KRW") ? 10 : 0.01) * Math.max(1, rows);

const has = (items, cat) => items.some((i) => i.category === cat);
const qtyOf = (i) => (isNum(i.elastic?.normal) ? i.elastic.normal : isNum(i.qty) ? i.qty : 0);
const OLD_GEN = /^(db\.|cache\.)?(t1|t2|m1|m2|m3|m4|c1|c3|c4|r3|r4|i2|d2|x1|g2|p2)\./;
const HA_WORDS = /이중화|이중|HA\b|multi[\s-]?az|active[\s-]?active|standby|복제|replica/i;
const STATEFUL = new Set(["db", "cache", "search", "queue"]);
const ENV_KO = { prod: "운영", nonprod: "비운영", unknown: "환경 불명" };
// 같은 환경을 가리키는 이름들(요구사항 키와 견적 라벨이 서로 다른 말로 적혀도 맞춘다)
const ENV_GROUPS = [
  ["prod", /^(prod|prd|production|live|운영|상용)$/i],
  ["dev", /^(dev|develop|development|개발)$/i],
  ["stg", /^(stg|stage|staging|스테이징|검증)$/i],
  ["test", /^(test|tst|qa|테스트|품질)$/i],
];
const canonEnv = (label) => {
  const t = String(label ?? "").trim();
  return ENV_GROUPS.find(([, re]) => re.test(t))?.[0] ?? t.toLowerCase();
};
// 가용성 목표 → multi(AZ 여러 개 필요) / single(단일 AZ 허용) / other(목표는 있으나 AZ 요구를 알 수 없음) / null(없음)
export function availabilityClass(v) {
  if (v == null || v === "") return null;
  const t = String(v).toLowerCase();
  if (/single|단일|one[s-]?az/.test(t)) return "single";
  if (/multi|다중|이중화|복수|2개s*(az|가용)|high|ha|active|99.9|99.99/.test(t)) return "multi";
  return "other";
}

export function check({ estimate = null, infra = null, req = {}, metrics = null } = {}) {
  const F = [];
  const add = (check, kind, where, message, data) => F.push({ check, kind, where: where ?? "-", message, ...(data ? { data } : {}) });
  const est = estimate?.items ?? [];
  const inf = infra?.items ?? [];
  const envReq = (label) => {
    if (!label || !req.environments) return null;
    if (req.environments[label]) return req.environments[label];
    const k = Object.keys(req.environments).find((key) => canonEnv(key) === canonEnv(label));
    return k ? req.environments[k] : null;
  };
  const availability = req.availability ?? envReq("prod")?.availability ?? null;
  const avail = availabilityClass(availability);
  const noAvail = avail === null ? "가용성 목표가 요구사항에 없어 판정 못 함" : `가용성 목표(${availability})로는 AZ 요구를 알 수 없어 판정 못 함`;

  // ---------- A. 산식 ----------
  const amountOf = new Map();
  for (const it of est) {
    const r = recompute(it);
    amountOf.set(it.id, isNum(it.amount_stated) ? it.amount_stated : r.value);
    if (r.value == null) {
      if (!isNum(it.amount_stated)) add("A4", "unknown", it.source_ref, `"${it.name}": 금액도 계산 근거도 없음 (${r.why})`);
      else if (r.why === "시간 단가인데 월 사용 시간이 없음") add("A4", "unknown", it.source_ref, `"${it.name}": ${r.why} — 적힌 금액 ${fmt(it.amount_stated)}을 검증할 수 없음`);
      continue;
    }
    if (isNum(it.amount_stated) && Math.abs(r.value - it.amount_stated) > tolerance(it.currency ?? req.currency, req.rounding)) {
      add("A1", "error", it.cells?.amount ?? it.source_ref, `"${it.name}": 적힌 금액 ${fmt(it.amount_stated)} ≠ 다시 계산한 값 ${fmt(r.value)} (${r.formula})`, { stated: it.amount_stated, computed: r.value });
    }
    if (!isNum(it.months) && it.unit !== "year") add("A4", "info", it.source_ref, `"${it.name}": 기간(개월)이 없어 1개월로 계산함`);
  }
  let prevTotal = null;
  for (const t of estimate?.totals ?? []) {
    const covers = t.covers ?? [];
    const parts = covers.map((id) => amountOf.get(id));
    const ok = isNum(t.amount_stated) && covers.length && !parts.some((v) => v == null);
    if (isNum(t.amount_stated) && covers.length && !ok) add("A2", "unknown", t.ref ?? t.label ?? "합계", `"${t.label}": 위 ${covers.length}개 행 중 ${parts.filter((v) => v == null).length}개의 금액을 숫자로 읽지 못해 합계를 검증 못 함("-" 같은 서식이면 0인지 확인)`);
    if (ok) {
      const sum = parts.reduce((a, b) => a + b, 0);
      const tol = tolerance(estimate.currency ?? req.currency, req.rounding, covers.length);
      const cands = [sum];
      if (t.kind !== "subtotal" && isNum(prevTotal)) cands.push(prevTotal + sum);
      if (!cands.some((c) => Math.abs(c - t.amount_stated) <= tol)) {
        add("A2", "error", t.ref ?? t.label ?? "합계", `"${t.label}" ${fmt(t.amount_stated)} ≠ 위 ${covers.length}개 행의 합 ${fmt(sum)}${cands.length > 1 ? ` (직전 합계를 더한 ${fmt(cands[1])}과도 다름)` : ""} (${t.kind === "subtotal" ? "직전 소계 이후" : "직전 합계 이후"} 행을 더했다고 가정)`, { stated: t.amount_stated, computed: sum });
      }
    }
    if (t.kind !== "subtotal" && isNum(t.amount_stated)) prevTotal = t.amount_stated;
  }
  const currencies = [...new Set(est.map((i) => i.currency).filter(Boolean))];
  if (currencies.length > 1) {
    const rates = req.fx_rate ?? {};
    const base = req.currency ?? estimate?.currency;
    const lacking = currencies.filter((c) => c !== base && !isNum(rates[c]));
    if (lacking.length) add("A3", "error", "견적 전체", `통화가 섞여 있음(${currencies.join(", ")}) — ${lacking.join(", ")} 환율 가정이 요구사항에 없음`);
  }
  for (const it of est) {
    const s = it.sizing;
    if (!s || !isNum(s.required) || !isNum(s.capacity_per_unit) || !isNum(s.provided_units) || s.capacity_per_unit <= 0) continue;
    const need = Math.ceil(s.required / s.capacity_per_unit - 1e-9);
    if (s.provided_units < need) add("A5", "under", it.source_ref, `"${it.name}": 산정 근거로는 ${fmt(s.required)} ÷ ${fmt(s.capacity_per_unit)} = ${need} 단위가 필요한데 ${fmt(s.provided_units)} 단위로 적힘`, { need, provided: s.provided_units });
    else if (s.provided_units >= need * 2 && need > 0) add("A5", "over", it.source_ref, `"${it.name}": 필요 ${need} 단위의 ${fmt(s.provided_units / need)}배(${fmt(s.provided_units)})로 잡힘 — 이중화·성장 계수를 여기서 또 곱했는지 확인`, { need, provided: s.provided_units });
  }

  // ---------- B. 누락 ----------
  if (est.length) {
    const core = est.some((i) => ["compute", "db", "cache", "managed"].includes(i.category));
    if (core && !has(est, "traffic")) add("B1", "missing", "견적 전체", "데이터 전송(아웃바운드·AZ 간·NAT 처리) 행이 없음 — 운영 후 청구서에서 차이가 가장 많이 나는 항목");
    if (core && !has(est, "backup")) add("B1", "missing", "견적 전체", "백업·스냅샷 행이 없음");
    const notes = [];
    if (!has(est, "tax") && req.include_tax == null) notes.push("부가세");
    if (!has(est, "support") && req.include_support == null) notes.push("지원 플랜·MSP 운영비");
    if (notes.length) add("B2", "unknown", "견적 전체", `${notes.join(", ")} 포함 여부가 견적과 요구사항 어디에도 없음`);
    if (req.common_infra_exists === true) {
      const sec = est.filter((i) => i.category === "security");
      if (sec.length) add("B3", "over", sec.map((i) => i.source_ref).join(", "), `기관 공통 인프라가 이미 있다고 했는데 시스템 견적에 보안 항목 ${sec.length}개가 있음(${sec.map((i) => i.name).join(", ")}) — 공통 인프라로 쓸 수 있으면 별도 구축 불필요`);
    }
  }

  // ---------- C. 가동 시간 ----------
  for (const it of est) {
    if (it.env_class !== "nonprod" || !["compute", "db", "cache", "managed"].includes(it.category)) continue;
    const hours = it.unit === "hour" ? it.hours_per_month : 730;
    const want = envReq(it.env)?.hours_per_month;
    if (isNum(want) && isNum(hours) && hours > want * 1.05) add("C1", "over", it.source_ref, `"${it.name}"(${it.env}): ${hours}시간/월로 잡힘 — 요구사항은 ${want}시간/월`);
    else if (!isNum(want) && isNum(hours) && hours >= 700) add("C1", "over", it.source_ref, `"${it.name}"(${it.env}): 상시 가동(${it.unit === "hour" ? hours + "시간" : "월 단가"})으로 잡힘 — 업무시간만 쓰면 약 176시간/월. 요구사항에 이 환경의 사용 시간이 없음`);
  }
  if (inf.some((i) => i.env_class === "nonprod" && i.category === "compute") && !inf.some((i) => /schedule/.test(i.type ?? ""))) {
    add("C2", "info", "구성 전체", "비운영 환경 컴퓨팅에 업무시간 외 중지·축소 설정(예: aws_autoscaling_schedule)이 구성에 보이지 않음 — 다른 방식으로 끄고 있는지 확인");
  }

  // ---------- D. 이중화·환경 ----------
  for (const it of inf) {
    if (it.env_class === "nonprod" && STATEFUL.has(it.category) && (it.ha?.multi_az || it.ha?.replica || (it.ha?.replicas ?? 0) > 0)) add("D1", "over", it.source_ref, `${it.id}(${it.env}): 비운영 환경인데 Multi-AZ·복제본이 켜져 있음 — 인스턴스 비용이 대략 2배`);
  }
  for (const it of est) if (it.env_class === "nonprod" && HA_WORDS.test(`${it.name} ${it.spec?.type ?? ""}`)) add("D1", "over", it.source_ref, `"${it.name}"(${it.env}): 비운영 환경 견적에 이중화가 들어 있음`);
  const natByEnv = new Map();
  for (const it of inf.filter((i) => i.category === "nat")) {
    const k = `${it.env_class}:${it.env ?? "?"}`;
    natByEnv.set(k, { env: it.env, cls: it.env_class, n: (natByEnv.get(k)?.n ?? 0) + (isNum(it.qty) ? it.qty : 1), unknown: (natByEnv.get(k)?.unknown ?? false) || it.attrs?.count === "unknown", refs: [...(natByEnv.get(k)?.refs ?? []), it.source_ref] });
  }
  for (const v of natByEnv.values()) {
    if (v.cls === "nonprod" && v.n > 1) add("D1", "over", v.refs.join(", "), `${v.env} 환경 NAT Gateway ${v.n}개 — 비운영은 1개로 충분한 경우가 많음(시간당 요금이 개수만큼)`);
    if (v.cls !== "nonprod" && v.n === 1 && !v.unknown) {
      if (avail === "multi") add("D2", "under", v.refs.join(", "), `${v.env ?? "운영(추정)"} NAT Gateway가 1개 — 가용성 목표(${availability})와 달리 AZ 하나에 묶임. 다른 AZ 트래픽은 AZ 간 전송비도 붙음`);
      else if (avail !== "single") add("D3", "unknown", v.refs.join(", "), `${v.env ?? "환경 불명"} NAT Gateway가 1개 — ${noAvail}`);
    }
  }
  for (const it of inf) {
    if (it.env_class === "nonprod" || it.category !== "db" || it.type === "aws_dynamodb_table" || it.ha?.multi_az || it.ha?.replica) continue;
    if (it.ha && it.ha.multi_az === null) { add("D3", "unknown", it.source_ref, `${it.id}: Multi-AZ 여부가 변수·모르는 count로 정해져 코드만으로는 모름`); continue; }
    if (avail === "multi") add("D2", "under", it.source_ref, `${it.id}: 운영 DB가 단일 AZ — 가용성 목표(${availability})와 맞지 않음`);
    else if (it.env_class === "prod" && avail !== "single") add("D3", "unknown", it.source_ref, `${it.id}: 운영 DB가 단일 AZ — ${noAvail}`);
  }

  // ---------- E. 탄력성 ----------
  for (const it of inf) {
    const e = it.elastic;
    if (it.category === "compute" && e && isNum(e.min) && isNum(e.max) && e.max > 0 && e.min === e.max) add("E1", "under", it.source_ref, `${it.id}: 최소=최대=${e.max} — 자동 확장이 사실상 꺼져 있음(피크에 못 늘고, 한가할 때 못 줄임)`);
  }
  const fixed = new Map();
  for (const it of inf.filter((i) => i.type === "aws_instance" && i.env_class === "prod")) {
    const k = it.spec?.type ?? "?";
    fixed.set(k, [...(fixed.get(k) ?? []), it]);
  }
  for (const [t, list] of fixed) {
    const n = list.reduce((a, i) => a + (isNum(i.qty) ? i.qty : 1), 0);
    if (n >= 2) add("E2", "info", list.map((i) => i.source_ref).join(", "), `운영에 같은 규격(${t}) 단독 인스턴스 ${n}대 — 자동 확장 그룹이 아님. 상태 없는 계층이면 탄력성이 없음`);
  }
  let load = null;
  if (req.load && Object.keys(req.load).length) {
    load = computeLoad(req.load);
    if (load.missing.length) add("G1", "unknown", "요구사항 load", `부하 모델을 계산할 수 없음: ${load.missing.join(" / ")}`);
    for (const n of load.notes) if (/그대로 TPS/.test(n)) add("G2", "over", "요구사항 load", n);
    let target = null;
    try { target = req.load.target ? new RegExp(req.load.target, "i") : null; } catch { add("G1", "unknown", "요구사항 load.target", `load.target이 올바른 정규식이 아님: ${req.load.target}`); }
    const r = load.result;
    if (!target && !req.load.target && isNum(r.units_for_peak)) add("G1", "info", "요구사항 load.target", "load.target이 없어 부하 모델을 구성·견적의 어느 항목에도 대지 않음(E3·E4·E5 생략)");
    if (target && isNum(r.units_for_peak)) {
      const peakNeed = r.units_for_peak_with_az_loss ?? r.units_for_peak;
      const minNeed = Math.max(r.units_for_normal ?? 1, isNum(req.load.azs) ? req.load.azs : 1);
      // 부하 모델은 운영 기준이다. 비운영 환경은 대지 않는다
      // 같은 계층이 여러 그룹(AZ별 ASG 등)으로 나뉘면 합쳐서 비교한다
      const tier = inf.filter((i) => i.category === "compute" && i.env_class !== "nonprod" && target.test(`${i.id} ${i.name}`));
      if (tier.length) {
        const val = (i, f) => (isNum(i.elastic?.[f]) ? i.elastic[f] : i.qty);
        const max = tier.reduce((a, i) => a + val(i, "max"), 0);
        const min = tier.reduce((a, i) => a + val(i, "min"), 0);
        const where = tier.map((i) => i.source_ref).join(", ");
        const name = tier.length > 1 ? `${tier.length}개 그룹 합계` : tier[0].id;
        if (isNum(max) && max < peakNeed) add("E3", "under", where, `${name}: 최대 ${max}대 < 피크 필요 ${peakNeed}대(${r.units_for_peak_with_az_loss ? "AZ 하나 장애 포함, " : ""}${r.design_api_rps ? `설계 피크 ${r.design_api_rps}` : `피크 ${r.peak_api_rps}`} RPS ÷ 대당 ${req.load.unit_rps})`);
        if (isNum(min) && min > minNeed) add("E4", "over", where, `${name}: 최소 ${min}대 > 평상 필요 ${minNeed}대(평상 ${r.api_rps} RPS 기준, AZ당 1대 포함) — 한가할 때도 ${min}대가 돎`);
      }
      const estT = est.filter((i) => i.category === "compute" && i.env_class !== "nonprod" && target.test(`${i.name} ${i.spec?.type ?? ""}`));
      if (estT.length) {
        const q = estT.reduce((a, i) => a + (isNum(i.qty) ? i.qty : 0), 0);
        if (q < r.units_for_peak) add("E5", req.budget_mode === "fixed" ? "under" : "info", estT.map((i) => i.source_ref).join(", "), `견적 ${q}대 < 피크 필요 ${r.units_for_peak}대 — 피크에 늘어나는 구간의 비용이 ${req.budget_mode === "fixed" ? "고정 예산에 없음" : "견적에 없음(종량 청구면 실제 청구가 견적보다 큼)"}`);
      }
    }
  }
  // 견적과 구성이 둘 다 있을 때: 견적 대수가 탄력 범위의 어디에 맞춰졌는지
  // 견적과 구성의 환경 짝: 둘 다 환경을 알면 환경별로, 한쪽이라도 전부 모르면 전체를 한 묶음으로
  const envPairs = (cat) => {
    const a = est.filter((i) => i.category === cat), b = inf.filter((i) => i.category === cat);
    const known = (xs) => xs.some((i) => i.env_class !== "unknown");
    if (!known(a) || !known(b)) return a.length && b.length ? [{ env: "all", a, b, loose: known(a) || known(b) }] : [];
    return ["prod", "nonprod", "unknown"].map((env) => ({ env, a: a.filter((i) => i.env_class === env), b: b.filter((i) => i.env_class === env) })).filter((p) => p.a.length && p.b.length);
  };
  const ENV_LABEL = { ...ENV_KO, all: "전체" };
  let looseNoted = false;
  const noteLoose = (p) => {
    if (p.loose && !looseNoted) { looseNoted = true; add("H4", "info", "견적·구성 전체", "한쪽에만 환경 표시가 있어 환경을 나누지 않고 전체로 대조함 — 구성에 환경 태그를 달거나 --env로 지정하면 환경별로 대조"); }
  };
  if (est.length && inf.length) {
    for (const p of envPairs("compute")) {
      noteLoose(p);
      const env = p.env;
      const infC = p.b, estC = p.a;
      if (!infC.some((i) => i.elastic)) continue;
      const sum = (f) => infC.reduce((a, i) => a + (isNum(i.elastic?.[f]) ? i.elastic[f] : isNum(i.qty) ? i.qty : NaN), 0);
      const q = estC.reduce((a, i) => a + (isNum(i.qty) ? i.qty : NaN), 0);
      const [mn, nm, mx] = [sum("min"), sum("normal"), sum("max")];
      if (!isNum(q) || !isNum(mx)) continue;
      const refs = `${estC.map((i) => i.source_ref).join(", ")} ↔ ${infC.map((i) => i.source_ref).join(", ")}`;
      if (isNum(mn) && q < mn) add("E7", "mismatch", refs, `${ENV_LABEL[env]} 컴퓨팅: 견적 ${q}대 < 구성의 최소 ${mn}대 — 상시 돌아가는 대수만큼도 견적에 없음`);
      else if (q > mx) add("E7", "mismatch", refs, `${ENV_LABEL[env]} 컴퓨팅: 견적 ${q}대 > 구성의 최대 ${mx}대 — 구성으로는 쓸 수 없는 대수까지 견적에 있음`);
      if (mx > q && (q === mn || q === nm)) add("E5", req.budget_mode === "fixed" ? "under" : "info", estC.map((i) => i.source_ref).join(", "), `${ENV_LABEL[env]} 컴퓨팅: 견적 ${q}대 = 구성의 ${q === mn ? "최소" : "평상"}값, 최대는 ${mx}대 — 늘어나는 구간(${mx - q}대)의 비용이 견적에 없음`);
      if (q === mx && mn < mx) add("E6", "info", estC.map((i) => i.source_ref).join(", "), `${ENV_LABEL[env]} 컴퓨팅: 견적 ${q}대 = 구성의 최대값(최소 ${mn}대) — 상한 예산으로는 맞지만, 상시 ${q}대 비용으로 보고하면 과대`);
    }
  }

  // ---------- F. 계수 중복 ----------
  const sf = req.sizing_factors;
  if (sf && ((isNum(sf.growth) && sf.growth > 1) || (isNum(sf.redundancy) && sf.redundancy > 1))) {
    const fs_ = [isNum(sf.growth) && sf.growth > 1 ? `성장률 ×${sf.growth}` : null, isNum(sf.redundancy) && sf.redundancy > 1 ? `이중화 ×${sf.redundancy}` : null].filter(Boolean).join(", ");
    if (sf.applied_to === "always_on") add("F1", "over", "요구사항 sizing_factors", `${fs_}를 상시 가동 용량에 곱함 — 클라우드에서는 성장분은 확장 상한(max)으로 받고, 이중화는 AZ 분산 대수로 따로 셈(온프레미스식 산정의 중복)`);
    else if (!sf.applied_to) add("F1", "unknown", "요구사항 sizing_factors", `${fs_}가 상시 용량과 확장 상한 중 어디에 곱해졌는지 적혀 있지 않음`);
  }

  // ---------- H. 견적 ↔ 구성 대조 ----------
  if (est.length && inf.length) {
    const estCats = new Set(est.map((i) => i.category));
    const byCat = new Map();
    for (const it of inf.filter((i) => COST_CATEGORIES.has(i.category))) byCat.set(it.category, [...(byCat.get(it.category) ?? []), it]);
    for (const [cat, list] of byCat) {
      if (!estCats.has(cat)) add("H1", "missing", list.slice(0, 5).map((i) => i.source_ref).join(", ") + (list.length > 5 ? ` 외 ${list.length - 5}개` : ""), `구성에는 ${cat} ${list.length}개가 있는데 견적에 해당 행이 없음`);
    }
    for (const cat of ["compute", "db", "cache"]) {
      for (const p of envPairs(cat)) {
        noteLoose(p);
        const { a, b } = p;
        const cls = ENV_LABEL[p.env];
        const qa = a.reduce((s, i) => s + (isNum(i.qty) ? i.qty : 0), 0);
        const qb = b.reduce((s, i) => s + qtyOf(i), 0);
        if (qa !== qb && !b.some((i) => i.elastic)) add("H2", "mismatch", `${a[0].source_ref} ↔ ${b[0].source_ref}`, `${cls} ${cat}: 견적 ${qa}개, 구성 ${qb}개`);
        const ta = new Set(a.map((i) => i.spec?.type).filter(Boolean));
        const tb = new Set(b.map((i) => i.spec?.type).filter(Boolean));
        const onlyA = [...ta].filter((t) => !tb.has(t)), onlyB = [...tb].filter((t) => !ta.has(t));
        if (ta.size && tb.size && (onlyA.length || onlyB.length)) add("H3", "mismatch", `${a[0].source_ref} ↔ ${b[0].source_ref}`, `${cls} ${cat} 규격이 다름: 견적에만 ${onlyA.join(", ") || "-"} / 구성에만 ${onlyB.join(", ") || "-"}`);
      }
    }
  }

  // ---------- I. 사용률 ----------
  if (metrics) {
    const th = { cpu_low: 20, cpu_high: 70, mem_low: 30, mem_high: 80, ...Object.fromEntries(Object.entries(req.thresholds ?? {}).filter(([, v]) => isNum(v))) };
    const all = [...inf, ...est];
    for (const m of metrics) {
      const it = all.find((i) => i.id === m.id || i.name === m.id) ?? null;
      const where = it?.source_ref ?? m.id;
      const label = `${m.id}${m.stat ? ` (${m.stat})` : ""}`;
      if (isNum(m.period_days) && m.period_days < 14) add("I1", "info", where, `${label}: 측정 기간 ${m.period_days}일 — 14일 미만이면 주기 변동을 놓칠 수 있음`);
      const cpuHi = isNum(m.cpu_pct) && m.cpu_pct > th.cpu_high, memHi = isNum(m.mem_pct) && m.mem_pct > th.mem_high;
      if (cpuHi || memHi) { add("I1", "under", where, `${label}: 고사용(CPU ${fmt(m.cpu_pct)}%${isNum(m.mem_pct) ? `, 메모리 ${fmt(m.mem_pct)}%` : ""}) — 기준 CPU>${th.cpu_high}% 또는 메모리>${th.mem_high}%`); continue; }
      if (!isNum(m.mem_pct)) { add("I1", "unknown", where, `${label}: CPU ${fmt(m.cpu_pct)}%, 메모리 지표 없음 — 메모리를 모르면 축소 판정 못 함`); continue; }
      if (isNum(m.cpu_pct) && m.cpu_pct < th.cpu_low && m.mem_pct < th.mem_low) add("I1", "over", where, `${label}: 저사용(CPU ${fmt(m.cpu_pct)}% < ${th.cpu_low}%, 메모리 ${fmt(m.mem_pct)}% < ${th.mem_low}%) — 통합·축소 후보`);
    }
  }

  // ---------- J. 구세대·설정 ----------
  for (const it of inf) {
    const gp2 = it.spec?.storage_type === "gp2" || it.attrs?.root_volume_type === "gp2";
    if (gp2) add("J1", "info", it.source_ref, `${it.id}: gp2 볼륨 — gp3는 같은 용량에서 GB당 단가가 더 낮고 기본 IOPS가 3,000(리전 단가로 확인)`);
    if (OLD_GEN.test(it.spec?.type ?? "")) add("J2", "info", it.source_ref, `${it.id}: 구세대 규격 ${it.spec.type} — 같은 성능의 신세대가 대체로 더 쌈`);
    const keep = it.attrs?.retention_in_days;
    if (it.category === "log" && keep === "unknown") add("J3", "unknown", it.source_ref, `${it.id}: 로그 보존 기간이 변수로 정해져 코드만으로는 모름`);
    else if (it.category === "log" && (!isNum(keep) || keep === 0)) add("J3", "info", it.source_ref, `${it.id}: 로그 보존 기간이 없음(무기한 보존) — 매달 저장 비용이 쌓임`);
  }
  if (inf.some((i) => i.category === "nat") && !inf.some((i) => /s3/.test(i.attrs?.service_name ?? "") && i.attrs?.endpoint_type === "Gateway")) {
    add("J4", "info", "구성 전체", "NAT Gateway가 있는데 S3 Gateway Endpoint가 구성에 없음 — S3 트래픽이 NAT 처리비(GB당)를 냄. 실제 양은 VPC Flow Logs로 재야 함");
  }
  if (est.some((i) => i.env_class !== "nonprod" && ["compute", "db"].includes(i.category) && !/commit|약정|\bRI\b|reserved|savings|\bSP\b/i.test(i.pricing ?? "")) && req.commitment == null) {
    add("J5", "unknown", "견적 전체", "운영 컴퓨팅·DB가 정가(약정 없음) 기준으로 보임 — 약정(RI·Savings Plans·약정 할인) 계획 여부가 요구사항에 없음");
  }

  F.sort((a, b) => a.check.localeCompare(b.check) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const counts = Object.fromEntries(ORDER.map((k) => [k, F.filter((f) => f.kind === k).length]));
  return { findings: F, counts, load: load?.result ?? null };
}

export function parseMetrics(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const idx = (n) => h.indexOf(n);
  const pct = (v) => toNum(String(v ?? "").replace(/%\s*$/, ""));
  return rows.slice(1).map((r) => ({
    id: r[idx("id")]?.trim(),
    cpu_pct: pct(r[idx("cpu_pct")]),
    mem_pct: idx("mem_pct") >= 0 ? pct(r[idx("mem_pct")]) : null,
    period_days: idx("period_days") >= 0 ? toNum(r[idx("period_days")]) : null,
    stat: idx("stat") >= 0 ? r[idx("stat")]?.trim() : null,
  }));
}

export function render(res) {
  const lines = [];
  const c = res.counts;
  lines.push(ORDER.filter((k) => c[k]).map((k) => `${KIND_LABEL[k]} ${c[k]}`).join(" · ") || "찾은 항목 없음");
  if (res.load && Object.keys(res.load).length) lines.push("", "부하 모델: " + Object.entries(res.load).map(([k, v]) => `${k}=${v}`).join(", "));
  if (res.findings.length) {
    lines.push("", "| 검사 | 구분 | 위치 | 내용 |", "|---|---|---|---|");
    const cell = (v) => String(v ?? "-").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
    for (const f of res.findings) lines.push(`| ${f.check} | ${KIND_LABEL[f.kind]} | ${cell(f.where)} | ${cell(f.message)} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const readJson = (p) => (p ? JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")) : null);
  try {
    const estimate = readJson(opt("--estimate"));
    const infra = readJson(opt("--infra"));
    if (!estimate && !infra) throw new Error("--estimate 나 --infra 중 하나는 있어야 합니다.");
    const req = readJson(opt("--req")) ?? {};
    const metrics = opt("--metrics") ? parseMetrics(decode(fs.readFileSync(opt("--metrics"))).text) : null;
    const res = check({ estimate, infra, req, metrics });
    console.log(args.includes("--json") ? JSON.stringify(res, null, 1) : render(res));
    process.exit(res.findings.some((f) => f.kind !== "info") ? 2 : 0);
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
}
