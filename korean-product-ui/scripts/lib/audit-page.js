// 브라우저 페이지 안에서 실행되는 검사. check-ui.mjs가 이 함수를 문자열로 넣어 실행한다.
// 반환: { title, viewport: {width, height}, findings: [{ level, rule, message, where }], stats }
// level: ERROR(고쳐야 함) · WARN(대부분 고쳐야 함) · INFO(판단해서 고침)
(async function audit(opts) {
  const MOBILE = !!opts.mobile;
  const findings = [];
  const seen = new Set();
  const HANGUL = /[가-힣]/;
  const WORDCHAR = /[가-힣A-Za-z0-9]/;

  const describe = (el) => {
    if (!el || !el.tagName) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    return s;
  };
  const snippet = (t, n = 28) => { t = String(t).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
  const add = (level, rule, message, el, key) => {
    const k = rule + "|" + (key ?? message);
    if (seen.has(k)) return;
    seen.add(k);
    findings.push({ level, rule, message, where: describe(el) });
  };
  const visible = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (e.getAttribute("aria-hidden") === "true") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // ---------- 보이는 텍스트 모으기 ----------
  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const p = n.parentElement;
    if (!p || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(p.tagName)) continue;
    if (!visible(p)) continue;
    textNodes.push(n);
  }
  const inFooter = (el) => !!el.closest("footer, [data-kpui-ignore]");

  // ---------- 1. 한글 어절 중간 줄바꿈 ----------
  let checkedChars = 0;
  for (const node of textNodes) {
    const el = node.parentElement;
    const text = node.nodeValue;
    if (!HANGUL.test(text)) continue;
    if (getComputedStyle(el).whiteSpace.startsWith("nowrap") || getComputedStyle(el).whiteSpace === "pre") continue;
    if (checkedChars > 6000) break;
    const range = document.createRange();
    let prevTop = null, prevIdx = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) { prevTop = null; prevIdx = -1; continue; }
      range.setStart(node, i); range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      checkedChars++;
      if (prevTop !== null && rect.top - prevTop > rect.height * 0.5 && prevIdx === i - 1) {
        const a = text[i - 1], b = ch;
        if (WORDCHAR.test(a) && WORDCHAR.test(b) && (HANGUL.test(a) || HANGUL.test(b))) {
          const left = text.slice(Math.max(0, i - 6), i).split(/\s/).pop();
          const right = text.slice(i, i + 6).split(/\s/)[0];
          add("ERROR", "ko-midword-break", `어절 중간에서 줄이 바뀝니다: "${left}|${right}" (word-break: keep-all 필요)`, el, left + right);
        }
      }
      prevTop = rect.top; prevIdx = i;
    }
  }

  // ---------- 2. 한글 타이포그래피 ----------
  const KO_FONTS = /pretendard|suit|wanted sans|noto sans kr|noto sans cjk|spoqa|apple sd gothic|malgun|맑은 고딕|nanum|나눔|ibm plex sans kr|gmarket|s-core|paperlogy|system-ui|-apple-system|blinkmacsystemfont|sans-serif-ko/i;
  const stacksReported = new Set();
  const lineHeightReported = new Set();
  for (const node of textNodes) {
    const el = node.parentElement;
    if (!HANGUL.test(node.nodeValue)) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!KO_FONTS.test(cs.fontFamily) && !stacksReported.has(cs.fontFamily)) {
      stacksReported.add(cs.fontFamily);
      add("WARN", "ko-font-stack", `한글 글꼴이 없는 글꼴 지정: ${snippet(cs.fontFamily, 60)} (한글은 기기 기본 글꼴로 대체돼 화면마다 달라집니다)`, el);
    }
    if (size < 12) add("WARN", "ko-small-text", `한글 글자가 ${size}px로 너무 작습니다(12px 이상): "${snippet(node.nodeValue)}"`, el);
    const lh = cs.lineHeight === "normal" ? 1.2 : parseFloat(cs.lineHeight) / size;
    // 본문만 본다(제목·굵은 라벨은 줄 간격을 좁게 쓰는 게 맞다). 줄 수는 글자가 실제로 그려진 줄을 센다
    const isBody = size <= 18 && Number(cs.fontWeight) < 600 && !el.closest("h1, h2, h3, h4, h5, h6, button");
    if (isBody && lh < 1.4 && !lineHeightReported.has(el)) {
      const r = document.createRange(); r.selectNodeContents(node);
      const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
      if (tops.size >= 2) {
        lineHeightReported.add(el);
        add("WARN", "ko-line-height", `여러 줄 한글 본문의 줄 간격이 ${lh.toFixed(2)}배입니다(1.5 안팎 권장): "${snippet(node.nodeValue)}"`, el);
      }
    }
    if (size >= 28 && (cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing)) >= 0) add("INFO", "ko-heading-tracking", `큰 한글 제목(${size}px)의 자간이 0 이상입니다. -0.02em 안팎으로 좁히면 덜 벌어져 보입니다: "${snippet(node.nodeValue)}"`, el);
  }

  // ---------- 3. 문구 ----------
  const uiText = textNodes.filter((n) => !inFooter(n.parentElement));
  const allText = uiText.map((n) => n.nodeValue).join("\n");
  for (const n of uiText) {
    const t = n.nodeValue, el = n.parentElement;
    for (const m of t.matchAll(/(^|[^\d,.])(\d{4,})(\s?원)/g)) add("ERROR", "num-comma", `1,000 이상 금액에 쉼표가 없습니다: "${m[2]}${m[3]}" → "${Number(m[2]).toLocaleString("ko-KR")}원"`, el, m[2]);
    for (const m of t.matchAll(/(^|[^\d,.])(\d{4,})\s?(명|개|건|회|곳|점|건의|마리)/g)) add("WARN", "num-comma", `1,000 이상 수에 쉼표가 없습니다: "${m[2]}${m[3]}"`, el, m[2] + m[3]);
    if (/클릭/.test(t)) add("WARN", "copy-click", `"클릭"은 쓰지 않습니다. 할 행동이나 버튼 이름을 쓰세요: "${snippet(t)}"`, el, t);
    if (/되어지|되어집니다|되어졌/.test(t)) add("WARN", "copy-double-passive", `이중 피동 표현입니다("되어지다" → "되다"): "${snippet(t)}"`, el, t);
    if (/(혜택|할인|포인트|쿠폰).{0,12}(포기|안 받|필요 없|손해)|손해\s?보|놓칠게요|포기할게요/.test(t)) add("WARN", "dark-confirmshaming", `거절하는 사람을 탓하거나 겁주는 문구입니다: "${snippet(t, 40)}"`, el, t);
    if (/lorem ipsum|dolor sit amet|텍스트를 입력하세요|여기에 제목/i.test(t)) add("WARN", "placeholder-text", `자리표시 문구가 남아 있습니다: "${snippet(t)}"`, el, t);
    const emoji = t.match(/\p{Extended_Pictographic}/gu);
    if (emoji) add("WARN", "emoji-icon", `UI 문구에 이모지가 있습니다(${[...new Set(emoji)].join(" ")}). 아이콘은 SVG로, 문구는 글로 전달하세요: "${snippet(t)}"`, el, emoji.join(""));
    for (const w of ["혹시", "앞으로", "다양한", "지금 바로", "쉽고 빠르게", "손쉽게"]) {
      if (t.includes(w)) add("INFO", "copy-weed", `의미 없이 들어가기 쉬운 말 "${w}": 빼도 뜻이 같으면 지우세요: "${snippet(t)}"`, el, w + t);
    }
  }
  // 말투 섞임: 해요체 문장과 합쇼체 문장이 같은 화면에 함께 있으면
  const sentences = allText.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter((s) => HANGUL.test(s));
  const hapsyo = sentences.filter((s) => /(습니다|습니까|십시오|됩니다|합니다|입니다)[.!?]?$/.test(s));
  const haeyo = sentences.filter((s) => /요[.!?]?$/.test(s));
  if (hapsyo.length && haeyo.length) {
    add("WARN", "copy-tone-mix", `해요체와 합쇼체가 섞여 있습니다. 예: "${snippet(haeyo[0], 24)}" / "${snippet(hapsyo[0], 24)}"`, document.body);
  }
  const bangs = (allText.match(/!/g) || []).length;
  if (bangs > 2) add("INFO", "copy-exclaim", `느낌표가 ${bangs}개 있습니다. 강조는 문장보다 구조로 하세요`, document.body);

  // ---------- 4. 가로 넘침 ----------
  // 모바일 에뮬레이션에서는 넘친 만큼 레이아웃 폭이 늘어나므로 지정한 화면 폭을 기준으로 본다
  const W = opts.width || window.innerWidth;
  if (document.documentElement.scrollWidth > W + 1) {
    const over = [...document.body.querySelectorAll("*")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.right > W + 1 && r.width > 0 && visible(e) && getComputedStyle(e).position !== "fixed";
    });
    const top = over.filter((e) => !over.includes(e.parentElement)).slice(0, 3);
    add("ERROR", "overflow-x", `가로로 넘칩니다(문서 폭 ${document.documentElement.scrollWidth}px > 화면 ${W}px): ${top.map(describe).join(", ")}`, top[0]);
  }

  // ---------- 5. 터치 영역 (모바일) ----------
  if (MOBILE) {
    const small = [];
    for (const el of document.querySelectorAll("a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary, [onclick], label[for]")) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (el.tagName === "A" && cs.display === "inline" && el.closest("p, li")) continue; // 문장 안의 링크
      if (el.tagName === "INPUT" && ["checkbox", "radio"].includes(el.type) && el.closest("label")) continue; // 라벨이 터치 영역
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) small.push(`${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    if (small.length) add("WARN", "touch-target", `터치 영역이 44×44px보다 작은 요소 ${small.length}개: ${small.slice(0, 4).join(", ")}${small.length > 4 ? " …" : ""}`, document.body);
  }

  // ---------- 6. 글자 대비 ----------
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  // 반투명 배경은 아래 불투명 배경과 섞어서 계산한다(예: 사진 위 rgba(0,0,0,.6) 배지)
  const bgOf = (el) => {
    const layers = [];
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !layers.length) return null; // 이미지·그라데이션 바로 위 글자는 판단하지 않음
      const c = parse(cs.backgroundColor);
      if (!c || c.a === 0) continue;
      if (c.a > 0.9) { base = c; break; }
      layers.push(c);
    }
    for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a), a: 1 };
    return base;
  };
  const contrastDone = new Set();
  for (const n of textNodes) {
    const el = n.parentElement;
    if (contrastDone.has(el)) continue;
    contrastDone.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    if (el.closest("button[disabled], [aria-disabled=true]")) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) add(ratio < (large ? 2 : 3) ? "ERROR" : "WARN", "contrast", `글자 대비 ${ratio.toFixed(2)}:1 (${large ? "큰 글자 3" : "4.5"}:1 이상 필요): "${snippet(n.nodeValue)}"`, el);
  }

  // ---------- 7. 흔한 AI 화면 신호 ----------
  const hue = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return { h: 0, s: 0 }; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; const l = (mx + mn) / 2; return { h, s: d / (1 - Math.abs(2 * l - 1)) }; };
  let shadowed = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (/gradient/.test(cs.backgroundImage)) {
      const cols = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter(Boolean).map(hue);
      if (cols.some((c) => c.h >= 235 && c.h <= 300 && c.s > 0.35)) add("WARN", "ai-gradient", "보라·남색 계열 그라데이션 배경: AI 기본 화면에서 가장 흔한 신호입니다", el, "grad");
    }
    // inset 그림자는 테두리 대용이므로 세지 않는다
    if (cs.boxShadow && cs.boxShadow !== "none" && cs.boxShadow.split(/,(?![^(]*\))/).some((x) => !/inset/.test(x)) && el.getBoundingClientRect().height > 40) shadowed++;
    if (/blur\(/.test(cs.backdropFilter || "")) add("INFO", "ai-glass", "반투명 블러(glassmorphism) 효과: 꼭 필요한 곳인지 확인하세요", el, "glass");
  }
  if (shadowed >= 6) add("INFO", "ai-shadow", `그림자가 있는 블록이 ${shadowed}개입니다. 1px 구분선이나 배경색 차이로 나누면 덜 무거워 보입니다`, document.body);

  // ---------- 8. 다크패턴 ----------
  for (const cb of document.querySelectorAll("input[type=checkbox]")) {
    if (!cb.checked || !visible(cb.closest("label") || cb)) continue;
    const label = (cb.closest("label")?.innerText || document.querySelector(`label[for="${cb.id}"]`)?.innerText || cb.parentElement?.innerText || "");
    if (/마케팅|광고|수신|이벤트|혜택 알림|제3자|선택/.test(label)) add("ERROR", "dark-prechecked", `선택 동의 항목이 미리 체크돼 있습니다: "${snippet(label, 40)}"`, cb);
  }

  return {
    title: document.title,
    viewport: { width: W, height: opts.height || window.innerHeight },
    findings,
    stats: { textNodes: textNodes.length, checkedChars },
  };
})
