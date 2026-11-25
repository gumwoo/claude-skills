// 문서 모델 → HWPX(zip). 한컴오피스 없이 만든다.
// 구조는 한컴 2022가 저장한 HWPX(OWPML, KS X 6101)를 기준으로 했고, 알려진 함정을 지킨다:
//  - mimetype은 첫 항목, 압축하지 않음 / version.xml도 비압축
//  - 표에 rowCnt·colCnt, 칸마다 cellAddr·cellSpan·cellSz, 빈 칸에도 문단 하나
//  - 글자·문단 모양은 id 순서대로 빠짐없이(목록 안 순서로 해석되므로)
//  - 길이 값에는 unit을 붙인다 / linesegarray(줄바꿈 캐시)는 쓰지 않는다(한컴이 다시 계산)
//  - 한글 줄 나눔은 breakNonLatinWord="BREAK_WORD": 한컴 2022로 시험하니 이 값이 어절 단위로 끊고, 이름과 달리 KEEP_WORD가 글자 단위로 끊었다
import { writeZip } from "./zip.mjs";
import { mm2hu, pt2hu } from "./model.mjs";

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const ALL = (v) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;
const ALIGN = { left: "LEFT", right: "RIGHT", center: "CENTER", justify: "JUSTIFY" };

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 쓰이는 글자·문단 모양만 모아 id를 매긴다(0부터 빈틈없이)
function collectShapes(m) {
  const fonts = [...new Set(Object.values(m.preset.fonts))];
  const charKeys = new Map(), paraKeys = new Map();
  const charOf = (style, bold) => {
    const st = typeof style === "string" ? m.preset.styles[style] : style; // 서식 이름 또는 { font, pt, bold }
    const k = JSON.stringify([fonts.indexOf(m.preset.fonts[st.font]), st.pt, Boolean(bold ?? st.bold)]);
    if (!charKeys.has(k)) charKeys.set(k, charKeys.size);
    return charKeys.get(k);
  };
  const paraOf = (style, over = {}) => {
    const st = { ...m.preset.styles[style], ...over };
    const k = JSON.stringify([st.align, st.left_mm ?? 0, st.hang_mm ?? 0, st.before_pt ?? 0, st.after_pt ?? 0, st.line, Boolean(st.keepNext), Boolean(st.pageBreakBefore)]);
    if (!paraKeys.has(k)) paraKeys.set(k, paraKeys.size);
    return paraKeys.get(k);
  };
  charOf("body"); paraOf("body"); // id 0은 바탕글
  const pageNumChar = m.number ? charOf({ font: m.number.font, pt: m.number.pt, bold: false }) : null;
  return { fonts, charKeys, paraKeys, charOf, paraOf, pageNumChar };
}

function headerXml(m, sh) {
  const fontfaces = LANGS.map((lang) => `<hh:fontface lang="${lang}" fontCnt="${sh.fonts.length}">${sh.fonts.map((f, i) => `<hh:font id="${i}" face="${esc(f)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`).join("")}</hh:fontface>`).join("");
  const side = (name, type, w) => `<hh:${name} type="${type}" width="${w}" color="#000000"/>`;
  const bw = `${m.preset.table.border_mm} mm`;
  const borderFill = (id, type, fill) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${side("leftBorder", type, type === "NONE" ? "0.1 mm" : bw)}${side("rightBorder", type, type === "NONE" ? "0.1 mm" : bw)}${side("topBorder", type, type === "NONE" ? "0.1 mm" : bw)}${side("bottomBorder", type, type === "NONE" ? "0.1 mm" : bw)}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill ? `<hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>` : ""}</hh:borderFill>`;
  // 1: 쪽 테두리 없음, 2: 글자 테두리 없음, 3: 표 칸, 4: 표 머리 칸(음영)
  const borderFills = [borderFill(1, "NONE"), borderFill(2, "NONE"), borderFill(3, "SOLID"), borderFill(4, "SOLID", m.preset.table.head_fill)].join("");
  const charPrs = [...sh.charKeys.entries()].sort((a, b) => a[1] - b[1]).map(([k, id]) => {
    const [fontIdx, pt, bold] = JSON.parse(k);
    return `<hh:charPr id="${id}" height="${pt2hu(pt)}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef ${ALL(fontIdx)}/><hh:ratio ${ALL(100)}/><hh:spacing ${ALL(0)}/><hh:relSz ${ALL(100)}/><hh:offset ${ALL(0)}/>${bold ? "<hh:bold/>" : ""}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`;
  }).join("");
  const paraPrs = [...sh.paraKeys.entries()].sort((a, b) => a[1] - b[1]).map(([k, id]) => {
    const [align, left, hang, before, after, line, keepNext, pbb] = JSON.parse(k);
    // 한컴의 내어쓰기: 첫 줄은 left에서 시작하고, 둘째 줄부터 left + |intent|에서 시작한다
    const margin = `<hh:margin><hc:intent value="${-mm2hu(hang)}" unit="HWPUNIT"/><hc:left value="${mm2hu(left)}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${pt2hu(before)}" unit="HWPUNIT"/><hc:next value="${pt2hu(after)}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${line}" unit="HWPUNIT"/>`;
    return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${ALIGN[align] ?? "JUSTIFY"}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="${keepNext ? 1 : 0}" keepLines="0" pageBreakBefore="${pbb ? 1 : 0}" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
  }).join("");
  return `${XML}<hh:head ${NS} version="1.5" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="${LANGS.length}">${fontfaces}</hh:fontfaces><hh:borderFills itemCnt="4">${borderFills}</hh:borderFills><hh:charProperties itemCnt="${sh.charKeys.size}">${charPrs}</hh:charProperties><hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties><hh:numberings itemCnt="0"/><hh:paraProperties itemCnt="${sh.paraKeys.size}">${paraPrs}</hh:paraProperties><hh:styles itemCnt="${sh.pageNumChar == null ? 1 : 2}"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>${sh.pageNumChar == null ? "" : `<hh:style id="1" type="CHAR" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="${sh.pageNumChar}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`}</hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`;
}

function secPr(m) {
  const g = m.page, mg = g.margin_mm;
  const pbf = (type) => `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${mm2hu(g.width_mm)}" height="${mm2hu(g.height_mm)}" gutterType="LEFT_ONLY"><hp:margin header="${mm2hu(mg.header)}" footer="${mm2hu(mg.footer)}" gutter="0" left="${mm2hu(mg.left)}" right="${mm2hu(mg.right)}" top="${mm2hu(mg.top)}" bottom="${mm2hu(mg.bottom)}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>${pbf("BOTH")}${pbf("EVEN")}${pbf("ODD")}</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>${m.number ? `<hp:ctrl><hp:pageNum pos="${m.number.pos.toUpperCase().replace("-", "_")}" formatType="DIGIT" sideChar="${esc(m.number.side ?? "")}"/></hp:ctrl>` : ""}`;
}

const runsXml = (runs, sh, style) => runs.map((r) => `<hp:run charPrIDRef="${sh.charOf(style, r.b || undefined)}"><hp:t>${esc(r.t)}</hp:t></hp:run>`).join("");

function para(sh, style, runs, { over, pageBreak, lead } = {}) {
  const body = runsXml(runs, sh, style);
  return `<hp:p id="0" paraPrIDRef="${sh.paraOf(style, over)}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${lead ?? ""}${body || `<hp:run charPrIDRef="${sh.charOf(style)}"/>`}</hp:p>`;
}

let tableId = 1000;
function tableXml(m, sh, t) {
  const widths = t.widths_mm.map(mm2hu);
  const pad = m.preset.table.cell_pad_mm;
  const inM = `left="${mm2hu(pad.left)}" right="${mm2hu(pad.right)}" top="${mm2hu(pad.top)}" bottom="${mm2hu(pad.bottom)}"`;
  const minH = mm2hu(1);
  const totalW = widths.reduce((a, b) => a + b, 0);
  const trs = [];
  for (let r = 0; r < t.rows; r++) {
    const tcs = t.cells.filter((c) => c.row === r).map((c) => {
      const head = r < t.header_rows;
      const style = head ? "cellHead" : "cell";
      const w = widths.slice(c.col, c.col + c.colspan).reduce((a, b) => a + b, 0);
      const over = c.align ? { align: c.align } : undefined;
      return `<hp:tc name="" header="${head ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${head ? 4 : 3}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${para(sh, style, c.runs, { over })}</hp:subList><hp:cellAddr colAddr="${c.col}" rowAddr="${c.row}"/><hp:cellSpan colSpan="${c.colspan}" rowSpan="${c.rowspan}"/><hp:cellSz width="${w}" height="${minH * c.rowspan}"/><hp:cellMargin ${inM}/></hp:tc>`;
    });
    trs.push(`<hp:tr>${tcs.join("")}</hp:tr>`);
  }
  const tbl = `<hp:tbl id="${tableId++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${t.rows}" colCnt="${t.cols}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${minH * t.rows}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin ${inM}/>${trs.join("")}</hp:tbl>`;
  // 표 위아래 간격은 표 앞뒤의 빈 간격 문단(글자 크기 = 간격, 줄 간격 100%)으로 준다. 브라우저와 쪽 나눔을 맞추기 위해서다(한컴 2022로 확인):
  //  - 문단 간격으로 주면 쪽을 넘긴 표에는 한컴이 간격을 넣지 않는다
  //  - 바깥 여백(outMargin)으로 주면 한컴은 표가 쪽을 넘을 때 쪽마다 위 여백을 다시 넣고, 행 아래에도 아래 여백만큼 자리를 남기고 행을 넘긴다
  // 표 바로 다음 문단은 표 아래로 밀려나면서 자기 위 간격(prev)을 잃는다(간격 문단이 없을 때). HTML도 같게 그린다.
  // 표는 문단에 붙은 개체로 넣는다. 글자처럼 취급(treatAsChar=1)하면 한컴이 표를 쪽 사이에서 나누지 않고 통째로 넘긴다(한컴 2022로 확인)
  const flat = sh.paraOf("cell", { align: "left", before_pt: 0, after_pt: 0, line: 100 });
  const spacer = (pt) => (pt > 0 ? `<hp:p id="0" paraPrIDRef="${flat}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${sh.charOf({ font: "body", pt, bold: false })}"/></hp:p>` : "");
  const { space_before_pt: before, space_after_pt: after } = m.preset.table;
  return `${spacer(before)}<hp:p id="0" paraPrIDRef="${flat}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${sh.charOf("cell")}">${tbl}<hp:t/></hp:run></hp:p>${spacer(after)}`;
}

export function sectionXml(m, sh) {
  const out = [];
  let pendingBreak = false;
  m.blocks.forEach((b, i) => {
    if (b.type === "pagebreak") { pendingBreak = true; return; }
    let x;
    if (b.type === "table") x = tableXml(m, sh, b);
    else if (b.type === "list") x = para(sh, b.style, [{ t: `${b.marker} `, b: false }, ...b.runs]);
    else x = para(sh, b.style, b.runs, { over: b.align ? { align: b.align } : undefined });
    if (pendingBreak) { x = x.replace('pageBreak="0"', 'pageBreak="1"'); pendingBreak = false; }
    if (i === 0 || out.length === 0) {
      // 첫 문단의 첫 run 앞에 구역 설정(secPr)을 넣는다
      x = x.replace(/(<hp:p [^>]*>)/, `$1<hp:run charPrIDRef="0">${secPr(m)}</hp:run>`);
    }
    out.push(x);
  });
  if (!out.length) out.push(`<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${secPr(m)}</hp:run><hp:run charPrIDRef="0"/></hp:p>`);
  return `${XML}<hs:sec ${NS}>${out.join("")}</hs:sec>`;
}

export function buildHwpx(m) {
  tableId = 1000;
  const sh = collectShapes(m);
  const section = sectionXml(m, sh); // 먼저 만들어야 쓰인 모양이 모두 모인다
  const header = headerXml(m, sh);
  const title = esc(m.meta.title ?? "");
  const content = `${XML}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${title}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text"/><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text"/><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
  const version = `${XML}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="hwpx-deliver" appVersion="1"/>`;
  const container = `${XML}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`;
  const settings = `${XML}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`;
  const manifest = `${XML}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;
  return writeZip([
    { name: "mimetype", data: "application/hwp+zip", store: true },
    { name: "version.xml", data: version, store: true },
    { name: "Contents/header.xml", data: header },
    { name: "Contents/section0.xml", data: section },
    { name: "settings.xml", data: settings },
    { name: "META-INF/container.xml", data: container },
    { name: "META-INF/manifest.xml", data: manifest },
    { name: "Contents/content.hpf", data: content },
  ]);
}
