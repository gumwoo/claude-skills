# 에이전트에게 plan만 할 수 있는 권한 주기

차단 hook은 에이전트의 실수를 줄이는 장치이고, 명령 문자열만 보기 때문에 우회될 수 있습니다.
되돌릴 수 없는 변경을 확실히 막는 방법은 **에이전트가 쓰는 자격증명이 애초에 그 일을 할 수 없게 하는 것**입니다.

권장 구성은 자격증명을 둘로 나누는 것입니다.

| 누가 | 할 수 있는 것 |
|---|---|
| 에이전트(Claude Code 세션) | 읽기 + `terraform plan`(state 읽기, plan 중 잠금) |
| 사람 또는 CI 파이프라인 | `terraform apply`, 삭제, 백업 관리 |

아래는 AWS 예시입니다. **그대로 쓰지 말고, 자기 backend 구성과 Terraform 버전에 맞는지 확인한 뒤 쓰세요.**

## AWS: plan 전용 역할

1. 읽기 권한: AWS 관리형 정책 `ReadOnlyAccess`를 붙입니다. plan의 refresh가 리소스를 조회하는 데 필요합니다.
   - 이 정책은 S3 객체 읽기도 허용합니다. 민감한 데이터가 든 버킷이 있으면 별도로 거부하거나 더 좁은 정책을 쓰세요.
2. state 읽기와 plan 중 잠금: backend 구성에 맞춰 아래 중 하나를 추가합니다.

S3 backend + S3 잠금 파일(`use_lockfile = true`)을 쓰는 경우:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "StateList", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<state-bucket>" },
    { "Sid": "StateRead", "Effect": "Allow", "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<state-bucket>/<key-prefix>/terraform.tfstate" },
    { "Sid": "PlanLock", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<state-bucket>/<key-prefix>/terraform.tfstate.tflock" }
  ]
}
```

S3 backend + DynamoDB 잠금 테이블을 쓰는 경우, `PlanLock` 대신:

```json
{ "Sid": "PlanLock", "Effect": "Allow",
  "Action": ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
  "Resource": "arn:aws:dynamodb:<region>:<account-id>:table/<lock-table>" }
```

backend에 `kms_key_id`로 state를 암호화했다면 그 키에 대한 `kms:Decrypt`, `kms:Encrypt`, `kms:GenerateDataKey`도 필요합니다(잠금 파일 쓰기용).

state 파일 자체(`terraform.tfstate`)에는 쓰기 권한을 주지 않습니다. 그래서 이 역할로는 apply가 state를 저장하지 못하고 실패합니다.

3. 확인: IAM 정책 시뮬레이터로 위험한 동작이 거부되는지 봅니다. 읽기 전용 호출입니다.

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<account-id>:role/<agent-plan-role> \
  --action-names rds:DeleteDBInstance s3:DeleteBucket ec2:TerminateInstances backup:DeleteRecoveryPoint \
  --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output table
```

네 동작이 모두 `implicitDeny` 또는 `explicitDeny`면 됩니다.

## 백업은 에이전트가 닿지 않는 곳에

AI 에이전트 사고 분석에서 복구된 데이터는 모두 에이전트 권한이 닿지 않는 사본에서 나왔습니다.

- 스냅샷·백업을 다른 계정으로 복사합니다(AWS Backup 교차 계정 복사 등).
- 가능하면 삭제할 수 없게 잠급니다(AWS Backup Vault Lock, S3 Object Lock).
- 시뮬레이터로 에이전트 역할이 `backup:DeleteRecoveryPoint`, `rds:DeleteDBSnapshot`, `s3:DeleteObjectVersion`을 할 수 없는지 확인합니다.

## Kubernetes

에이전트가 쓰는 kube context는 읽기 전용 권한(예: 기본 ClusterRole `view`에 바인딩한 계정)으로 만듭니다. 변경은 사람이 쓰는 context나 GitOps(Argo CD 등) 파이프라인이 합니다.

## 참고
- Terraform S3 backend 권한: https://developer.hashicorp.com/terraform/language/backend/s3
- IAM 정책 시뮬레이터: https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html
