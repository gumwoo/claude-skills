# claude-skills

실무에서 직접 만들어 쓰는 [Claude Code](https://code.claude.com) skill 모음입니다.
skill마다 폴더가 하나씩 있고, 각 폴더의 `README.md`에 만든 이유, 설계 판단, 검증 과정, 알려진 한계를 정리합니다.

## Skills

| Skill | 하는 일 |
|---|---|
| [new-project-setup](new-project-setup/) | 저장소에 검증 명령, 최소 지침 파일, 권한 규칙, Stop hook, verify skill, 읽기 전용 리뷰어를 설치한다 |

## 설치

쓰고 싶은 skill 폴더를 `~/.claude/skills/` 아래에 복사하면 됩니다.

```bash
git clone https://github.com/gumwoo/claude-skills.git
cp -r claude-skills/new-project-setup ~/.claude/skills/
```

새 Claude Code 세션에서 `/skill 이름`으로 실행합니다. 각 skill의 요구 사항과 사용법은 해당 폴더의 README를 보세요.

## License

[MIT](LICENSE)
