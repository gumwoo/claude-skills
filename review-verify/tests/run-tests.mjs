#!/usr/bin/env node
// review-verify 시험. 임시 git 저장소와 가짜 gh로 anchors.mjs, pr-state.mjs를 확인한다.
// 사용법: node tests/run-tests.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, extract, nameTerms } from "../scripts/anchors.mjs";
import { collect, expectPushRun, expectRun, globToRe, matchList, parseWorkflow, verdict } from "../scripts/pr-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ANCHORS = path.join(ROOT, "scripts", "anchors.mjs");
const PRSTATE = path.join(ROOT, "scripts", "pr-state.mjs");
const FAKE_GH = path.join(HERE, "fake-gh.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "review-verify-test-"));
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};

function sh(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const g = (cwd, ...args) => {
  const r = sh(cwd, "git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out.trim();
};
const write = (repo, file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const commit = (repo, msg) => { g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", msg); return g(repo, "rev-parse", "HEAD"); };

// ---------- 시험 저장소 ----------
const REPO = path.join(TMP, "shop");
fs.mkdirSync(REPO);
g(REPO, "init", "-q", "-b", "main");
g(REPO, "config", "user.email", "test@example.com");
g(REPO, "config", "user.name", "test");
g(REPO, "config", "core.autocrlf", "false");

write(REPO, "README.md", "# shop\n\n위반 케이스 24개를 막는다.\n");
write(REPO, "src/order/OrderService.java", [
  "package order;",
  "public class OrderService {",
  "  public void cancel(long id) {",
  "    repo.markCancelled(id);",
  "  }",
  "}",
  "",
].join("\n"));
write(REPO, "src/legacy/OldHelper.java", "class OldHelper { void legacyRetry() {} }\n");
write(REPO, ".github/workflows/backend.yml", [
  "name: Backend",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "    paths:",
  "      - 'src/**'",
  "      # 데이터도 테스트 입력이다",
  "      - '.github/workflows/backend.yml'",
  "jobs: {}",
  "",
].join("\n"));
write(REPO, ".github/workflows/docs.yml", "name: Docs\non:\n  pull_request:\n    paths-ignore: ['src/**']\njobs: {}\n");
write(REPO, ".github/workflows/lint.yml", "name: \"Lint\"\non: [push, pull_request]\njobs: {}\n");
write(REPO, ".github/workflows/nightly.yml", "name: Nightly\non:\n  schedule:\n    - cron: '0 0 * * *'\njobs: {}\n");
const C1 = commit(REPO, "base");

g(REPO, "checkout", "-q", "-b", "feat/coupon");
write(REPO, "src/coupon/CouponService.java", [
  "package coupon;",
  "public class CouponService {",
  "  public boolean issue(long userId) {",
  "    int left = repo.remaining();",
  "    if (left > 0) { repo.save(left - 1); return true; }",
  "    return false;",
  "  }",
  "  public void refund(long id, long amount) { gateway.cancelAll(id); }",
  "}",
  "",
].join("\n"));
write(REPO, "src/order/util/OrderService.java", "package order.util;\nclass OrderService {}\n");
fs.rmSync(path.join(REPO, "src/legacy/OldHelper.java"));
const C2 = commit(REPO, "쿠폰 발급 추가");

write(REPO, "src/coupon/CouponService.java", fs.readFileSync(path.join(REPO, "src/coupon/CouponService.java"), "utf8").replace("gateway.cancelAll(id)", "gateway.cancel(id, amount)"));
write(REPO, "docs/notes.md", "메모\n");
const C3 = commit(REPO, "부분 환불");

// ---------- anchors: 글에서 꺼내기 ----------
console.log("\n# anchors: 글에서 꺼내기");
{
  const e = extract([
    "HEAD는 `6e9a934...`이고 이전 리뷰는 1930ab7 기준.",
    "숫자 1234567과 2026-11-24는 SHA가 아니다.",
    "`src/coupon/CouponService.java:5` 와 src/order/OrderService.java#L3-L4, app.js:12~14 를 봐.",
    "버전 1.2.3, 설정 `--no-verify`, 값 `200`, `true`.",
    "`Foo.bar()` 와 `Repo::find`, `@Valid`, `x.y.z`, `List<String>`, `HEAD`.",
    "링크 https://github.com/o/r/blob/abc1234/src/x/Y.java#L10-L12 와 https://github.com/o/r/pull/77 , CI run https://github.com/o/r/actions/runs/555",
    "PR #12 와 #13, Dockerfile, https://example.com/a/b.json",
  ].join("\n"));
  const shas = e.shas.map((s) => s.sha);
  ok(shas.includes("6e9a934") && shas.includes("1930ab7"), "SHA를 찾고 말줄임(...)을 떼어 읽음", shas.join(","));
  ok(!shas.includes("1234567") && e.maybeShas.some((s) => s.sha === "1234567"), "숫자만으로 된 7자리는 SHA 후보로만 둠");
  ok(shas.includes("abc1234"), "GitHub blob 링크의 커밋도 SHA로 꺼냄");
  const p = Object.fromEntries(e.paths.map((x) => [x.path, x]));
  ok(p["src/coupon/CouponService.java"]?.line === 5, "경로:줄", JSON.stringify(e.paths));
  ok(p["src/order/OrderService.java"]?.line === 3 && p["src/order/OrderService.java"]?.lineEnd === 4, "경로#L3-L4");
  ok(p["app.js"]?.line === 12 && p["app.js"]?.lineEnd === 14, "경로:12~14");
  ok(p["src/x/Y.java"]?.line === 10 && p["src/x/Y.java"]?.ref === "abc1234", "GitHub blob 링크의 경로·줄·커밋");
  ok(p["Dockerfile"], "확장자 없는 Dockerfile");
  ok(!e.paths.some((x) => /1\.2\.3|example\.com|a\/b\.json/.test(x.path)), "버전 번호와 일반 URL은 경로로 보지 않음", e.paths.map((x) => x.path).join(","));
  const names = e.names.map((n) => n.raw);
  ok(names.includes("Foo.bar()") && names.includes("Repo::find") && names.includes("@Valid"), "백틱 안 코드 이름", names.join(","));
  ok(!names.some((n) => /--no-verify|^200$|^true$|^HEAD$|6e9a934/.test(n)), "옵션·숫자·흔한 낱말·SHA는 이름으로 보지 않음", names.join(","));
  ok(e.refs.includes("#77") && e.refs.includes("#12") && e.refs.includes("run555"), "PR·실행 번호", e.refs.join(","));
  ok(JSON.stringify(nameTerms("Foo.bar()")) === '["bar","Foo"]', "Foo.bar() → bar, Foo");
  ok(JSON.stringify(nameTerms("Repo::find")) === '["find","Repo"]', "Repo::find → find, Repo");
  ok(JSON.stringify(nameTerms("x.y.zed")) === '["zed"]', "소문자 소유자는 따로 찾지 않음");
  ok(JSON.stringify(nameTerms("List<String>")) === '["List"]', "제네릭 괄호는 뗌");
  ok(nameTerms("a == b").length === 0 && nameTerms("this").length === 0 && nameTerms("finally").length === 0, "식, 흔한 낱말, 예약어는 버림");
  const multi = extract("`RunRequest`에 `@Valid / @NotNull / @NotBlank`, `issue, refund`").names.map((n) => n.raw);
  ok(["@Valid", "@NotNull", "@NotBlank", "issue", "refund"].every((x) => multi.includes(x)), "한 백틱에 / 나 , 로 여럿 쓴 이름을 나눔", multi.join(","));
  const fenced = extract("흐름:\n```\nP01 실행 클릭\n→ cancelActiveRun() 실행\n→ repo.findById(id)\n→ Run(x) 와 print(y)\n```\n").names.map((n) => n.raw);
  ok(fenced.includes("cancelActiveRun()") && fenced.includes("repo.findById()"), "코드 블록 안의 호출 모양 이름", fenced.join(","));
  ok(!fenced.some((x) => /^(Run|print)\(\)$/.test(x)), "코드 블록의 짧은·평범한 호출은 버림", fenced.join(","));
}

// ---------- anchors: 저장소와 대조 ----------
console.log("\n# anchors: 저장소와 대조");
{
  const r = check(`HEAD ${C3.slice(0, 7)} 다시 봤어. 이전 ${C1.slice(0, 7)}.`, { repo: REPO });
  ok(r.shas.find((s) => s.sha === C3.slice(0, 7))?.status === "OK", "지금 HEAD SHA는 OK");
  ok(r.shas.find((s) => s.sha === C1.slice(0, 7))?.status === "BEHIND" && !r.reviewPoint, "글에 HEAD가 있으면 과거 SHA는 기준점이 아님(과거 언급)");
}
{
  const text = [
    `리뷰 기준 ${C2.slice(0, 7)}.`,
    "1. `src/coupon/CouponService.java:8` 의 `refund()` 가 amount를 무시한다.",
    "2. `OrderService.cancel()` 이 이벤트를 두 번 낸다. src/order/OrderService.java:99 참고.",
    "3. `CouponService.verifyLimit()` 이 없다. `src/legacy/OldHelper.java` 의 `legacyRetry` 도.",
    "4. `NoSuchClass.issue()` 와 deadbee1 커밋.",
    "5. `OrderService.java` 와 README.md, docs/notes.md.",
    "6. 발급은 src/coupon/CouponService.java:3 에서 시작한다.",
  ].join("\n");
  const r = check(text, { repo: REPO, base: "main" });
  const P = (k) => r.paths.find((p) => p.raw.startsWith(k));
  const N = (k) => r.names.find((n) => n.raw === k);
  ok(r.reviewPoint === C2, "글에 HEAD가 없으면 가장 가까운 과거 SHA를 리뷰 기준점으로 추정", r.reviewPoint);
  ok(r.shas.find((s) => s.sha === "deadbee1")?.status === "MISS", "없는 SHA는 MISS");
  const coupon = P("src/coupon/CouponService.java:8");
  ok(coupon?.status === "OK" && coupon.changedSinceReview && coupon.inPr, "리뷰 뒤 바뀐 파일, PR에서 바뀐 파일 표시");
  ok(coupon?.lineChanged === true && coupon.oldText.includes("gateway.cancelAll(id)"), "리뷰 시점 줄 내용을 보여 주고, 그 줄이 리뷰 뒤 바뀌었다고 표시", JSON.stringify(coupon));
  const same = P("src/coupon/CouponService.java:3");
  ok(same?.lineChanged === false && same.lineNow === 3 && same.text.includes("issue(long userId)"), "파일은 바뀌었어도 그 줄이 그대로면 '그대로'로 표시하고 지금 줄을 보여 줌", JSON.stringify(same));
  ok(P("src/order/OrderService.java:99")?.status === "RANGE", "줄 번호가 파일 밖이면 RANGE");
  const old = P("src/legacy/OldHelper.java");
  ok(old?.status === "MISS" && /마지막으로 나온 커밋/.test(old.note), "지워진 파일은 MISS + 마지막 커밋", old?.note);
  ok(P("OrderService.java")?.status === "AMBIGUOUS", "같은 이름 파일이 둘이면 AMBIGUOUS");
  ok(P("README.md")?.status === "OK" && P("README.md").file === "README.md", "루트 경로가 정확히 맞으면 그 파일");
  ok(P("docs/notes.md")?.changedSinceReview === true, "리뷰 뒤 새로 생긴 파일도 표시");
  ok(N("refund()")?.status === "OK" && N("refund()").changedSinceReview, "있는 이름은 OK, 리뷰 뒤 바뀜 표시");
  ok(N("OrderService.cancel()")?.status === "OK" && N("OrderService.cancel()").where[0].startsWith("src/order/OrderService.java"), "소유자가 있는 파일의 위치를 먼저 보여 줌", N("OrderService.cancel()")?.where.join(","));
  ok(N("CouponService.verifyLimit()")?.status === "MISS" && /이력에도 없는/.test(N("CouponService.verifyLimit()").note), "지어낸 이름은 MISS(이력에도 없음)");
  ok(N("legacyRetry")?.status === "MISS" && /마지막으로 넣거나 뺀 커밋/.test(N("legacyRetry").note), "지워진 이름은 MISS + 마지막 커밋", N("legacyRetry")?.note);
  ok(N("NoSuchClass.issue()")?.status === "PARTIAL", "흔한 메서드만 있고 소유 클래스가 없으면 PARTIAL");
}
{
  // 독립 리뷰에서 나온 경우들
  const r = check(`이 회귀는 ${C2.slice(0, 7)}에서 들어왔다. \`refund()\``, { repo: REPO });
  ok(!r.reviewPoint, "'X에서 들어왔다' 같은 이력 언급은 리뷰 기준점으로 삼지 않음");
  ok(check(`Reviewed at ${C2.slice(0, 7)}.`, { repo: REPO }).reviewPoint === C2, "'Reviewed at X'는 기준점");
  const e2 = check("Node.js 22, Next.js에서 돈다. 색 `#1a73e8cc`, 배경 #1a73e8cc", { repo: REPO });
  ok(!e2.paths.length && !e2.shas.length && !e2.names.length, "Node.js 같은 제품 이름, 색상 코드는 경로·SHA·이름으로 보지 않음", JSON.stringify([e2.paths, e2.shas, e2.names]));
  const sug = check("고치려면:\n```suggestion\nif (!validateCouponLimit(userId)) return false;\n```\n```diff\n-    int left = repo.remaining();\n+    int left = repo.decrementIfPositive();\n```\n", { repo: REPO });
  ok(sug.proposed.map((x) => x.name).includes("validateCouponLimit") && !sug.names.some((n) => /validateCouponLimit/.test(n.raw)), "suggestion 속 이름은 '제안된 이름'으로 따로(MISS 아님)", JSON.stringify(sug.proposed));
  ok(sug.diffAdded.some((x) => x.name === "decrementIfPositive" && !x.exists), "diff + 줄 이름은 따로 모으고 지금 없는지 표시", JSON.stringify(sug.diffAdded));
  ok(!sug.names.some((n) => n.status === "MISS"), "제안된 이름을 MISS로 세지 않음", JSON.stringify(sug.names));
  ok(sug.names.some((n) => n.raw === "repo.remaining()" && n.status === "OK"), "diff의 - 줄 이름은 지금 코드와 대조");
  const abs = check("at /home/dev/shop/src/coupon/CouponService.java:3 and C:\\work\\shop\\src\\order\\OrderService.java:4", { repo: REPO });
  ok(abs.paths.every((p) => p.status === "OK") && abs.paths.length === 2, "절대 경로(리눅스·윈도우)를 저장소 안 경로로 줄여 봄", JSON.stringify(abs.paths.map((p) => [p.path, p.status, p.file])));
  g(REPO, "branch", "feature/coupon-limit");
  const br = check("https://github.com/o/r/blob/feature/coupon-limit/src/coupon/CouponService.java#L3", { repo: REPO });
  ok(br.paths[0]?.status === "OK" && br.paths[0].ref === "feature/coupon-limit", "브랜치 이름에 / 가 있는 GitHub 링크", JSON.stringify(br.paths));
  g(REPO, "branch", "-D", "feature/coupon-limit");
  // 재검토에서 나온 경우들
  const hist = check(`이 버그는 ${C2.slice(0, 7)} 에서 들어왔고 지금도 src/coupon/CouponService.java:8 에서 금액을 무시합니다.`, { repo: REPO });
  ok(!hist.reviewPoint && hist.paths[0]?.status === "OK" && hist.paths[0].text.includes("gateway.cancel(id, amount)"), "문장 어딘가의 '지금' 때문에 이력 SHA를 기준점으로 잡지 않고, 줄은 지금 코드로 대조", JSON.stringify([hist.reviewPoint, hist.paths[0]]));
  for (const t of [`HEAD는 \`${C2.slice(0, 7)}...\`이고`, `HEAD가 **\`${C2.slice(0, 7)}\`**로 올라갔고`, `리뷰 기준 ${C2.slice(0, 7)}.`, `${C2.slice(0, 7)} 기준으로 봤어`, `as of ${C2.slice(0, 7)}`]) {
    ok(check(t, { repo: REPO }).reviewPoint === C2, `기준점 표현: ${t.replace(C2.slice(0, 7), "X")}`);
  }
  const ind = check("1. 고치세요.\n\n   ```diff\n   --- a/src/coupon/CouponService.java\n   +++ b/src/coupon/CouponService.java\n   @@ -4 +4 @@\n   -    int left = repo.remaining();\n   +    return enforceLimit(left);\n   ```\n", { repo: REPO });
  ok(!ind.names.some((n) => n.status === "MISS") && !ind.paths.some((p) => p.status !== "OK") && ind.diffAdded.some((x) => x.name === "enforceLimit"), "목록 안에 들여 쓴 diff, diff 머리 줄", JSON.stringify([ind.names, ind.paths, ind.diffAdded]));
  const gone = check("/home/dev/shop/src/legacy/OldHelper.java:1 과 C:\\work\\shop\\src\\legacy\\OldHelper.java:1", { repo: REPO });
  ok(gone.paths.length === 2 && gone.paths.every((p) => p.status === "MISS" && /마지막으로 나온 커밋/.test(p.note)), "절대 경로로 쓴 지워진 파일도 이력을 찾음", JSON.stringify(gone.paths.map((p) => p.note)));
  // 새 리뷰어가 찾은 경우들
  const wrongOwner = check("`OrderService.issue()`가 두 번 발급한다", { repo: REPO });
  ok(wrongOwner.names[0]?.status === "PARTIAL" && /CouponService/.test(wrongOwner.names[0].note), "다른 클래스에만 있는 메서드는 PARTIAL", JSON.stringify(wrongOwner.names[0]));
  const args = check("`refund(orderId, amount)`가 amount를 무시하고 `fooBar(a, b)`도 있다", { repo: REPO });
  ok(args.names.some((n) => n.raw === "refund(orderId, amount)" && n.status === "OK") && args.names.some((n) => n.raw === "fooBar(a, b)" && n.status === "MISS"), "인자가 있는 호출 이름", JSON.stringify(args.names.map((n) => [n.raw, n.status])));
  for (const t of [`${C2.slice(0, 7)} 커밋을 기준으로 봤습니다`, `${C2.slice(0, 7)}를 기준으로 리뷰`, `Head SHA: ${C2.slice(0, 7)}`, `Reviewed commit: ${C2.slice(0, 7)}`]) {
    ok(check(t, { repo: REPO }).reviewPoint === C2, `기준점 표현: ${t.replace(C2.slice(0, 7), "X")}`);
  }
  const perma = check(`https://github.com/o/r/blob/${C2}/src/coupon/CouponService.java#L8 여기서 금액을 무시`, { repo: REPO });
  ok(perma.reviewPoint === C2 && perma.paths[0].lineChanged === true, "퍼머링크의 커밋은 리뷰어가 본 시점", JSON.stringify([perma.reviewPoint, perma.paths[0]?.lineChanged]));
  let rev = null;
  try { rev = check("src/coupon/CouponService.java:9-3 참고", { repo: REPO }); } catch (e) { rev = e; }
  ok(rev?.paths?.[0]?.status === "OK" && rev.paths[0].line === 3 && rev.paths[0].lineEnd === 9, "거꾸로 쓴 줄 범위(9-3)에서 죽지 않고 3-9로 읽음", rev instanceof Error ? rev.message : JSON.stringify(rev.paths));
}
{
  // 한글 파일명: git grep이 경로를 인용하지 않아야 다른 목록과 맞는다
  const K = path.join(TMP, "korean");
  fs.mkdirSync(K);
  g(K, "init", "-q", "-b", "main"); g(K, "config", "user.email", "t@example.com"); g(K, "config", "user.name", "t");
  write(K, "docs/주문.md", "# 주문\nissueCoupon 을 부른다\n");
  const k1 = commit(K, "a");
  write(K, "docs/주문.md", "# 주문\nissueCoupon 을 부른다\n추가\n");
  commit(K, "b");
  const r = check(`HEAD는 ${k1.slice(0, 7)}. \`issueCoupon\``, { repo: K });
  ok(r.names[0]?.where[0] === "docs/주문.md:2" && r.names[0].changedSinceReview, "한글 경로를 그대로 보여 주고 리뷰 뒤 바뀐 파일로 표시", JSON.stringify(r.names[0]));
}
{
  // 짧은 SHA가 숫자만으로 된 커밋: 나올 때까지 빈 커밋을 만든다(평균 27번)
  const D = path.join(TMP, "digits");
  fs.mkdirSync(D);
  g(D, "init", "-q", "-b", "main"); g(D, "config", "user.email", "t@example.com"); g(D, "config", "user.name", "t");
  let digitSha = null;
  for (let i = 0; i < 400 && !digitSha; i++) {
    g(D, "commit", "-q", "--allow-empty", "-m", `c${i}`);
    const h = g(D, "rev-parse", "HEAD");
    if (/^\d{7}$/.test(h.slice(0, 7))) digitSha = h;
  }
  g(D, "commit", "-q", "--allow-empty", "-m", "next");
  const r = check(`리뷰 기준 ${digitSha?.slice(0, 7)}, 이슈 번호 1234567`, { repo: D });
  ok(digitSha && r.reviewPoint === digitSha, "숫자만으로 된 짧은 SHA도 실제 커밋이면 기준점으로 읽음", digitSha);
  ok(!r.shas.some((s) => s.sha === "1234567"), "커밋이 아닌 7자리 숫자는 SHA로 세지 않음");
}
{
  const r = check(`https://github.com/o/r/blob/${C2.slice(0, 7)}/src/coupon/CouponService.java#L8 그리고 https://github.com/o/r/blob/${C2.slice(0, 7)}/README.md`, { repo: REPO });
  ok(r.paths.find((p) => p.path === "src/coupon/CouponService.java")?.changedSinceLink, "링크의 커밋 뒤 바뀐 파일 표시");
  ok(!r.paths.find((p) => p.path === "README.md")?.changedSinceLink, "링크 뒤 안 바뀐 파일은 표시 없음");
}
{
  const f = path.join(TMP, "good.md");
  fs.writeFileSync(f, `HEAD ${C3.slice(0, 7)}. \`refund()\` 와 src/coupon/CouponService.java:3 확인.`);
  const okRun = sh(REPO, process.execPath, [ANCHORS, f]);
  ok(okRun.code === 0, "모두 찾으면 종료 코드 0", okRun.out + okRun.err);
  const bad = path.join(TMP, "bad.md");
  fs.writeFileSync(bad, "`whereIsThis()` 를 봐.");
  const badRun = sh(REPO, process.execPath, [ANCHORS, bad]);
  ok(badRun.code === 2 && /MISS/.test(badRun.out), "없는 이름이 있으면 종료 코드 2");
  const stale = path.join(TMP, "stale.md");
  fs.writeFileSync(stale, `기준 ${C2.slice(0, 7)}. \`refund()\``);
  ok(sh(REPO, process.execPath, [ANCHORS, stale]).code === 2, "리뷰 기준점이 HEAD보다 과거면 종료 코드 2");
  const notRepo = fs.mkdtempSync(path.join(TMP, "norepo-"));
  ok(sh(notRepo, process.execPath, [ANCHORS, f]).code === 1, "git 저장소가 아니면 종료 코드 1");
  const stdin = spawnSync(process.execPath, [ANCHORS, "-", "--json"], { cwd: REPO, input: "`refund()`", encoding: "utf8" });
  ok(stdin.status === 0 && JSON.parse(stdin.stdout).names[0].status === "OK", "표준 입력과 --json");
  const empty = path.join(TMP, "empty.md");
  fs.writeFileSync(empty, "방향은 좋아. 머지해도 될 것 같아.");
  const emptyRun = sh(REPO, process.execPath, [ANCHORS, empty]);
  ok(emptyRun.code === 0 && /찾지 못했습니다/.test(emptyRun.out), "위치가 없는 리뷰면 직접 찾으라고 안내");
}

// ---------- pr-state: 경로 필터 ----------
console.log("\n# pr-state: 경로 필터");
ok(globToRe("src/**").test("src/a/b/C.java"), "src/** 는 하위 전체");
ok(!globToRe("*.md").test("docs/a.md") && globToRe("*.md").test("a.md"), "*.md 는 / 를 넘지 않음");
ok(globToRe("**/*.md").test("a.md") && globToRe("**/*.md").test("docs/x/a.md"), "**/*.md 는 루트와 하위 모두");
ok(matchList("src/a.js", ["**.jsx?"]) && matchList("src/a.jsx", ["**.jsx?"]) && !matchList("src/a.jsxx", ["**.jsx?"]), "? 는 앞 글자 0~1개 (문서 예시 '*.jsx?')");
ok(matchList("config/app.yml", ["config/**.ya?ml"]) && matchList("config/app.yaml", ["config/**.ya?ml"]), "config/**.ya?ml 은 .yml과 .yaml");
ok(matchList("v1.10.1", ["v[12].[0-9]+.[0-9]+"]) && !matchList("v3.0.0", ["v[12].[0-9]+.[0-9]+"]), "+ 와 [] (문서 예시 v[12].[0-9]+.[0-9]+)");
ok(globToRe("?a").test("?a") && !globToRe("?a").test("a"), "맨 앞 ? 는 글자 그대로");
ok(matchList("src/gen/X.java", ["src/**", "!src/gen/**"]) === false, "! 로 다시 뺌");
ok(matchList("src/gen/keep.java", ["src/**", "!src/gen/**", "src/gen/keep.java"]) === true, "뒤 패턴이 앞을 덮음");
{
  const w = parseWorkflow(fs.readFileSync(path.join(REPO, ".github/workflows/backend.yml"), "utf8"), "backend.yml");
  ok(w.name === "Backend" && w.pr && JSON.stringify(w.paths) === '["src/**",".github/workflows/backend.yml"]', "블록형 paths 목록(주석 줄 건너뜀)", JSON.stringify(w));
  ok(w.branches === null, "push 쪽 branches를 pull_request 조건으로 읽지 않음");
  const d = parseWorkflow("name: Docs\non:\n  pull_request:\n    paths-ignore: ['src/**', \"*.java\"]\n", "d.yml");
  ok(JSON.stringify(d.pathsIgnore) === '["src/**","*.java"]', "한 줄 paths-ignore 목록");
  ok(parseWorkflow('name: "Lint"\non: [push, pull_request]\n', "l.yml").pr, "on: [push, pull_request]");
  ok(parseWorkflow("on: pull_request\n", "x.yml").name === "x.yml", "name이 없으면 파일 경로가 이름");
  ok(parseWorkflow("name: A\non:\n  - push\n  - pull_request\n", "a.yml").pr, "목록형 on");
  ok(!parseWorkflow(fs.readFileSync(path.join(REPO, ".github/workflows/nightly.yml"), "utf8"), "n.yml").pr, "pull_request가 없으면 PR 워크플로 아님");
  const b = parseWorkflow("name: B\non:\n  pull_request:\n    branches:\n      - main\n      - 'release/**'\n    types: [opened, synchronize]\n", "b.yml");
  ok(JSON.stringify(b.branches) === '["main","release/**"]', "pull_request branches 목록");
  ok(expectRun(b, "release/1.0", ["a"]).expected && !expectRun(b, "dev", ["a"]).expected, "기준 브랜치 필터");
  ok(parseWorkflow("name: T\non:\n  pull_request_target:\n    paths: [a/**]\n", "t.yml").kind === "pull_request_target", "pull_request_target");
  ok(parseWorkflow("name: T\non:\n  push:\n# PR에도 돈다\n  pull_request:\n    paths: ['src/**']\n", "t.yml").pr, "on 블록 안 0열 주석이 블록을 끊지 않음");
  const same = parseWorkflow("name: B\non:\n  pull_request:\n    paths:\n    - 'src/**'\n    - docs/**\n    types:\n    - opened\n    - synchronize\n", "b.yml");
  ok(JSON.stringify(same.paths) === '["src/**","docs/**"]' && JSON.stringify(same.types) === '["opened","synchronize"]' && expectRun(same, "main", ["src/a.ts"]).expected === true, "목록을 키와 같은 깊이에 쓴 YAML", JSON.stringify(same));
  ok(JSON.stringify(parseWorkflow("name: W\non:\n  pull_request:\n    paths: [\n      'web/**',\n      'api/**'\n    ]\n", "w.yml").paths) === '["web/**","api/**"]', "여러 줄에 걸친 [ ] 목록");
  ok(parseWorkflow("name: L\non:\n- push\n- pull_request\n", "l.yml").pr, "최상위 들여쓰기 0의 on 목록");
  const weird = parseWorkflow("name: X\non:\n  pull_request:\n    paths: *common_paths\n    branches:\n", "x.yml");
  ok(expectRun(weird, "main", ["a"]).expected === undefined, "값을 못 읽은 필터는 '필터 없음'이나 '필터 밖'이 아니라 '모름'", JSON.stringify(weird));
  // 세 번째 독립 리뷰에서 나온 경우들
  const alias = parseWorkflow("name: X\non:\n  pull_request:\n    paths: *backend_paths\n", "x.yml");
  ok(expectRun(alias, "main", ["src/a.js"]).expected === undefined, "YAML 별칭(*name)만 있는 paths는 '모름'", JSON.stringify(alias));
  ok(expectRun(parseWorkflow("name: X\non:\n  pull_request:\n    branches: *b\n", "x.yml"), "main", ["a"]).expected === undefined, "별칭 branches도 '모름'");
  ok(JSON.stringify(parseWorkflow("name: X\non:\n  pull_request:\n    paths: &p\n      - 'src/**'\n", "x.yml").paths) === '["src/**"]', "앵커 정의(&name)는 떼고 목록을 읽음");
  const bom = parseWorkflow("\uFEFFname: B\non:\n  pull_request:\n    paths: ['src/**']\n", "b.yml");
  ok(bom.name === "B" && bom.pr && JSON.stringify(bom.paths) === '["src/**"]', "BOM으로 시작하는 워크플로", JSON.stringify(bom));
  const flow = parseWorkflow("name: F\non: {\n  pull_request: { paths: ['src/**'] }\n}\n", "f.yml");
  ok(flow.pr && JSON.stringify(flow.paths) === '["src/**"]', "여러 줄에 걸친 on: { }", JSON.stringify(flow));
  ok(parseWorkflow('name: "Test #1"\non: pull_request\n', "t.yml").name === "Test #1", "따옴표 안의 #은 주석이 아님");
  const push = parseWorkflow("name: T\non:\n  push:\n    branches: ['**']\n", "t.yml");
  ok(!push.pr && push.push && expectPushRun(push.push, "feat/x", ["src/a.js"]).expected === true, "push로만 도는 워크플로도 읽음", JSON.stringify(push));
  ok(expectPushRun(parseWorkflow("on:\n  push:\n    tags: ['v*']\n", "r.yml").push, "feat", ["a"]).expected === false, "태그 push에만 도는 워크플로는 PR 브랜치에 안 돎");
  ok(expectPushRun(parseWorkflow("on:\n  push:\n    paths: ['src/**']\n", "p.yml").push, "feat", ["src/a"]).expected === undefined, "push의 paths는 직전 push와 비교라 확정하지 않고 통과로도 보지 않음");
  const fm = parseWorkflow("name: F\non: { pull_request: { branches: [main], paths: ['src/**'] } }\n", "f.yml");
  ok(fm.pr && JSON.stringify(fm.branches) === '["main"]' && JSON.stringify(fm.paths) === '["src/**"]', "한 줄 { } 형식", JSON.stringify(fm));
  const closed = parseWorkflow("name: C\non:\n  pull_request:\n    types: [closed]\n", "c.yml");
  ok(!expectRun(closed, "main", ["a"]).expected, "types가 closed뿐이면 새 커밋에 돌지 않는 게 정상");
  ok(expectRun(parseWorkflow("name: S\non:\n  pull_request:\n    types: [opened, synchronize]\n", "s.yml"), "main", ["a"]).expected, "types에 synchronize가 있으면 돌아야 함");
  ok(expectRun(parseWorkflow("name: A\non:\n  pull_request:\n    types: [opened, ready_for_review]\n", "a.yml"), "main", ["a"]).expected === null, "synchronize 없이 opened만 있으면 '알 수 없음'(push 뒤에는 안 돎)");
  const td = parseWorkflow("name: P\non:\n  push:\n  pull_request: { types: [closed] }\n", "p.yml");
  ok(td.pr && JSON.stringify(td.types) === '["closed"]' && !expectRun(td, "main", ["a"]).expected, "블록 안의 pull_request: { types: [closed] }", JSON.stringify(td));
  ok(matchList("app/[id]/page.tsx", ["app/\\[id\\]/**"]) && !matchList("app/i/page.tsx", ["app/\\[id\\]/**"]), "\\ 로 이스케이프한 [ ] 는 글자 그대로");
  ok(expectRun(w, "main", ["src/x/A.java"]).expected, "paths에 걸리면 돌아야 함");
  ok(!expectRun(w, "main", ["problems/P1/case.json"]).expected, "paths 밖이면 안 도는 게 필터대로");
  ok(!expectRun(d, "main", ["src/A.java", "B.java"]).expected && expectRun(d, "main", ["docs/a.md"]).expected, "paths-ignore");
}

// ---------- pr-state: PR 상태 ----------
console.log("\n# pr-state: PR 상태");
const ghFile = path.join(TMP, "gh.json");
const prJson = (over = {}) => ({
  number: 42, url: "https://github.com/o/r/pull/42", title: "쿠폰 발급", state: "OPEN", isDraft: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: C3, headRefName: "feat/coupon", baseRefName: "main",
  files: [{ path: "src/coupon/CouponService.java" }, { path: "docs/notes.md" }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Backend" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" },
  ],
  body: "src/coupon/CouponService.java 의 `issue()` 를 고쳤다.", ...over,
});
const runPr = (over, args = [], env = {}) => {
  fs.writeFileSync(ghFile, JSON.stringify(prJson(over)));
  return sh(REPO, process.execPath, [PRSTATE, ...args], { GH_BIN: FAKE_GH, FAKE_GH_FILE: ghFile, ...env });
};
const state = (over) => {
  fs.writeFileSync(ghFile, JSON.stringify(prJson(over)));
  process.env.GH_BIN = FAKE_GH; process.env.FAKE_GH_FILE = ghFile;
  const s = collect({ repo: REPO }); return { s, v: verdict(s) };
};
{
  const r = runPr({});
  ok(r.code === 0 && /모두 성공/.test(r.out), "HEAD 같고 체크 모두 성공이면 종료 코드 0", r.out + r.err);
  const { s } = state({});
  ok(s.workflows.find((w) => w.name === "Backend").status === "RAN" && s.workflows.length === 3, "PR 워크플로만 고르고(Nightly 제외) 돈 것을 표시");
}
{
  const { v } = state({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", workflowName: "Backend" }, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" }, { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" }] });
  ok(v.pending.length === 1 && !v.clean, "진행 중인 체크가 있으면 통과 아님");
}
{
  const { v } = state({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", workflowName: "Backend" }, { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" }, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED", workflowName: "Lint" }, { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" }] });
  ok(v.failed.length === 1 && v.failed[0].name === "test" && v.skipped.length === 1, "실패는 실패, StatusContext SUCCESS는 성공, SKIPPED는 따로 셈");
}
{
  const { v } = state({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SKIPPED", workflowName: "Backend" }, { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" }, { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" }] });
  ok(!v.clean && v.skipped.length === 1, "테스트 체크가 건너뛰어졌으면 '모두 성공'이 아님");
}
{
  const r = runPr({ statusCheckRollup: [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" }, { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" }] });
  ok(r.code === 2 && /안 돎!\s+Backend/.test(r.out), "paths에 걸리는데 체크가 없으면 '안 돎!'과 종료 코드 2", r.out);
}
{
  const { s, v } = state({ files: [{ path: "problems/P11/case.json" }], statusCheckRollup: [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" }, { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Docs" }] });
  ok(s.workflows.find((w) => w.name === "Backend").status === "FILTERED" && v.clean && v.filtered.length === 1, "필터 밖이라 안 돈 것은 FILTERED로 알리되 실패로 세지 않음");
}
{
  const r = runPr({ statusCheckRollup: [] });
  ok(r.code === 2 && /체크가 하나도 없습니다/.test(r.out), "체크가 없으면 통과라고 하지 않음");
}
{
  // 작업 트리의 워크플로를 바꿔도 PR HEAD의 파일로 판단한다
  const wf = path.join(REPO, ".github/workflows/backend.yml");
  const orig = fs.readFileSync(wf, "utf8");
  fs.writeFileSync(wf, orig.replace("'src/**'", "'nothing/**'"));
  const { s } = state({ files: [{ path: "src/coupon/CouponService.java" }] });
  ok(s.workflows.find((w) => w.name === "Backend").expected === true, "워크플로는 작업 트리가 아니라 PR HEAD 커밋에서 읽음");
  ok(s.local.uncommitted === 1, "커밋 안 한 변경을 셈");
  fs.writeFileSync(wf, orig);
  write(REPO, "src/coupon/NewTest.java", "class NewTest {}\n");
  const { s: su, v: vu } = state({});
  ok(su.local.untracked === 1 && !vu.clean, "add 안 한 새 파일도 커밋 안 한 변경으로 셈");
  fs.rmSync(path.join(REPO, "src/coupon/NewTest.java"));
  const many = Array.from({ length: 100 }, (_, i) => ({ path: `docs/d${i}.md` }));
  const { s: sm, v: vm } = state({ files: many, baseRefName: "develop" });
  ok(sm.filesMaybeCut && !vm.clean, "gh 파일 목록이 100개 이상이고 git으로 다시 계산할 수 없으면 통과로 보지 않음");
  const { s: sg } = state({ files: many });
  ok(!sg.filesMaybeCut && /git/.test(sg.filesSource) && sg.changedFiles === 4, "기준 브랜치가 로컬에 있으면 git으로 다시 계산(수정·추가·삭제 4개)", `${sg.filesSource} ${sg.changedFiles}`);
  write(REPO, "src/coupon/NewTest.java", "class NewTest {}\n");
  fs.rmSync(path.join(REPO, "src/coupon/NewTest.java"));
}
{
  write(REPO, "src/coupon/Extra.java", "class Extra {}\n");
  const C4 = commit(REPO, "push 안 함");
  const { s } = state({ headRefOid: C3 });
  ok(!s.local.same && /push 안 한 커밋이 1개/.test(s.local.note), "로컬에 push 안 한 커밋", s.local.note);
  g(REPO, "reset", "-q", "--hard", C3);
  const { s: s2 } = state({ headRefOid: C4 });
  ok(!s2.local.same && /원격 PR이 로컬보다 1커밋 앞서/.test(s2.local.note), "원격이 앞서 있음", s2.local.note);
  const { s: s3 } = state({ headRefOid: "0123456789abcdef0123456789abcdef01234567" });
  ok(/로컬에 없습니다/.test(s3.local.note) && /작업 트리/.test(s3.workflowSource), "PR HEAD가 로컬에 없으면 fetch 안내, 워크플로는 작업 트리에서", s3.local.note);
  g(REPO, "checkout", "-q", "main");
  const { s: s4 } = state({});
  ok(/PR 브랜치\(feat\/coupon\)가 아니라 main/.test(s4.local.note), "다른 브랜치에 있으면 그렇게 알림", s4.local.note);
  g(REPO, "checkout", "-q", "feat/coupon");
}
{
  const bodyOut = path.join(TMP, "out", "pr-body.md");
  const r = runPr({}, ["--body-out", bodyOut]);
  ok(fs.readFileSync(bodyOut, "utf8").includes("`issue()`"), "--body-out으로 PR 본문 저장", r.err);
  const a = sh(REPO, process.execPath, [ANCHORS, bodyOut]);
  ok(a.code === 0 && /OK\s+issue\(\)/.test(a.out), "저장한 본문을 anchors로 대조", a.out);
  const j = runPr({}, ["--json"]);
  const parsed = JSON.parse(j.out);
  ok(parsed.verdict.clean === true && parsed.body === undefined, "--json (본문은 빼고 출력)");
  const f = runPr({}, [], { FAKE_GH_FAIL: "no pull requests found" });
  ok(f.code === 1 && /gh pr view 실패/.test(f.err), "gh 실패는 종료 코드 1", f.err);
}

// ---------- 세 번째 독립 리뷰에서 나온 경우들 (따로 만든 작은 저장소) ----------
console.log("\n# 세 번째 리뷰에서 나온 경우");
const mini = (name, files) => {
  const d = path.join(TMP, name);
  fs.mkdirSync(d);
  g(d, "init", "-q", "-b", "main"); g(d, "config", "user.email", "t@example.com"); g(d, "config", "user.name", "t"); g(d, "config", "core.autocrlf", "false");
  for (const [f, t] of Object.entries(files)) write(d, f, t);
  return { d, head: commit(d, "init") };
};
const miniState = (d, over) => {
  const f = path.join(d, "..", `${path.basename(d)}-gh.json`);
  fs.writeFileSync(f, JSON.stringify({ number: 1, url: "u", title: "t", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: "main", baseRefName: "main", files: [{ path: "src/a.js" }], body: "", ...over }));
  process.env.GH_BIN = FAKE_GH; process.env.FAKE_GH_FILE = f;
  const s = collect({ repo: d }); return { s, v: verdict(s) };
};
{
  const { d, head } = mini("dupname", {
    "src/a.js": "a\n", "docs/x.md": "x\n",
    ".github/workflows/ci-backend.yml": "name: CI\non:\n  pull_request:\n    paths: ['src/**']\n",
    ".github/workflows/ci-docs.yml": "name: CI\non:\n  pull_request:\n    paths: ['docs/**']\n",
  });
  const { s, v } = miniState(d, { headRefOid: head, files: [{ path: "src/a.js" }, { path: "docs/x.md" }], statusCheckRollup: [{ __typename: "CheckRun", name: "docs-build", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "CI" }] });
  ok(!v.clean && s.workflows.every((w) => w.status === "UNREAD"), "이름이 같은 워크플로가 둘이면 하나만 돌아도 '돎'으로 보지 않음", JSON.stringify(s.workflows.map((w) => [w.file, w.status])));
}
{
  const { d, head } = mini("pushonly", {
    "src/a.js": "a\n",
    ".github/workflows/test.yml": "name: Test\non:\n  push:\n    branches: ['**']\n",
    ".github/workflows/labeler.yml": "name: Labeler\non: pull_request_target\n",
  });
  const checks = [{ __typename: "CheckRun", name: "label", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Labeler" }];
  const { s, v } = miniState(d, { headRefOid: head, statusCheckRollup: checks });
  ok(!v.clean && s.workflows.find((w) => w.name === "Test")?.status === "MISSING", "push로만 도는 테스트가 이 HEAD에 안 돌았으면 통과 아님", JSON.stringify(s.workflows.map((w) => [w.name, w.status])));
  const { s: sf, v: vf } = miniState(d, { headRefOid: head, statusCheckRollup: checks, isCrossRepository: true });
  ok(!vf.clean && sf.workflows.find((w) => w.name === "Test")?.status === "UNREAD", "포크 PR이면 push 워크플로가 이 PR 체크에 안 보이므로 '모름!'", JSON.stringify(sf.workflows.map((w) => [w.name, w.status])));
  const many = Array.from({ length: 100 }, (_, i) => ({ __typename: "CheckRun", name: `c${i}`, status: "COMPLETED", conclusion: "SUCCESS", workflowName: i ? "Labeler" : "Test" }));
  const { s: sc, v: vc } = miniState(d, { headRefOid: head, statusCheckRollup: many });
  ok(sc.checksMaybeCut === undefined && vc.clean, "체크는 gh가 끝까지 받으므로 100개 이상이어도 그것만으로 막지 않음", JSON.stringify(sc.workflows.map((w) => [w.name, w.status])));
}
{
  // force-push(amend)로 계보에서 빠진 커밋을 리뷰가 "HEAD는 X"라고 한 경우
  const { d } = mini("amend", { "src/pay.js": "function pay(order) {\n  return 1;\n  const total = order.total;\n}\n" });
  g(d, "commit", "-q", "--allow-empty", "-m", "리뷰 받은 커밋");
  const reviewed = g(d, "rev-parse", "HEAD");
  write(d, "src/pay.js", "function a() {}\nfunction b() {}\nfunction pay(order, amount) {\n  return 1;\n  const total = amount;\n}\n");
  g(d, "add", "-A"); g(d, "commit", "-q", "--amend", "-m", "고침");
  const r = check(`HEAD는 ${reviewed.slice(0, 7)} 입니다. src/pay.js:3 에서 order.total을 씁니다.\n이전 리뷰는 ${g(d, "rev-parse", "HEAD~1").slice(0, 7)} 기준이었습니다.`, { repo: d });
  ok(r.reviewPoint === reviewed && r.paths[0]?.oldText?.includes("order.total") && r.paths[0].lineChanged === true, "계보에서 빠진 커밋도 'HEAD는 X'면 기준점(이전 리뷰 SHA는 아님)", JSON.stringify([r.reviewPoint, r.paths[0]]));
}
{
  const r = check(`이 버그는 ${C2.slice(0, 7)} 시점에 들어왔고 src/coupon/CouponService.java:8 에서 금액을 무시합니다.`, { repo: REPO });
  ok(!r.reviewPoint && r.paths[0]?.status === "OK", "'X 시점에 들어왔고'는 기준점이 아님", JSON.stringify([r.reviewPoint, r.paths[0]?.status]));
  ok(check(`${C2.slice(0, 7)} 시점 기준으로 봤습니다`, { repo: REPO }).reviewPoint === C2, "'X 시점 기준'은 기준점");
}
{
  const { d } = mini("owners", {
    "order/service.go": "package order\ntype OrderService struct{}\n",
    "order/cancel.go": "package order\nfunc (s *OrderService) Cancel() {}\n",
    "order/OrderService.js": "export class OrderService { cancel() {} }\n",
    "payment/PaymentService.js": "export class PaymentService { refundAll() {} }\n",
  });
  const r = check("`OrderService.Cancel()` 과 `orderService.refundAll()`", { repo: d });
  const N = (raw) => r.names.find((n) => n.raw === raw);
  ok(N("OrderService.Cancel()")?.status === "OK", "Go처럼 메서드를 다른 파일에 붙이는 언어도 소유자 파일로 봄", JSON.stringify(N("OrderService.Cancel()")));
  ok(N("orderService.refundAll()")?.status === "PARTIAL", "변수 이름 receiver(orderService)는 같은 이름의 클래스로 소유자 검사", JSON.stringify(N("orderService.refundAll()")));
}
{
  const e = extract("`docs/주문.md:40` 와 docs/결제.md, `src/주문/OrderService.java:99`");
  ok(JSON.stringify(e.paths.map((p) => p.path).sort()) === JSON.stringify(["docs/주문.md", "docs/결제.md", "src/주문/OrderService.java"].sort()), "글 속 한글 경로를 꺼냄", JSON.stringify(e.paths.map((p) => p.path)));
}
{
  // 스킬 폴더를 링크(정션·심볼릭 링크)로 설치해도 스크립트가 실행됨
  const link = path.join(TMP, "skill-link");
  fs.symlinkSync(ROOT, link, "junction");
  const bad = path.join(TMP, "bad.md");
  fs.writeFileSync(bad, "`whereIsThisThing()`");
  const a = sh(REPO, process.execPath, [path.join(link, "scripts", "anchors.mjs"), bad]);
  ok(a.code === 2 && /MISS/.test(a.out), "링크 경로로 실행한 anchors", `${a.code} ${a.out}`);
  const p = sh(REPO, process.execPath, [path.join(link, "scripts", "pr-state.mjs")], { GH_BIN: FAKE_GH, FAKE_GH_FAIL: "no pull requests found" });
  ok(p.code === 1 && /gh pr view 실패/.test(p.err), "링크 경로로 실행한 pr-state", `${p.code} ${p.err}`);
  // 링크만 지운다(재귀 삭제는 링크를 따라갈 위험이 있어 쓰지 않는다). 비어 있지 않은 진짜 폴더면 rmdir이 실패해 안전하다
  try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  ok(!fs.existsSync(link) && fs.existsSync(ANCHORS), "링크만 지우고 원본은 남김");
}

// ---------- 네 번째 독립 리뷰에서 나온 경우들 ----------
console.log("\n# 네 번째 리뷰에서 나온 경우");
{
  ok(parseWorkflow('name: T\non:\n  "pull_request":\n    branches: [main]\n', "t.yml").pr, "따옴표로 감싼 이벤트 키");
  ok(parseWorkflow("name: T\non: [\n  push,\n  pull_request,\n]\n", "t.yml").pr, "여러 줄에 걸친 on: [ ]");
  const tagged = parseWorkflow("name: T\non:\n  !!str pull_request:\n    branches: [main]\n", "t.yml");
  ok(!tagged.pr && tagged.unparsed, "이벤트를 못 알아봐도 on: 맨 위에 pull_request가 있으면 '읽지 못함'으로 남김", JSON.stringify(tagged));
  const disp = parseWorkflow("name: D\non:\n  workflow_dispatch:\n    inputs:\n      push:\n        description: Whether to push image\n        type: boolean\n", "d.yml");
  ok(!disp.pr && !disp.push && !disp.unparsed, "workflow_dispatch의 input 이름 push는 이벤트가 아님", JSON.stringify(disp));
  ok(JSON.stringify(parseWorkflow("name: T\non:\n  pull_request:\n    paths:\n      - &code 'src/**'\n", "t.yml").paths) === '["src/**"]', "목록 항목에 붙은 앵커 정의를 떼고 읽음");
  ok(parseWorkflow("name: Rock 'n roll CI # 메인 CI\non: pull_request\n", "r.yml").name === "Rock 'n roll CI", "이름 속 아포스트로피는 따옴표가 아님");
}
{
  const { d, head } = mini("pushpr", {
    "src/a.js": "a\n",
    ".github/workflows/test.yml": "name: Test\non:\n  push:\n  pull_request:\n    branches: [main]\n",
    ".github/workflows/lint.yml": "name: Lint\non: pull_request\n",
    ".github/workflows/nightly.yml": "name: Lint\non:\n  schedule:\n    - cron: '0 0 * * *'\n",
    ".github/workflows/weird.yml": "name: Weird\non:\n  !!str pull_request:\n",
  });
  const lint = [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Lint" }];
  const { s, v } = miniState(d, { headRefOid: head, baseRefName: "develop", statusCheckRollup: lint });
  const W = (n) => s.workflows.find((w) => w.name === n);
  ok(W("Test")?.status === "MISSING" && W("Test").via === "push", "pull_request branches에 안 걸려도 push로 돌았어야 하면 '안 돎!'", JSON.stringify(W("Test")));
  ok(W("Lint")?.status === "RAN", "schedule에만 도는 같은 이름 워크플로는 이름 중복으로 세지 않음", JSON.stringify(s.workflows.map((w) => [w.file, w.status])));
  ok(W("Weird")?.status === "UNREAD" && !v.clean, "형식을 못 읽은 워크플로는 목록에서 빼지 않고 '모름!'", JSON.stringify(W("Weird")));
}
{
  for (const t of [`This regression was introduced at commit ${C2.slice(0, 7)} and is still present.`, `이 버그는 HEAD가 ${C2.slice(0, 7)}일 때 들어왔고 지금도 그렇다.`, `예전에 ${C2.slice(0, 7)}에서 봤던 회귀와 같다.`]) {
    ok(!check(t, { repo: REPO }).reviewPoint, `이력 언급은 기준점이 아님: ${t.replace(C2.slice(0, 7), "X")}`);
  }
  ok(check(`Follow-up to the previous review. Reviewed at ${C2.slice(0, 7)}.`, { repo: REPO }).reviewPoint === C2, "앞 문장의 'previous review'가 다음 문장의 기준점을 막지 않음");
  ok(check(`지난 리뷰 지적 3건 반영 확인. HEAD는 ${C2.slice(0, 7)} 입니다.`, { repo: REPO }).reviewPoint === C2, "앞 문장의 '지난 리뷰'가 다음 문장의 기준점을 막지 않음");
  ok(check(`지난번 HEAD는 ${C1.slice(0, 7)}였고, 이번에는 ${C2.slice(0, 7)} 기준으로 봤습니다.`, { repo: REPO }).reviewPoint === C2, "'지난번 HEAD는 X'는 기준점이 아니고 '이번에는 Y 기준'이 기준점");
}
{
  const { d } = mini("inherit", {
    "src/OrderRepository.java": "interface OrderRepository extends JpaRepository<Order, Long> {}\n",
    "src/OrderService.java": "class OrderService {\n  void cancel(long id) {\n    var o = orderRepository.findById(id);\n    orderRepository.save(o);\n  }\n}\n",
  });
  const r = check("`orderRepository.findById()` 와 `OrderRepository.save()`", { repo: d });
  ok(r.names.every((n) => n.status === "OK" && n.maybeInherited === "OrderRepository"), "상속받은 메서드는 PARTIAL이 아니라 OK(상속일 수 있다고 표시)", JSON.stringify(r.names));
}
{
  const r = check("쿠폰 로직은CouponService.java:3 에서 한도를 본다.", { repo: REPO });
  ok(r.paths[0]?.status === "OK" && r.paths[0].file === "src/coupon/CouponService.java", "띄어쓰기 없이 붙은 한글을 떼고 경로를 찾음", JSON.stringify(r.paths));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 통과, ${fail} 실패`);
process.exitCode = fail ? 1 : 0;
