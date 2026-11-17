// TunnelSupervisor status from tunnel-client's log lines (fake binary prints the lines seen on the Mac).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelSupervisor } from "../lib/tunnel.mjs";

let failed = 0;
const check = (name, ok, info = "") => (console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${info}`}`), ok || failed++);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-tunnel-test-"));
process.env.CONTROL_PLANE_API_KEY = "test-not-a-key";

function fake(lines) {
  const f = path.join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, `#!${process.execPath}\n${lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`).join("\n")}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  return f;
}
const quiet = { log() {}, error() {} };
async function run(lines, wait) {
  const t = new TunnelSupervisor({ binary: fake(lines), profile: "p", log: quiet });
  t.start();
  for (let i = 0; i < 100 && t.status === "starting"; i++) await sleep(50); // the fake can be slow to start under load
  await sleep(wait);
  const s = t.status;
  t.stop();
  return s;
}

const started = { level: "INFO", msg: "poller started" };
const bad = { level: "WARN", msg: "poll failed; backing off: controlplane client: unexpected status 401: invalid_api_key: Incorrect API key provided" };
const noAccess = { level: "WARN", msg: "tunnel metadata fetch failed: controlplane client: unexpected metadata status 403: insufficient permissions" };
const net = { level: "WARN", msg: "poll failed; backing off: dial tcp: no such host" };

check("bad key -> key rejected (not connected)", (await run([started, bad], 6500)) === "key rejected");
check("403 -> key lacks Tunnels access", (await run([started, noAccess], 1500)) === "key lacks Tunnels access");
check("poller started is only 'checking' at first", (await run([started], 1000)) === "checking");
check("no failure for 5 s -> connected", (await run([started], 6000)) === "connected");
check("network failure -> poll failing", (await run([started, net], 1500)) === "poll failing");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
