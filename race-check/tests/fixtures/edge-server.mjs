// 실행기가 이상한 서버 앞에서 거짓 통과나 무한 대기를 하지 않는지 보는 시험용 서버
import http from "node:http";
const port = Number(process.argv[2] || 4580);
let n = 0;
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const json = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    switch (req.url) {
      case "/ok": return json(201, { ok: true });
      case "/fail": return json(500, { error: "boom" });
      case "/cut": // 헤더를 보내고 본문 도중에 끊는다
        res.writeHead(200, { "content-length": "100" });
        res.write("partial");
        return setTimeout(() => req.socket.destroy(), 50);
      case "/drop-third": // 세 번에 한 번 연결을 끊는다
        if (n++ % 3 === 0) return req.socket.destroy();
        return json(201, { ok: true });
      case "/drip": { // 시간 초과보다 짧은 간격으로 1바이트씩 끝없이 흘려보낸다
        res.writeHead(200, { "content-type": "text/plain" });
        const t = setInterval(() => res.write("."), 300);
        return res.on("close", () => clearInterval(t));
      }
      case "/null": return json(200, { v: null });
      case "/empty": return json(200, { v: "" });
      case "/num": return json(200, { v: 3 });
      case "/json-only": // JSON 본문이 아니면 Spring처럼 415
        if (!String(req.headers["content-type"] || "").includes("application/json")) return json(415, { error: "unsupported" });
        return json(200, { ok: true, got: JSON.parse(raw) });
      case "/redirect": res.writeHead(302, { location: "http://example.com/" }); return res.end();
      default: return json(404, {});
    }
  });
}).listen(port, () => console.log("edge-server", port));
