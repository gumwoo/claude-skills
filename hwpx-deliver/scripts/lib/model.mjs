// 문서 모델(doc.json)과 서식(preset). HWPX와 HTML(PDF)이 같은 모델·같은 서식에서 나오게 하는 중심이다.
//
// doc.json
// {
//   "preset": "report",
//   "page": { "margin_mm": { "top": 20, "bottom": 8, "left": 20, "right": 20, "header": 0, "footer": 7 },      (선택, 서식 기본값을 덮음)
//             "number": false | { "side": "-" } },          쪽 번호(기본: 아래 가운데 "- 1 -". 위치는 bottom-center만)
//   "meta": { "title": "..." },
//   "fonts": { "body": "함초롬바탕", "head": "함초롬돋움" },                              (선택)
//   "blocks": [
//     { "type": "title", "text": "..." },
//     { "type": "heading", "level": 1, "text": "1. 사업 개요" },
//     { "type": "para", "text": "..." }                         text는 문자열 또는 [{ "t": "...", "b": true }]
//     { "type": "list", "level": 1, "marker": "□", "text": "..." }  marker를 빼면 서식의 기호
//     { "type": "table", "widths_mm": [30, 70], "header_rows": 1, "rows": [["구분", "내용"], ["기간", { "text": "...", "colspan": 1, "rowspan": 1 }]] },
//     { "type": "pagebreak" }
//   ]
// }

export const MM = 7200 / 25.4; // HWPUNIT per mm (1 HWPUNIT = 1/7200 inch)
export const mm2hu = (mm) => Math.round(mm * MM);
export const pt2hu = (pt) => Math.round(pt * 100); // 1pt = 100 HWPUNIT

// 서식. 글꼴 이름은 HWPX에 그대로 들어가고, HTML에서도 같은 이름으로 찾는다
export const PRESETS = {
  report: {
    fonts: { body: "함초롬바탕", head: "함초롬돋움" },
    page: { width_mm: 210, height_mm: 297, margin_mm: { top: 20, bottom: 8, left: 20, right: 20, header: 0, footer: 7 } },
    // 쪽 번호는 꼬리말 영역에 그려진다. 꼬리말이 0이면 한컴이 다른 자리에 그리므로 6mm 이상 둔다
    page_number: { pos: "bottom-center", side: "-", font: "head", pt: 10 },
    styles: {
      title: { font: "head", pt: 20, bold: true, align: "center", before_pt: 0, after_pt: 12, line: 140 },
      h1: { font: "head", pt: 15, bold: true, align: "left", before_pt: 12, after_pt: 6, line: 140, keepNext: true },
      h2: { font: "head", pt: 13, bold: true, align: "left", before_pt: 8, after_pt: 4, line: 140, keepNext: true },
      h3: { font: "head", pt: 12, bold: true, align: "left", before_pt: 6, after_pt: 3, line: 140, keepNext: true },
      body: { font: "body", pt: 11, bold: false, align: "justify", before_pt: 0, after_pt: 4, line: 160 },
      list1: { font: "body", pt: 11, bold: false, align: "justify", before_pt: 2, after_pt: 2, line: 160, left_mm: 0, hang_mm: 5 },
      list2: { font: "body", pt: 11, bold: false, align: "justify", before_pt: 0, after_pt: 2, line: 160, left_mm: 5, hang_mm: 5 },
      list3: { font: "body", pt: 11, bold: false, align: "justify", before_pt: 0, after_pt: 2, line: 160, left_mm: 10, hang_mm: 4 },
      cell: { font: "body", pt: 10, bold: false, align: "left", before_pt: 0, after_pt: 0, line: 130 },
      cellHead: { font: "head", pt: 10, bold: true, align: "center", before_pt: 0, after_pt: 0, line: 130 },
    },
    markers: { 1: "□", 2: "○", 3: "-" },
    table: { border_mm: 0.12, space_before_pt: 4, space_after_pt: 8, head_fill: "#E5E5E5", cell_pad_mm: { left: 1.8, right: 1.8, top: 0.5, bottom: 0.5 } },
  },
};

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// 문자열 또는 run 배열을 [{t, b}]로
export function runsOf(text) {
  if (text == null) return [];
  if (typeof text === "string") return [{ t: text, b: false }];
  if (Array.isArray(text)) return text.map((r) => (typeof r === "string" ? { t: r, b: false } : { t: String(r.t ?? ""), b: Boolean(r.b) }));
  throw new Error(`text 형식이 잘못됐습니다: ${JSON.stringify(text).slice(0, 80)}`);
}

export const plainText = (text) => runsOf(text).map((r) => r.t).join("");

// 모델을 검사하고 서식을 합쳐 돌려준다. 잘못된 모델은 어디가 잘못됐는지 말하고 멈춘다
export function normalize(doc) {
  if (!isObj(doc) || !Array.isArray(doc.blocks)) throw new Error("doc.blocks 배열이 필요합니다");
  const base = PRESETS[doc.preset ?? "report"];
  if (!base) throw new Error(`알 수 없는 preset: ${doc.preset}`);
  // 글꼴만 바꿔 쓸 수 있다: { "fonts": { "body": "...", "head": "..." } }
  const preset = doc.fonts ? { ...base, fonts: { ...base.fonts, ...doc.fonts } } : base;
  const page = { ...preset.page, margin_mm: { ...preset.page.margin_mm, ...(doc.page?.margin_mm ?? {}) } };
  // 쪽 번호: 서식 기본값을 쓰고, doc.page.number가 false면 넣지 않는다
  const number = doc.page?.number === false ? null : { ...preset.page_number, ...(typeof doc.page?.number === "object" ? doc.page.number : {}) };
  // 한컴과 위치를 대조한 것은 아래 가운데뿐이다. 다른 위치는 PDF가 한컴과 다르게 나올 수 있어 받지 않는다
  if (number && number.pos !== "bottom-center") throw new Error(`page.number.pos는 지금 "bottom-center"만 됩니다: ${number.pos}`);
  const blocks = doc.blocks.map((b, i) => {
    const where = `blocks[${i}]`;
    if (!isObj(b) || !b.type) throw new Error(`${where}: type이 없습니다`);
    switch (b.type) {
      case "title":
        return { type: "title", style: "title", runs: runsOf(b.text) };
      case "heading": {
        const lv = b.level ?? 1;
        if (![1, 2, 3].includes(lv)) throw new Error(`${where}: heading level은 1~3`);
        return { type: "heading", style: `h${lv}`, runs: runsOf(b.text) };
      }
      case "para":
        return { type: "para", style: "body", runs: runsOf(b.text), align: b.align };
      case "list": {
        const lv = b.level ?? 1;
        if (![1, 2, 3].includes(lv)) throw new Error(`${where}: list level은 1~3`);
        return { type: "list", style: `list${lv}`, marker: b.marker ?? preset.markers[lv], runs: runsOf(b.text) };
      }
      case "table": {
        if (!Array.isArray(b.rows) || !b.rows.length) throw new Error(`${where}: rows가 비었습니다`);
        const grid = layoutTable(b, where);
        const widths = b.widths_mm ?? Array(grid.cols).fill((page.width_mm - page.margin_mm.left - page.margin_mm.right) / grid.cols);
        if (widths.length !== grid.cols) throw new Error(`${where}: widths_mm는 ${grid.cols}개여야 합니다(지금 ${widths.length}개)`);
        return { type: "table", widths_mm: widths, header_rows: b.header_rows ?? 1, ...grid };
      }
      case "pagebreak":
        return { type: "pagebreak" };
      default:
        throw new Error(`${where}: 알 수 없는 type ${b.type}`);
    }
  });
  return { preset, page, number, blocks, meta: doc.meta ?? {} };
}

// 병합을 풀어 격자 위치를 정한다. 가려지는 칸은 cells에 넣지 않는다(OWPML도 왼쪽 위 칸만 둔다)
function layoutTable(b, where) {
  const occupied = [];
  const cells = [];
  let cols = 0;
  b.rows.forEach((row, r) => {
    if (!Array.isArray(row)) throw new Error(`${where}.rows[${r}]: 배열이어야 합니다`);
    let c = 0;
    for (const raw of row) {
      while (occupied[r]?.[c]) c++;
      const cell = isObj(raw) ? raw : { text: raw };
      const colspan = cell.colspan ?? 1, rowspan = cell.rowspan ?? 1;
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) {
        (occupied[r + dr] ??= [])[c + dc] = true;
      }
      cells.push({ row: r, col: c, colspan, rowspan, runs: runsOf(cell.text ?? ""), align: cell.align });
      c += colspan;
      cols = Math.max(cols, c);
    }
  });
  const rows = occupied.length;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!occupied[r]?.[c]) throw new Error(`${where}: ${r + 1}행 ${c + 1}열이 비었습니다(병합 범위나 칸 수를 확인)`);
  return { rows, cols, cells };
}
