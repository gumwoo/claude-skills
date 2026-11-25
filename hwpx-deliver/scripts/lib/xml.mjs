// 작은 XML 파서(외부 패키지 없음). HWPX처럼 잘 짜인 XML만 다룬다(DTD·엔티티 선언 없음).
// 노드: { name, attrs, children: [노드 | 글자 문자열] }
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) { top.children.push(m[1]); continue; }
    if (m[6] != null) { if (stack.length > 1) top.children.push(unesc(m[6])); continue; }
    if (!m[3]) continue; // 주석, 처리 지시
    if (m[2]) {
      if (top.name !== m[3]) throw new Error(`XML 짝이 맞지 않습니다: </${m[3]}> (열린 것: <${top.name}>)`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unesc(a[2] ?? a[3]);
    const node = { name: m[3], attrs, children: [] };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`XML이 닫히지 않았습니다: <${stack[stack.length - 1].name}>`);
  return root;
}

// 도움 함수
export const kids = (n, name) => (n?.children ?? []).filter((c) => typeof c !== "string" && (!name || c.name === name));
export const kid = (n, name) => kids(n, name)[0];
export function find(n, name) {
  // 깊이 우선으로 첫 번째
  for (const c of kids(n)) { if (c.name === name) return c; const r = find(c, name); if (r) return r; }
  return null;
}
export function findAll(n, name, out = []) {
  for (const c of kids(n)) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}
// hp:switch가 있으면 hp:case 쪽을 쓴다. 한컴 2022가 저장한 문단 여백은 case(HwpUnitChar)에 실제 값(12pt = 1200),
// default에 그 두 배(2400)를 적었다 — 옛 판용 값으로 보인다(추정). case가 없을 때만 default
export function unswitch(n) {
  return (n?.children ?? []).flatMap((c) => {
    if (typeof c === "string") return [c];
    if (c.name === "hp:switch") return unswitch(kid(c, "hp:case") ?? kid(c, "hp:default"));
    return [c];
  });
}
