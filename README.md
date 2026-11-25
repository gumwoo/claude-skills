# claude-skills

제가 실제 작업에서 만들어 쓰는 [Claude Code](https://code.claude.com) skill들입니다. 폴더마다 README에 왜 만들었는지, 어떻게 시험했는지, 아직 못 한 게 뭔지 적어 두었습니다.

- [new-project-setup](new-project-setup/): 새 저장소에 CLAUDE.md, 권한 규칙, 작업이 끝날 때 테스트를 돌리는 hook을 깔아 줍니다.
- [infra-change-guard](infra-change-guard/): 인프라를 바꾸기 전에 대상 환경과 Terraform plan을 확인하고, 사람이 승인한 plan만 적용하게 합니다.
- [korean-product-ui](korean-product-ui/): 한국어 서비스 화면을 실서비스처럼 만들고, 실제 브라우저로 그려서 한글 줄바꿈·금액 표기·말투·다크패턴을 검사합니다.
- [race-check](race-check/): 재고·좌석·쿠폰처럼 공유 상태를 바꾸는 API에 요청을 동시에 보내 초과 판매나 중복 처리가 생기는지 확인하고 고칩니다.
- [engineering-records](engineering-records/): 작업이 끝나면 트러블슈팅·개선·결정 기록이 필요한지 판정해 저장소 규칙대로 쓰고, 문서 속 숫자가 측정 원자료와 맞는지 검사합니다.
- [review-verify](review-verify/): 다른 AI나 동료가 쓴 코드 리뷰를 받으면, 리뷰가 본 커밋·인용한 코드·CI 상태부터 대조하고 주장마다 맞음/틀림/이미 고쳐짐을 판정한 뒤 맞는 것만 고칩니다.
- [cloud-cost-check](cloud-cost-check/): 클라우드 견적·사이징과 Terraform 구성을 요구사항과 대조해, 산식 오류와 빠진 비용을 찾고 과하게 잡은 곳과 모자란 곳을 근거와 함께 판정합니다.
- [hwpx-deliver](hwpx-deliver/): 한컴오피스 없이 고객에게 낼 한글 문서(HWPX)와 같은 모양의 PDF를 만듭니다. 회의록·RFP를 읽어 문장마다 근거를 붙이고, 받은 HWPX 양식을 서식 그대로 채우며, 내기 전에 대화체·자리표시자·원자료와 다른 숫자를 검사합니다. 한컴 2022와 대조해 맞췄습니다(채운 양식의 PDF와 .hwp 읽기는 아직).

쓰고 싶은 폴더를 `~/.claude/skills/` 아래에 복사하면 됩니다.

```
git clone https://github.com/gumwoo/claude-skills.git
cp -r claude-skills/infra-change-guard ~/.claude/skills/
```

[MIT License](LICENSE)
