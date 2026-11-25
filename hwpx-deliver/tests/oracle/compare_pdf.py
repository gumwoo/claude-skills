"""개발 검증용: 한컴이 만든 PDF와 hwpx-deliver가 만든 PDF를 비교한다(PyMuPDF 필요, skill 실행에는 쓰지 않음).

출력(JSON):
  pages: 양쪽 쪽수
  lines: 쪽마다 줄 수, 줄별 첫 글자 위치(y, mm)와 텍스트
  y_diff_mm: 같은 텍스트로 시작하는 줄끼리 세로 위치 차이(최대·평균)
  breaks: 같은 문단이 몇 번째 줄에서 끊기는지 다른 곳(줄 끝 단어 비교)
--png 를 주면 두 PDF의 쪽을 나란히 붙인 이미지를 남긴다.
"""
import json
import sys

import pymupdf

MM = 72 / 25.4


def lines_of(path):
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        rows = []
        for b in page.get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                text = "".join(s["text"] for s in ln["spans"]).strip()
                if not text:
                    continue
                x0, y0, x1, y1 = ln["bbox"]
                # 글꼴 상자 위쪽은 PDF를 만든 프로그램마다 다르게 적으므로 기준선(origin)으로 비교한다
                base = ln["spans"][0]["origin"][1]
                rows.append({"y": round(base / MM, 2), "x": round(x0 / MM, 2), "x1": x1 / MM, "text": text})
        rows.sort(key=lambda r: (r["y"], r["x"]))
        # 같은 높이(0.8mm 이내)의 조각은 한 줄로 합친다(표 칸은 따로 남는다)
        merged = []
        for r in rows:
            # 끝 위치는 실제 글자 상자로 잰다(글자 수로 어림하면 옆 표 칸까지 한 줄로 붙는다)
            if merged and abs(merged[-1]["y"] - r["y"]) < 0.8 and r["x"] - merged[-1]["x1"] < 3:
                merged[-1]["text"] += r["text"]
                merged[-1]["x1"] = max(merged[-1]["x1"], r["x1"])
            else:
                merged.append(dict(r))
        pages.append([{k: v for k, v in m.items() if k != "x1"} for m in merged])
    return doc, pages


def main():
    a_path, b_path = sys.argv[1], sys.argv[2]
    png = sys.argv[sys.argv.index("--png") + 1] if "--png" in sys.argv else None
    da, a = lines_of(a_path)
    db, b = lines_of(b_path)
    pairs = []
    for pa, pb in zip(a, b):
        used = set()
        for la in pa:
            key = la["text"][:6]
            for j, lb in enumerate(pb):
                if j in used:
                    continue
                if lb["text"][:6] == key and abs(lb["x"] - la["x"]) < 15:
                    used.add(j)
                    pairs.append({"text": la["text"][:20], "ya": la["y"], "yb": lb["y"], "dy": round(lb["y"] - la["y"], 2), "end_a": la["text"][-4:], "end_b": lb["text"][-4:]})
                    break
    dys = [abs(p["dy"]) for p in pairs]
    out = {
        "pages": [len(a), len(b)],
        "lines": [[len(p) for p in a], [len(p) for p in b]],
        "matched_lines": len(pairs),
        "y_diff_mm": {"max": max(dys) if dys else None, "mean": round(sum(dys) / len(dys), 2) if dys else None},
        "line_end_differs": [p for p in pairs if p["end_a"] != p["end_b"]],
        "worst": sorted(pairs, key=lambda p: -abs(p["dy"]))[:8],
        # 쪽마다 첫 줄·마지막 줄(앞 12자). 같은 줄이 같은 쪽에 오는지 보는 기준
        "page_edges": [[[p[0]["text"][:12], p[-1]["text"][:12]] if p else None for p in side] for side in (a, b)],
    }
    out["same_page_breaks"] = out["page_edges"][0] == out["page_edges"][1]
    if "--table" in sys.argv:
        for p in sorted(pairs, key=lambda p: p["ya"]):
            print(f'{p["ya"]:8.2f} {p["yb"]:8.2f} {p["dy"]:6.2f}  {p["text"]}')
        return
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if png:
        n = max(len(da), len(db))
        for i in range(n):
            imgs = []
            for d in (da, db):
                if i < len(d):
                    imgs.append(d[i].get_pixmap(dpi=70))
            w = sum(p.width for p in imgs) + 10
            h = max(p.height for p in imgs)
            canvas = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), 0)
            canvas.clear_with(255)
            x = 0
            for p in imgs:
                p2 = pymupdf.Pixmap(pymupdf.csRGB, p) if p.n != 3 else p
                p2.set_origin(x, 0)
                canvas.copy(p2, p2.irect)
                x += p.width + 10
            canvas.save(png.replace(".png", f"-p{i + 1}.png"))


if __name__ == "__main__":
    main()
