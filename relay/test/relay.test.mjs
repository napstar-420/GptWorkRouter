// End-to-end test of the relay with the real bridge-side client (lib/relay.mjs) and pairing
// script (scripts/relay.mjs), all on localhost. A stand-in bridge MCP endpoint plays the
// computer; this test plays both the browser and ChatGPT (DCR + PKCE + resource).
// Run: npm test (in relay/). No network, Google, GitHub or Codex needed.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.join(here, "..");
const root = path.join(relayDir, "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-relay-test-"));
const RPORT = 3391, BPORT = 3392, CB = `http://localhost:${BPORT + 1}/cb`;
const RELAY = `http://localhost:${RPORT}`, MCP = `${RELAY}/mcp`;
const BRIDGE_DATA = path.join(T, "bridge");
const EMAIL = "friend@example.com";
const MARKER = "SECRET-BRIEF-MARKER-7731";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${String(detail).slice(0, 300)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};

// ---- Stand-in bridge: the loopback MCP endpoint the relay client replays requests into ----
const seen = [];
let aborted = 0;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const m = body ? JSON.parse(body) : {};
    seen.push({ headers: req.headers, method: m.method, name: m.params?.name });
    const reply = (result) => res.writeHead(200, { "content-type": "application/json", "set-cookie": "bad=1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    if (m.method === "tools/list") return reply({ tools: [{ name: "start_task", inputSchema: { type: "object" } }] });
    if (m.method === "tools/call" && m.params?.name === "echo") return reply({ content: [{ type: "text", text: `echo ${m.params.arguments?.text}` }] });
    if (m.method === "tools/call" && m.params?.name === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
      await sleep(900);
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "streamed" }] } })}\n\n`);
      return;
    }
    if (m.method === "tools/call" && m.params?.name === "silent") return; // never answers at all
    if (m.method === "tools/call" && m.params?.name === "hang") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": started\n\n");
      res.on("close", () => aborted++);
      return; // an open stream that never finishes
    }
    reply({});
  });
});
await new Promise((r) => stub.listen(BPORT, "127.0.0.1", r));

// ---- The relay ----
const relayEnv = { ...process.env, PORT: String(RPORT), DEV_LOGIN: "1", DATA_DIR: path.join(T, "relay"), RELAY_DEADLINE_MS: "1500", RELAY_KEEPALIVE_MS: "300", RELAY_PING_MS: "1000" };
fs.mkdirSync(path.join(T, "relay", "downloads", "releases", "1.2.3"), { recursive: true });
fs.writeFileSync(path.join(T, "relay", "downloads", "install.sh"), "#!/bin/sh\necho hi\n");
fs.writeFileSync(path.join(T, "relay", "downloads", "releases", "1.2.3", "gwr.zip"), "zipbytes");
execFileSync(process.execPath, ["admin.mjs", "allow", EMAIL], { cwd: relayDir, env: relayEnv });
let relayLog = "";
const relay = spawn(process.execPath, ["server.mjs"], { cwd: relayDir, env: relayEnv });
relay.stdout.on("data", (d) => (relayLog += d));
relay.stderr.on("data", (d) => (relayLog += d));
check("relay starts", await until(async () => (await fetch(`${RELAY}/healthz`).catch(() => null))?.ok));

// ---- A tiny browser: cookie jar + manual redirects ----
const jar = new Map();
const keep = (res) => {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(";");
    const [k, ...v] = kv.split("=");
    if (/Max-Age=0/i.test(c)) jar.delete(k);
    else jar.set(k, v.join("="));
  }
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function browse(url, opts = {}, hops = 15) {
  let res;
  for (let i = 0; i < hops; i++) {
    res = await fetch(url, { ...opts, redirect: "manual", headers: { ...(opts.headers || {}), cookie: cookieHeader() } });
    keep(res);
    const loc = res.headers.get("location");
    if (!loc || res.status < 300 || res.status >= 400) break;
    url = new URL(loc, url).toString();
    if (url.startsWith(CB) || url.startsWith("https://evil.example")) return { url, res };
    opts = {};
  }
  return { url, res, text: await res.text() };
}
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const field = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html || "")?.[1];

// ---- Pairing with the real script ----
const bridgeEnv = { ...process.env, DATA_DIR: BRIDGE_DATA, GWR_KEY_STORE: "file", GWR_NO_BROWSER: "1", NOTIFY: "0" };
function runPair() {
  const p = spawn(process.execPath, [path.join(root, "scripts", "relay.mjs"), "pair", "--relay", RELAY, "--name", "Test-PC", "--json"], { env: bridgeEnv });
  let out = "";
  const lines = [];
  p.stdout.on("data", (d) => {
    out += d;
    for (const l of String(d).split("\n").filter(Boolean)) try { lines.push(JSON.parse(l)); } catch {}
  });
  p.stderr.on("data", (d) => (out += d));
  const done = new Promise((r) => p.on("exit", (code) => r(code)));
  return { lines, done, out: () => out };
}
const pairRun = runPair();
await until(() => pairRun.lines.some((l) => l.event === "code"));
const codeEvent = pairRun.lines.find((l) => l.event === "code");
check("pair prints a code and verify URL", /^[A-Z]{4}-\d{4}$/.test(codeEvent?.code || "") && codeEvent.verify_url.includes(codeEvent.code), pairRun.out());

let r = await browse(codeEvent.verify_url);
check("pair page asks to sign in first", /Sign in to GPTWorkRouter/.test(r.text));
r = await browse(`${RELAY}/login/dev`, form({ email: "stranger@example.com", next: `/pair?code=${codeEvent.code}` }));
check("an email not on the invite list is refused", r.res.status === 403 && /not on the invite list/.test(r.text));
r = await browse(`${RELAY}/login/dev`, form({ email: EMAIL, next: `/pair?code=${codeEvent.code}` }));
check("invited user signs in and sees the code to confirm", /Connect this computer\?/.test(r.text) && r.text.includes(codeEvent.code) && r.text.includes("Test-PC"), r.text?.slice(0, 300));
const bad = await browse(`${RELAY}/pair`, form({ code: codeEvent.code, action: "connect", csrf: "forged" }));
check("pairing needs the page's CSRF token", bad.res.status === 400);
r = await browse(`${RELAY}/pair`, form({ code: codeEvent.code, action: "connect", csrf: field(r.text, "csrf") }));
check("Connect pairs the computer", /Computer connected/.test(r.text), r.text?.slice(0, 300));
const pairExit = await pairRun.done;
const paired = pairRun.lines.find((l) => l.event === "paired");
const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DATA, "relay.json"), "utf8"));
check("pair exits 0 and writes relay.json with exactly the contract fields", pairExit === 0 && paired?.mcp_url === MCP && cfg.machine_id === paired.machine_id && Object.keys(cfg).sort().join() === "account,machine_id,mcp_url,paired_at,relay", pairRun.out());
const keyFile = path.join(BRIDGE_DATA, "relay-key");
check("machine key saved 0600, not in relay.json", fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o777) === 0o600 && !JSON.stringify(cfg).includes(fs.readFileSync(keyFile, "utf8").trim()));

// ---- The bridge-side client ----
Object.assign(process.env, bridgeEnv);
const { RelaySupervisor, machineToken, loadKey } = await import(path.join(root, "lib", "relay.mjs"));
const { codexEnv } = await import(path.join(root, "lib", "tasks.mjs"));
let dropped = 0;
const quiet = { log() {}, error() {} };
const newSup = () => new RelaySupervisor({ port: BPORT, events: { unsubscribeAll: () => dropped++ }, version: "test", log: quiet });
const sup = newSup();
sup.start();
check("bridge connects to the relay", await until(() => sup.status === "connected"), sup.status);
check("ChatGPT grants count is 0 before linking", await until(() => sup.chatgptGrants === 0), sup.chatgptGrants);

// ---- ChatGPT: register (DCR), authorize with PKCE + resource, consent, token ----
const register = (redirect) =>
  fetch(`${RELAY}/oauth/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  }).then((x) => x.json());
const reg = await register(CB);
check("DCR registers a public client", typeof reg.client_id === "string", JSON.stringify(reg));
async function authorize(clientId, redirect = CB, scope = "mcp offline_access") {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", ...(scope ? { scope } : {}), code_challenge: challenge, code_challenge_method: "S256", state: "st8", resource: MCP, prompt: "consent" });
  return { a: await browse(`${RELAY}/oauth/auth?${q}`), verifier };
}
let { a, verifier } = await authorize(reg.client_id);
check("consent page names the computer", /Allow ChatGPT\?/.test(a.text || "") && /Test-PC/.test(a.text), `${a.res?.status} ${a.url} ${a.text?.slice(0, 300)}`);
const confirmPath = /action="(\/interaction\/[^"]+\/confirm)"/.exec(a.text || "")?.[1];
const confirmCsrf = /\/confirm"><input type="hidden" name="csrf" value="([^"]+)"/.exec(a.text || "")?.[1];
a = await browse(new URL(confirmPath || "/x", RELAY).toString(), form({ csrf: confirmCsrf }));
const back = new URL(a.url);
check("Allow redirects back to ChatGPT with code, state and iss (RFC 9207)", a.url.startsWith(CB) && back.searchParams.get("code") && back.searchParams.get("state") === "st8" && back.searchParams.get("iss") === RELAY, `${a.url} ${a.text?.slice(0, 300)}`);
const tok = await fetch(`${RELAY}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") || "", redirect_uri: CB, client_id: reg.client_id, code_verifier: verifier, resource: MCP }),
}).then((x) => x.json());
check("token endpoint gives an access token and a refresh token", tok.access_token && tok.refresh_token && tok.token_type === "Bearer", JSON.stringify(tok));
check("grants count goes to 1 after Allow", await until(() => sup.chatgptGrants === 1), sup.chatgptGrants);

// ---- MCP through the relay ----
let rpcId = 1;
const mcp = (method, params, token = tok.access_token, extra = {}, signal) =>
  fetch(MCP, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(params?.name ? { "mcp-name": params.name } : {}), origin: "https://evil.example", cookie: "c=1", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
const noTok = await fetch(MCP, { method: "POST", body: "{}" });
check("no token: 401 with resource_metadata", noTok.status === 401 && /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource"/.test(noTok.headers.get("www-authenticate")));
const badTok = await mcp("tools/list", {}, "not-a-token");
check("bad token: 401 invalid_token", badTok.status === 401 && /invalid_token/.test(badTok.headers.get("www-authenticate")));
let res = await mcp("tools/list", {});
let body = await res.json();
check("tools/list is piped to the computer", res.status === 200 && body.result?.tools?.[0]?.name === "start_task", JSON.stringify(body));
const last = seen.at(-1);
check("the bridge sees a local request: Host 127.0.0.1, no Origin, no cookie, no token", last?.headers.host === `127.0.0.1:${BPORT}` && !last.headers.origin && !last.headers.cookie && !last.headers.authorization, JSON.stringify(last?.headers));
check("MCP headers pass through unchanged", last?.headers["mcp-method"] === "tools/list" && last.headers["mcp-protocol-version"] === "2026-07-28");
check("the bridge's Set-Cookie does not reach ChatGPT", !res.headers.get("set-cookie"));
res = await mcp("tools/call", { name: "echo", arguments: { text: MARKER } });
body = await res.json();
check("tools/call round trip", body.result?.content?.[0]?.text === `echo ${MARKER}`, JSON.stringify(body));
const many = await Promise.all(Array.from({ length: 8 }, (_, i) => mcp("tools/call", { name: "echo", arguments: { text: `n${i}` } }).then((x) => x.json())));
check("8 calls at once all come back right", many.every((b, i) => b.result?.content?.[0]?.text === `echo n${i}`));

res = await mcp("tools/call", { name: "stream" });
const sseText = await res.text();
check("SSE streams through, with no-buffering headers", res.headers.get("content-type") === "text/event-stream" && res.headers.get("x-accel-buffering") === "no" && /notifications\/progress/.test(sseText) && /streamed/.test(sseText), sseText);
check("keep-alive comments are added to a quiet stream", /: keepalive/.test(sseText), sseText);

res = await mcp("tools/call", { name: "silent" });
check("a call that never answers gets 504 after the deadline", res.status === 504, res.status);
const ac = new AbortController();
const hang = mcp("tools/call", { name: "hang" }, tok.access_token, { "mcp-method": "subscriptions/listen" }, ac.signal).then((x) => x.text()).catch(() => null);
await sleep(800);
const before = aborted;
ac.abort();
await hang;
check("closing a stream cancels it on the computer (no deadline on listen streams)", await until(() => aborted > before, 3000), `${before} -> ${aborted}`);

// ---- Refresh token ----
const ref = await fetch(`${RELAY}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token || "", client_id: reg.client_id, resource: MCP }),
}).then((x) => x.json());
res = ref.access_token ? await mcp("tools/list", {}, ref.access_token) : { status: 0 };
check("refresh gives a working access token", res.status === 200, JSON.stringify(ref));

// ---- A second connection with the same key replaces the first ----
const sup2 = newSup();
sup2.start();
check("a second connection with the same key replaces the first", await until(() => sup2.status === "connected" && /replaced/.test(sup.status)), `${sup.status} / ${sup2.status}`);
sup2.stop();
await sleep(300);

// ---- Offline answer ----
res = await mcp("tools/call", { name: "echo", arguments: { text: "x" } }, ref.access_token);
body = await res.json();
check("computer offline: a tool error, not a 401", res.status === 200 && body.result?.isError === true && /isn't connected/.test(body.result?.content?.[0]?.text) && body.result.resultType === "complete", JSON.stringify(body));
res = await mcp("tools/list", {}, ref.access_token);
body = await res.json();
check("computer offline: other calls get a JSON-RPC error", body.error?.code === -32000, JSON.stringify(body));
const sup3 = newSup();
sup3.start();
check("bridge reconnects after being started again", await until(() => sup3.status === "connected"), sup3.status);

// ---- Machine auth ----
const key = loadKey();
const forged = machineToken(cfg.machine_id, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
const tryUnpair = (t) => fetch(`${RELAY}/machine/unpair`, { method: "POST", headers: { authorization: `GWR-Machine ${t}`, "content-type": "application/json" }, body: "{}" });
check("a forged machine signature is refused", (await tryUnpair(forged)).status === 401);
check("an old machine token is refused", (await tryUnpair(machineToken(cfg.machine_id, key, Date.now() - 10 * 60000))).status === 401);

// ---- Revoke the ChatGPT link on the account page ----
r = await browse(`${RELAY}/account`);
check("account page lists the computer and the ChatGPT link", /Test-PC/.test(r.text) && /connected now/.test(r.text) && /ChatGPT, linked/.test(r.text), r.text?.slice(0, 600));
const grant = /name="grant" value="([^"]+)"/.exec(r.text || "")?.[1];
const dropsBefore = dropped;
await browse(`${RELAY}/account/revoke`, form({ grant, csrf: /name="grant" value="[^"]+"><input type="hidden" name="csrf" value="([^"]+)"/.exec(r.text || "")?.[1] }));
check("revoke: the old token stops working", (await mcp("tools/list", {}, ref.access_token)).status === 401);
check("revoke: the bridge drops its event subscriptions", await until(() => dropped > dropsBefore));
check("revoke: grants count goes back to 0", await until(() => sup3.chatgptGrants === 0), sup3.chatgptGrants);

// ---- Only ChatGPT redirect URIs, for every client ----
const evilReg = await register("https://evil.example/cb");
check("registering a client that redirects elsewhere is refused", !evilReg.client_id && /invalid_(client_metadata|redirect_uri)/.test(evilReg.error), JSON.stringify(evilReg));
const mixed = await fetch(`${RELAY}/oauth/reg`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [CB, "https://evil.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) }).then((x) => x.json());
check("a client with one ChatGPT URI and one foreign URI is refused too", !mixed.client_id, JSON.stringify(mixed));
// The skip-consent path: signed in, grant already given, no prompt=consent, foreign redirect.
const sneaky = await browse(`${RELAY}/oauth/auth?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb", response_type: "code", scope: "mcp", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: MCP })}`);
check("an authorize request with an unregistered redirect never reaches it", !String(sneaky.url).startsWith("https://evil.example"), sneaky.url);
check("pushed authorization requests are off", (await fetch(`${RELAY}/request`, { method: "POST" })).status === 404);

// ---- ChatGPT may ask for no scope at all ----
const reg2 = await register(CB);
let n = await authorize(reg2.client_id, CB, "");
if (/Allow ChatGPT\?/.test(n.a.text || "")) {
  const cp = /action="(\/interaction\/[^"]+\/confirm)"/.exec(n.a.text)[1];
  const cc = /\/confirm"><input type="hidden" name="csrf" value="([^"]+)"/.exec(n.a.text)[1];
  n.a = await browse(new URL(cp, RELAY).toString(), form({ csrf: cc }));
}
const code2 = new URL(n.a.url).searchParams.get("code");
const tok2 = await fetch(`${RELAY}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2 || "", redirect_uri: CB, client_id: reg2.client_id, code_verifier: n.verifier, resource: MCP }) }).then((x) => x.json());
check("no-scope sign-in still gives a token that works on /mcp", tok2.access_token && (await mcp("tools/list", {}, tok2.access_token)).status === 200, JSON.stringify(tok2));

// ---- A revocation while the computer is offline reaches it on the next connect ----
sup3.stop();
await sleep(300);
r = await browse(`${RELAY}/account`);
const g2 = /name="grant" value="([^"]+)"/.exec(r.text || "")?.[1];
const drops2 = dropped;
await browse(`${RELAY}/account/revoke`, form({ grant: g2, csrf: /name="grant" value="[^"]+"><input type="hidden" name="csrf" value="([^"]+)"/.exec(r.text || "")?.[1] }));
const sup5 = newSup();
sup5.start();
check("revoked while offline: the bridge drops subscriptions after reconnecting", (await until(() => sup5.status === "connected")) && (await until(() => dropped > drops2)), `${sup5.status} ${dropped}`);

// ---- Unlink the computer on the account page ----
r = await browse(`${RELAY}/account`);
await browse(`${RELAY}/account/unlink`, form({ csrf: /action="\/account\/unlink"><input type="hidden" name="csrf" value="([^"]+)"/.exec(r.text || "")?.[1] }));
check("unlink: the bridge stops with status revoked", await until(() => sup5.status === "revoked"), sup5.status);
const sup4 = newSup();
sup4.start();
check("unlink: reconnecting is refused as revoked", await until(() => sup4.status === "revoked"), sup4.status);

// ---- Re-pair, then unpair with the script ----
const pair2 = runPair();
await until(() => pair2.lines.some((l) => l.event === "code"));
const c2 = pair2.lines.find((l) => l.event === "code");
r = await browse(c2.verify_url);
await browse(`${RELAY}/pair`, form({ code: c2.code, action: "connect", csrf: field(r.text, "csrf") }));
check("re-pair works", (await pair2.done) === 0, pair2.out());
const un = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "relay.mjs"), "unpair", "--json"], { env: bridgeEnv, encoding: "utf8" }).trim());
check("unpair tells the relay and removes relay.json and the key", un.relay_told === true && !fs.existsSync(path.join(BRIDGE_DATA, "relay.json")) && !fs.existsSync(keyFile), JSON.stringify(un));
const st = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts", "relay.mjs"), "status", "--json"], { env: bridgeEnv, encoding: "utf8" }).trim());
check("status --json after unpair", st.relay === "off" && st.chatgpt_grants === null, JSON.stringify(st));

// ---- Pairing cancelled in the browser ----
const pair3 = runPair();
await until(() => pair3.lines.some((l) => l.event === "code"));
const c3 = pair3.lines.find((l) => l.event === "code");
r = await browse(c3.verify_url);
await browse(`${RELAY}/pair`, form({ code: c3.code, action: "cancel", csrf: field(r.text, "csrf") }));
check("Cancel in the browser: pair exits 1 with reason denied", (await pair3.done) === 1 && pair3.lines.some((l) => l.event === "error" && l.reason === "denied"), pair3.out());

// ---- Downloads ----
const dl = await fetch(`${RELAY}/install.sh`);
check("installer script is served", dl.status === 200 && (await dl.text()).includes("echo hi") && dl.headers.get("cache-control") === "no-cache");
const z = await fetch(`${RELAY}/releases/1.2.3/gwr.zip`);
check("versioned release file is served, cacheable", z.status === 200 && /immutable/.test(z.headers.get("cache-control")));
const trav = await Promise.all(["/releases/1.2.3/..%2F..%2Frelay.db", "/releases/../relay.db", "/releases/1.2.3/.hidden", "/install.sh/../relay.db", "/relay.db"].map((u) => fetch(RELAY + u).then((x) => x.status)));
check("download paths cannot escape the downloads folder", trav.every((s) => s === 404 || s === 400), trav);

// ---- Logs and secrets ----
const logDir = path.join(T, "relay", "logs");
const logs = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("");
check("request log has method and tool names", /"method":"tools\/call"/.test(logs) && /"name":"echo"/.test(logs), logs.slice(0, 300));
check("request log and console never contain request content or tokens", !logs.includes(MARKER) && !relayLog.includes(MARKER) && !logs.includes(tok.access_token) && !relayLog.includes(tok.access_token));
process.env.GWR_RELAY_KEY = "k";
check("GWR_RELAY_KEY is withheld from Codex", !("GWR_RELAY_KEY" in codexEnv()));
check("relay database is 0600", (fs.statSync(path.join(T, "relay", "relay.db")).mode & 0o777) === 0o600);

for (const s of [sup, sup3, sup4, sup5]) s.stop();
relay.kill("SIGTERM");
stub.close();
fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
