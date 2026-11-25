// OLE 복합 문서(Compound File Binary) 읽기. 바이너리 HWP(5.0)가 이 형식이다. 외부 패키지 없이 Node 내장 기능만 쓴다.
// 반환: Map<"경로/이름", Buffer>  예: "FileHeader", "DocInfo", "BodyText/Section0"
const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff;
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isCfb(buf) {
  return buf.length >= 512 && SIG.every((b, i) => buf[i] === b);
}

export function readCfb(buf) {
  if (!isCfb(buf)) throw new Error("OLE 복합 문서가 아닙니다(바이너리 HWP가 아님)");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const firstDir = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c), numMiniFat = buf.readUInt32LE(0x40);
  let difatSect = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  const sector = (id) => {
    const off = (id + 1) * sectorSize;
    if (off + sectorSize > buf.length + sectorSize) throw new Error(`OLE 섹터 번호가 파일 밖입니다: ${id}`);
    return buf.subarray(off, Math.min(off + sectorSize, buf.length));
  };
  // FAT 섹터 목록(DIFAT): 헤더의 109개 + 이어지는 DIFAT 섹터
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = buf.readUInt32LE(0x4c + i * 4); if (s !== FREESECT) fatSectors.push(s); }
  for (let n = 0; n < numDifat && difatSect !== ENDOFCHAIN && difatSect !== FREESECT; n++) {
    const d = sector(difatSect);
    for (let i = 0; i < sectorSize / 4 - 1; i++) { const s = d.readUInt32LE(i * 4); if (s !== FREESECT) fatSectors.push(s); }
    difatSect = d.readUInt32LE(sectorSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) { const d = sector(s); for (let i = 0; i + 4 <= d.length; i += 4) fat.push(d.readUInt32LE(i)); }
  const chain = (start, table) => {
    const out = [], seen = new Set();
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT; s = table[s]) {
      if (s >= table.length || seen.has(s)) throw new Error("OLE 섹터 사슬이 깨졌습니다");
      seen.add(s); out.push(s);
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));
  // 디렉터리
  const dir = readChain(firstDir);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    entries.push({
      name: dir.toString("utf16le", off, off + Math.max(0, nameLen - 2)),
      type: dir[off + 66],
      left: dir.readUInt32LE(off + 68), right: dir.readUInt32LE(off + 72), child: dir.readUInt32LE(off + 76),
      start: dir.readUInt32LE(off + 116), size: dir.readUInt32LE(off + 120),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error("OLE 루트 항목이 없습니다");
  // 작은 스트림(cutoff 미만)은 미니 스트림 안에 64바이트 단위로 들어 있다
  const miniStream = root.start === ENDOFCHAIN ? Buffer.alloc(0) : readChain(root.start);
  const miniFat = [];
  if (numMiniFat && firstMiniFat !== ENDOFCHAIN) { const d = readChain(firstMiniFat); for (let i = 0; i + 4 <= d.length; i += 4) miniFat.push(d.readUInt32LE(i)); }
  const readStream = (e) => {
    if (e.size === 0) return Buffer.alloc(0);
    if (e.size < cutoff) return Buffer.concat(chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, e.size);
    return readChain(e.start).subarray(0, e.size);
  };
  // 저장소 트리: 자식은 child에서 시작하는 형제 트리(left/right)
  const out = new Map();
  const walk = (id, prefix, seen = new Set()) => {
    if (id === FREESECT || id >= entries.length || seen.has(id)) return;
    seen.add(id);
    const e = entries[id];
    walk(e.left, prefix, seen);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) out.set(path, readStream(e));
    else if (e.type === 1) walk(e.child, path, new Set());
    walk(e.right, prefix, seen);
  };
  walk(root.child, "");
  return out;
}
