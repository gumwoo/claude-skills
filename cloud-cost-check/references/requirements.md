# 요구사항 질문지

`templates/requirements.json`의 각 필드를 어디서 찾고, 없으면 어떻게 묻는지 적었다. 문서에서 찾은 값은 `_sources`에 출처를 남긴다(예: `"availability": "RFP 37쪽 SAR-002"`).

| 필드 | 뜻 | 문서에서 찾을 곳 | 없을 때 |
|---|---|---|---|
| `sector` | `public`이면 공통 인프라·고정 예산 기준을 함께 본다(판정 참고용, 스크립트는 읽지 않음) | 발주처 | 묻는다 |
| `currency`, `fx_rate` | 기준 통화, 다른 통화의 환율(예: `{"USD": 1400}`) | 견적 머리말, 단가표 | 통화가 섞였을 때만 묻는다 |
| `rounding` | 견적의 끝자리 처리 단위(예: 천 원 절사면 1000). 재계산 허용 오차로 쓴다 | 견적 머리말("단위: 천 원") | 기본: 원화 10, 그 밖 0.01 |
| `environments.<이름>.hours_per_month` (이름은 dev·개발, prod·운영처럼 같은 뜻이면 서로 맞춰 읽는다) | 환경별 월 사용 시간(상시 730, 업무시간 약 176) | 운영 계획, 개발 환경 요구 | 비운영 환경이 있으면 묻는다 |
| `environments.<이름>.availability`, `availability` | 가용성 목표(`multi-az`, `single-az`, `99.9` 등) | 비기능 요구사항(가용성·SLA) | 묻는다. 없으면 이중화 판정은 "확인 못 함" |
| `budget_mode` | `fixed`(연간·월 고정 예산) 또는 `metered`(쓴 만큼) | 사업 예산 방식 | 공공이면 대개 fixed — 확인한다 |
| `load.concurrent_users`, `load.users_basis` | 동시 사용자 수와, 그 수가 피크(`peak`, 기본)인지 평상(`normal`)인지 | 성능 요구사항 | 묻는다. "피크 시간대 N명"이면 peak |
| `load.request_interval_s` 또는 `load.think_time_s`, `load.response_time_s` | 사용자 1명이 요청을 보내는 간격 | 업무 시나리오, 기존 시스템 로그 | 묻는다. 모르면 TPS 계산 안 함 |
| `load.tps` | 업무 TPS를 이미 알면 직접 | 기존 시스템 통계 | 선택 |
| `load.assumed_tps` | 산정 문서가 가정한 TPS(검증 대상) | 사이징 근거 표 | 선택 |
| `load.api_per_tx`, `db_reads_per_tx`, `db_writes_per_tx` | 업무 1건당 API·DB 호출 수 | 설계서 | 모르면 1로 두고 가정이라고 쓴다 |
| `load.peak_factor` | 피크 ÷ 평상 배수. 동시 사용자가 피크 값이면 평상을 역산하는 데만 쓴다(피크에 또 곱하지 않음) | 성능 요구사항, 기존 통계 | 묻는다 |
| `load.headroom` | 피크 위에 더 둘 여유 계수(예: 2). 필요 대수, 피크 DB 요청, 네트워크 산정에 곱한다 | 사이징 근거 | 선택(기본 1) |
| `load.unit_rps`, `load.unit_rps_measured` | 인스턴스·컨테이너 1개가 목표 지연 안에서 처리하는 RPS, 부하 테스트 실측 여부 | 부하 테스트 결과 | 없으면 필요 대수를 계산하지 않음 |
| `load.azs` | 나눠 둘 AZ 수 | 설계서 | 가용성 목표에서 정한다 |
| `load.target` | 부하 모델을 댈 컴퓨팅 항목의 이름·주소 정규식(예: `"app\|WAS"`) | — | 항목표를 보고 정한다 |
| `load.response_kb`, `load.request_kb` | 평균 응답·요청 크기 | 설계서, 기존 로그 | 선택(네트워크 산정용) |
| `sizing_factors` | 산정에 쓴 계수(`growth`, `redundancy`, `peak`, `utilization`)와 `applied_to`(`always_on` 또는 `max`). 스크립트는 growth·redundancy만 보고, 나머지는 기록용 | 사이징 근거 표 | 사이징 표가 있으면 거기서 읽는다 |
| `common_infra_exists` | 기관 공통 인프라(방화벽·WAF 등)가 이미 있는지 | 사업 범위 | 공공이면 묻는다 |
| `include_tax`, `include_support` | 견적에 부가세·지원 플랜이 들어가야 하는지 | 견적 조건 | 선택 |
| `commitment` | 약정 계획(`none`, `planned`, `contract`) | 계약 조건 | 선택. 모르면 약정 권고 안 함 |
| `thresholds` | 사용률 판정 기준(기본 CPU 20/70, 메모리 30/80) | 내부 기준 | 기본값 |

## 묻는 법

- 한 번에 묻는다. 문서에서 찾은 값은 다시 묻지 않고 "이렇게 읽었다"고 보여 준다.
- 숫자를 모른다고 하면 범위로 받는다(예: 동시 사용자 300~500). 범위면 양 끝으로 각각 돌려 판정이 바뀌는지 본다.
- 끝내 없는 값은 비워 둔다. 지어내서 채우지 않는다.
