// 시험용 가상 저장소를 임시 폴더에 만든다. 파일 내용을 한곳에서 관리하려고 코드로 만든다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "records-test-"));
  const w = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === "string" ? text : JSON.stringify(text, null, 2)); };
  fs.mkdirSync(path.join(root, ".git"));

  // 트러블슈팅: TS-002는 목록에서 빠져 있다
  w("docs/troubleshooting/_index.md", "# 트러블슈팅\n\n| ID | 제목 |\n|---|---|\n| [TS-001](TS-001-login-loop.md) | 로그인 반복 |\n");
  w("docs/troubleshooting/TS-001-login-loop.md", "# TS-001 · 로그인 반복\n");
  w("docs/troubleshooting/TS-002-cache-stale.md", "# TS-002 · 캐시가 오래된 값을 준다\n");
  // 개선: 템플릿과 목록이 있다
  w("docs/improvements/_TEMPLATE.md", "# IMP-XXX · 제목\n## 측정 결과\n");
  w("docs/improvements/_index.md", "| ID | 제목 |\n|---|---|\n| [IMP-001](IMP-001-search-index.md) | 검색 인덱스 |\n| [IMP-002](IMP-002-bad-numbers.md) | 틀린 숫자 |\n");
  // 결정: MADR식 0001-제목.md
  w("docs/decisions/README.md", "# 결정\n- [0001](0001-use-postgres.md)\n- [0002](0002-queue-redis.md)\n");
  w("docs/decisions/0001-use-postgres.md", "# 1. PostgreSQL을 쓴다\n");
  w("docs/decisions/0002-queue-redis.md", "# 2. 대기열은 Redis\n");
  // 스캔에서 빠져야 하는 곳
  w("node_modules/pkg/docs/TS-999-x.md", "x");

  // 원자료: k6 --summary-export 형식, 일반 JSON, 텍스트 로그
  w("benchmarks/search-before.json", { metrics: { http_req_duration: { values: { avg: 512.3, "p(95)": 849.6, "p(99)": 1902.1 } }, http_reqs: { values: { rate: 118.42 } } } });
  w("benchmarks/search-after.json", { metrics: { http_req_duration: { values: { avg: 120.9, "p(95)": 210.4, "p(99)": 388 } }, http_reqs: { values: { rate: 1380.7 } } } });
  w("benchmarks/oversell-before.json", { config: { seats: 100, threads: 200 }, result: { sold: 137, overSold: 37 } });
  w("benchmarks/oversell-after.json", { config: { seats: 100, threads: 200 }, result: { sold: 100, overSold: 0 } });
  w("benchmarks/batch-before.txt", "run 1\nelapsed: 2.412s\nrows: 50000\n");
  w("benchmarks/batch-after.txt", "run 1\nelapsed: 0.618s\nrows: 50000\n");

  const B = "../../benchmarks";
  w("docs/improvements/IMP-001-search-index.md", `# IMP-001 · 검색에 인덱스를 추가해 p95를 줄였다

- 날짜: 2026-11-02
- 관련: PR #41, 커밋 a1b2c3d
- 원자료: \`benchmarks/search-before.json\` → \`benchmarks/search-after.json\`

## 상황
v2.3.1 배포 뒤 검색 API가 느려졌다는 문의가 IMP-000 이후 처음 들어왔다.

## 측정 결과 (before)
- 조건: k6, 50 VU, 5분, 워밍업 1분 (시험 조건이며 측정값 아님)
| 지표 | 값 |
|------|----|
| p95 | 850ms <!-- src: ${B}/search-before.json :: metrics.http_req_duration.values["p(95)"] --> |

## 재측정 결과 (같은 조건)
| 지표 | before | after | 변화 |
|------|--------|-------|------|
| p95 | 850ms <!-- src: ${B}/search-before.json :: metrics.http_req_duration.values["p(95)"] --> | 210ms <!-- src: ${B}/search-after.json :: metrics.http_req_duration.values["p(95)"] --> | -75% |
| 처리량 | 118.4 req/s <!-- src: ${B}/search-before.json :: metrics.http_reqs.values.rate --> | 1,380.7 req/s <!-- src: ${B}/search-after.json :: metrics.http_reqs.values.rate --> | 11.7배 |
| 초과 판매 | 37건 <!-- src: ${B}/oversell-before.json :: result.overSold --> | 0건 <!-- src: ${B}/oversell-after.json :: result.overSold --> | -100% |
| 배치 시간 | 2,412ms <!-- src: ${B}/batch-before.txt :: /elapsed: (\\d+\\.\\d+)s/ *1000 --> | 618ms <!-- src: ${B}/batch-after.txt :: /elapsed: (\\d+\\.\\d+)s/ *1000 --> | 3.9배 |

목표 p95는 200ms였다(목표치, 측정값 아님).

\`\`\`
코드 블록 안의 숫자 9999는 검사하지 않는다
\`\`\`

## 한계와 다음
캐시는 아직 없다. 다음 목표는 p99 300ms(예상).
`);

  w("docs/improvements/IMP-002-bad-numbers.md", `# IMP-002 · 틀린 숫자가 섞인 문서

## 재측정 결과
| 지표 | before | after | 변화 |
|------|--------|-------|------|
| p95 | 900ms <!-- src: ${B}/search-before.json :: metrics.http_req_duration.values["p(95)"] --> | 210ms <!-- src: ${B}/search-after.json :: metrics.http_req_duration.values["p(95)"] --> | -77% |
| p99 | 1,902ms <!-- src: ${B}/search-before.json :: metrics.http_req_duration.values["p(99.9)"] --> | 388ms <!-- src: ${B}/nope.json :: a.b --> | -80% |
| 처리량 | 118 req/s | 1,381 req/s | +40,000% |
| 초과 판매 | 37건 <!-- src: ${B}/oversell-before.json :: result.overSold --> | 0건 <!-- src: ${B}/oversell-after.json :: result.overSold --> | -90% |
| 평균 | 512ms <!-- src: ${B}/search-before.json :: metrics.http_req_duration.values.avg ~1% --> | 125ms <!-- src: ${B}/search-after.json :: metrics.http_req_duration.values.avg ~5% --> | -76% |

## 결과
에러율은 0.4%로 줄었다.
처리량은 약 2배가 될 것으로 예측한다.
`);
  return root;
}
