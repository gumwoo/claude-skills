# claude-skills

제가 실제 작업에서 만들어 쓰는 [Claude Code](https://code.claude.com) skill들입니다. 폴더마다 README에 왜 만들었는지, 어떻게 시험했는지, 아직 못 한 게 뭔지 적어 두었습니다.

- [new-project-setup](new-project-setup/): 새 저장소에 CLAUDE.md, 권한 규칙, 작업이 끝날 때 테스트를 돌리는 hook을 깔아 줍니다.
- [infra-change-guard](infra-change-guard/): 인프라를 바꾸기 전에 대상 환경과 Terraform plan을 확인하고, 사람이 승인한 plan만 적용하게 합니다.
- [korean-product-ui](korean-product-ui/): 한국어 서비스 화면을 실서비스처럼 만들고, 실제 브라우저로 그려서 한글 줄바꿈·금액 표기·말투·다크패턴을 검사합니다.

쓰고 싶은 폴더를 `~/.claude/skills/` 아래에 복사하면 됩니다.

```
git clone https://github.com/gumwoo/claude-skills.git
cp -r claude-skills/infra-change-guard ~/.claude/skills/
```

[MIT License](LICENSE)
