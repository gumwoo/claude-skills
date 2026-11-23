# new-project-setup

새 저장소에서 `/new-project-setup`을 한 번 실행하면 Claude Code가 그 저장소에서 일할 기본 틀을 깔아 줍니다. 테스트 명령을 찾아 실제로 돌려 보고, 짧은 CLAUDE.md와 권한 규칙, 작업이 끝날 때 테스트를 돌리는 hook을 만듭니다.

혼자 쓰는 작은 npm 저장소에 돌렸을 때 생긴 파일입니다.

```
CLAUDE.md
.worktreeinclude
.claude/settings.json            # 비밀 파일 읽기·force push 차단, git push는 확인
.claude/hooks/check-on-stop.mjs  # 작업이 끝날 때 npm test 실행
.claude/hooks/check-on-stop.json
.claude/skills/verify/SKILL.md   # 완료 보고 전에 따를 검증 절차
.claude/agents/reviewer.md       # 읽기만 하는 리뷰어
```

CLAUDE.md는 이게 전부입니다. 아키텍처 설명 같은 건 Claude가 코드를 읽으면 알 수 있어서 넣지 않았습니다.

```markdown
# Commands
- 전체 검증: `npm test`
- 테스트 하나만: `node --test test/sum.test.js`

# Gotchas

# Working style
- 입력이 필요 없으면 계속 진행하고, 상태 보고는 다음 작업과 같은 메시지에 쓴다.
- 데이터 삭제, force push, 저장소 밖 변경 전에만 멈추고 묻는다.
```

그 뒤 Claude가 코드를 고치다 테스트를 깨뜨린 채 작업을 끝내면, hook이 테스트를 돌려 이렇게 알려 줍니다.

```
[check-on-stop 관찰 모드] `npm test` 실패(exit 1) — 막지 않음: ✖ sum (0.9785ms)
```

## 사용법

```
git clone https://github.com/gumwoo/claude-skills.git
cp -r claude-skills/new-project-setup ~/.claude/skills/
```

설정하려는 저장소에서 Claude Code를 열고 실행합니다.

```
/new-project-setup          # 저장소를 보고 어떻게 설치할지 묻는다
/new-project-setup commit   # 팀과 공유: CLAUDE.md와 .claude/settings.json으로
/new-project-setup local    # 나만 사용: 모든 파일을 .claude/ 아래 두고 git에서 제외
```

git, Node.js가 필요합니다. 커밋, push, 앱 실행은 하지 않습니다. 저장소를 살펴보는 읽기 명령 말고 실제로 돌리는 건 테스트·빌드 같은 검사 명령뿐이고, 그것도 DB나 외부 서비스에 붙는지 먼저 확인합니다.

## 왜 이렇게 만들었나

Claude Code로 일해 보면 결과를 가르는 건 프롬프트보다 두 가지였습니다. 끝났는지 확인할 수단이 있는지, 그리고 꼭 지켜야 하는 규칙이 강제되는지입니다. 테스트가 없으면 Claude는 "될 것 같은" 상태에서 멈추고 결국 사람이 테스트 역할을 합니다. CLAUDE.md에 "`.env`를 읽지 마라"라고 써 두면 대부분 지키지만 항상 지키지는 않습니다. 그래서 확인 수단은 hook으로, 예외가 없어야 하는 규칙은 권한 설정으로 옮기는 걸 저장소마다 반복하지 않도록 skill로 만들었습니다.

hook은 처음부터 막지 않습니다. 기본은 관찰 모드라서 테스트가 깨져도 경고만 띄우고 로그를 남깁니다. 리팩터링 도중처럼 일부러 깨진 상태로 멈추고 싶을 때도 있기 때문입니다. 1주쯤 로그를 보고 쓸데없이 막는 일이 없겠다 싶으면 그때 강제 모드로 바꿉니다. 강제 모드에서도 같은 실패가 세 번 이어지면 더 붙잡지 않고 사람에게 넘깁니다. 테스트가 1분 넘게 걸리면 hook에는 빠른 검사만 걸고, 전체 테스트는 verify 절차로 돌립니다.

팀 저장소에서는 흔적을 남기지 않는 쪽을 기본으로 했습니다. 작성자가 여러 명이면 로컬 설치를 추천하고, 모든 파일을 `.claude/` 아래에 두고 `.git/info/exclude`로 git에서 뺍니다. 이 PC에만 있는 경로(PATH에 없는 Maven의 절대 경로 같은 것)도 저장소에 올라가는 파일이 아니라 로컬 설정 파일에만 씁니다.

AGENTS.md만 있는 저장소는 건드리지 않습니다. Claude Code는 CLAUDE.md나 CLAUDE.local.md가 하나라도 있으면 AGENTS.md를 읽지 않습니다. 개인 설정 파일을 하나 만들었다가 팀 지침이 통째로 안 읽히는 일이 생길 수 있어서, 이 경우엔 지침 파일을 만들지 않습니다.

## 시험하면서 알게 된 것

npm(혼자 쓰는 저장소), Maven(작성자 2명에 AGENTS.md가 있는 저장소), 커밋이 하나도 없는 빈 저장소, 이렇게 세 샘플에 `claude -p`로 실제 skill을 돌렸습니다. 설치된 npm 샘플에서는 세션에 일부러 테스트를 깨뜨리게 해서 hook이 실제로 돌아 로그를 남기는 것까지 봤습니다. 빈 저장소에서는 검증할 테스트가 없으니 지침과 권한만 깔고 "테스트를 만들면 다시 실행하라"고 안내합니다.

처음 돌렸을 때 나온 문제들입니다.

- 정작 대상인 커밋 0개 저장소에서 hook이 죽었습니다. `git diff HEAD`를 할 HEAD가 없었기 때문입니다.
- skill 본문에 적은 `${CLAUDE_PROJECT_DIR}`가 skill을 불러오는 순간 실제 경로로 바뀌었습니다. 그래서 팀과 공유할 설정에 이 PC의 임시 폴더 경로가 박힐 뻔했습니다. 그 예시는 치환되지 않는 템플릿 파일로 옮겼습니다.
- Maven wrapper를 찾는 경로가 실제보다 한 단계 얕았습니다.
- 관찰 모드 로그 파일이 `.gitignore` 목록에 빠져 있었습니다.
- `git push --force`는 막는데 `git push origin main --force`는 못 막고 있었습니다.

## 한계

- Windows에서만 시험했습니다.
- hook은 Node.js로 돌기 때문에 Node가 없는 환경에서는 동작하지 않습니다.
- 모노레포처럼 하위 프로젝트마다 다른 검사가 필요한 구조는 지원하지 않습니다.
- 대화형 세션에서 경고가 화면에 어떻게 보이는지는 직접 보지 못했습니다. `-p` 모드에서 로그로만 확인했습니다.
