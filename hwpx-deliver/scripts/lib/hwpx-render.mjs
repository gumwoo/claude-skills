// HWPX → 인쇄용 HTML(한컴 없이). 양식을 채운 문서처럼, 이 skill이 만들지 않은 HWPX를 그대로 그린다.
// header.xml의 글자 모양·문단 모양·테두리와 구역의 쪽 설정을 CSS로 옮기고, 1단계에서 한컴과 맞춘 보정(FIXUP)을 함께 쓴다.
//
// 그리는 것: 문단(정렬, 여백, 들여쓰기·내어쓰기, 줄 간격, 쪽 나누기), 글자(글꼴, 크기, 굵게·기울임·밑줄·취소선, 색, 자간·장평),
//           탭, 줄바꿈, 표(칸 너비·행 높이·병합·테두리·배경·칸 여백·세로 정렬, 표 안 표, 머리 행 반복),
//           글자처럼 취급한 개체와 떠 있는 개체(표, 그림, 글상자), 머리말·꼬리말, 쪽 번호
// 못 그리는 것은 warnings로 알린다(수식, 차트, OLE, 글맵시, 묶음 개체, 선·도형, 다단, 각주 등)
import { readZip } from "./zip.mjs";
import { parseXml, kids, kid, find, findAll, unswitch } from "./xml.mjs";
import { esc } from "./hwpx-write.mjs";
import { FIXUP, HANCOM } from "./html-render.mjs";

const MM = 25.4 / 7200; // HWPUNIT → mm
const f2 = (x) => Number(x.toFixed(3));
const hu = (v) => f2(Number(v ?? 0) * MM); // HWPUNIT → mm(숫자)

// ---------- header.xml ----------
function parseHeader(xml) {
  const h = parseXml(xml);
  const fonts = {};
  for (const ff of findAll(h, "hh:fontface")) fonts[ff.attrs.lang] = kids(ff, "hh:font").map((f) => f.attrs.face);
  const byId = (tag) => new Map(findAll(h, tag).map((n) => [n.attrs.id, n]));
  return { fonts, charPr: byId("hh:charPr"), paraPr: byId("hh:paraPr"), border: byId("hh:borderFill") };
}

function charInfo(H, id) {
  const c = H.charPr.get(String(id));
  if (!c) return null;
  const ref = kid(c, "hh:fontRef")?.attrs ?? {}, rel = kid(c, "hh:relSz")?.attrs ?? {}, sp = kid(c, "hh:spacing")?.attrs ?? {}, ra = kid(c, "hh:ratio")?.attrs ?? {};
  const hangul = H.fonts.HANGUL?.[Number(ref.hangul ?? 0)] ?? "", latin = H.fonts.LATIN?.[Number(ref.latin ?? 0)] ?? hangul;
  const pt = (Number(c.attrs.height ?? 1000) / 100) * (Number(rel.hangul ?? 100) / 100);
  return {
    id, pt, hangul, latin,
    bold: Boolean(kid(c, "hh:bold")), italic: Boolean(kid(c, "hh:italic")),
    underline: (kid(c, "hh:underline")?.attrs.type ?? "NONE") !== "NONE", strike: (kid(c, "hh:strikeout")?.attrs.shape ?? "NONE") !== "NONE",
    color: c.attrs.textColor ?? "#000000", shade: c.attrs.shadeColor && c.attrs.shadeColor !== "none" ? c.attrs.shadeColor : null,
    // 자간은 글자 크기의 %. 장평(가로 비율)은 글자 폭을 줄이므로, 한글(전각) 기준으로 그만큼 자간을 더해 줄 나눔을 맞춘다(글자 모양은 줄지 않는다)
    spacingEm: Number(sp.hangul ?? 0) / 100 + (Number(ra.hangul ?? 100) - 100) / 100,
    // 숫자·영문은 글자 폭이 반각쯤이다. 한컴의 자간·장평은 글자 폭에 비례하는 것으로 보고(추정, 기안문 대조에서 숫자가 덜 좁았다) 반만 준다
    spacingLatinEm: (Number(sp.latin ?? sp.hangul ?? 0) / 100 + (Number(ra.latin ?? ra.hangul ?? 100) - 100) / 100) * 0.5,
    ratio: Number(ra.hangul ?? 100),
  };
}

// 글꼴이 PC에 없을 때 브라우저가 고를 대체 글꼴: 명조·바탕 계열은 바탕, 나머지는 돋움(한컴도 없는 글꼴은 대체해 그린다)
const fallbackOf = (name) => (/명조|바탕|Myeong|Batang|신명|serif/i.test(name) ? `"함초롬바탕","바탕",serif` : `"함초롬돋움","돋움",sans-serif`);

function charCss(ci, missing) {
  const fam = `${ci.latin && ci.latin !== ci.hangul ? `"${ci.latin}","${ci.hangul}"` : `"${ci.hangul}"`},${fallbackOf(ci.hangul)}`;
  const deco = [ci.underline && "underline", ci.strike && "line-through"].filter(Boolean).join(" ");
  // 없는 글꼴이 굵은 계열(견고딕, 헤드라인 등)이면 대체 글꼴을 굵게 — 한컴도 굵은 대체 글꼴로 그렸다(기안문 제목)
  const heavy = missing?.has(ci.hangul) && /견고딕|헤드라인|굵은|Bold|Black|Heavy/i.test(ci.hangul);
  return `font-family:${fam};font-size:${f2(ci.pt)}pt;font-weight:${ci.bold || heavy ? 700 : 400};font-style:${ci.italic ? "italic" : "normal"};color:${ci.color};${ci.spacingEm ? `letter-spacing:${f2(ci.spacingEm)}em;` : ""}${deco ? `text-decoration:${deco};` : ""}${ci.shade ? `background:${ci.shade};` : ""}`;
}

const ALIGN = { JUSTIFY: "justify", LEFT: "left", RIGHT: "right", CENTER: "center", DISTRIBUTE: "justify", DISTRIBUTE_SPACE: "justify" };

function paraInfo(H, id) {
  const p = H.paraPr.get(String(id));
  if (!p) return null;
  const parts = unswitch(p).filter((x) => typeof x !== "string");
  const margin = parts.find((x) => x.name === "hh:margin");
  const mv = (n) => Number(kid(margin, n)?.attrs.value ?? 0);
  const ls = parts.find((x) => x.name === "hh:lineSpacing")?.attrs ?? { type: "PERCENT", value: "160" };
  const align = kid(p, "hh:align")?.attrs.horizontal ?? "JUSTIFY";
  const br = kid(p, "hh:breakSetting")?.attrs ?? {};
  return {
    id, align, intent: mv("hc:intent"), left: mv("hc:left"), right: mv("hc:right"), prev: mv("hc:prev"), next: mv("hc:next"),
    lsType: ls.type, lsValue: Number(ls.value),
    // 한컴 2022 실측: KEEP_WORD는 글자 단위, BREAK_WORD는 어절 단위로 끊는다(1단계 tests/oracle/README.md)
    keepAll: br.breakNonLatinWord === "BREAK_WORD",
    keepNext: br.keepWithNext === "1", pageBreakBefore: br.pageBreakBefore === "1",
  };
}

function paraCss(pi) {
  const hang = pi.intent < 0 ? -pi.intent : 0, first = pi.intent > 0 ? pi.intent : 0;
  const al = ALIGN[pi.align] ?? "justify";
  return `text-align:${al};${pi.align.startsWith("DISTRIBUTE") ? "text-align-last:justify;" : ""}padding:${f2(pi.prev / 100)}pt ${hu(pi.right)}mm ${f2(pi.next / 100)}pt ${hu(pi.left + hang)}mm;text-indent:${hu(first - hang)}mm;word-break:${pi.keepAll ? "keep-all" : "break-all"};${pi.keepNext ? "break-after:avoid;" : ""}`;
}

// 줄 높이를 글자 크기의 배수로(1단계 FIXUP이 이 값으로 기준선을 맞춘다)
function lineMul(pi, pt) {
  if (pi.lsType === "FIXED") return Math.max(0.5, pi.lsValue / 100 / pt);
  if (pi.lsType === "BETWEEN_LINES") return 1 + pi.lsValue / 100 / pt;
  if (pi.lsType === "AT_LEAST") return Math.max(1, pi.lsValue / 100 / pt);
  return pi.lsValue / 100;
}

const BORDER_STYLE = { NONE: "none", SOLID: "solid", DASH: "dashed", DOT: "dotted", DASH_DOT: "dashed", DASH_DOT_DOT: "dashed", LONG_DASH: "dashed", DOUBLE_SLIM: "double", SLIM_THICK: "double", THICK_SLIM: "double", SLIM_THICK_SLIM: "double", CIRCLE: "dotted", WAVE: "solid", DOUBLE_WAVE: "double", THICK_3D: "solid", THICK_3D_REVERS: "solid", "3D": "solid", "3D_REVERS": "solid" };

// 테두리 두께(mm): 칸 여백 보정에 쓴다
function borderWidth(H, id, side) {
  const s = kid(H.border.get(String(id)), side)?.attrs;
  if (!s || s.type === "NONE") return 0;
  return parseFloat(String(s.width ?? "0.12")) || 0;
}

function borderCss(H, id) {
  const b = H.border.get(String(id));
  if (!b) return "";
  const side = (n, css) => {
    const s = kid(b, n)?.attrs;
    if (!s || s.type === "NONE") return `border-${css}:none;`;
    return `border-${css}:${String(s.width ?? "0.12 mm").replace(/\s+/g, "")} ${BORDER_STYLE[s.type] ?? "solid"} ${s.color ?? "#000"};`;
  };
  const face = find(b, "hc:winBrush")?.attrs.faceColor;
  return side("hh:leftBorder", "left") + side("hh:rightBorder", "right") + side("hh:topBorder", "top") + side("hh:bottomBorder", "bottom") + (face && face !== "none" ? `background:${face};` : "");
}

// ---------- 본문 ----------
// missing: PC에 없는 글꼴 이름(Set). 주면 대체할 때 굵은 계열을 굵게 그린다
export function renderHwpx(buf, { title = "", missing = null } = {}) {
  const entries = readZip(buf);
  const get = (n) => entries.find((e) => e.name === n)?.data;
  const H = parseHeader(get("Contents/header.xml")?.toString("utf8") ?? "<x/>");
  const manifest = parseXml(get("Contents/content.hpf")?.toString("utf8") ?? "<x/>");
  const bin = new Map(findAll(manifest, "opf:item").map((i) => [i.attrs.id, { href: i.attrs.href, type: i.attrs["media-type"] }]));
  const secs = entries.filter((e) => /^Contents\/section\d+\.xml$/.test(e.name)).sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  const warnings = new Set();
  const usedChars = new Set(), usedParas = new Set(), needFonts = new Set(), usedLatin = new Set();
  const css = [];
  let pageNum = null, page = null;
  const headerFooter = [];

  const runHtml = (run, pChar) => {
    const cid = run.attrs.charPrIDRef;
    const ci0 = charInfo(H, cid);
    // 한글이 아닌 글자(숫자·영문)는 자간이 다르면 따로 감싼다
    const latinSplit = ci0 && Math.abs(ci0.spacingLatinEm - ci0.spacingEm) > 0.001;
    const seg = (str) => (latinSplit ? str.split(/([가-힣ㄱ-ㅎㅏ-ㅣ\s]+)/).map((part, i) => (i % 2 ? esc(part) : part ? (usedLatin.add(cid), `<span class="L${cid}">${esc(part)}</span>`) : "")).join("") : esc(str));
    let s = "";
    for (const c of kids(run)) {
      if (c.name === "hp:t") {
        for (const x of c.children) {
          if (typeof x === "string") s += seg(x);
          else if (x.name === "hp:tab") s += `<span class="tab" style="width:${hu(x.attrs.width ?? 4000)}mm"></span>`;
          else if (x.name === "hp:lineBreak") s += "<br>";
          else if (x.name === "hp:nbSpace" || x.name === "hp:fwSpace") s += "&nbsp;";
          else if (x.name === "hp:hyphen") s += "-";
        }
      } else s += objectHtml(c);
    }
    if (!s) return "";
    usedChars.add(cid);
    // 실제로 그리는 글자 종류에 쓰이는 글꼴만 필요한 글꼴로 센다
    const txt = kids(run, "hp:t").flatMap((t) => t.children.filter((x) => typeof x === "string")).join("");
    const ci = charInfo(H, cid);
    if (ci) { if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(txt)) needFonts.add(ci.hangul); if (/[A-Za-z0-9]/.test(txt)) needFonts.add(ci.latin); }
    return cid === pChar ? s : `<span class="c${cid}">${s}</span>`;
  };

  // 개체 놓기:
  //   글자처럼 취급(treatAsChar=1) → 줄 안에
  //   위아래로 글 피하기(TOP_AND_BOTTOM)·둘러싸기 → 본문 흐름 안의 블록(오프셋은 여백으로). 한컴도 글을 개체 위아래로 흘리고, 표는 쪽을 넘긴다
  //   글 앞으로·뒤로 → 문단 기준으로 떠 있게
  let objs = { any: false, flow: false };
  const placed = (node, inner, w) => {
    const pos = kid(node, "hp:pos")?.attrs ?? {};
    if (pos.treatAsChar === "1") { objs.any = true; return `<span class="inl">${inner}</span>`; }
    const top = hu(pos.vertOffset), left = hu(pos.horzOffset);
    if (pos.vertRelTo === "PAPER" || pos.vertRelTo === "PAGE" || pos.horzRelTo === "PAPER" || pos.horzRelTo === "PAGE") warnings.add("쪽 기준으로 놓인 개체는 문단 기준으로 근사해 그림");
    const wrap = node.attrs.textWrap ?? "TOP_AND_BOTTOM";
    if (wrap === "IN_FRONT_OF_TEXT" || wrap === "BEHIND_TEXT") return `<div class="float" style="top:${top}mm;left:${left}mm;width:${w}mm;z-index:${wrap === "BEHIND_TEXT" ? 0 : 2}">${inner}</div>`;
    if (wrap === "SQUARE" || wrap === "TIGHT" || wrap === "THROUGH") warnings.add("글 둘러싸기 개체는 위아래 배치로 근사해 그림");
    // 떠 있는 개체(글 앞·뒤)는 문단 줄을 차지하지 않으므로 objs.any에 넣지 않는다: 앵커 문단은 빈 줄 한 줄을 그대로 차지한다
    objs.any = true;
    objs.flow = true;
    const h = pos.horzAlign === "CENTER" ? "margin-left:auto;margin-right:auto;" : pos.horzAlign === "RIGHT" ? `margin-left:auto;margin-right:${left}mm;` : `margin-left:${left}mm;`;
    return `<div class="flow" style="margin-top:${top}mm;${h}width:${w}mm">${inner}</div>`;
  };

  const objectHtml = (n) => {
    switch (n.name) {
      case "hp:tbl": { const t = tableHtml(n); return placed(n, t.html, t.w); }
      case "hp:pic": {
        const img = find(n, "hc:img"), sz = kid(n, "hp:sz")?.attrs ?? kid(n, "hp:curSz")?.attrs ?? {};
        const w = hu(sz.width), h = hu(sz.height);
        const item = bin.get(img?.attrs.binaryItemIDRef);
        const data = item && get(item.href);
        if (!data) { warnings.add("그림 파일을 찾지 못함"); return ""; }
        return placed(n, `<img src="data:${item.type ?? "image/png"};base64,${data.toString("base64")}" style="width:${w}mm;height:${h}mm;display:block">`, w);
      }
      case "hp:rect": {
        const sz = kid(n, "hp:sz")?.attrs ?? {}, w = hu(sz.width), h = hu(sz.height);
        const line = kid(n, "hp:lineShape")?.attrs ?? {}, fill = find(n, "hc:winBrush")?.attrs.faceColor;
        const dt = kid(n, "hp:drawText"), m = kid(dt, "hp:textMargin")?.attrs ?? {};
        const body = dt ? subListHtml(kid(dt, "hp:subList")) : "";
        const border = line.style && line.style !== "NONE" ? `border:${hu(line.width ?? 33)}mm solid ${line.color ?? "#000"};` : "";
        return placed(n, `<div class="box" style="width:${w}mm;height:${h}mm;${border}${fill && fill !== "none" ? `background:${fill};` : ""}padding:${hu(m.top)}mm ${hu(m.right)}mm ${hu(m.bottom)}mm ${hu(m.left)}mm">${body}</div>`, w);
      }
      case "hp:ctrl": {
        for (const c of kids(n)) {
          if (c.name === "hp:header" || c.name === "hp:footer") headerFooter.push({ kind: c.name === "hp:header" ? "header" : "footer", html: subListHtml(kid(c, "hp:subList")) });
          else if (c.name === "hp:pageNum") pageNum = c.attrs;
          else if (c.name === "hp:colPr" && Number(c.attrs.colCount ?? 1) > 1) warnings.add("다단은 한 단으로 그림");
          else if (c.name === "hp:footNote" || c.name === "hp:endNote") warnings.add("각주·미주는 그리지 않음");
        }
        return "";
      }
      case "hp:secPr": return "";
      case "hp:equation": case "hp:chart": case "hp:ole": case "hp:textart": case "hp:container":
      case "hp:line": case "hp:ellipse": case "hp:arc": case "hp:polygon": case "hp:curve": case "hp:connectLine":
        warnings.add(`그리지 못한 개체: ${n.name.slice(3)}`);
        return "";
      default: return "";
    }
  };
  // 흐름 안 표 바로 다음 문단은 위 간격(prev)이 없다(1단계에서 한컴 2022로 확인한 동작)
  let afterFlow = false;
  const paraHtml = (p) => {
    const pid = p.attrs.paraPrIDRef;
    const runs = kids(p, "hp:run");
    const firstChar = runs.find((r) => kids(r, "hp:t").length)?.attrs.charPrIDRef ?? runs[0]?.attrs.charPrIDRef ?? "0";
    const pi = paraInfo(H, pid) ?? paraInfo(H, "0");
    const ci = charInfo(H, firstChar) ?? charInfo(H, "0");
    usedParas.add(pid); usedChars.add(firstChar);
    const savedObjs = objs, savedAfter = afterFlow;
    objs = { any: false, flow: false };
    afterFlow = false;
    const inner = runs.map((r) => runHtml(r, firstChar)).join("");
    const mine = objs;
    objs = savedObjs;
    const after = savedAfter;
    afterFlow = mine.flow;
    const L = lineMul(pi, ci.pt);
    const pb = p.attrs.pageBreak === "1" || pi.pageBreakBefore ? " pb" : "";
    // 글자 없이 개체만 있는 문단: 줄 상자 높이를 없애고 개체만 놓는다. 기준선 보정(FIXUP)도 걸지 않는다(표가 밀린다)
    const textless = !runs.some((r) => kids(r, "hp:t").some((t) => t.children.some((x) => (typeof x === "string" ? x.length : x.name === "hp:tab"))));
    const objOnly = textless && mine.any;
    const fix = objOnly ? "" : ` data-k="p${pid}c${firstChar}" data-l="${f2(L)}"`;
    // 빈 문단은 글자 없이 최소 높이로 한 줄을 잡는다(보이지 않는 글자를 넣으면 PDF 텍스트에 섞인다)
    // CSS는 줄 끝 글자 뒤에도 자간을 더하므로, 자간이 양수면 그만큼 오른쪽으로 넓혀 한컴처럼 끊기게 한다
    const sp = ci.spacingEm > 0 ? `margin-right:-${f2(ci.spacingEm)}em;` : "";
    return `<div class="para p${pid} c${firstChar}${pb}${objOnly ? " objonly" : ""}${after ? " after" : ""}"${fix} style="line-height:${f2(L)};${objOnly ? "" : `min-height:${f2(L)}em;`}${sp}">${inner}</div>`;
  };

  const subListHtml = (sub) => (sub ? kids(sub, "hp:p").map(paraHtml).join("") : "");

  const tableHtml = (t) => {
    const sz = kid(t, "hp:sz")?.attrs ?? {}, inM = kid(t, "hp:inMargin")?.attrs ?? {};
    const rows = kids(t, "hp:tr");
    const cols = Number(t.attrs.colCnt);
    const cells = rows.flatMap((tr) => kids(tr, "hp:tc").map((tc) => {
      const a = kid(tc, "hp:cellAddr")?.attrs ?? {}, sp = kid(tc, "hp:cellSpan")?.attrs ?? {}, cs = kid(tc, "hp:cellSz")?.attrs ?? {};
      return { tc, row: Number(a.rowAddr), col: Number(a.colAddr), colspan: Number(sp.colSpan ?? 1), rowspan: Number(sp.rowSpan ?? 1), w: Number(cs.width), h: Number(cs.height) };
    }));
    // 열 너비: 한 칸짜리 칸에서 먼저 정하고, 병합 칸으로 나머지를 푼다
    const colW = Array(cols).fill(null);
    for (let pass = 0; pass < cols + 1; pass++) {
      for (const c of cells) {
        const span = Array.from({ length: c.colspan }, (_, i) => c.col + i);
        const unknown = span.filter((i) => colW[i] == null);
        if (unknown.length === 1) colW[unknown[0]] = Math.max(0, c.w - span.filter((i) => colW[i] != null).reduce((s, i) => s + colW[i], 0));
      }
    }
    const known = colW.reduce((s, x) => s + (x ?? 0), 0), miss = colW.filter((x) => x == null).length;
    for (let i = 0; i < cols; i++) if (colW[i] == null) colW[i] = miss ? Math.max(0, (Number(sz.width) - known) / miss) : 0;
    const rowH = rows.map((_, r) => Math.max(0, ...cells.filter((c) => c.row === r && c.rowspan === 1).map((c) => c.h)));
    const headRows = new Set(cells.filter((c) => c.tc.attrs.header === "1").map((c) => c.row));
    const trHtml = rows.map((tr, r) => {
      const tds = cells.filter((c) => c.row === r).map((c) => {
        const own = c.tc.attrs.hasMargin === "1" ? kid(c.tc, "hp:cellMargin")?.attrs ?? inM : inM;
        const sub = kid(c.tc, "hp:subList");
        const va = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" }[sub?.attrs.vertAlign ?? "TOP"] ?? "top";
        // 한컴은 테두리 두께를 칸 높이에 넣지 않는데, 브라우저는 1픽셀보다 가는 테두리도 1픽셀로 그려 행 높이에 넣는다. 그만큼 위아래 여백에서 뺀다(1단계와 같은 보정)
        const bf = c.tc.attrs.borderFillIDRef, PX = 25.4 / 96;
        const bt = borderWidth(H, bf, "hh:topBorder"), bb = borderWidth(H, bf, "hh:bottomBorder");
        const pt = Math.max(0, hu(own.top) - (bt ? Math.max(bt, PX) / 2 : 0)), pb = Math.max(0, hu(own.bottom) - (bb ? Math.max(bb, PX) / 2 : 0));
        return `<td${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""} style="${borderCss(H, bf)}padding:${f2(pt)}mm ${hu(own.right)}mm ${f2(pb)}mm ${hu(own.left)}mm;vertical-align:${va}">${subListHtml(sub)}</td>`;
      });
      return `<tr style="height:${hu(rowH[r])}mm">${tds.join("")}</tr>`;
    });
    // 맨 위에서 이어지는 머리 행은 thead로(쪽을 넘으면 반복)
    let nHead = 0;
    while (headRows.has(nHead) && t.attrs.repeatHeader === "1") nHead++;
    const w = hu(sz.width), h = hu(sz.height);
    // 표 자체의 테두리 설정은 그리지 않는다(한컴 2022는 칸 테두리만 그렸다: 기안문 대조)
    const html = `<table style="width:${w}mm"><colgroup>${colW.map((x) => `<col style="width:${hu(x)}mm">`).join("")}</colgroup>${nHead ? `<thead>${trHtml.slice(0, nHead).join("")}</thead>` : ""}<tbody>${trHtml.slice(nHead).join("")}</tbody></table>`;
    return { html, w, h };
  };

  const body = secs.map((e, si) => {
    const sec = parseXml(e.data.toString("utf8"));
    const root = find(sec, "hs:sec");
    const sp = find(root, "hp:secPr");
    if (sp) {
      const pp = kid(sp, "hp:pagePr")?.attrs ?? {}, mg = kid(kid(sp, "hp:pagePr"), "hp:margin")?.attrs ?? {};
      let w = hu(pp.width), h = hu(pp.height);
      // 한컴: landscape="NARROWLY"가 가로 방향(크기 값은 세로 기준) — 추정, 대조 안 함
      if (pp.landscape === "NARROWLY" && w < h) [w, h] = [h, w];
      css.push(`@page s${si}{size:${w}mm ${h}mm;margin:${f2(hu(mg.top) + hu(mg.header))}mm ${hu(mg.right)}mm ${f2(hu(mg.bottom) + hu(mg.footer))}mm ${hu(mg.left)}mm}`);
      if (si === 0) page = { w, h, mg: Object.fromEntries(Object.entries(mg).map(([k, v]) => [k, hu(v)])) };
    }
    return `<section style="page:s${si}"${si ? ' class="pb"' : ""}>${kids(root, "hp:p").map(paraHtml).join("")}</section>`;
  }).join("");

  for (const id of usedChars) { const ci = charInfo(H, id); if (ci) css.push(`.c${id}{${charCss(ci, missing)}}`); }
  for (const id of usedParas) { const pi = paraInfo(H, id); if (pi) css.push(`.p${id}{${paraCss(pi)}}`); }
  for (const id of usedLatin) { const ci = charInfo(H, id); if (ci) css.push(`.L${id}{letter-spacing:${f2(ci.spacingLatinEm)}em}`); }
  const fontsUsed = [...needFonts].filter(Boolean);
  if ([...usedChars].some((id) => (charInfo(H, id)?.ratio ?? 100) !== 100)) warnings.add("장평(글자 가로 비율)은 글자 폭 대신 자간으로 맞춤: 줄 나눔은 맞추지만 글자 모양은 줄지 않음");

  // 머리말·꼬리말: 인쇄할 때 쪽마다 되풀이되는 고정 위치로(위·아래 여백 안)
  const mg = page?.mg ?? { top: 20, bottom: 15, header: 0, footer: 0, left: 20, right: 20 };
  const hf = headerFooter.map((x) => x.kind === "header"
    ? `<div class="hf" style="top:${f2(-(mg.header || 0))}mm">${x.html}</div>`
    : `<div class="hf" style="bottom:${f2(-(mg.footer || 0))}mm">${x.html}</div>`).join("");
  // 쪽 번호: 글꼴은 "쪽 번호" 글자 스타일(없으면 첫 한글 글꼴 10pt). 아래 가운데는 1단계에서 한컴과 맞춘 위치 보정(data-pn)을 쓴다
  let pn = "";
  if (pageNum) {
    const box = { TOP_LEFT: "top-left", TOP_CENTER: "top-center", TOP_RIGHT: "top-right", BOTTOM_LEFT: "bottom-left", BOTTOM_CENTER: "bottom-center", BOTTOM_RIGHT: "bottom-right" }[pageNum.pos];
    if (box) {
      const side = pageNum.sideChar && pageNum.sideChar !== "" ? pageNum.sideChar : "";
      const st = findAll(parseXml(get("Contents/header.xml")?.toString("utf8") ?? "<x/>"), "hh:style").find((s) => s.attrs.name === "쪽 번호");
      const pci = (st && charInfo(H, st.attrs.charPrIDRef)) || null;
      const font = pci?.hangul ?? H.fonts.HANGUL?.[0] ?? "", pt = pci?.pt ?? 10;
      css.push(`@page{@${box}{content:"${side ? side + " " : ""}" counter(page) "${side ? " " + side : ""}";font-family:"${font}";font-size:${f2(pt)}pt;line-height:1;vertical-align:top;text-align:center}}`);
      if (box === "bottom-center") pn = ` data-pn='${JSON.stringify({ font, pt, footer: page?.mg.footer ?? 0, box }).replace(/'/g, "&#39;")}'`;
      else warnings.add(`쪽 번호 위치 ${pageNum.pos}는 한컴과 대조하지 않음`);
    }
  }

  const base = [
    `html,body{margin:0;padding:0;background:#fff;color:#000}`,
    `section{display:block}`,
    // 한컴은 공백을 줄이지 않는다(문단 앞 공백, 연속 공백)
    `.para{margin:0;white-space:pre-wrap;overflow-wrap:break-word;orphans:1;widows:1;font-kerning:none;position:relative}`,
    `.inl{display:inline-block;vertical-align:bottom;text-indent:0;white-space:normal}`,
    // 글자 없이 개체만 있는 문단: 줄 상자 높이를 없애고 개체만 문단 정렬대로 놓는다
    `.para.objonly{font-size:0;line-height:0!important;padding-top:0;padding-bottom:0}.objonly .inl{vertical-align:top}`,
    `.para.after{padding-top:0}`,
    `.flow{text-indent:0;white-space:normal}`,
    `.float{position:absolute;text-indent:0;white-space:normal}`,
    `.box{box-sizing:border-box;overflow:hidden}`,
    `.tab{display:inline-block}`,
    `table{border-collapse:collapse;table-layout:fixed}`,
    `td{box-sizing:border-box;overflow:hidden}`,
    `tr{break-inside:avoid}`,
    `.pb{break-before:page}`,
    `.hf{position:fixed;left:0;right:0}`,
  ];
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${[...base, ...css].join("\n")}</style></head><body${pn}>${hf}${body}<script>${FIXUP}</script></body></html>`;
  return { html, warnings: [...warnings], fonts: fontsUsed, page };
}

export { HANCOM };
