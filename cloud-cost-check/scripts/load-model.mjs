#!/usr/bin/env node
// 요구사항의 부하 가정을 숫자로 바꾼다. 정답이 아니라 "가정을 드러낸 출발점"이다.
//   업무 TPS ≒ 동시 사용자 ÷ (응답시간 + Think Time)     (Little's Law를 단순화)
//   동시 사용자는 기본으로 "피크" 값으로 본다(users_basis: "peak"). 평상 = 피크 ÷ peak_factor
//   users_basis가 "normal"이면 반대로 피크 = 평상 × peak_factor. 피크에 또 곱하지 않는다
//   설계 피크 = 피크 × headroom(여유 계수, 기본 1)
//   필요 대수 = 설계 피크 RPS ÷ 대당 처리량(부하 테스트 실측) — AZ 하나가 빠져도 버티려면 × AZ수/(AZ수-1)
//
// 사용: node load-model.mjs <requirements.json> [--json]
// 종료 코드: 0 = 계산함, 2 = 계산에 필요한 값이 빠짐(빠진 값을 알린다), 1 = 읽기 실패
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function computeLoad(load = {}) {
  const missing = [];
  const notes = [];
  const L = load ?? {};
  let txInterval = null;
  if (isNum(L.request_interval_s)) txInterval = L.request_interval_s;
  else if (isNum(L.think_time_s)) txInterval = L.think_time_s + (isNum(L.response_time_s) ? L.response_time_s : 0);
  const basis = L.users_basis === "normal" ? "normal" : "peak";
  let tps = null; // basis 기준 TPS
  if (isNum(L.tps)) { tps = L.tps; notes.push(`업무 TPS를 요구사항에 직접 적힌 값(${basis === "peak" ? "피크" : "평상"})으로 씀`); }
  else if (isNum(L.concurrent_users) && txInterval) tps = L.concurrent_users / txInterval;
  else {
    if (!isNum(L.concurrent_users)) missing.push("load.concurrent_users(동시 사용자) 또는 load.tps");
    if (!txInterval) missing.push("load.request_interval_s(1인당 요청 간격) 또는 load.think_time_s — 동시 사용자 수만으로는 TPS를 알 수 없다");
  }
  if (isNum(L.assumed_tps) && isNum(L.concurrent_users) && L.assumed_tps >= L.concurrent_users * 0.9 && (!txInterval || txInterval > 1.5))
    notes.push(`산정 문서가 동시 사용자(${L.concurrent_users})를 거의 그대로 TPS(${L.assumed_tps})로 쓴 것으로 보임 — 요청 간격이 1초가 아니면 과대 산정`);
  const apiPerTx = isNum(L.api_per_tx) ? L.api_per_tx : (missing.push("load.api_per_tx(업무 1건당 API 호출 수, 모르면 1)"), null);
  const pf = isNum(L.peak_factor) && L.peak_factor >= 1 ? L.peak_factor : (notes.push("load.peak_factor가 없거나 1보다 작아 평상=피크로 계산"), 1);
  const head = isNum(L.headroom) && L.headroom >= 1 ? L.headroom : 1;
  const r = {};
  if (tps != null) {
    const peakTps = basis === "peak" ? tps : tps * pf;
    const normalTps = basis === "peak" ? tps / pf : tps;
    r.users_basis = basis;
    r.tx_per_s = round(peakTps);
    r.normal_tx_per_s = round(normalTps);
    if (apiPerTx != null) {
      r.api_rps = round(normalTps * apiPerTx);
      r.peak_api_rps = round(peakTps * apiPerTx);
      if (head > 1) r.design_api_rps = round(peakTps * apiPerTx * head);
    }
    if (isNum(L.db_reads_per_tx)) r.peak_db_reads_per_s = round(peakTps * L.db_reads_per_tx * head);
    if (isNum(L.db_writes_per_tx)) r.peak_db_writes_per_s = round(peakTps * L.db_writes_per_tx * head);
    const design = r.design_api_rps ?? r.peak_api_rps;
    if (design != null && isNum(L.response_kb)) r.peak_out_mbps = round((design * L.response_kb * 8) / 1000);
    if (design != null && isNum(L.request_kb)) r.peak_in_mbps = round((design * L.request_kb * 8) / 1000);
  }
  const design = r.design_api_rps ?? r.peak_api_rps;
  if (design != null) {
    if (isNum(L.unit_rps) && L.unit_rps > 0) {
      r.units_for_peak = Math.ceil(design / L.unit_rps - 1e-9);
      r.units_for_normal = Math.ceil(r.api_rps / L.unit_rps - 1e-9);
      if (isNum(L.azs) && L.azs > 1) {
        // 고르게 나눠도 가장 많이 든 AZ에는 ceil(n/azs)대가 있다. 그 AZ가 빠져도 피크를 받는 가장 작은 n
        let n = r.units_for_peak;
        while (n - Math.ceil(n / L.azs) < r.units_for_peak) n++;
        r.units_for_peak_with_az_loss = n;
      }
      if (!L.unit_rps_measured) notes.push("load.unit_rps(대당 처리량)가 부하 테스트 실측인지 표시되지 않음(unit_rps_measured) — 추정이면 필요 대수도 추정");
    } else missing.push("load.unit_rps(인스턴스·컨테이너 1개가 목표 지연 안에서 처리하는 RPS, 부하 테스트로 측정)");
  }
  return { result: r, missing, notes };
}

const round = (n) => Math.round(n * 10) / 10;

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  try {
    const req = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const out = computeLoad(req.load);
    if (args.includes("--json")) console.log(JSON.stringify(out, null, 1));
    else {
      for (const [k, v] of Object.entries(out.result)) console.log(`${k}: ${v}`);
      for (const m of out.missing) console.log(`빠짐: ${m}`);
      for (const n of out.notes) console.log(`참고: ${n}`);
    }
    process.exit(out.missing.length ? 2 : 0);
  } catch (e) {
    console.error(`읽기 실패: ${e.message}`);
    process.exit(1);
  }
}
