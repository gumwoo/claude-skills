#!/usr/bin/env node
// 예시용 선착순 구매 서버. 프로세스 여러 개가 SQLite 파일 하나를 같이 쓴다.
//   --mode naive : 남은 수량을 읽고 → 앱에서 1을 빼서 → 다시 쓴다 (흔히 AI가 처음 짜는 모양)
//   --mode fixed : 조건부 UPDATE 한 문장으로 차감하고, (이벤트, 사용자) 유니크 제약으로 중복을 막는다
// 사용법: node ticket-server.mjs --mode naive|fixed [--port 4100] [--workers 4] [--gap 5]
// --gap은 앱과 DB 사이 왕복 지연을 흉내 낸 대기(ms)다. 실제 서비스의 DB는 다른 서버에 있어서 읽기와 쓰기 사이에 이만한 틈이 생긴다.
import cluster from "node:cluster";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODE = arg("mode", "naive");
const PORT = Number(arg("port", 4100));
const WORKERS = Number(arg("workers", 4));
const GAP = Number(arg("gap", 5));
const DB = arg("db", path.join(os.tmpdir(), `race-check-demo-${PORT}.sqlite`));
if (!["naive", "fixed"].includes(MODE)) { console.error("--mode는 naive 또는 fixed"); process.exit(1); }

function open() {
  const db = new DatabaseSync(DB);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");
  return db;
}

function setup(stock) {
  const db = open();
  db.exec(`
    DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS events;
    CREATE TABLE events (id INTEGER PRIMARY KEY, stock INTEGER NOT NULL, remaining INTEGER NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id TEXT NOT NULL);
  `);
  if (MODE === "fixed") db.exec("CREATE UNIQUE INDEX orders_event_user ON orders(event_id, user_id);");
  db.prepare("INSERT INTO events (id, stock, remaining) VALUES (1, ?, ?)").run(stock, stock);
  db.close();
}

if (cluster.isPrimary) {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) fs.rmSync(f, { force: true });
  setup(100);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  let up = 0;
  cluster.on("listening", () => { if (++up === WORKERS) console.log(`ticket-server ${MODE} · http://localhost:${PORT} · 프로세스 ${WORKERS}개 · DB 왕복 지연 ${GAP}ms`); });
  const stop = () => { for (const w of Object.values(cluster.workers)) w.kill(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
} else {
  const db = open();
  // --gap 0이면 기다리지 않는다. 그래도 프로세스가 여럿이라 읽기와 쓰기 사이 아주 짧은 틈에서 경쟁이 생길 수 있다
  const sleep = () => (GAP ? new Promise((r) => setTimeout(r, GAP * (0.5 + Math.random()))) : undefined);
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };

  async function buyNaive(userId) {
    const ev = db.prepare("SELECT remaining FROM events WHERE id = 1").get();
    await sleep();
    if (ev.remaining <= 0) return [409, { error: "매진됐어요" }];
    const dup = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE event_id = 1 AND user_id = ?").get(userId);
    await sleep();
    if (dup.n > 0) return [409, { error: "이미 구매했어요" }];
    db.prepare("UPDATE events SET remaining = ? WHERE id = 1").run(ev.remaining - 1);
    await sleep();
    db.prepare("INSERT INTO orders (event_id, user_id) VALUES (1, ?)").run(userId);
    return [201, { ok: true }];
  }

  async function buyFixed(userId) {
    await sleep(); // 지연은 같게 두고, 차감과 기록은 DB가 한 번에 처리하게 한다
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = db.prepare("UPDATE events SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0").run();
      if (r.changes === 0) { db.exec("ROLLBACK"); return [409, { error: "매진됐어요" }]; }
      db.prepare("INSERT INTO orders (event_id, user_id) VALUES (1, ?)").run(userId);
      db.exec("COMMIT");
      return [201, { ok: true }];
    } catch (e) {
      db.exec("ROLLBACK");
      if (/UNIQUE/.test(e.message)) return [409, { error: "이미 구매했어요" }];
      throw e;
    }
  }

  http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/reset") {
          const stock = Number(body.stock ?? 100);
          db.exec("BEGIN IMMEDIATE");
          db.prepare("DELETE FROM orders").run();
          db.prepare("UPDATE events SET stock = ?, remaining = ? WHERE id = 1").run(stock, stock);
          db.exec("COMMIT");
          return json(res, 200, { ok: true, stock });
        }
        if (req.method === "POST" && req.url === "/events/1/buy") {
          if (!body.userId) return json(res, 400, { error: "userId가 필요해요" });
          const [status, out] = await (MODE === "fixed" ? buyFixed : buyNaive)(String(body.userId));
          return json(res, status, out);
        }
        if (req.method === "GET" && req.url === "/events/1/stats") {
          const ev = db.prepare("SELECT stock, remaining FROM events WHERE id = 1").get();
          const orders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE event_id = 1").get().n;
          const dupUsers = db.prepare("SELECT COUNT(*) AS n FROM (SELECT user_id FROM orders WHERE event_id = 1 GROUP BY user_id HAVING COUNT(*) > 1)").get().n;
          return json(res, 200, { stock: ev.stock, remaining: ev.remaining, orders, duplicateUsers: dupUsers, leak: ev.stock - ev.remaining - orders });
        }
        json(res, 404, { error: "없는 경로" });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
    });
  }).listen(PORT);
}
