---
name: infra-change-guard
description: 인프라를 바꾸기 전에 대상 환경을 확인하고 Terraform plan을 데이터 손실 관점에서 검토해, 사람이 승인한 plan만 적용하게 한다. Terraform/OpenTofu plan 검토를 요청받았을 때, 또는 terraform/tofu/terragrunt apply·destroy·state 변경, kubectl apply·delete, helm install·upgrade·uninstall, argocd sync, aws·gcloud·az로 리소스를 바꾸거나 지우려 할 때 먼저 사용한다. 인자 install [local|commit]이면 검토 절차를 강제하는 차단 hook을 저장소에 설치한다.
argument-hint: "[install [local|commit]]"
---

인자: $ARGUMENTS

인자가 `install`로 시작하면 아래 "B. 차단 hook 설치"를, 아니면 "A. 변경 검토"를 한다.

스크립트는 `${CLAUDE_SKILL_DIR}/scripts/`에 있고 Node.js로 돈다. 모두 읽기 전용이다.

## 원칙

- 인프라를 바꾸는 명령은 사람이 이 대화에서 그 변경을 명시적으로 승인한 뒤에만 실행한다. destroy, 백업·스냅샷 삭제, `-auto-approve`는 에이전트가 실행하지 않는다.
- 대상 환경을 확인하기 전에는 아무것도 바꾸지 않는다. 확인하지 못했으면 확인하지 못했다고 쓰고 멈춘다.
- "삭제해도 안전하다", "복구할 수 없다", "검증 완료" 같은 판단은 근거(명령 출력, 체크섬, 실제 복원 시험)를 붙여서만 쓴다. 근거가 없으면 확인하지 못했다고 쓴다.
- 비밀 값(`.tfvars`의 비밀번호, `.env`, 자격증명 파일)은 읽거나 출력하지 않는다.

## A. 변경 검토

### 1. 대상 환경 확인 (읽기 전용)

해당하는 것만 실행하고 결과를 그대로 적는다.

- Terraform: `terraform workspace show`, backend 설정(코드의 `backend` 블록 또는 `.terraform/terraform.tfstate`의 backend 부분에서 버킷·키·workspace 이름만)
- AWS: `aws sts get-caller-identity` (계정 ID, 역할 ARN). `--profile`·`AWS_PROFILE`이 무엇인지도 적는다
- Kubernetes: `kubectl config current-context`, 대상 namespace
- 이름이나 계정·context에 `prod`·`production`이 보이면 "운영 환경"으로 표시한다. 자격증명이 무엇을 가리키는지 확인하지 못하면 여기서 멈추고 사용자에게 묻는다.

### 2. 변경 내용 만들기

- Terraform: 모듈 디렉터리에서 `terraform plan -input=false -out=tfplan`. 변수나 비밀 값이 필요하면 지어내지 말고 사용자에게 묻는다. plan은 실제 인프라를 바꾸지 않지만 state를 읽고 잠시 잠근다.
- Kubernetes: `kubectl diff -f <파일>` 또는 `kubectl diff -k <디렉터리>`, 클러스터가 없으면 `kubectl apply --dry-run=client`.
- helm: `helm diff upgrade`(플러그인이 있을 때) 또는 `helm upgrade --dry-run`.

### 3. 위험 분석

```
node "${CLAUDE_SKILL_DIR}/scripts/plan-check.mjs" tfplan
```

- 저장된 plan 파일을 주면 같은 디렉터리에서 `terraform show -json`을 실행해 읽는다. JSON 파일을 직접 줘도 된다. OpenTofu는 `--tool tofu`.
- 종료 코드 2는 HIGH가 있다는 뜻이다. 데이터를 가진 리소스(DB, 버킷, 볼륨, 키 등)의 삭제·교체, 삭제 보호 해제, 버전 관리 해제, IAM `*` 권한, plan 오류 같은 것들이다.
- 저장소에 `.tf`가 있고 보호 설정이 궁금하면 `node "${CLAUDE_SKILL_DIR}/scripts/tf-static-audit.mjs" <디렉터리>`로 삭제 보호·스냅샷·버전 관리가 빠진 리소스를 함께 본다(코드만 보는 근사 점검). 저장소에 Checkov·Trivy·conftest 같은 정책 검사가 이미 있으면 그것도 돌려 결과를 함께 보고한다.

### 4. 보고하고 승인 받기

다음 순서로 보고한다.

1. 대상 환경: 계정·workspace·context와 운영 여부
2. 변경 요약: 생성·변경·교체·삭제 개수
3. plan-check의 HIGH·MEDIUM 항목 그대로
4. 되돌릴 수 없는 것과, 복구 수단(스냅샷·백업·버전)을 실제로 확인했는지. 확인하지 못했으면 "확인 못 함"
5. 질문: "이 plan 파일(`tfplan`)을 적용해도 되는가?"

HIGH가 있으면 사람이 직접 적용하도록 권한다.

### 5. 적용 (승인받은 경우만)

- `terraform apply tfplan`처럼 검토한 plan 파일로만 적용한다. 차단 hook이 설치돼 있으면 이 명령에 확인 창이 뜬다.
- plan을 만든 뒤 코드나 state가 바뀌었으면 Terraform이 그 plan을 거부한다. 그때는 2단계부터 다시 한다.
- Kubernetes는 diff로 보인 것과 같은 파일로 `kubectl apply`한다.

### 6. 적용 뒤 확인

- Terraform: `terraform plan -detailed-exitcode -input=false`의 종료 코드 0(남은 변경 없음)을 근거로 보고한다.
- Kubernetes: `kubectl rollout status`와 관련 Pod 상태를 보고한다.
- 확인하지 못한 것은 확인하지 못했다고 쓴다.

## B. 차단 hook 설치

위 검토 절차를 건너뛰지 못하게 하는 PreToolUse hook을 설치한다. Bash·PowerShell 명령을 검사한다.

- deny: 되돌릴 수 없는 명령(destroy, `-auto-approve`, plan 없는 apply, `state rm`, namespace·PV·PVC·CRD 삭제, 백업·스냅샷·버킷 삭제 등). 대상 환경과 상관없이 항상.
- ask: 저장된 plan 적용과 state 변경은 항상. 그 밖의 변경 명령(kubectl apply, helm upgrade, aws 변경 등)은 대상(kube context·namespace, aws profile, gcloud project 등)이 운영으로 보이거나 판단할 수 없을 때만. 로컬·개발 환경으로 확인되면 묻지 않는다.

설치 순서:

1. 설치 방식: 인자가 `local`이면 로컬 전용, `commit`이면 커밋용. 없으면 AskUserQuestion으로 묻는다(작성자 2명 이상이거나 사내 Git이면 로컬 전용 추천).
   - 로컬 전용: 설정은 `.claude/settings.local.json`, `.git/info/exclude`에 `.claude/` 추가
   - 커밋용: 설정은 `.claude/settings.json`, `.gitignore`에 `.claude/settings.local.json`과 `.claude/infra-guard.log`
2. `${CLAUDE_SKILL_DIR}/scripts/guard-hook.mjs`를 `.claude/hooks/infra-guard.mjs`로, `${CLAUDE_SKILL_DIR}/templates/infra-guard.json`을 `.claude/hooks/infra-guard.json`으로 복사한다. 이미 있으면 덮어쓰지 않고 알린다.
3. 운영·개발 이름 규칙: `kubectl config get-contexts -o name`과 `aws configure list-profiles`(있을 때)로 이 PC의 context·profile 이름을 보고, 기본 규칙(`prod`/`production`/`prd`/`live`는 운영, `dev`/`test`/`stage`/`kind`/`minikube` 등은 개발)으로 분류되지 않는 이름이 있으면 사용자에게 운영인지 묻고 `.claude/hooks/infra-guard.json`의 `prodPatterns`·`nonProdPatterns`에 단어를 추가한다. 묻지 않고 추측해 넣지 않는다.
4. 설정 파일의 `hooks`에 템플릿 하나의 `PreToolUse` 항목을 병합한다. 기존 hook은 지우지 않는다.
   - 로컬 전용: `templates/hooks-local.json`. `<SCRIPT_ABSOLUTE_PATH>`를 `.claude/hooks/infra-guard.mjs`의 절대 경로(Windows는 `C:/...`처럼 슬래시)로 바꾼다.
   - 커밋용: `templates/hooks-commit.json`을 글자 그대로 쓴다. 그 안의 프로젝트 경로 변수는 Claude Code가 실행할 때 바꾸므로 절대 경로로 바꾸지 않는다. 이 SKILL.md 본문에는 그 변수를 적지 않는다(skill을 불러올 때 본문의 변수가 실제 경로로 치환된다).
5. 확인: 표준 입력에 JSON을 넣어 설치한 스크립트를 직접 실행한다.
   - `{"tool_name":"Bash","tool_input":{"command":"terraform destroy"}}` → `permissionDecision`이 `deny`인 JSON
   - `{"tool_name":"Bash","tool_input":{"command":"terraform plan"}}` → 출력 없음
   - 설정 JSON이 파싱되는지, 로컬 전용이면 `git status`에 `.claude/`가 안 보이는지
6. 보고에 다음을 넣는다.
   - 만든 파일, 위 판정 기준 요약, 3단계에서 정한 운영·개발 이름
   - 모드 바꾸기: `.claude/hooks/infra-guard.json`의 `mode`를 `observe`(막지 않고 `.claude/infra-guard.log`에 기록) 또는 `off`로. 판단할 수 없는 대상도 묻지 않으려면 `unknownTarget`을 `allow`로
   - 한계: 명령 문자열만 본다. 스크립트 파일 안의 명령이나 변수로 조립한 명령은 보지 못한다. Claude Code auto mode의 분류기도 destroy 같은 명령을 기본으로 막지만 분류기 판단이고, 이 hook은 모든 권한 모드에서 같은 규칙을 적용한다. 더 넓은 명령 차단(git, 파일 삭제, DB 등)이 필요하면 destructive_command_guard나 cc-safety-net 같은 도구를 함께 쓰라고 안내한다.
   - 최종 방어선은 권한이라는 점: 에이전트가 쓰는 자격증명을 plan 전용으로 나누는 방법은 `${CLAUDE_SKILL_DIR}/references/plan-only-iam.md`에 있다고 알리고, 운영 DB·백업을 지울 수 있는 자격증명인지 확인하라고 권한다.
   - "새 세션에서 `/hooks`로 설치를 확인할 것"

## 참고

- hook 판정(`allow`/`deny`/`ask`)과 auto mode에서의 `ask` 동작: https://code.claude.com/docs/en/hooks
- Terraform plan JSON 형식: https://developer.hashicorp.com/terraform/internals/json-format
