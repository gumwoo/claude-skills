# infra-change-guard

AI 에이전트가 인프라를 바꾸기 전에 **대상 환경을 확인하고, Terraform plan을 데이터 손실 관점에서 검토해, 사람이 승인한 plan만 적용하게 하는** skill입니다.

```
/infra-change-guard                    # 지금 변경사항 검토 (Claude가 인프라 변경 전에 스스로 쓰기도 한다)
/infra-change-guard install local      # 검토 절차를 강제하는 차단 hook 설치 (나만 쓰는 파일, git에서 제외)
/infra-change-guard install commit     # 같은 hook을 팀과 공유하는 파일로 설치
```

## 왜 만들었나

AI 에이전트가 운영 환경을 망가뜨린 공개 사례를 분석한 글([eon.io, 2026년 11월](https://www.eon.io/blog/ai-agent-production-incidents), 33건)에서 같은 패턴이 반복됩니다.

1. **평범한 명령이 운영을 쳤다.** 자격증명이나 `.env`가 운영을 가리키는 줄 모르고 마이그레이션·정리 작업을 돌렸습니다.
2. **문서로 적은 규칙은 막지 못했다.** 지침 파일에 "절대 삭제하지 마라"가 있었는데도 지웠습니다.
3. **에이전트가 자기가 한 일을 틀리게 보고했다.** "검증 완료", "복구 불가"가 사실이 아니었습니다.
4. **백업까지 에이전트 권한 안에 있었다.** 복구된 데이터는 모두 에이전트가 닿지 못한 사본에서 나왔습니다.

실제로 Claude Code가 `terraform destroy`로 운영 인프라와 자동 스냅샷을 지운 사고도 기록돼 있습니다([AI Incident Database #1424](https://incidentdatabase.ai/cite/1424/)).

## 기존 도구와의 관계

이 영역에는 이미 좋은 도구가 많아서, 무엇을 새로 하고 무엇을 맡기는지 먼저 정리합니다.

| 하는 일 | 이미 있는 것 | 이 skill |
|---|---|---|
| 위험한 셸 명령 차단 | Claude Code auto mode 분류기(destroy 등을 기본 차단), [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard), [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | 검토 절차를 건너뛰지 못하게 하는 **최소한의 규칙만** 둔다. 넓은 차단은 위 도구를 함께 쓰라고 안내 |
| plan 정책 검사 | conftest(OPA), Checkov, Trivy | 정책을 직접 쓸 필요 없이 **데이터 손실**(상태를 가진 리소스의 삭제·교체, 삭제 보호·버전 관리 해제)을 바로 잡는다. 저장소에 기존 검사가 있으면 함께 돌린다 |
| 변경 전 확인 흐름 | 없음(차단 도구들은 막기만 한다) | 대상 환경 확인 → 저장된 plan → 분석 → 근거 있는 보고 → 승인 → 같은 plan으로만 적용 → 남은 변경 확인 |
| 최종 방어선 | 클라우드 권한 | 에이전트용 plan 전용 권한 구성 예시를 제공([references/plan-only-iam.md](references/plan-only-iam.md)) |

## 무엇을 하나

| 구성 | 하는 일 |
|---|---|
| 변경 검토 절차 (SKILL.md) | 대상 환경 확인(workspace, 계정, kube context, 운영 여부) → `plan -out` → 위험 분석 → 보고 → 사람 승인 → 저장된 plan으로만 적용 → `plan -detailed-exitcode`로 남은 변경 없음 확인 |
| `scripts/plan-check.mjs` | plan JSON에서 위험 신호를 찾아 HIGH·MEDIUM·LOW로 보고. HIGH가 있으면 종료 코드 2 |
| `scripts/guard-hook.mjs` | 검토 절차를 강제하는 PreToolUse hook (아래 판정표) |
| `scripts/tf-static-audit.mjs` | `.tf` 코드에서 삭제 보호·마지막 스냅샷·버전 관리가 빠진 리소스를 찾음 |
| `references/plan-only-iam.md` | 에이전트에게 plan만 허용하는 AWS 권한 예시, 백업 분리, 정책 시뮬레이터로 확인하는 법 |

**plan-check가 HIGH로 보는 것:** 데이터를 가진 리소스(RDS, DynamoDB, S3, EBS·EFS, ElastiCache, KMS 키, Secrets, EKS 클러스터, GCP·Azure의 대응 리소스, Kubernetes namespace·PV·PVC 등)의 삭제·교체, 삭제 보호 해제, `skip_final_snapshot`·`force_destroy`를 새로 켜기, S3 버전 관리 끄기, IAM `Action "*" / Resource "*"`, 오류로 중단된 plan.
MEDIUM은 그 밖의 삭제·교체, 웹이 아닌 포트를 `0.0.0.0/0`에 여는 것, `s3:*` 같은 넓은 IAM 권한 등입니다.

**guard hook의 판정**

| | 언제 | 예 |
|---|---|---|
| **deny** | 항상 (환경 무관) | `terraform/tofu destroy`, `apply -destroy`, `-auto-approve`, plan 파일 없는 `apply`, `state rm/push`, `force-unlock`, `kubectl delete` namespace·PV·PVC·CRD·node·`--all`, `argocd app delete`, `aws s3 rb`·`s3 rm --recursive`, RDS·DynamoDB·EC2·EKS·KMS·백업·스냅샷 삭제, S3 버전 관리 끄기, `.tfstate` 삭제 |
| **ask** | 항상 (검토 절차의 승인 지점) | 저장된 plan으로 `terraform apply`, `state mv`, `import` |
| **ask** | 대상이 운영으로 보이거나 판단할 수 없을 때만 | `kubectl apply/delete/scale/rollout restart`, `helm install/upgrade/uninstall`, `argocd app sync`, aws·gcloud·az 변경 명령 |
| 통과 | 대상이 로컬·개발로 확인되면 / 읽기 전용 명령 | `kind-*` context에서 `kubectl apply`, `--profile dev`로 `aws ... stop-instances`, `plan`·`get`·`describe`·`--dry-run` |

대상 판단에는 kube context·namespace, aws profile(`--profile`, `AWS_PROFILE`), gcloud project, az subscription·resource group, Terraform workspace·디렉터리·var-file 이름을 씁니다. 이름을 단어로 나눠 `prod`·`production`·`prd`·`live`가 있으면 운영, `dev`·`test`·`stage`·`sandbox`·`kind`·`minikube` 등이 있으면 개발로 봅니다(`product` 같은 단어는 운영으로 보지 않음). 이 PC에서 쓰는 이름은 `infra-guard.json`의 `prodPatterns`·`nonProdPatterns`에 추가합니다(기본 목록에 더해짐). `cd x && …`, `VAR=1 …`, PowerShell `$env:X=…; …`, `bash -c "…"`, `$(…)`, `& …` 안의 명령도 꺼내서 검사합니다.

## 설계 판단

**deny와 ask를 나눈 기준은 "되돌릴 수 있는가"입니다.** 실수 한 번이 복구 불가로 이어지는 명령은 에이전트가 아예 실행하지 못하게 하고 사람이 직접 하게 합니다. 나머지는 확인 창으로 돌립니다.

**확인 창은 필요할 때만 띄웁니다.** 사고 분석 글에 따르면 사용자는 권한 확인 창의 97%를 승인합니다. 모든 `kubectl apply`마다 물으면 결국 읽지 않고 누르게 됩니다. 그래서 변경 명령은 "변경이면서 운영 대상일 때"만 묻고, 로컬·개발로 확인되면 통과시킵니다([agent_db_guard](https://github.com/andrewjpyle/agent_db_guard)의 "키워드가 아니라 조건의 결합으로 판단하라"는 생각을 따랐습니다). 대상을 판단할 수 없으면 안전하게 묻는 쪽을 기본으로 했고, 설정으로 바꿀 수 있습니다.

**적용은 저장된 plan으로만 합니다.** plan 파일 없이 `apply`하면 사람이 검토한 것과 다른 변경이 적용될 수 있습니다. plan을 저장해 검토하고 같은 파일로만 적용하게 했습니다. plan 이후 코드나 state가 바뀌면 Terraform이 그 plan을 거부하므로 "검토한 것 = 적용되는 것"이 보장됩니다.

**hook은 보안 경계가 아닙니다.** 명령 문자열만 보기 때문에 스크립트 파일이나 변수로 조립한 명령은 보지 못합니다. auto mode 분류기와 겹치는 부분도 있지만, 분류기는 모델 판단이고 이 hook은 모든 권한 모드에서 같은 규칙을 적용합니다. 최종 방어선은 클라우드 권한이라 plan 전용 권한 구성 예시를 함께 제공합니다.

**확인하지 못한 것은 확인하지 못했다고 씁니다.** 에이전트가 자기 작업을 틀리게 보고하는 문제(패턴 3)에 대응해, 보고 형식에 "복구 수단을 실제로 확인했는지"를 넣었습니다.

**클라우드 없이 시험할 수 있게 만들었습니다.** 세 스크립트 모두 읽기 전용이고 외부 의존성이 없습니다.

## 검증 과정

### 1. 자동 시험 (`node tests/run-tests.mjs`, 156개 통과)
- **plan-check**
  - Terraform 1.9.8이 실제로 만든 plan(내장 `terraform_data`로 생성·변경·교체·삭제)
  - hashicorp/aws 5.100.0 provider가 오프라인(`-refresh=false`, 가짜 자격증명)으로 만든 실제 AWS plan
  - RDS 교체, S3 삭제, 삭제 보호 해제, 버전 관리 해제, SSH 공개, IAM 와일드카드, drift를 담은 시험 데이터
- **guard hook:** 명령 86개의 판정, 그리고 대상 환경별 판정 26개. 연결 연산자, 환경변수 접두사, `bash -c`, `$(…)`, PowerShell, 무해한 문자열(`git commit -m "terraform destroy"`)이 포함됩니다. 환경별 판정은 kind context, `--context`, namespace, aws profile, `$env:AWS_PROFILE`, gcloud project, workspace, `cd` 경로, 이름 규칙 추가와 대소문자를 다룹니다.
- **정적 점검:** 주석 안의 값, 문자열 안의 중괄호, 변수로 정해진 값 처리
- 기대값을 일부러 틀리게 바꿔 실패가 잡히는 것도 확인했습니다.

### 2. 실제 Claude Code 세션 (`claude -p`, auto mode)
시험용 Terraform 폴더(`terraform_data` 리소스 4개, 로컬 state)에서 실행했습니다.

| 시험 | 결과 |
|---|---|
| `/infra-change-guard install local` | hook 설치, 직접 실행 확인까지 skill이 수행. `git status` 깨끗. 이 PC의 kube context·aws profile 이름을 조회해 `kind-*`는 개발로 분류하고, ARN 형식의 EKS context와 `default` profile은 운영인지 추측하지 않고 질문으로 남김 |
| "`terraform destroy -auto-approve` 실행해" | hook이 deny. 리소스 4개 그대로 |
| `/infra-change-guard 변경사항 검토해줘` | 대상 환경 확인 → plan 저장 → plan-check → 되돌릴 수 없는 것과 state 백업 없음 지적 → 승인 요청. 적용하지 않음 |
| "검토한 plan 적용 승인, `terraform apply tfplan` 실행해" | 세션이 만든 `cd "…" && terraform apply tfplan`을 hook이 ask로 판정. 물을 사람이 없는 `-p`라 거부. 리소스 그대로 |

### 3. 실제 프로젝트 코드에 정적 점검
개인 프로젝트의 AWS Terraform 코드(`.tf` 40개, resource 블록 77개)에 돌려 11건을 지적했습니다. RDS 삭제 보호 꺼짐, 마지막 스냅샷 생략, 자동 스냅샷 없는 ElastiCache 등입니다. 코드를 직접 확인해 보니 모두 실제로 적힌 값이었고 오탐은 없었습니다.

### 시험과 비교 조사로 고친 것
- **provider 기본값 오탐:** 실제 AWS plan을 돌려 보니 `delete_automated_backups`가 provider 기본값 `true`라서 DB를 만들 때마다 경고가 떴습니다. 이 속성은 변경으로 새로 켜질 때만 지적하게 바꿨습니다.
- **변수로 정해진 값 단정:** `deletion_protection = var.x`를 "보호 안 됨"으로 단정하던 것을 "변수로 정해짐, 환경별 값 확인 필요"(LOW)로 바꿨습니다.
- **확인 창 남발:** 처음에는 모든 `kubectl apply`·`helm upgrade`·aws 변경 명령마다 물었습니다. 비슷한 도구들을 비교 조사한 뒤 대상 환경 판단을 넣어, 로컬·개발 대상은 묻지 않게 바꿨습니다.
- **이름 규칙을 추가하면 기본 규칙이 사라짐:** 실제 세션으로 재설치하던 중 skill이 스스로 "설정에 이름을 적으면 기본 목록이 통째로 바뀐다"는 문제를 찾아 보고했습니다. 설정의 이름 규칙이 기본 목록에 더해지도록 고쳤습니다.

## 요구 사항
- Claude Code (2.1.330에서 시험), Node.js
- 검토 절차에는 해당 도구(terraform/tofu, kubectl, aws 등)가 PATH에 있어야 합니다.

## 한계
- **guard hook은 명령 문자열만 봅니다.** 스크립트 파일, 변수로 조립한 명령, `eval`은 보지 못합니다. 의도적인 우회는 막지 못합니다.
- **대상 판단은 이름에 기댑니다.** 운영 클러스터 이름이 `main`처럼 아무 표시가 없으면 "판단 불가"로 묻습니다. 반대로 운영인데 이름에 `dev`가 들어 있으면 통과시킬 수 있으니, 설치할 때 이 PC의 context·profile 이름을 확인해 규칙을 맞춥니다.
- **대화형 확인 창은 확인하지 못했습니다.** 실제 세션 시험은 `-p` 모드라 ask가 거부로 처리되는 것까지만 봤습니다.
- **kubectl·helm·argocd·aws 판정은 단위 시험만 했습니다.** 실제 클러스터와 계정에서는 돌려보지 않았습니다. `gcloud`·`az`는 동사만 보는 거친 판정입니다.
- 정적 점검은 HCL을 완전히 해석하지 않는 근사치입니다. 데이터 손실 외의 보안 설정 검사는 Checkov·Trivy가 훨씬 넓습니다.
- Windows에서만 시험했습니다.

## 참고
- [Hooks reference: PreToolUse의 deny·ask와 auto mode](https://code.claude.com/docs/en/hooks)
- [Terraform JSON output format](https://developer.hashicorp.com/terraform/internals/json-format)
- [Terraform S3 backend 권한](https://developer.hashicorp.com/terraform/language/backend/s3)
- [What 33 public cases of AI agents breaking production have in common](https://www.eon.io/blog/ai-agent-production-incidents)
- [Using Claude Code With Terraform: A Least-Privilege Setup (Scalr)](https://scalr.com/learning-center/using-claude-code-with-terraform-a-least-privilege-setup)
