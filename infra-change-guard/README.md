# infra-change-guard

Claude Code가 인프라를 바꾸기 전에 멈춰서 확인하게 만드는 skill입니다. 어느 계정과 클러스터를 건드리는지 먼저 보고, Terraform plan에서 데이터가 날아갈 변경을 찾아 사람에게 보여 준 뒤, 사람이 승인한 그 plan만 적용합니다.

RDS를 교체하고 S3 버킷을 지우는 plan을 넣으면 이렇게 나옵니다(일부).

```
$ node scripts/plan-check.mjs tfplan

생성 4 · 변경 3 · 교체 1 · 삭제 2 · 변화 없음 1

| HIGH   | aws_db_instance.main     | 데이터를 가진 리소스를 교체(삭제 후 재생성)합니다 — 교체 원인 속성: engine_version |
| HIGH   | aws_db_instance.reports  | 삭제 보호(deletion_protection)를 끕니다 |
| HIGH   | aws_s3_bucket.uploads    | 데이터를 가진 리소스를 삭제합니다 |
| MEDIUM | aws_security_group.bastion | 인터넷 전체(0.0.0.0/0)에 포트 22를 엽니다 |

판정: HIGH 6건 — 사람이 이 plan을 직접 승인하기 전에는 적용하지 않는다.
```

hook을 설치해 두면 에이전트가 `terraform destroy -auto-approve`를 실행하려 할 때 이 메시지와 함께 막힙니다.

```
[infra-guard] terraform destroy는 에이전트가 실행하지 않는다. 삭제가 필요하면 사람에게 plan -destroy 결과를 보이고 사람이 직접 실행하게 한다.
```

## 사용법

```
git clone https://github.com/gumwoo/claude-skills.git
cp -r claude-skills/infra-change-guard ~/.claude/skills/
```

설치하면 Claude가 인프라를 바꾸려 할 때 알아서 이 skill을 씁니다. 직접 부를 수도 있습니다.

```
/infra-change-guard                  # 지금 변경사항 검토
/infra-change-guard install local    # 차단 hook을 이 저장소에만, git에 안 올라가게 설치
/infra-change-guard install commit   # 팀과 공유하도록 설치
```

검토는 대상 환경 확인, `terraform plan -out=tfplan`, 위험 분석, 보고 순서로 진행됩니다. 승인을 받으면 `terraform apply tfplan`으로 그 plan만 적용하고, 끝나면 `plan -detailed-exitcode`로 남은 변경이 없는지 확인합니다. Node.js가 필요하고, 스크립트는 모두 읽기 전용입니다.

## hook이 막는 것과 묻는 것

| 판정 | 대상 |
|---|---|
| 항상 막음 | `destroy`, `apply -destroy`, `-auto-approve`, plan 파일 없는 `apply`, `state rm/push`, `force-unlock`, namespace·PV·PVC·CRD·node 삭제, `kubectl delete --all`, `argocd app delete`, 버킷·백업·스냅샷·RDS·DynamoDB 삭제, S3 버전 관리 끄기, `.tfstate` 삭제 |
| 항상 물음 | 저장된 plan으로 `apply`, `state mv`, `import` |
| 운영이거나 판단이 안 될 때만 물음 | `kubectl apply/delete/scale/rollout restart`, `helm install/upgrade/uninstall`, `argocd app sync`, aws·gcloud·az의 변경 명령 |
| 그냥 통과 | 대상이 로컬·개발로 확인될 때(`kind-*` context, `--profile dev` 등), 읽기 전용 명령 |

운영인지는 kube context·namespace, aws profile, gcloud project, Terraform workspace와 경로 이름에 `prod`, `production`, `prd`, `live`가 들어 있는지로 봅니다. 이름에 아무 표시가 없으면 판단할 수 없으니 묻습니다. 회사 클러스터처럼 이름만으로 알 수 없는 것은 설치할 때 skill이 하나씩 물어보고 `infra-guard.json`에 적어 둡니다.

## 만들면서 고민한 것

시작은 AI 에이전트가 운영 환경을 망가뜨린 공개 사례 33건을 정리한 [글](https://www.eon.io/blog/ai-agent-production-incidents)이었습니다. 지침 파일에 "절대 지우지 마라"라고 써 놨는데도 지운 경우가 여럿 있었고, 에이전트가 "복구 불가"라고 보고했는데 사실은 복구가 되는 경우도 있었습니다. 실제로 Claude Code가 `terraform destroy`로 운영 DB와 자동 스냅샷까지 지운 [사고](https://incidentdatabase.ai/cite/1424/)도 있습니다. 그래서 규칙을 글로 적는 대신 실행 단계에서 막고, 보고할 때는 확인한 것과 못 한 것을 나눠 쓰게 했습니다.

처음 버전은 위험한 명령을 막는 hook이 중심이었습니다. 그런데 찾아보니 이미 [destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)나 [cc-safety-net](https://github.com/kenryu42/cc-safety-net) 같은 훨씬 큰 도구가 있었고, Claude Code의 auto mode도 `terraform destroy`를 기본으로 막고 있었습니다. 그래서 무게를 옮겼습니다. 명령 차단은 검토 절차를 건너뛰지 못하게 하는 정도로만 두고, 비어 있던 쪽인 "plan에서 데이터 손실을 찾고 승인받은 plan만 적용하는 흐름"에 집중했습니다. conftest(OPA)로도 plan을 검사할 수는 있지만 정책을 직접 써야 하고, Trivy에서도 plan의 삭제를 잡는 건 기본 기능이 아니라는 [논의](https://github.com/aquasecurity/trivy/discussions/6492)가 있었습니다.

hook도 처음엔 모든 `kubectl apply`와 `helm upgrade`마다 확인 창을 띄웠습니다. 그러다 위 글에서 Anthropic이 밝힌 수치를 봤습니다. 사용자가 권한 확인 창의 97%를 그냥 승인한다는 것이었고, 그걸 보고 바꿨습니다. 자주 물으면 결국 아무도 읽지 않습니다. 지금은 되돌릴 수 없는 명령만 무조건 막고, 나머지는 대상이 운영으로 보일 때만 묻습니다. 로컬 kind 클러스터에 `kubectl apply`하는 건 그냥 통과합니다.

그래도 hook은 명령 문자열을 보는 장치라 스크립트 파일 안에 숨은 명령은 못 봅니다. 진짜 마지막 방어선은 권한입니다. 그래서 에이전트에게는 plan만 할 수 있는 자격증명을 주고 적용은 사람이나 CI가 하도록 나누는 방법을 [references/plan-only-iam.md](references/plan-only-iam.md)에 정리했습니다.

## 어떻게 확인했나

`node tests/run-tests.mjs`로 156개 시험을 돌립니다. plan 분석은 Terraform이 실제로 만든 plan 두 개로 시험했습니다. 하나는 내장 `terraform_data` 리소스로 만든 것이고, 다른 하나는 AWS provider를 가짜 자격증명으로 오프라인에서 돌려 만든 것입니다. 실제 계정에는 닿지 않았습니다. hook은 명령 86개와 환경별 경우 26개로 시험했습니다. `cd x && …`, `bash -c "…"`, PowerShell의 `$env:AWS_PROFILE=…`, `git commit -m "terraform destroy"` 같은 무해한 문자열도 포함됩니다.

시험용 Terraform 폴더에서 `claude -p`로 실제 세션도 돌렸습니다. skill이 hook을 설치했고, `terraform destroy -auto-approve`는 막혔습니다. 검토를 시키자 plan을 만들고 "state 백업이 없다"는 점까지 짚은 뒤 승인을 물었고, 아무것도 적용하지 않았습니다. 승인 후 `terraform apply tfplan`은 확인 창 대상으로 잡혔습니다.

시험하면서 고친 것들입니다.

- AWS provider는 `delete_automated_backups`의 기본값이 `true`라서, DB를 만들 때마다 경고가 떴습니다. 손으로 만든 시험 데이터만 썼다면 몰랐을 문제입니다.
- `deletion_protection = var.x`처럼 변수로 넘어오는 값을 "보호 안 됨"으로 단정하고 있었습니다.
- 재설치 시험 중에 skill이 직접 "설정에 이름을 추가하면 기본 규칙이 통째로 사라진다"는 문제를 찾아 보고했습니다.

개인 프로젝트의 Terraform 코드(.tf 40개)에 정적 점검을 돌렸을 때는 11건이 나왔는데, 코드를 열어 보니 전부 실제로 적혀 있는 값이었습니다.

## 한계

- 명령 문자열만 봅니다. 스크립트나 변수로 조립한 명령은 못 막습니다.
- 운영 여부를 이름으로 판단합니다. 운영 클러스터 이름에 `dev`가 들어 있으면 통과시킵니다.
- 대화형 세션의 확인 창은 직접 보지 못했습니다. `-p` 모드에서 거부되는 것까지만 확인했습니다.
- kubectl·helm·aws 판정은 실제 클러스터와 계정에서 돌려보지 않았습니다.
- 정적 점검은 HCL을 완전히 해석하지 않는 근사치입니다.
- Windows에서만 시험했습니다.
