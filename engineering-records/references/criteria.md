# 언제 쓰는가

기본값은 "쓰지 않음"이다. 아래 기준 중 하나에 걸릴 때만 후보로 올린다.
프로젝트마다 기준 숫자가 다르니 `.records.json`의 `triggers`로 바꿀 수 있다(아래 예시).

## 트러블슈팅 (원인을 추적한 기록)

쓰는 경우:

- 사용자에게 보이는 장애나 품질 저하가 있었다(오류율, 지연이 기준을 넘음)
- 데이터가 잘못 저장되거나 유실됐다(초과 판매, 중복 결제, 정합성 깨짐). 규모와 상관없이 쓴다
- 사람이 개입해 되돌렸다(롤백, 트래픽 우회, 수동 데이터 수정)
- 원인을 찾는 데 오래 걸렸다(기준 시간 이상, 또는 가설을 두 개 이상 버렸다)
- 같은 증상이 다시 났다(재발)

쓰지 않는 경우:

- 설정 누락, 오타, 문법 오류, 의존성 버전 맞추기처럼 검색 몇 분이면 풀리는 것. PR 설명으로 충분하다
- 원인을 확인하지 못했고 재현도 안 되는 것. 대신 "관찰 기록"으로 이슈에 남긴다

근거: Google SRE의 포스트모템 기준(사용자에게 보이는 장애, 데이터 유실, 당직자 개입, 해결 시간)과,
"검색 3분이면 푸는 설정 누락은 트러블슈팅이 아니다"라는 국내 채용 쪽 관점.

## 개선 (전후를 측정한 기록)

쓰는 경우:

- 같은 조건에서 전후를 측정했고, 지표가 의미 있게 바뀌었다(기준: 기본 10% 이상, 또는 정합성 지표가 0이 됨)
- 바꾼 이유가 측정으로 드러났다(병목을 측정으로 찾음)

쓰지 않는 경우:

- 전후 측정이 없다. 측정부터 하자고 제안한다
- 조건이 달라 비교할 수 없다(데이터량, 동시성, 환경이 다름). 비교할 수 있게 다시 측정하자고 제안한다
- 변화가 측정 오차 안이다

## 결정 (설계 선택의 기록)

쓰는 경우(엔지니어가 코드를 쓰는 방식이나 시스템 구조에 영향을 주는 결정):

- 구조: 패턴, 모듈 경계, 동기/비동기, 캐시 위치
- 비기능 요구: 일관성·가용성 트레이드오프, 보안 방식, 장애 허용
- 의존성: 새 라이브러리·DB·메시지 브로커 도입, 교체
- 인터페이스: 외부 API 계약, 이벤트 스키마
- 만드는 방식: 테스트 전략, 마이그레이션 방식, 배포 방식
- 되돌리기 어렵거나 여러 곳에 영향을 준다

쓰지 않는 경우:

- 이미 있는 결정을 따른 구현
- 지역 변수 이름, 한 함수 안의 구현처럼 영향 범위가 작은 선택

확정된 결정은 고치지 않는다. 바뀌면 새 결정을 쓰고 예전 것을 "대체됨"으로 표시한다.

근거: Spotify("엔지니어가 소프트웨어를 쓰는 방식에 영향을 주는 중요한 결정이면 쓴다"),
AWS Prescriptive Guidance의 ADR 범위(구조, 비기능 요구, 의존성, 인터페이스, 만드는 방식)와 "승인된 ADR은 바꾸지 않고 새 ADR로 대체한다".

## 기준 바꾸기

저장소 루트의 `.records.json`:

```json
{
  "types": {
    "TS": { "dir": "docs/troubleshooting", "kind": "troubleshooting" },
    "IMP": { "dir": "docs/improvements", "kind": "improvement" },
    "ADR": { "dir": "docs/decisions", "kind": "decision" }
  },
  "triggers": {
    "improvement_min_change_pct": 10,
    "troubleshooting_min_hours": 2,
    "user_visible_error_rate_pct": 1
  }
}
```

- `types`: 스캐너가 찾은 폴더의 이름이나 종류를 바꿀 때(폴더 경로 `dir` 또는 접두어 `prefix`로 맞춘다), 그리고 아직 문서가 하나도 없는 종류를 미리 정할 때 쓴다. 문서가 없는 종류는 `TS-001`부터 번호를 매긴다(자릿수는 `width`, 기본 3).
- `triggers`: 판정할 때 이 문서의 기본 숫자 대신 쓴다.

## 출처

- Google SRE Book, Postmortem Culture: https://sre.google/sre-book/postmortem-culture/
- Spotify Engineering, When Should I Write an ADR: https://engineering.atspotify.com/2020/04/when-should-i-write-an-architecture-decision-record
- AWS Prescriptive Guidance, ADR process: https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html
- 그릿, 개발자 트러블슈팅 작성법: https://teamgrit.co/article/571
