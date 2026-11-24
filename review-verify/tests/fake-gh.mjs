#!/usr/bin/env node
// 시험용 gh. FAKE_GH_FILE의 JSON을 그대로 출력한다. FAKE_GH_FAIL이 있으면 실패한다.
import fs from "node:fs";

if (process.env.FAKE_GH_FAIL) {
  process.stderr.write(process.env.FAKE_GH_FAIL + "\n");
  process.exit(1);
}
const args = process.argv.slice(2);
if (args[0] !== "pr" || args[1] !== "view") {
  process.stderr.write(`fake-gh: 지원하지 않는 명령 ${args.join(" ")}\n`);
  process.exit(1);
}
process.stdout.write(fs.readFileSync(process.env.FAKE_GH_FILE, "utf8"));
