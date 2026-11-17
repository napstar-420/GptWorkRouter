// Offline test of the bridge's relay client against the REAL bridge (server.mjs, stand-in Codex)
// and a minimal fake relay. Proves piped calls pass the bridge's Host/Origin checks, /health
// reports relay status and the ChatGPT grants count, and the relay states are right.
// Run: node test/relay.test.mjs  (the full relay service is tested by `npm run test:relay`).
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-relayc-test-"));
const PORT = 3296, RPORT = 3297;
const DATA = path.join(T, "data");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(T, "codexhome"), { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${String(detail).slice(0, 300)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => ({}));

// A paired computer: key pair, key in a file store, relay.json pointing at the fake relay.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(path.join(DATA, "relay-key"), privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(DATA, "relay.json"), JSON.stringify({ relay: `http://127.0.0.1:${RPORT}`, machine_id: "m_test", account: "me@example.com", mcp_url: `http://127.0.0.1:${RPORT}/mcp`, paired_at: new Date().toISOString() }));

// ---- Fake relay: checks the machine signature, then lets the test send frames ----
let mode = "ok"; // ok | revoked | old
let sock = null, authOk = null;
const frames = [];
const srv = http.createServer();
const wss = new WebSocketServer({ noServer: true });
srv.on("upgrade", (req, socket, head) => {
  const m = /^GWR-Machine ([\w-]+)\.([\w-]+)$/.exec(req.headers.authorization || "");
  authOk = Boolean(m && crypto.verify(null, Buffer.from(m[1]), publicKey, Buffer.from(m[2], "base64url")) && JSON.parse(Buffer.from(m[1], "base64url")).machine_id === "m_test");
  if (mode !== "ok") {
    socket.end(`HTTP/1.1 ${mode === "old" ? "426 Upgrade Required" : "401 Unauthorized"}\r\nX-GWR-Reason: ${mode === "old" ? "update_required" : "revoked"}\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sock = ws;
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: "hello", version: 1 }));
    ws.send(JSON.stringify({ t: "grants", count: 2 }));
  });
});
await new Promise((r) => srv.listen(RPORT, "127.0.0.1", r));

const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, WORKSPACE_ROOT: path.join(T, "work"), CODEX_HOME: path.join(T, "codexhome"), CODEX_PATH: path.join(here, "fixtures", "fake-codex.cjs"), GWR_KEY_STORE: "file", NOTIFY: "0" };
let bridge, out = "";
const startBridge = () => {
  bridge = spawn(process.execPath, [path.join(root, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  bridge.stdout.on("data", (d) => (out += d));
  bridge.stderr.on("data", (d) => (out += d));
};
const stopBridge = async () => {
  bridge.kill("SIGTERM");
  await new Promise((r) => bridge.on("exit", r));
};
startBridge();
check("bridge dials the relay and signs in with its machine key", await until(() => sock) && authOk === true, out);
check("/health: relay connected, relay_chatgpt_grants from the relay", await until(async () => { const h = await health(); return h.relay === "connected" && h.relay_chatgpt_grants === 2; }), JSON.stringify(await health()));
check("bridge says hello with its version and OS", await until(() => frames.some((f) => f.t === "hello" && f.version === 1 && f.bridge === JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version && f.os === process.platform)), JSON.stringify(frames));

// Send a request down the socket as the relay would, collect the reply frames.
const ask = (id, headers, body, method = "POST") =>
  new Promise((resolve) => {
    sock.send(JSON.stringify({ t: "req", id, method, path: "/mcp", headers, body: body ? Buffer.from(JSON.stringify(body)).toString("base64") : undefined }));
    const t = setInterval(() => {
      if (frames.some((f) => f.t === "end" && f.id === id)) {
        clearInterval(t);
        const mine = frames.filter((f) => f.id === id);
        resolve({ head: mine.find((f) => f.t === "head"), text: Buffer.concat(mine.filter((f) => f.t === "data").map((f) => Buffer.from(f.chunk, "base64"))).toString("utf8") });
      }
    }, 20);
  });
const H = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", host: "relay.example", origin: "https://chatgpt.com" };
let r = await ask("r1", H, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "relay-test", version: "1" } } });
check("initialize through the relay passes the bridge's Host/Origin checks", r.head?.status === 200 && /gpt-work-router/.test(r.text), `${r.head?.status} ${r.text.slice(0, 200)}`);
const sid = r.head?.headers?.["mcp-session-id"];
r = await ask("r2", { ...H, ...(sid ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
check("tools/list through the relay returns the bridge's tools", r.head?.status === 200 && /start_task/.test(r.text) && /check_task/.test(r.text), r.text.slice(0, 200));
r = await ask("r3", { ...H, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
check("a 2026-07-28 stateless call works too", r.head?.status === 200 && /start_task/.test(r.text), `${r.head?.status} ${r.text.slice(0, 200)}`);
r = await ask("r4", H, null, "DELETE");
check("non-POST methods are relayed (bridge answers, no crash)", r.head && r.head.status >= 200, JSON.stringify(r.head));

// Revoked frame drops event subscriptions.
fs.mkdirSync(path.join(DATA, "subscriptions"), { recursive: true });
fs.writeFileSync(path.join(DATA, "subscriptions", "s1.json"), JSON.stringify({ id: "s1", principal: "owner", name: "task.finished", arguments: {}, url: "https://example.com/hook", secret: "whsec_x" }));
await stopBridge();
sock = null;
startBridge();
await until(async () => (await health()).relay === "connected" && sock);
const subsBefore = fs.readdirSync(path.join(DATA, "subscriptions")).filter((f) => f.endsWith(".json")).length;
sock.send(JSON.stringify({ t: "revoked", scope: "chatgpt" }));
check("a revoked frame drops the bridge's event subscriptions", subsBefore === 1 && (await until(() => fs.readdirSync(path.join(DATA, "subscriptions")).filter((f) => f.endsWith(".json")).length === 0)), `${subsBefore} ${out.slice(-300)}`);

// Relay goes away: status offline, then back to connected on its own.
sock.terminate();
check("relay drop: /health shows offline and grants null", await until(async () => { const h = await health(); return /^(offline|connecting)/.test(h.relay) && h.relay_chatgpt_grants === null; }), JSON.stringify(await health()));
check("bridge reconnects by itself", await until(async () => (await health()).relay === "connected", 10000));

// Refused as revoked / too old.
mode = "revoked";
sock.close(1011, "restart");
check("refused as revoked: status revoked, stops dialling", await until(async () => (await health()).relay === "revoked", 10000), JSON.stringify(await health()));
await stopBridge();
mode = "old";
startBridge();
check("refused as too old: status update_required", await until(async () => (await health()).relay === "update_required"), JSON.stringify(await health()));
await stopBridge();

// Key missing.
fs.rmSync(path.join(DATA, "relay-key"));
startBridge();
check("relay.json without a key: status key_missing", await until(async () => (await health()).relay === "key_missing"), JSON.stringify(await health()));
await stopBridge();

// Not paired at all.
fs.rmSync(path.join(DATA, "relay.json"));
startBridge();
check("not paired: relay off, grants null", await until(async () => { const h = await health(); return h.relay === "off" && h.relay_chatgpt_grants === null; }), JSON.stringify(await health()));
await stopBridge();

// Units: proxy choice, Codex env, key store command shapes.
const unit = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  import { proxyAgentFor } from ${JSON.stringify(path.join(root, "lib", "relay.mjs"))};
  import { codexEnv } from ${JSON.stringify(path.join(root, "lib", "tasks.mjs"))};
  import { storeKeyCommand, keyCommand } from ${JSON.stringify(path.join(root, "lib", "desktop.mjs"))};
  const mac = storeKeyCommand("darwin", { user: "u", name: "gptworkrouter-relay", secret: "S3CRET" });
  const win = storeKeyCommand("win32", { user: "u", name: "gptworkrouter-relay", file: "C:/x/relay-key.dpapi", secret: "S3CRET" });
  console.log(JSON.stringify({
    proxied: Boolean(proxyAgentFor("https://relay.example")),
    noProxy: Boolean(proxyAgentFor("https://sub.relay.example")),
    withheld: !("GWR_RELAY_KEY" in codexEnv()),
    macArgvClean: !mac.args.join(" ").includes("S3CRET") && mac.input.includes("S3CRET"),
    winArgvClean: !win.args.join(" ").includes("S3CRET") && win.env.GWR_SECRET === "S3CRET",
    readName: keyCommand("darwin", { user: "u", dataDir: "/d", name: "gptworkrouter-relay" }).args.includes("gptworkrouter-relay"),
    tunnelDefault: keyCommand("darwin", { user: "u", dataDir: "/d" }).args.includes("gptworkrouter-tunnel"),
  }));
`], { env: { ...process.env, HTTPS_PROXY: "http://proxy.local:3128", NO_PROXY: "localhost,.sub.relay.example", GWR_RELAY_KEY: "k", DATA_DIR: DATA }, encoding: "utf8" }));
check("HTTPS_PROXY is used for the relay host", unit.proxied);
check("NO_PROXY skips the proxy", !unit.noProxy);
check("GWR_RELAY_KEY is withheld from Codex", unit.withheld);
check("storing the key never puts it on a command line (macOS, Windows)", unit.macArgvClean && unit.winArgvClean);
check("key commands: relay name, tunnel stays the default", unit.readName && unit.tunnelDefault);

srv.close();
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
