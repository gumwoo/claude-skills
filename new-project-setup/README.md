# new-project-setup

새 저장소(또는 아직 Claude 설정이 없는 저장소)에 Claude Code 작업 기반을 설치하는 skill입니다.

```
/new-project-setup            # 저장소를 보고 설치 방식을 묻는다
/new-project-setup commit     # 팀과 공유할 파일로 설치 (CLAUDE.md, .claude/settings.json)
/new-project-setup local      # 나만 쓰는 파일로 설치 (.claude/settings.local.json, git에서 제외)
```

## 왜 만들었나

Claude Code로 일할 때 결과를 좌우하는 건 프롬프트보다 두 가지였습니다.

1. **"끝났다"를 판정할 수단이 있는가.** 테스트나 빌드처럼 통과·실패가 나오는 검사가 없으면 Claude는 "그럴듯해 보이는" 상태에서 멈추고, 사람이 테스트 역할을 하게 됩니다.
2. **꼭 지켜야 하는 규칙이 강제되는가.** CLAUDE.md에 적은 규칙은 모델이 판단해서 따르는 것이라 거의 지켜지지만 항상은 아닙니다. 비밀 파일 읽기 금지나 force push 금지처럼 예외가 없어야 하는 규칙은 설정(권한 규칙, hook)으로 옮겨야 합니다.

저장소를 새로 만들 때마다 이걸 손으로 맞추는 대신, 저장소를 조사해서 필요한 것만 깔아 주는 절차를 skill로 만들었습니다.

## 무엇을 설치하나

| 파일 | 역할 |
|---|---|
| `CLAUDE.md` (commit 모드) | 검증 명령, 실제로 확인한 단일 테스트 명령, 빈 Gotchas, "언제 멈추고 물을지" 두 줄. 아키텍처 설명은 쓰지 않는다 |
| `.claude/settings.json` 또는 `settings.local.json` | 비밀 파일 읽기와 파괴적 git 명령 deny, `git push` ask, Stop hook 등록 |
| `.claude/hooks/check-on-stop.mjs` + `.json` | Claude가 턴을 끝낼 때 코드가 바뀌었으면 검증 명령을 실행하는 hook |
| `.claude/skills/verify/SKILL.md` | 완료를 보고하기 전에 따를 검증 절차 (전체 검사, 관련 테스트, 실행 확인, 보고 형식) |
| `.claude/agents/reviewer.md` | `Read, Grep, Glob`만 가진 읽기 전용 리뷰어. 저장소에서 확인된 불변식만 담는다 |
| `REVIEW.md`, `.worktreeinclude` | 조건이 맞을 때만 (불변식이 있을 때, gitignore된 작은 설정 파일이 있을 때) |

검증 명령을 고르고 실행 시간을 잰 뒤, 60초 이하면 Stop hook에, 넘으면 verify skill에만 넣습니다. 저장소에 아직 테스트가 없으면 지침과 권한만 깔고 나중에 다시 실행하라고 안내합니다.

## 설계 판단

**모델이 판단할 것과 설정이 강제할 것을 나눈다.**
작업 방식이나 스타일 같은 건 CLAUDE.md에 두고 Claude가 판단하게 합니다. 비밀 파일, 파괴적 git, 저장소 지침에 "하지 않는다"로 적힌 것만 deny로 옮기고, "승인 없이 하지 않는다"는 ask로 옮깁니다. 지침에 실제로 나오는 명령만 패턴으로 만들고, 추측이 필요한 패턴(예: 어떤 DB 클라이언트인지 모를 때)은 넣지 않습니다.

**hook은 막지 않는 것부터 시작한다.**
Stop hook은 세 가지 모드가 있습니다.

| mode | 동작 |
|---|---|
| `observe` (기본) | 실패해도 막지 않고 사용자에게만 경고를 보이고 로그에 남긴다 |
| `enforce` | 실패하면 Claude에게 피드백을 돌려보내 계속 고치게 한다. 같은 턴에서 3회 실패하면 더 막지 않고 사람에게 넘긴다 |
| `off` | 아무것도 하지 않는다 |

처음부터 막으면 리팩터링 도중처럼 일부러 깨진 상태로 멈추고 싶을 때도 Claude가 되돌아가 고치려 합니다. 그래서 observe로 시작해 로그로 오탐을 보고 enforce로 올리게 했습니다. 실패 피드백은 hook 오류가 아니라 `additionalContext`(Stop hook feedback)로 보내고, 같은 변경 상태로는 검사를 다시 돌리지 않도록 캐시합니다. 꼭 통과시켜야 하는 작업은 세션 단위로 `/goal`을 쓰도록 안내합니다.

**팀 저장소에는 흔적을 남기지 않는다.**
작성자가 여러 명이거나 사내 Git이면 local 모드를 추천합니다. 모든 파일을 `.claude/` 아래 두고 `.git/info/exclude`로 git에서 뺍니다. 빌드 도구가 PATH에 없어 이 PC 전용 절대 경로가 필요하면 그 경로는 `check-on-stop.local.json`에만 쓰고, 저장소에 남는 파일에는 원래 명령(`mvn test` 등)을 씁니다.

**AGENTS.md만 있는 저장소를 건드리지 않는다.**
Claude Code는 CLAUDE.md나 CLAUDE.local.md가 없을 때만 AGENTS.md를 읽습니다. 그래서 local 모드에서 CLAUDE.local.md를 만들면 오히려 팀 지침이 로드되지 않습니다. 이 경우 지침 파일을 만들지 않습니다.

**확인하지 않은 것은 만들어 넣지 않는다.**
단일 테스트 명령은 실제로 실행해 본 것만, 앱 실행 방법은 README에 적혀 있으면 "문서에 적힌 방법(실행 확인 안 함)"으로, 불변식은 저장소 지침에서 확인된 것만 넣습니다. 비밀 파일은 존재 여부만 보고 내용은 읽지 않습니다.

## 검증 과정

### 1. hook 스크립트 단위 시험
임시 git 저장소에서 다음 경우를 모두 시험했습니다.

- 변경 없음, 통과, 같은 상태 재실행(캐시)
- observe 실패(경고만, 로그 기록), 같은 실패 상태 재실행
- enforce 연속 실패 1/3 → 2/3 → 3/3 → 4번째에 더 막지 않음
- `CLAUDE_VERIFY_MODE=off`, 설정 파일 없음, 깨진 local 설정 파일
- 커밋 0개 저장소, git이 아닌 폴더, 존재하지 않는 명령
- Maven(`[ERROR]`)·node test(`✖`) 출력에서 첫 오류 줄 고르기

### 2. 실제 Claude Code CLI로 skill 실행
`claude -p "/new-project-setup <인자>"`로 새 세션을 띄워 세 샘플 저장소에서 실행했습니다.

| 샘플 | 조건 | 결과 |
|---|---|---|
| npm-solo | 작성자 1명, commit 모드, gitignore된 로컬 설정 파일 | CLAUDE.md, settings.json, hook(observe), verify, reviewer, `.worktreeinclude` 생성. 7단계 hook 시험 3종 통과 |
| maven-team | 작성자 2명, AGENTS.md 있음, local 모드, `mvn`이 PATH에 없음 | 지침 파일을 만들지 않음. `mvn test`는 저장소 설정에, 절대 경로는 local 파일에만. `git status` 깨끗 |
| new-empty | 커밋 0개, 테스트 없음 | 지침·권한·`.gitignore`만 설치하고 hook과 verify는 나중에 다시 실행하라고 안내 |

### 3. 실제 세션에서 hook 실행 확인
설치된 npm-solo에서 CLI 세션에 테스트가 깨지는 수정을 시켰습니다. 세션이 턴을 끝내자 Stop hook이 `npm test`를 실행해 실패를 감지했고, observe 모드대로 막지 않고 로그를 남겼습니다.

### 시험으로 찾아서 고친 문제
- **커밋 0개 저장소에서 hook이 예외로 종료** — `git diff HEAD`가 실패했습니다. HEAD가 없으면 index 기준으로 비교하고, 어떤 오류도 턴을 막지 않게 바꿨습니다.
- **SKILL.md 본문의 변수가 실제 경로로 치환됨** — Claude Code는 skill을 불러올 때 본문의 `${...}` 변수를 바꿔 넣습니다. 커밋용 hook 설정 예시가 이 PC의 임시 경로로 바뀌어 전달됐습니다. 예시를 치환되지 않는 템플릿 파일로 옮겼습니다.
- **Maven 탐색 경로가 실제 구조와 다름** — wrapper 배포본은 한 단계 더 깊은 곳에 있었습니다. 재귀로 찾고 가장 높은 버전을 고르게 했습니다.
- **observe 로그가 gitignore 목록에 없음** — 커밋에 섞일 수 있었습니다.
- **force push 차단 구멍** — `git push origin main --force`처럼 옵션이 뒤에 오면 deny에 걸리지 않았습니다. 패턴을 추가했습니다.
- **Git Bash 형식 경로(`/c/...`)를 받지 못함**, **npm의 `> 명령` 줄을 오류로 고름** 등.

## 요구 사항
- Claude Code (2.1.330에서 시험)
- git, Node.js (hook 스크립트가 Node로 동작)

## 한계
- **Windows에서만 시험했습니다.** macOS·Linux에서는 돌려보지 않았습니다.
- 권한 규칙은 명령의 앞부분 일치로 동작합니다. `git -C . reset --hard`처럼 앞에 옵션을 붙인 형태는 막지 못합니다.
- 대화형 세션 화면에서 observe 경고가 어떻게 보이는지, enforce 모드가 실제 세션에서 Claude를 되돌려 보내는지는 스크립트 출력으로만 확인했습니다.
- 모노레포처럼 하위 프로젝트별로 다른 검사가 필요한 구조는 지원하지 않습니다.

## 참고 문서
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Memory (CLAUDE.md, AGENTS.md)](https://code.claude.com/docs/en/memory)
- [/goal](https://code.claude.com/docs/en/goal)
