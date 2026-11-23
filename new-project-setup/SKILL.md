---
name: new-project-setup
description: 새 프로젝트(또는 아직 Claude 설정이 없는 저장소)에 검증 명령, 최소 CLAUDE.md, deny/ask 권한, Stop hook, verify skill, 읽기 전용 리뷰어를 깐다.
disable-model-invocation: true
argument-hint: "[local|commit] (생략하면 저장소를 보고 묻는다)"
---

현재 작업 디렉터리의 저장소에 Claude 작업 기반을 설치한다. 인자: $ARGUMENTS

원칙: Claude가 코드에서 알 수 없는 것만 적는다. "끝났다"를 판정할 명령을 먼저 확보한다.
예외가 없어야 하는 규칙만 설정으로 강제한다. 처음부터 많이 깔지 않는다. 확인하지 않은 것은 만들어 넣지 않는다.

템플릿은 `${CLAUDE_SKILL_DIR}/templates/`에 있다. 이 skill이 기대는 Claude Code 동작의 근거는 맨 아래 "근거 문서"에 있다.

## 0. 안전 규칙 (이 skill 전체에 적용)

- 기존 파일은 덮어쓰지 않는다. 이미 있으면 내용을 읽고, 추가할 부분만 제안하거나 병합한다.
- 커밋, push, 브랜치 변경을 하지 않는다.
- 실행해도 되는 것은 검증 명령과 그 일부(단일 테스트 실행, 컴파일만 하는 명령)뿐이다. 앱·서버 기동, DB 접속, 마이그레이션은 하지 않는다.
- 실행 전에 그 명령이 DB나 외부 서비스에 붙는지 스크립트·설정을 읽어 확인한다. 붙는다면 실행하지 말고 사용자에게 묻는다. 의존성 다운로드(npm, Maven 저장소 등)는 외부 서비스로 보지 않지만, 처음 받는 것이라 오래 걸릴 수 있다고 보고에 적는다.
- 비밀 파일(`.env*`, 키·인증서, 비밀번호가 든 설정)은 내용을 읽지 않는다. 존재 여부와 gitignore 여부만 `ls`와 `git check-ignore`로 확인한다.

## 1. 저장소 조사 (읽기만)

다음을 확인하고 결과를 짧게 정리한다.

- git 여부. git이 아니면 멈추고, `git init` 후 다시 실행하라고 알린다(hook과 변경 감지가 git에 의존한다).
- 커밋 수(`git rev-list --count HEAD`, 실패하면 0). 0이면 "커밋 전 새 저장소"로 보고 작성자 수와 원격 판단을 건너뛴다.
- 원격 주소와 호스트(GitHub/GitLab/사내/없음), 전체 기간 작성자 수(`git shortlog -sn HEAD`)
- 스택: `package.json`, `pom.xml`, `mvnw`, `build.gradle`, `gradlew`, `pyproject.toml`, `go.mod`, `Cargo.toml` 등
- 이미 있는 검증 수단: package scripts(test, lint, typecheck, check), Maven/Gradle test, CI 설정(`.github/workflows`, `.gitlab-ci.yml`), 저장소 지침에 적힌 검증 명령
- 이미 있는 지침: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/`, `.cursor/rules`, `docs/rules`
- `codex` CLI가 PATH에 있는지(8단계 리뷰 안내에만 쓴다).
- 빌드 도구가 PATH에 있는지. 스택에 필요한 것만 본다. 저장소에 wrapper(`mvnw`, `gradlew`)가 있으면 그것을 쓴다. Maven 스택인데 `mvn`과 `mvnw`가 모두 없으면 `~/.m2/wrapper/dists` 아래를 재귀로 찾아(`find ~/.m2/wrapper/dists -name mvn.cmd -path "*/bin/*"`, Windows가 아니면 `mvn`) 버전이 가장 높은 것을, 같으면 수정 시각이 가장 최근인 것을 고른다.
- `node`가 PATH에 있는지. Stop hook 스크립트가 Node로 돈다.

## 2. 설치 방식 결정

- 인자가 `local`이면 로컬 전용, `commit`이면 커밋용으로 한다.
- 인자가 없으면 AskUserQuestion으로 묻는다. 추천 첫 옵션은 이렇게 정한다: 작성자 2명 이상이거나 원격이 사내 Git 호스트면 "로컬 전용", 그 밖(혼자, 원격 없음, 커밋 전 새 저장소)은 "커밋용".

| | 로컬 전용 | 커밋용 |
|---|---|---|
| 권한·hook 설정 | `.claude/settings.local.json` | `.claude/settings.json` |
| git 제외 | `.git/info/exclude`에 `.claude/` 추가 | `.gitignore`에 `CLAUDE.local.md`, `.claude/settings.local.json`, `.claude/.verify-cache.json`, `.claude/verify-observe.log`, `.claude/hooks/check-on-stop.local.json` |
| 지침 파일 | 저장소 루트에 새 지침 파일을 만들지 않는다 | `CLAUDE.md` |
| REVIEW.md | 만들지 않고 리뷰어 agent 본문에 기준을 넣는다 | 확인된 불변식이 있을 때만 루트 `REVIEW.md` |

## 3. 검증 명령 확보

1. 고르는 순서: 저장소 지침(AGENTS.md, README, CLAUDE.md)이나 CI에 적힌 검증 명령이 있으면 그것을 쓴다. 없으면 package scripts·빌드 도구에서 "테스트 + 타입체크/컴파일 + 린트"를 가장 넓게 덮는 명령 하나를 고른다. 아무것도 없으면 스택에 맞는 후보를 제안하고 AskUserQuestion으로 확인한다(인자가 있어 물을 수 없는 실행이면 hook을 만들지 않고 보고한다). 확정 전에는 다음 단계로 가지 않는다.
2. 고른 명령이 덮지 못하는 것(예: 린트·타입체크 없음)은 추가하지 말고 보고에 "빠진 검사"로 적는다.
3. 빌드 도구가 PATH에 없어 1단계에서 찾은 절대 경로를 써야 하면, 저장소에 남는 파일(커밋용 `CLAUDE.md`, `check-on-stop.json`, verify skill)에는 원래 명령(`mvn test` 등)을 쓰고, 이 PC 전용 절대 경로는 `check-on-stop.local.json`과 로컬 전용 파일에만 쓴다. 보고에 "빌드 도구를 PATH에 추가하면 이 우회가 필요 없다"고 적는다.
4. 그 명령을 hook과 같은 방식(셸을 거친 실행)으로 한 번 실행해 종료 코드와 소요 시간(벽시계 기준)을 잰다. 측정 횟수와 의존성 캐시 상태를 보고에 적는다.
5. 소요 시간으로 나눈다.
   - 60초 이하: Stop hook 검사 명령으로 쓴다.
   - 60초 초과: 더 빠른 부분 검사(타입체크, 린트, 컴파일만)를 Stop hook에 쓰고, 전체 명령은 verify skill에만 넣는다. 빠른 부분 검사가 없으면 Stop hook을 만들지 않는다.
6. 현재 실패한다면 Stop hook을 만들지 않는다. 사용자에게 알리고 hook 없이 진행한다(처음부터 막히는 hook은 쓸모가 없다).
7. 커밋 전 새 저장소처럼 아직 코드와 검증 명령이 없으면 4단계 지침 파일과 5단계 권한만 깔고, hook과 verify skill은 "코드와 테스트가 생기면 이 skill을 다시 실행"하라고 보고한다.

## 4. 지침 파일

- `CLAUDE.md`도 `AGENTS.md`도 없고 커밋용이면: `templates/CLAUDE.md`를 채워 만든다.
  - Commands에는 3단계에서 확정한 전체 검증 명령과, 실제로 실행해 확인한 단일 테스트 명령만 쓴다. 확인하지 못한 명령은 쓰지 않는다.
  - Conventions는 저장소에서 확인된 팀 규칙이 없으면 섹션째 지운다.
  - Gotchas는 비워 두고 제목만 남긴다(나중에 두 번 교정한 것을 적는 자리).
  - 아키텍처·폴더 구조 설명은 쓰지 않는다.
- `AGENTS.md`만 있으면: 그 상태로 Claude가 AGENTS.md를 자동으로 읽는다(근거 문서 1). 로컬 전용에서는 아무것도 만들지 않는다. `CLAUDE.local.md`를 만들지 않는다(만들면 AGENTS.md가 로드되지 않는다, 근거 문서 1). 커밋용이면 첫 줄이 `@AGENTS.md`인 CLAUDE.md를 만들고 그 아래에 없는 항목만 추가한다.
- `CLAUDE.md`가 있으면: 수정하지 않는다. 템플릿의 "Working style" 두 줄과 Commands 중 빠진 것만 제안 목록으로 보고한다.

## 5. 권한과 Stop hook

1. `templates/settings.json`의 `permissions`를 2단계에서 정한 파일에 쓴다. 파일이 이미 있으면 JSON으로 읽어 `permissions.deny`, `permissions.ask`, `hooks.Stop`에 없는 항목만 병합한다.
   - 템플릿의 deny는 비밀 파일 읽기와 파괴적 git 명령만 담는다. 스택에 비밀이 들어가는 파일이 따로 확인되면(예: 비밀번호가 든 `application-*.properties`) 그 경로의 Read deny를 더한다. 확인되지 않은 경로는 넣지 않는다.
   - 저장소 지침의 금지 규칙은 이렇게 옮긴다: "하지 않는다/금지"는 deny, "승인 없이 하지 않는다/확인 후"는 ask. 지침이나 스크립트에 실제로 나오는 명령만 패턴으로 만든다(예: 지침이 "DB 스크립트"라고만 하고 도구를 밝히지 않으면 DB 클라이언트 패턴을 추측해 넣지 말고 보고에 적는다).
   - 이 규칙들은 명령의 앞부분 일치로 동작한다. `git -C . rebase`처럼 앞에 옵션을 붙인 형태는 막지 못한다고 보고에 적는다.
2. Stop hook을 만들기로 했으면(`node`가 PATH에 없으면 만들지 않고 보고한다):
   - `templates/check-on-stop.mjs`를 `.claude/hooks/check-on-stop.mjs`로 복사한다.
   - `.claude/hooks/check-on-stop.json`을 만든다: `{"mode": "observe", "command": "<3단계 명령>", "watch": [<소스 디렉터리>, <테스트 디렉터리>, <빌드 설정 파일>], "timeoutSec": <측정 시간의 3배, 최소 60, 최대 300>}`. lock 파일은 넣지 않는다.
   - 3단계 3번처럼 이 PC 전용 경로가 필요하면 `.claude/hooks/check-on-stop.local.json`에 `{"command": "<절대 경로를 쓴 명령>"}`만 둔다.
   - mode는 항상 `observe`로 시작한다. 실패해도 막지 않고 사용자에게 경고만 보이며 `.claude/verify-observe.log`에 남긴다. `enforce`로 올리는 건 사용자가 로그를 보고 정한다.
   - 설정 파일의 `hooks`에 템플릿 파일 하나의 내용을 넣고, `timeout`만 `timeoutSec + 60`으로 바꾼다.
     - 로컬 전용: `templates/hooks-local.json`. `<SCRIPT_ABSOLUTE_PATH>`를 `.claude/hooks/check-on-stop.mjs`의 절대 경로(Windows면 `C:/...`처럼 슬래시)로 바꾼다.
     - 커밋용: `templates/hooks-commit.json`. 이 파일의 `args` 값은 Claude Code가 실행할 때 프로젝트 경로로 바꾸는 변수 표기다. 글자 그대로 복사하고 절대 경로로 바꾸지 않는다(근거 문서 2). 이 SKILL.md 본문에는 그 변수를 적지 않는다: skill을 불러올 때 본문의 변수가 실제 경로로 치환되기 때문이다.
3. `.worktreeinclude`: 커밋용이고 gitignore된 작은 설정 파일(`.env`, `.env.local` 등)이 실제로 있을 때만 그 이름을 적어 만든다. `node_modules` 같은 큰 디렉터리는 넣지 않는다. 만들었다면 "worktree를 만들 때마다 이 파일들(비밀 포함)이 복사된다"고 보고한다.

## 6. verify skill과 리뷰어

1. `templates/verify-SKILL.md`를 `.claude/skills/verify/SKILL.md`로 만들고, 확인된 사실로만 채운다.
   - 전체 검증 명령과 측정 시간, 실제로 실행해 확인한 단일·부분 테스트 명령을 넣는다.
   - 앱 기동 방법은 README나 스크립트에 적혀 있으면 "문서에 적힌 방법(실행 확인 안 함)"으로 넣고, 서버처럼 끝나지 않는 명령이면 사용자 승인 후 백그라운드로 띄우고 확인 뒤 종료하라고 적는다. 적힌 곳이 없으면 "미정. 처음 실행할 때 사용자에게 묻고 이 skill에 추가한다"라고 쓴다.
   - DB나 외부 시스템에 붙는 실행은 사용자 승인 후에만 한다고 적는다.
2. `templates/reviewer.md`를 `.claude/agents/reviewer.md`로 만든다. 저장소 지침에서 확인된 "깨지면 안 되는 것"(불변식, 금지 패턴)만 최대 6줄 넣는다. 하나도 없으면 목록과 그 제목 줄을 함께 지운다.
3. 커밋용이고 그런 불변식이 있으면 같은 내용으로 루트 `REVIEW.md`를 만든다(`templates/REVIEW.md`). 없으면 만들지 않는다.

## 7. 동작 확인

1. 만든 JSON 파일들이 파싱되는지 확인한다.
2. Stop hook을 만들었으면 `CLAUDE_PROJECT_DIR`를 저장소 루트로 두고 표준 입력에 `{}`를 넣어 직접 실행해 세 가지를 본다. 시험 뒤에는 만든 것을 모두 지운다.
   - 변경 없음: exit 0, 출력 없음.
   - 실행 경로: 첫 watch 디렉터리에 빌드에 영향 없는 임시 파일 `.verify-probe.txt`를 만들고 실행 → exit 0, 출력 없음, `.claude/.verify-cache.json` 생성.
   - 실패 경로: 같은 상태에서 캐시를 지우고 환경변수 `CLAUDE_VERIFY_COMMAND="node -e \"process.exit(1)\""`로 실행 → exit 0, 출력이 `systemMessage`를 가진 JSON 한 줄, `.claude/verify-observe.log`에 한 줄.
   - 끝나면 `.verify-probe.txt`, `.claude/.verify-cache.json`, `.claude/verify-observe.log`를 지운다.
3. `git status --short`를 본다. 로컬 전용이면 `.claude/`가 나타나지 않아야 한다. 커밋용이면 이번에 만든 파일만 나타나야 한다.

## 8. 보고

결과부터 쓴다. 다음을 구분한다.

- 만든 파일과 각 파일이 하는 일
- 병합하거나 건너뛴 파일과 이유
- 측정한 값(검증 명령의 종료 코드·소요 시간, 측정 횟수와 캐시 상태)과 빠진 검사
- 확인하지 못한 것. 최소한 "실제 Claude 세션에서 hook이 걸리는지는 새 세션에서 `/hooks`로 확인 필요"를 포함한다.
- 사용자가 할 일: 빌드 도구 PATH 추가(해당 시), 커밋 여부 결정(커밋용), 팀 공유 여부(로컬 전용).
- hook 모드 사용법: 현재 `observe`. 1주쯤 `.claude/verify-observe.log`를 보고 쓸데없이 막을 경우가 거의 없으면 `check-on-stop.json`의 mode를 `enforce`로 바꾼다. 세션 하나만 바꾸려면 환경변수 `CLAUDE_VERIFY_MODE=off|observe|enforce`. `enforce`는 같은 턴에서 3회 실패하면 더 막지 않고 알린다.
- 꼭 통과시켜야 하는 작업은 그 세션에서만 `/goal`로 강제할 수 있다(근거 문서 3). 판정하는 모델은 대화만 읽고 파일이나 명령을 직접 보지 않으므로, 조건에 증명할 명령과 지킬 제약과 상한을 함께 넣은 예를 이 저장소 명령으로 채워 보고한다. 예: `/goal <검증 명령>을 실행해 exit 0인 출력을 보여 줌, <테스트 디렉터리>와 검사 설정 파일은 수정하지 않음, 아니면 15턴 뒤 멈춤`.
- 1단계에서 `codex`가 PATH에 있거나 Codex 플러그인이 켜져 있으면, 마무리 직전에 다른 모델 리뷰(`/codex:adversarial-review`)를 한 번 받을 수 있다고 덧붙인다. Codex의 stop-time review gate를 상시로 켜는 것은 권하지 않는다(두 모델이 번갈아 도는 루프가 사용량을 빠르게 쓴다). Codex가 없으면 이 항목은 쓰지 않는다.
- 같은 프롬프트를 반복 주입하는 Ralph 방식 플러그인은 설치하지 않는다. 완료를 작업하는 모델 스스로 판정하므로 `/goal`이나 Stop hook보다 약하다.
- 아직 깔지 않은 다음 단계(필요해질 때): 영역별 규칙이 생기면 `.claude/rules/` + `paths:`, 부작용 있는 팀 절차는 `disable-model-invocation: true` skill, 같은 실수가 두 번 나오면 CLAUDE.md Gotchas, 그래도 반복되면 hook/deny.

## 근거 문서

1. AGENTS.md 로딩: CLAUDE.md·CLAUDE.local.md가 작업 디렉터리나 그 위에 없을 때만 AGENTS.md를 읽는다. https://code.claude.com/docs/en/memory ("When Claude Code reads AGENTS.md")
2. hook의 `args`(exec form)와 프로젝트 경로 변수 치환, Stop hook의 `additionalContext`·`systemMessage`·`stop_hook_active`: https://code.claude.com/docs/en/hooks
3. `/goal`: https://code.claude.com/docs/en/goal
