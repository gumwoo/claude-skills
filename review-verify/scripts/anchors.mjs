#!/usr/bin/env node
// 리뷰(또는 PR 본문) 글에 나온 커밋 SHA, 파일 경로·줄 번호, 백틱 안의 코드 이름이 지금 저장소에 실제로 있는지 대조한다.
// 판정은 하지 않는다. "리뷰어가 본 것과 지금 코드가 같은 것을 가리키는가"만 알려 준다.
// 사용법: node anchors.mjs <글 파일|-> [--repo 경로] [--head 리비전] [--base 리비전] [--json]
//   --head: 대조할 코드 (기본 HEAD)
//   --base: 이번 PR의 기준 브랜치. 주면 "이번 PR에서 바뀜" 표시를 붙인다 (예: origin/main)
// 종료 코드: 0 = 모두 찾음, 2 = 없거나 범위 밖이거나 리뷰 기준점이 HEAD와 다름(diff + 줄 이름이 없는 것 포함), 1 = 실행 오류
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = "java|kt|kts|scala|groovy|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|cs|c|h|cc|cpp|hpp|swift|m|sql|ya?ml|json|jsonc|toml|ini|cfg|conf|properties|xml|gradle|md|mdx|tf|tfvars|hcl|sh|bash|ps1|bat|css|scss|less|html|vue|svelte|proto|graphql|gql|txt|csv|lock|env";
const PRODUCT_JS = /^(node|next|nuxt|vue|express|three|d3|chart|ember|backbone|deno|moment|alpine|solid|preact|nest|knockout|angular|react|socket\.io)\.js$/i;
const BARE_NAMES ="Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Rakefile|Vagrantfile";
// 백틱 안에 있어도 코드 이름으로 찾지 않을 것들
const STOP = new Set(["true", "false", "null", "nil", "none", "undefined", "void", "this", "self", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "throws", "new", "delete", "typeof", "instanceof", "in", "of", "is", "not", "and", "or", "class", "public", "private", "static", "final", "const", "let", "var", "def", "fn", "func", "async", "await", "import", "from", "export", "default", "main", "master", "head", "HEAD", "PASS", "FAIL", "OK", "TODO", "FIXME", "GET", "POST", "PUT", "PATCH", "DELETE"]);

export function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git을 실행할 수 없습니다: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} 실패: ${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

// ---------- 글에서 꺼내기 ----------

const uniqBy = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

export function extract(text) {
  const shas = [], paths = [], names = [], refs = [];
  let rest = text;

  // GitHub 파일 링크: .../blob/<ref>/<path>#L10-L20
  rest = rest.replace(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/([^/\s]+)\/([^\s)#>\]]+)(?:#L(\d+)(?:-L(\d+))?)?/g, (_, ref, p, a, b) => {
    // 브랜치 이름에 / 가 있으면(feature/x) ref와 경로의 경계를 알 수 없다. check에서 다시 나눠 본다
    paths.push({ raw: `${p}${a ? `#L${a}${b ? `-L${b}` : ""}` : ""}`, path: decodeURIComponent(p), line: a ? Number(a) : null, lineEnd: b ? Number(b) : null, ref, blobTail: decodeURIComponent(`${ref}/${p}`) });
    if (/^[0-9a-f]{7,40}$/.test(ref)) shas.push({ raw: ref, sha: ref, fromLink: true }); // 퍼머링크의 커밋은 리뷰어가 본 버전이다
    return " ";
  });
  // GitHub 커밋·PR 링크
  rest = rest.replace(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:commit|pull\/\d+\/commits)\/([0-9a-f]{7,40})\S*/g, (_, s) => { shas.push({ raw: s, sha: s }); return " "; });
  rest = rest.replace(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues|actions\/runs)\/(\d+)\S*/g, (_, kind, n) => { refs.push(`${kind === "actions/runs" ? "run" : "#"}${n}`); return " "; });
  // 나머지 URL은 경로로 잘못 읽지 않게 지운다
  rest = rest.replace(/https?:\/\/\S+/g, " ");

  // ```suggestion에 나온 이름은 앞으로 만들 이름이라 지금 없는 게 정상이다. 따로 모으고 MISS로 세지 않는다.
  // ```diff의 + 줄은 제안일 수도, 리뷰가 PR 변경을 인용한 것일 수도 있다. 따로 모아 지금 없으면 "확인 필요"로 센다.
  // diff의 - 줄과 맥락 줄은 남긴다(- 줄 이름이 지금 없으면 PR에서 지운 것일 수 있다. MISS 설명의 커밋으로 가린다).
  const proposed = [], diffAdded = [];
  rest = rest.replace(/```(suggestion|diff)[^\n]*\n([\s\S]*?)```/g, (_, kind, body) => {
    // 목록 안에 들여 쓴 블록이면 공통 들여쓰기를 떼고, diff 머리 줄(--- a/x, +++ b/x, @@)은 버린다
    let lines = body.split("\n");
    const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    if (Number.isFinite(ind) && ind > 0) lines = lines.map((l) => l.slice(ind));
    if (kind === "diff") lines = lines.filter((l) => !/^(?:---|\+\+\+|@@|diff --git|index )/.test(l));
    const added = kind === "diff" ? lines.filter((l) => /^\+(?!\+\+)/.test(l)).map((l) => l.slice(1)) : lines;
    for (const l of added) for (const m of l.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) if (m[1].length >= 4 && !STOP.has(m[1])) (kind === "diff" ? diffAdded : proposed).push(m[1]);
    if (kind !== "diff") return " ";
    return "```\n" + lines.filter((l) => !/^\+/.test(l)).map((l) => l.replace(/^[- ]/, "")).join("\n") + "\n```";
  });

  // 코드 블록 안의 호출 모양(cancelActiveRun(), repo.findById() 등). 산문 낱말이 걸리지 않게
  // camelCase·snake_case·점으로 이은 이름만 받는다. 블록 내용은 그대로 두어 경로·SHA도 찾는다.
  const blockNames = [];
  for (const b of rest.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const m of b[1].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/g)) {
      const last = m[1].split(".").at(-1);
      if (last.length >= 4 && (/[a-z][A-Z]/.test(last) || /_/.test(last.replace(/^_+/, "")) || m[1].includes("."))) blockNames.push(`${m[1]}()`);
    }
  }

  // 백틱 안 (경로·이름·SHA 모두 여기서 나올 수 있다). `@Valid / @NotNull`처럼 한 칸에 여럿 쓴 것은 나눈다
  const ticks = [];
  // 괄호 안의 쉼표(refund(orderId, amount))로는 나누지 않는다
  rest = rest.replace(/`([^`\n]{1,200})`/g, (_, s) => { ticks.push(...(s.includes("(") ? s.trim().split(/\s+\/\s+/) : s.trim().split(/\s+\/\s+|,\s+/))); return ` ${s} `; });
  ticks.push(...blockNames);

  // SHA: 7~40자 16진수. "6e9a934..."처럼 말줄임이 붙어도 읽는다.
  // 숫자만(0332824)이거나 글자만(deadbee)인 것도 실제 SHA일 수 있어서 버리지 않고 "후보"로 둔다.
  // 후보는 저장소에 그 커밋이 있을 때만 SHA로 센다(check에서). 짧은 SHA의 약 4%는 숫자만으로 되어 있다.
  const maybeShas = [];
  for (const m of rest.matchAll(/(?<![0-9A-Za-z_\-/.#])([0-9a-f]{7,40})(?![0-9A-Za-z_\-/])/g)) {
    if (/[a-f]/.test(m[1]) && /[0-9]/.test(m[1])) shas.push({ raw: m[1], sha: m[1] });
    else maybeShas.push({ raw: m[1], sha: m[1], maybe: true });
  }

  // 파일 경로 (+ :줄, :줄-줄, #L줄)
  // 절대 경로(/home/me/repo/src/a.ts, C:\work\repo\src\a.ts)도 받고, check에서 저장소 안 경로로 줄여 본다
  // 경로 글자로 한글 같은 유니코드 글자도 받는다(docs/주문.md)
  const pathRe = new RegExp(`(?<![\\w.\\-/\\\\\\p{L}])((?:[A-Za-z]:[\\\\/]|/)?(?:[\\w.\\-\\p{L}]+[\\\\/])*(?:[\\w.\\-\\p{L}]+\\.(?:${EXT})|${BARE_NAMES}))(?![\\w\\-])(?:(?::|#L)(\\d+)(?:[-–~](?:L)?(\\d+))?)?`, "gu");
  for (const m of rest.matchAll(pathRe)) {
    const p = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p.includes("/") && PRODUCT_JS.test(p)) continue; // Node.js, Next.js 같은 제품 이름
    if (/^\d+(\.\d+)+$/.test(p)) continue; // 1.2.3 같은 버전
    if (/^v?\d/.test(p) && !p.includes("/")) continue; // 2.0.json 같은 것
    paths.push({ raw: m[0], path: p, abs: /^([A-Za-z]:)?\//.test(p), line: m[2] ? Number(m[2]) : null, lineEnd: m[3] ? Number(m[3]) : null });
  }

  // 코드 이름: 백틱 안의 한 토큰
  for (const tick of ticks) {
    const t = tick.replace(/(\.{2,}|…)$/, "");
    // refund(orderId, amount)처럼 인자 안의 공백은 이름 판단에서 뺀다
    if (/\s/.test(t.replace(/^([\w$.@:#]+)\(.*\)$/, "$1()")) || t.length < 2 || t.length > 80) continue;
    if (new RegExp(pathRe.source, "u").test(t)) continue; // 경로는 위에서 따로 본다
    if (/^[0-9a-f]{7,40}$/.test(t) && /[a-f]/.test(t) && /\d/.test(t)) continue; // SHA는 위에서 따로 본다
    if (/^[-+]?\d[\d.,_]*%?$/.test(t)) continue; // 숫자
    if (/^#[0-9a-fA-F]{3,8}$/.test(t)) continue; // 색상 코드
    if (/^--?[\w-]+/.test(t)) continue; // CLI 옵션
    const terms = nameTerms(t);
    if (!terms.length) continue;
    names.push({ raw: t, terms });
  }
  for (const m of rest.matchAll(/(?<![\w/])(?:PR\s*)?#(\d{1,6})\b/g)) refs.push(`#${m[1]}`);

  return {
    shas: uniqBy(shas, (s) => s.sha.slice(0, 7)),
    maybeShas: uniqBy(maybeShas, (s) => s.sha.slice(0, 7)),
    proposed: [...new Set(proposed)],
    diffAdded: [...new Set(diffAdded)],
    paths: uniqBy(paths, (p) => `${p.path}:${p.line ?? ""}-${p.lineEnd ?? ""}`),
    names: uniqBy(names, (n) => n.raw),
    refs: [...new Set(refs)],
  };
}

// `Foo.bar()` → ["bar", "Foo"], `A::b` → ["b", "A"], `@Valid` → ["@Valid"], `x.y.z` → ["z", "x.y.z"]
export function nameTerms(t) {
  let s = t.replace(/\(.*\)$/, "").replace(/[;,:]+$/, "");
  if (!s) return [];
  if (/[^\w.$@:#<>\[\]\-가-힣]/.test(s)) return [];
  s = s.replace(/<.*>$/, "").replace(/\[\]$/, "");
  const parts = s.split(/::|#|\.(?=[A-Za-z_$@가-힣])/).filter(Boolean);
  const last = parts.at(-1);
  if (!last || STOP.has(last) || last.length < 2) return [];
  const terms = [last];
  if (parts.length > 1) {
    const owner = parts.at(-2);
    if (/^[A-Z][\w$]*$/.test(owner) && !STOP.has(owner)) terms.push(owner);
  }
  return terms;
}

// ---------- 저장소와 대조 ----------

// 리뷰가 본 시점을 말하는 표현인지: SHA 바로 앞이나 바로 뒤에 붙은 말만 본다.
// "HEAD는 X", "리뷰 기준 X", "reviewed at X", "X 기준", "X 시점을 봤다"는 기준점.
// "이 버그는 X에서 들어왔고 지금도 …"처럼 문장 어딘가에 '지금'이 있는 것은 기준점이 아니다.
const RP_BEFORE = /(?:\bHEAD|헤드)(?:\s*(?:SHA|commit|커밋))?\s*(?:는|은|가|이|:|=|is|was|at|→|->)?\s*$|(?:리뷰|검토)?\s*기준(?:점|\s*커밋)?\s*(?:은|는|:)?\s*$|(?:reviewed|reviewing|looked at|checked out)(?:\s+(?:at|on))?(?:\s+(?:commit|sha))?\s*:?\s*$|\bas of\s*$|(?:리뷰|검토)한\s*커밋\s*(?:은|는|:)?\s*$/i;
// '시점'만으로는 기준점이 아니다("X 시점에 들어왔고"는 이력). "X 시점 기준", "X 시점에서 봤다"만 받는다
const RP_AFTER = /^\s*(?:커밋\s*)?(?:을|를|으로|로)?\s*(?:기준|시점\s*(?:기준|에서\s*(?:봤|본|리뷰|검토)|을\s*(?:봤|본|리뷰)|으로)|에서 봤(?!던)|봤(?!던)|보고)/;
// "이전 리뷰는 X 기준"은 이번 리뷰의 기준점이 아니다
// "지난 리뷰는 X 기준", "지난번 HEAD는 X"처럼 같은 구절(쉼표·마침표 전) 안에서 SHA 바로 앞에 있을 때만 본다
const RP_PREVIOUS = /(?:이전|지난번?|앞선|previous|earlier|prior|last)\s*(?:리뷰|검토|review|HEAD|헤드|커밋|commit)[^,.;!?\n]{0,12}$/i;
// "X에서 들어왔다", "HEAD가 X일 때 생겼다", "introduced at commit X"는 이력 언급이다
const RP_HISTORY_AFTER = /^\s*(?:일\s*때|때|에서|시점에|부터|이후)?\s*(?:처음\s*)?(?:들어왔|들어온|생겼|생긴|도입|추가됐|추가된|깨졌|깨진|발생)|^\s*(?:introduced|regressed|broke)/i;
const RP_HISTORY_BEFORE = /(?:introduced|regressed|broken|broke|appeared|added)\s+(?:in|at|by|since|with)?\s*(?:commit)?\s*$/i;
// 2 = "HEAD는 X"처럼 앞에서 가리킴, 1 = "X 기준"처럼 뒤에서 가리킴, 0 = 기준점 표현 아님
export function reviewContext(text, raw) {
  let best = 0;
  for (let i = text.indexOf(raw); i >= 0; i = text.indexOf(raw, i + 1)) {
    const before = text.slice(Math.max(0, i - 30), i).replace(/[`*_]/g, "");
    const after = text.slice(i + raw.length, i + raw.length + 20).replace(/^[0-9a-f]*(?:\.{2,}|…)?/, "").replace(/^[`*_]+/, "");
    const clause = before.split(/[.!?。\n]\s/).pop(); // 앞 문장은 보지 않는다
    if (RP_PREVIOUS.test(clause) || RP_HISTORY_BEFORE.test(clause) || RP_HISTORY_AFTER.test(after)) continue;
    if (RP_BEFORE.test(clause)) best = 2;
    else if (RP_AFTER.test(after)) best = Math.max(best, 1);
  }
  return best;
}

// git diff -U0 의 @@ -a,b +c,d @@ 로, 옛 파일의 [from, to] 줄이 바뀌었는지와 그대로라면 지금 몇 행인지 계산한다
export function mapLines(diff, from, to) {
  let shift = 0;
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a = Number(m[1]), b = m[2] == null ? 1 : Number(m[2]), d = m[4] == null ? 1 : Number(m[4]);
    if (b === 0) { if (a < from) shift += d; else if (a < to) return { changed: true }; continue; } // a 줄 뒤에 끼워 넣음
    const end = a + b - 1;
    if (end < from) shift += d - b;
    else if (a <= to) return { changed: true };
  }
  return { changed: false, now: from + shift };
}

export function check(text, { repo = ".", head = "HEAD", base = null } = {}) {
  const top = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const headSha = git(top, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const found = extract(text);
  const files = git(top, ["ls-tree", "-r", "--name-only", "-z", headSha]).split("\0").filter(Boolean);
  const fileSet = new Set(files);

  let baseSha = null, prFiles = null, diffText = "";
  if (base) {
    const mb = git(top, ["merge-base", base, headSha], { allowFail: true });
    if (!mb) throw new Error(`--base ${base}와 ${head}의 공통 조상을 찾지 못했습니다`);
    baseSha = mb.trim();
    prFiles = new Set(git(top, ["diff", "--name-only", "-z", baseSha, headSha]).split("\0").filter(Boolean));
    diffText = git(top, ["diff", "-U0", "--no-color", baseSha, headSha]);
  }

  // SHA (숫자만·글자만인 후보는 실제 커밋이 있을 때만)
  const candidates = [...found.shas, ...found.maybeShas.filter((s) =>
    git(top, ["rev-parse", "--verify", "--quiet", `${s.sha}^{commit}`], { allowFail: true }) !== null)];
  const shas = candidates.map((s) => {
    const full = git(top, ["rev-parse", "--verify", "--quiet", `${s.sha}^{commit}`], { allowFail: true })?.trim();
    if (!full) return { ...s, status: "MISS", note: "이 저장소에 없는 커밋입니다 (fetch 전이거나, 다른 저장소이거나, 잘못 옮긴 SHA)" };
    if (full === headSha) return { ...s, full, status: "OK", note: "지금 HEAD와 같습니다" };
    const isAnc = git(top, ["merge-base", "--is-ancestor", full, headSha], { allowFail: true }) !== null;
    if (isAnc) {
      const behind = Number(git(top, ["rev-list", "--count", `${full}..${headSha}`]).trim());
      const changed = git(top, ["diff", "--name-only", "-z", full, headSha]).split("\0").filter(Boolean);
      return { ...s, full, status: "BEHIND", behind, changedSince: changed, note: `HEAD보다 ${behind}커밋 앞선 시점입니다. 그 뒤에 바뀐 파일 ${changed.length}개` };
    }
    const isDesc = git(top, ["merge-base", "--is-ancestor", headSha, full], { allowFail: true }) !== null;
    if (isDesc) return { ...s, full, status: "AHEAD", note: "지금 HEAD보다 나중 커밋입니다. 로컬이 뒤처져 있으니 pull 하고 다시 보세요" };
    // 계보에 없어도 객체가 로컬에 있으면(rebase·amend 전 커밋) 그 시점 파일을 읽을 수 있다
    const changed = git(top, ["diff", "--name-only", "-z", full, headSha]).split("\0").filter(Boolean);
    return { ...s, full, status: "OFFLINE", changedSince: changed, note: "HEAD 계보에 없는 커밋입니다 (다른 브랜치, 또는 force-push로 사라진 커밋)" };
  });
  // 리뷰어가 본 시점 추정: 글에 지금 HEAD가 있으면 HEAD를 본 것이고(나머지 SHA는 과거 이력을 언급한 것),
  // 없으면 "HEAD는 X", "X 기준", "reviewed at X"처럼 본 시점을 말하는 문맥의 커밋. 과거 커밋(BEHIND)과
  // force-push·rebase로 계보에서 빠진 커밋(OFFLINE) 모두 후보다. "HEAD는 X"가 "X 기준"보다 우선이고, 같으면 HEAD에 가까운 것.
  // "이 버그는 X에서 들어왔다" 같은 이력 언급은 기준점으로 삼지 않는다.
  let reviewPoint = null;
  if (!shas.some((s) => s.status === "OK")) {
    const cand = shas.filter((s) => s.status === "BEHIND" || s.status === "OFFLINE")
      .map((s) => ({ s, score: Math.max(reviewContext(text, s.raw), s.fromLink ? 1 : 0) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || (a.s.status === "BEHIND" ? a.s.behind : 1e9) - (b.s.status === "BEHIND" ? b.s.behind : 1e9));
    if (cand.length) { reviewPoint = cand[0].s; reviewPoint.reviewPoint = true; }
  }
  const changedSinceReview = new Set(reviewPoint ? reviewPoint.changedSince : []);

  // 파일
  const resolve = (pp) => {
    let m = fileSet.has(pp) ? [pp] : files.filter((f) => f.endsWith("/" + pp));
    if (!m.length && !pp.includes("/")) m = files.filter((f) => path.posix.basename(f) === pp);
    return m;
  };
  const paths = found.paths.map((p) => {
    const out = { ...p };
    let matches = [];
    if (p.abs) {
      // 절대 경로: 앞에서부터 한 칸씩 떼어 저장소 안 경로와 정확히 맞는 가장 긴 꼬리를 찾는다
      const segs = p.path.replace(/^([A-Za-z]:)?\//, "").split("/");
      for (let i = 0; i < segs.length && !matches.length; i++) {
        const tail = segs.slice(i).join("/");
        matches = i === segs.length - 1 ? resolve(tail) : fileSet.has(tail) ? [tail] : [];
      }
    } else matches = resolve(p.path);
    if (!matches.length && p.blobTail) {
      // blob/feature/x/src/a.ts: ref가 feature/x일 수 있다
      const segs = p.blobTail.split("/");
      for (let i = 2; i < segs.length && !matches.length; i++) {
        const tail = segs.slice(i).join("/");
        if (fileSet.has(tail)) { matches = [tail]; out.ref = segs.slice(0, i).join("/"); out.path = tail; }
      }
    }
    if (!matches.length && /[^\x00-\x7F]/.test(p.path)) {
      // 띄어쓰기 없이 붙은 한글("로직은OrderService.java", "결제/환불/src/pay.ts"): 앞의 비ASCII 부분을 떼고 다시 찾는다.
      // 진짜 한글 경로(docs/주문.md)는 위에서 그대로 찾았으므로 여기 오지 않는다
      const stripped = p.path.replace(/^[^\x00-\x7F/]+(?:\/[^\x00-\x7F/]+)*\/?/, "");
      if (stripped && stripped !== p.path) {
        const m2 = resolve(stripped);
        if (m2.length) { matches = m2; out.path = stripped; }
      }
    }
    if (!matches.length) {
      // 이력 찾기: 절대 경로면 앞에서부터 한 칸씩 떼며 저장소 안 경로를 찾는다
      const segs = p.path.replace(/^([A-Za-z]:)?\//, "").split("/");
      let last = null;
      for (let i = 0; i < segs.length && !last; i++) {
        if (!p.abs && i > 0) break;
        last = git(top, ["log", "-1", "--format=%h %s", headSha, "--", `:(glob)**/${segs.slice(i).join("/")}`], { allowFail: true })?.trim() || null;
      }
      return { ...out, status: "MISS", note: last ? `HEAD에는 없습니다. 마지막으로 나온 커밋: ${last} (삭제·이동됐을 수 있음)` : "HEAD에도, 이력에도 없는 파일입니다" };
    }
    if (matches.length > 1) {
      // 줄 번호가 있으면 그 줄이 있는 파일로 좁혀 보지 않는다. 사람이 고르게 둔다
      return { ...out, status: "AMBIGUOUS", matches, note: `같은 이름의 파일이 ${matches.length}개입니다: ${matches.slice(0, 4).join(", ")}${matches.length > 4 ? " …" : ""}` };
    }
    const file = matches[0];
    out.file = file;
    out.inPr = prFiles ? prFiles.has(file) : null;
    out.changedSinceReview = changedSinceReview.has(file);
    // 링크에 커밋이 박혀 있으면(blob/<sha>/...) 그 시점과 지금 파일이 다른지 본다
    if (p.ref && p.ref !== headSha) {
      const refSha = git(top, ["rev-parse", "--verify", "--quiet", `${p.ref}^{commit}`], { allowFail: true })?.trim();
      if (refSha && refSha !== headSha) {
        const same = git(top, ["diff", "--quiet", refSha, headSha, "--", file], { allowFail: true }) !== null;
        if (!same) out.changedSinceLink = p.ref;
      }
    }
    if (p.line != null) {
      const readLines = (rev) => {
        const body = git(top, ["show", `${rev}:${file}`], { allowFail: true });
        if (body == null) return null;
        const lines = body.split(/\r?\n/);
        if (body.endsWith("\n")) lines.pop();
        return lines;
      };
      if (p.lineEnd != null && p.lineEnd < p.line) [out.line, out.lineEnd] = [p.lineEnd, p.line]; // 40-5처럼 거꾸로 쓴 범위
      const start = out.line, end = out.lineEnd ?? out.line;
      p = { ...p, line: start };
      const nowLines = readLines(headSha) ?? [];
      // 리뷰어가 옛 버전을 봤고 그 뒤 파일이 바뀌었으면, 줄 번호는 옛 버전 기준이다
      const oldLines = reviewPoint && out.changedSinceReview ? readLines(reviewPoint.full) : null;
      if (oldLines) {
        if (p.line < 1 || end > oldLines.length) return { ...out, status: "RANGE", note: `리뷰 시점 파일은 ${oldLines.length}줄입니다` };
        out.oldText = oldLines[p.line - 1].trim().slice(0, 140);
        const mapped = mapLines(git(top, ["diff", "-U0", "--no-color", reviewPoint.full, headSha, "--", file]), p.line, end);
        out.lineChanged = mapped.changed;
        if (!mapped.changed) { out.lineNow = mapped.now; out.text = (nowLines[mapped.now - 1] ?? "").trim().slice(0, 140); }
      } else {
        if (p.line < 1 || end > nowLines.length) return { ...out, status: "RANGE", note: `파일은 ${nowLines.length}줄입니다` };
        out.text = nowLines[p.line - 1].trim().slice(0, 140);
      }
    }
    return { ...out, status: "OK" };
  });

  // 코드 이름
  const grepHits = (term) => {
    // core.quotePath=false: 한글 파일명이 "docs/\354..." 로 인용되면 다른 목록과 맞춰 볼 수 없다
    const r = git(top, ["-c", "core.quotePath=false", "grep", "-n", "-I", "-F", "-w", "-e", term, headSha, "--"], { allowFail: true });
    const hits = [];
    for (const line of (r ?? "").split("\n").filter(Boolean)) {
      const m = line.slice(headSha.length + 1).match(/^(.*?):(\d+):/);
      if (m) hits.push({ file: m[1], line: Number(m[2]) });
    }
    return hits;
  };
  const lastTouch = (term) => git(top, ["log", "-1", "--format=%h %s", `-S${term}`, headSha], { allowFail: true })?.trim();
  // Owner를 정의하거나 Owner에 메서드를 붙이는 파일: class Owner, Owner.java, Go의 func (s *Owner), Rust의 impl … Owner,
  // C++의 Owner::, Swift의 extension Owner, Kotlin의 fun Owner.x. 메서드를 다른 파일에 두는 언어가 있어서 모두 본다
  const defFilesOf = (owner) => {
    const re = `(class|interface|object|struct|enum|trait|record|type|extension)\\s+${owner}\\b|\\bimpl\\b[^{;]*\\b${owner}\\b|func\\s*\\(\\s*\\w*\\s*\\*?${owner}\\s*\\)|\\b${owner}::|fun\\s+${owner}\\.`;
    const defR = git(top, ["-c", "core.quotePath=false", "grep", "-l", "-I", "-E", "-e", re, headSha, "--"], { allowFail: true });
    const defFiles = new Set((defR ?? "").split("\n").filter(Boolean).map((l) => l.slice(headSha.length + 1)));
    for (const f of files) if (path.posix.basename(f).replace(/\.[^.]+$/, "") === owner) defFiles.add(f);
    return defFiles;
  };
  // Owner가 다른 타입을 상속하면(extends, implements, class Owner(Base), class Owner : Base) 메서드가 부모에 있을 수 있다
  const inherits = (owner) => git(top, ["grep", "-q", "-I", "-E", "-e",
    `(class|interface|struct|record|object)\\s+${owner}\\b[^{]*\\b(extends|implements)\\b|class\\s+${owner}\\s*\\(\\s*[A-Za-z_]|(class|interface|struct|object|record)\\s+${owner}\\b[^{=]*:\\s*[A-Za-z_]`,
    headSha, "--"], { allowFail: true }) !== null;
  // 코드에 receiver.member가 글자 그대로 있으면(orderRepository.findById) 그 이름은 실제로 쓰이고 있다
  const literalUse = (text) => git(top, ["grep", "-q", "-I", "-F", "-e", text, headSha, "--"], { allowFail: true }) !== null;
  const names = found.names.map((n) => {
    const [member, owner] = n.terms;
    // orderService.refundAll()처럼 변수 이름이 receiver면, 같은 이름의 클래스(OrderService)가 있을 때만 그 클래스로 본다
    let varOwner = null;
    const parts = n.raw.replace(/\(.*\)$/, "").split(".");
    if (!owner && parts.length >= 2 && /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(parts.at(-2))) {
      const cand = parts.at(-2)[0].toUpperCase() + parts.at(-2).slice(1);
      if (defFilesOf(cand).size) varOwner = cand;
    }
    let hits = grepHits(member);
    const usedTerm = member;
    const out = { ...n };
    if (!hits.length) {
      const last = lastTouch(member);
      return { ...out, status: "MISS", note: last ? `HEAD에는 없습니다. 마지막으로 넣거나 뺀 커밋: ${last}` : "HEAD에도, 이력에도 없는 이름입니다" };
    }
    // `Owner.member`: member만 있고 Owner가 없으면 흔한 이름이 우연히 걸린 것일 수 있다
    if (owner) {
      const ownerHits = grepHits(owner);
      if (!ownerHits.length) {
        const last = lastTouch(owner);
        return { ...out, status: "PARTIAL", note: `"${member}"는 ${hits.length}곳 있지만 "${owner}"는 HEAD에 없습니다${last ? ` (마지막으로 넣거나 뺀 커밋: ${last})` : ""}` };
      }
      const ownerFiles = new Set(ownerHits.map((h) => h.file));
      const near = hits.filter((h) => ownerFiles.has(h.file));
      if (near.length) hits = [...near, ...hits.filter((h) => !ownerFiles.has(h.file))];
      // Owner를 정의한 파일(class Owner, Owner.java 등)을 찾을 수 있는데 그 안에 member가 없으면,
      // 같은 이름의 다른 클래스 메서드가 걸린 것이다. "OrderService.cancel()"이 PaymentService.cancel만 찾는 경우
      const defFiles = defFilesOf(owner);
      if (defFiles.size && !hits.some((h) => defFiles.has(h.file))) {
        if (inherits(owner) || literalUse(`${owner}.${member}`)) out.maybeInherited = owner;
        else return { ...out, status: "PARTIAL", note: `"${owner}"를 정의한 파일(${[...defFiles].slice(0, 2).join(", ")})에는 "${member}"가 없습니다. 다른 곳: ${[...new Set(hits.map((h) => h.file))].slice(0, 3).join(", ")}` };
      }
    } else if (varOwner) {
      const defFiles = defFilesOf(varOwner);
      if (!hits.some((h) => defFiles.has(h.file))) {
        if (inherits(varOwner) || literalUse(`${parts.at(-2)}.${member}`)) out.maybeInherited = varOwner;
        else return { ...out, status: "PARTIAL", note: `변수 이름으로 보아 ${varOwner}의 메서드 같은데, ${varOwner}를 정의한 파일(${[...defFiles].slice(0, 2).join(", ")})에는 "${member}"가 없습니다. 다른 곳: ${[...new Set(hits.map((h) => h.file))].slice(0, 3).join(", ")}` };
      }
    }
    const filesHit = [...new Set(hits.map((h) => h.file))];
    out.term = usedTerm;
    out.count = hits.length;
    out.where = hits.slice(0, 3).map((h) => `${h.file}:${h.line}`);
    out.files = filesHit.length;
    out.changedSinceReview = filesHit.some((f) => changedSinceReview.has(f));
    if (diffText) {
      const re = new RegExp(`(^|[^\\w$])${usedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);
      out.inPr = diffText.split("\n").some((l) => /^[+-](?![+-]{2})/.test(l) && re.test(l.slice(1)));
    }
    return { ...out, status: "OK" };
  });

  // 리뷰가 새로 만들자고 한 이름: 지금 있는지만 알려 주고 판정에 넣지 않는다
  const proposed = found.proposed.map((name) => ({ name, exists: grepHits(name).length > 0 }));
  // diff 블록의 + 줄 이름: 지금 있으면 문제없고, 없으면 제안인지 지어낸 인용인지 글을 보고 가려야 한다
  const diffAdded = found.diffAdded.map((name) => ({ name, exists: grepHits(name).length > 0 }));

  return { repo: top, head: headSha, base: baseSha, reviewPoint: reviewPoint?.full ?? null, shas, paths, names, proposed, diffAdded, refs: found.refs };
}

// ---------- 출력 ----------

function render(r) {
  const out = [];
  const tag = (s) => s.padEnd(9);
  out.push(`대조 대상: ${r.head.slice(0, 7)}${r.base ? ` (기준 ${r.base.slice(0, 7)}부터의 변경을 "PR" 표시)` : ""}`);
  if (r.shas.length) {
    out.push("", "커밋");
    for (const s of r.shas) {
      out.push(`  ${tag(s.status)} ${s.raw.padEnd(12)} ${s.note}${s.reviewPoint ? "  ← 리뷰어가 본 시점으로 추정" : ""}`);
      if (s.reviewPoint && s.changedSince.length) out.push(`            바뀐 파일: ${s.changedSince.slice(0, 8).join(", ")}${s.changedSince.length > 8 ? " …" : ""}`);
    }
    if (r.reviewPoint && r.shas.find((s) => s.reviewPoint)?.status === "OFFLINE") out.push(`  리뷰가 본 ${r.reviewPoint.slice(0, 7)}은 지금 HEAD 계보에 없습니다(force-push·rebase 전 커밋일 수 있음). 줄 번호가 있는 지적은 그 커밋 기준으로 대조했습니다.`);
    else if (r.reviewPoint) out.push(`  리뷰가 지금 HEAD가 아니라 ${r.reviewPoint.slice(0, 7)} 시점을 본 것 같습니다. 줄 번호가 있는 지적은 그 시점 기준으로 대조했습니다. "리뷰 뒤 이 줄 바뀜"은 다시 읽어야 할 지적이지, 고쳐졌다는 뜻은 아닙니다.`);
    else if (!r.shas.some((s) => s.status === "OK")) out.push("  글에서 리뷰가 본 시점을 알 수 없습니다(HEAD를 가리키는 SHA가 없고, 본 시점을 말하는 문맥의 SHA도 없음). 지적마다 지금 코드를 직접 읽습니다.");
  }
  if (r.paths.length) {
    out.push("", "파일");
    for (const p of r.paths) {
      let review = null;
      if (p.lineChanged === true) review = "리뷰 뒤 이 줄 바뀜";
      else if (p.lineChanged === false) review = `리뷰 뒤 파일은 바뀌었지만 이 줄은 그대로, 지금 ${p.lineNow}행`;
      else if (p.changedSinceReview) review = "리뷰 뒤 파일 바뀜";
      const flags = [p.inPr ? "PR" : null, review, p.changedSinceLink ? `링크의 ${p.changedSinceLink.slice(0, 7)} 뒤 바뀜` : null].filter(Boolean).join(", ");
      const where = p.file && p.file !== p.path ? ` → ${p.file}` : "";
      let line = `  ${tag(p.status)} ${p.raw}${where}${flags ? `  [${flags}]` : ""}`;
      if (p.note) line += `  ${p.note}`;
      out.push(line);
      if (p.oldText != null) out.push(`            리뷰 시점 ${p.line}행: ${p.oldText}`);
      if (p.text != null) out.push(`            지금 ${p.lineNow ?? p.line}행: ${p.text}`);
    }
  }
  if (r.names.length) {
    out.push("", "코드 이름");
    for (const n of r.names) {
      const flags = [n.inPr ? "PR" : null, n.changedSinceReview ? "리뷰 뒤 바뀐 파일에 있음" : null, n.maybeInherited ? `${n.maybeInherited}에 직접 정의는 없음(상속·위임일 수 있음)` : null].filter(Boolean).join(", ");
      if (n.status === "OK") {
        const via = n.term !== n.raw ? ` ("${n.term}"로 찾음)` : "";
        out.push(`  ${tag("OK")} ${n.raw}${via}  ${n.count}곳/${n.files}파일: ${n.where.join(", ")}${n.count > 3 ? " …" : ""}${flags ? `  [${flags}]` : ""}`);
      } else out.push(`  ${tag(n.status)} ${n.raw}  ${n.note}`);
    }
  }
  if (r.proposed.length) {
    out.push("", "리뷰가 제안한 코드 속 이름 (지금 없어도 정상, 판정에 넣지 않음)");
    out.push(`  ${r.proposed.map((x) => `${x.name}${x.exists ? "(이미 있음)" : ""}`).join(", ")}`);
  }
  const diffMissing = r.diffAdded.filter((x) => !x.exists);
  if (diffMissing.length) {
    out.push("", "리뷰의 ```diff + 줄에 나온 이름 중 지금 없는 것 (확인 필요)");
    out.push(`  ${diffMissing.map((x) => x.name).join(", ")}`);
    out.push("  리뷰가 고치자고 제안한 코드면 없는 게 정상이고, PR 변경을 인용한 것이면 지어냈거나 잘못 옮긴 이름입니다. 글을 읽고 가립니다.");
  }
  if (r.refs.length) out.push("", `PR·이슈·실행 번호: ${r.refs.join(" ")}  (상태는 pr-state.mjs로 확인)`);
  const bad = summary(r);
  out.push("", `요약: 커밋 ${r.shas.length}개 중 HEAD와 다름 ${bad.shaOff} · 파일 ${r.paths.length}개 중 확인 안 됨 ${bad.pathBad} · 이름 ${r.names.length}개 중 없음 ${bad.nameMiss}${bad.diffMissing ? ` · diff + 줄 이름 중 없음 ${bad.diffMissing}` : ""}`);
  if (!r.shas.length && !r.paths.length && !r.names.length) out.push("글에서 커밋·파일·코드 이름을 찾지 못했습니다. 리뷰가 위치를 말하지 않았다면 주장마다 직접 위치를 찾아야 합니다.");
  return out.join("\n");
}

function summary(r) {
  return {
    // 과거 이력을 언급한 SHA(BEHIND이지만 기준점이 아닌 것)는 문제로 세지 않는다
    shaOff: r.shas.filter((s) => s.status !== "OK" && (s.status !== "BEHIND" || s.reviewPoint)).length,
    pathBad: r.paths.filter((p) => p.status !== "OK").length,
    nameMiss: r.names.filter((n) => n.status !== "OK").length,
    diffMissing: (r.diffAdded ?? []).filter((x) => !x.exists).length,
  };
}

function main(argv) {
  const args = { repo: ".", head: "HEAD", base: null, json: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") { console.log("사용법: node anchors.mjs <글 파일|-> [--repo 경로] [--head 리비전] [--base 리비전] [--json]"); return 0; }
    else if (!args.file) args.file = a;
    else { console.error(`알 수 없는 인자: ${a}`); return 1; }
  }
  if (!args.file) { console.error("리뷰 글 파일을 주세요 (표준 입력이면 -)"); return 1; }
  let text;
  try { text = args.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args.file, "utf8"); }
  catch (e) { console.error(`글 파일을 읽지 못했습니다: ${e.message}`); return 1; }
  let r;
  try { r = check(text, args); } catch (e) { console.error(e.message); return 1; }
  console.log(args.json ? JSON.stringify(r, null, 2) : render(r));
  const b = summary(r);
  return b.shaOff || b.pathBad || b.nameMiss || b.diffMissing ? 2 : 0;
}

// 직접 실행됐을 때만 main. 링크(심볼릭 링크·정션)로 설치한 경로로 불러도 실제 경로끼리 비교한다
function isMain() {
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1])), b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}
if (process.argv[1] && isMain()) process.exitCode = main(process.argv.slice(2));
