// 문서 모델 → 인쇄용 HTML. HWPX와 같은 서식 값(mm·pt·%)을 그대로 CSS로 옮기고,
// 한컴 2022가 그린 PDF와 대조해서 찾은 차이를 맞춘다(tests/oracle 참고):
//  1) 줄 상자: 한컴은 줄 높이 = 글자 크기 × 줄 간격%이고 기준선을 줄 위에서 글자 크기의 0.85에 둔다.
//     CSS는 남는 높이를 위아래로 나누므로, 문단을 그만큼 위로 올려(position:relative) 기준선을 맞춘다
//  2) 공백 폭: 한컴은 한글 글꼴의 공백을 글자 크기의 1/2로 그린다. 글꼴의 실제 공백 폭과의 차이를 word-spacing으로 채운다
//  3) 표 칸: 한컴은 칸 안 마지막 줄의 줄 간격도, 테두리 두께도 칸 높이에 넣지 않는다
//  4) 문단 간격은 margin이 아니라 padding으로(CSS는 위아래 margin을 겹치는데 한컴은 더한다)
//  5) 줄 나눔은 어절 단위(word-break: keep-all) — HWPX에는 BREAK_WORD로 적는다(한컴 2022에서 어절 단위)
//  6) 표 바로 다음 문단은 위 간격이 없다 — 한컴에서 표(쪽을 넘길 수 있는 개체) 아래로 밀린 문단은 prev 간격을 잃는다
// 1)·2)는 글꼴마다 값이 달라 페이지 안의 스크립트가 브라우저의 실제 글꼴 값을 재서 넣는다
import { esc } from "./hwpx-write.mjs";

// pagenum_desc_em: 쪽 번호 기준선은 아래 여백 경계에서 글자 크기 × 0.31 위(한컴 2022, 10pt에서 1.1mm로 측정)
export const HANCOM = { baseline: 0.85, space_em: 0.5, pagenum_desc_em: 0.31 };
const PX_MM = 25.4 / 96; // 브라우저의 1픽셀

function runsHtml(runs) {
  return runs.map((r) => (r.b ? `<b>${esc(r.t)}</b>` : esc(r.t))).join("");
}

function styleCss(m, key, st) {
  const font = m.preset.fonts[st.font];
  const left = st.left_mm ?? 0, hang = st.hang_mm ?? 0;
  return `.s-${key}{font-family:"${font}";font-size:${st.pt}pt;font-weight:${st.bold ? 700 : 400};text-align:${st.align};line-height:${st.line / 100};padding:${st.before_pt ?? 0}pt 0 ${st.after_pt ?? 0}pt ${left + hang}mm;text-indent:${-hang}mm;min-height:${st.line / 100}em;${st.keepNext ? "break-after:avoid;" : ""}}`;
}

// 글꼴 값을 재서 문단별 보정 규칙을 만든다. data-l(줄 간격 배수)을 가진 문단마다 적용
export const FIXUP = `(function(){
var c=document.createElement('canvas').getContext('2d'),cache={},rules=[];
function metrics(font,bold){var k=font+bold;if(cache[k])return cache[k];c.font=(bold?'700 ':'400 ')+'100px "'+font+'"';var sp=c.measureText(' ').width/100,g=c.measureText('\\uAC00');return cache[k]={sp:sp,asc:g.fontBoundingBoxAscent/100,desc:g.fontBoundingBoxDescent/100};}
var seen={};document.querySelectorAll('[data-k]').forEach(function(p){var k=p.getAttribute('data-k');if(seen[k])return;seen[k]=1;var cs=getComputedStyle(p),f=cs.fontFamily.split(',')[0].replace(/"/g,'').trim(),b=parseInt(cs.fontWeight)>=600,L=parseFloat(p.getAttribute('data-l')),m=metrics(f,b);
var shift=((L+m.asc-m.desc)/2-${HANCOM.baseline});rules.push('[data-k="'+k+'"]{position:relative;top:'+(-shift).toFixed(4)+'em;word-spacing:'+(${HANCOM.space_em}-m.sp).toFixed(4)+'em}');
rules.push('td [data-k="'+k+'"]:last-child{margin-top:'+(-(L-1)).toFixed(4)+'em;top:'+(L-1-shift).toFixed(4)+'em}');});
var pn=document.body.getAttribute('data-pn');if(pn){pn=JSON.parse(pn);var pm=metrics(pn.font,false),em=pn.pt*25.4/72;
var y=pn.footer-${HANCOM.pagenum_desc_em}*em-(1+pm.asc-pm.desc)/2*em;rules.push('@page{@'+pn.box+'{padding-top:'+Math.max(0,y).toFixed(3)+'mm;word-spacing:'+(${HANCOM.space_em}-pm.sp).toFixed(4)+'em}}');}
var s=document.createElement('style');s.textContent=rules.join('\\n');document.head.appendChild(s);})();`;

export function buildHtml(m) {
  const g = m.page, mg = g.margin_mm, t = m.preset.table;
  const css = [
    `@page{size:${g.width_mm}mm ${g.height_mm}mm;margin:${mg.top + mg.header}mm ${mg.right}mm ${mg.bottom + mg.footer}mm ${mg.left}mm}`,
    `html,body{margin:0;padding:0;background:#fff;color:#000}`,
    `p{margin:0;word-break:keep-all;overflow-wrap:break-word;orphans:1;widows:1;font-kerning:none}`,
    `b{font-weight:700}`,
    ...Object.entries(m.preset.styles).map(([k, st]) => styleCss(m, k, st)),
    // 표 위아래 간격은 HWPX와 같게 표 앞뒤의 빈 간격 문단(.tsb, .tsa)으로 그린다
    `table{border-collapse:collapse;table-layout:fixed;margin:0}`,
    `.tsb{height:${t.space_before_pt}pt;break-inside:avoid}`,
    `.tsa{height:${t.space_after_pt}pt;break-inside:avoid}`,
    `table+p{padding-top:0!important}`,
    // 브라우저는 1픽셀(1/96인치)보다 가는 테두리를 1픽셀로 그리고 행 높이에도 그 두께를 넣는다. 그만큼 칸 여백에서 뺀다
    `td{border:${t.border_mm}mm solid #000;vertical-align:middle;padding:${Math.max(0, t.cell_pad_mm.top - Math.max(t.border_mm, PX_MM) / 2).toFixed(3)}mm ${t.cell_pad_mm.right}mm ${Math.max(0, t.cell_pad_mm.bottom - Math.max(t.border_mm, PX_MM) / 2).toFixed(3)}mm ${t.cell_pad_mm.left}mm}`,
    `td.h{background:${t.head_fill}}`,
    `tr{break-inside:avoid}`,
    `td p{padding:0;text-indent:0}`,
    `.pb{break-before:page}`,
    // 쪽 번호는 @page 여백 상자에 그린다. 세로 위치는 스크립트가 글꼴 값을 재서 padding-top으로 맞춘다
    ...(m.number ? [`@page{@${m.number.pos}{content:"${m.number.side ? m.number.side + " " : ""}" counter(page) "${m.number.side ? " " + m.number.side : ""}";font-family:"${m.preset.fonts[m.number.font]}";font-size:${m.number.pt}pt;line-height:1;vertical-align:top;text-align:center}}`] : []),
  ].join("\n");
  const pAttrs = (style, extra = "") => {
    const st = m.preset.styles[style];
    return `class="s-${style}${extra}" data-k="${style}" data-l="${st.line / 100}"`;
  };
  const body = [];
  let pendingBreak = false;
  for (const b of m.blocks) {
    if (b.type === "pagebreak") { pendingBreak = true; continue; }
    const pb = pendingBreak ? " pb" : "";
    pendingBreak = false;
    if (b.type === "table") {
      const cols = b.widths_mm.map((w) => `<col style="width:${w}mm">`).join("");
      const rows = [];
      for (let r = 0; r < b.rows; r++) {
        const tds = b.cells.filter((c) => c.row === r).map((c) => {
          const head = r < b.header_rows;
          const st = head ? "cellHead" : "cell";
          const al = c.align ? ` style="text-align:${c.align}"` : "";
          return `<td${head ? ' class="h"' : ""}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""}><p ${pAttrs(st)}${al}>${runsHtml(c.runs)}</p></td>`;
        });
        rows.push(`<tr>${tds.join("")}</tr>`);
      }
      // 머리 행은 thead로: 표가 쪽을 넘으면 브라우저도 한컴(repeatHeader)처럼 쪽마다 반복한다
      const head = rows.slice(0, b.header_rows).join(""), rest = rows.slice(b.header_rows).join("");
      const before = t.space_before_pt > 0;
      body.push(`${before ? `<p class="tsb${pb}"></p>` : ""}<table class="${before ? "" : pb.trim()}" style="width:${b.widths_mm.reduce((a, x) => a + x, 0)}mm"><colgroup>${cols}</colgroup>${head ? `<thead>${head}</thead>` : ""}<tbody>${rest}</tbody></table>${t.space_after_pt > 0 ? `<p class="tsa"></p>` : ""}`);
      continue;
    }
    const runs = b.type === "list" ? [{ t: `${b.marker} `, b: false }, ...b.runs] : b.runs;
    const al = b.align ? ` style="text-align:${b.align}"` : "";
    body.push(`<p ${pAttrs(b.style, pb)}${al}>${runsHtml(runs)}</p>`);
  }
  const title = esc(m.meta.title ?? "");
  const pn = m.number ? ` data-pn='${JSON.stringify({ font: m.preset.fonts[m.number.font], pt: m.number.pt, footer: mg.footer, box: m.number.pos }).replace(/'/g, "&#39;")}'` : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body${pn}>${body.join("\n")}<script>${FIXUP}</script></body></html>`;
}
