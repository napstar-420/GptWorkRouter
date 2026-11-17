// Offline tests for the installer: Codex config editing, browser choice, bundled PATH,
// launchd plist, bootstrap scripts. Run: node test/installer.test.mjs (no network, no Codex).
// Nothing here touches the real ~/.codex, launchd or the login task: temp dirs only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { planEdits, applyEdits, describe, writeWithBackup } from "../installer/codex-config.mjs";
import { findBrowsers, setBrowserBlock } from "../installer/browser.mjs";
import { bundledEnv } from "../lib/bundled.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-inst-"));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${String(detail).slice(0, 400)}` : ""}`);
};
const edit = (text, opts) => applyEdits(text, planEdits(parse(text.replace(/^\uFEFF/, "")), opts));

// ---- Codex config ----
{
  const r = edit("", { platform: "darwin" });
  const t = parse(r.text);
  check("empty config gets the three settings", t.sandbox_mode === "workspace-write" && t.approval_policy === "never" && t.sandbox_workspace_write?.network_access === true, r.text);
}
{
  const src = "# my config\nmodel = \"gpt-5\" # keep\n\n# servers\n[mcp_servers.x]\nurl = \"http://a\" # trailing\n";
  const r = edit(src, { platform: "darwin" });
  const kept = src.split("\n").filter(Boolean).every((l) => r.text.includes(l));
  const t = parse(r.text);
  check("comments and other settings kept", kept && t.model === "gpt-5" && t.mcp_servers.x.url === "http://a", r.text);
  check("top-level keys land before the first table, not inside it", t.sandbox_mode === "workspace-write" && !("sandbox_mode" in t.mcp_servers.x), r.text);
  check("the table's comment stays with the table", /# servers\n\[mcp_servers\.x\]/.test(r.text), r.text);
}
{
  const r = edit("[mcp_servers.x]\nurl = \"http://a\"\n", { platform: "darwin" });
  const t = parse(r.text);
  check("file starting with a table: top-level keys go first", r.text.startsWith("sandbox_mode") && !("approval_policy" in t.mcp_servers.x), r.text);
}
{
  const r = edit('[windows]\nsandbox = "elevated" # old\n', { platform: "win32" });
  check("[windows] sandbox replaced in place, comment kept", /sandbox = "mxc" # old/.test(r.text) && parse(r.text).windows.sandbox === "mxc", r.text);
  check("diff shows old and new line", /- sandbox = "elevated" # old\n {2}\+ sandbox = "mxc" # old/.test(describe(r.changes)), describe(r.changes));
}
{
  const r = edit('windows.sandbox = "unelevated"\n', { platform: "win32" });
  check("dotted windows.sandbox replaced in place", r.text?.includes('windows.sandbox = "mxc"') && !r.text.includes("[windows]"), r.text);
}
{
  const r = edit('windows = { sandbox = "elevated" }\n', { platform: "win32" });
  check("inline table: no write, lines to add by hand", !r.text && r.manual?.some((l) => l.includes('sandbox = "mxc"')), JSON.stringify(r));
}
{
  const src = 'profile = "work"\n[profiles.work]\nsandbox_mode = "read-only"\n';
  const r = edit(src, { platform: "darwin" });
  const t = parse(r.text);
  check("selected profile: its sandbox_mode is the one changed", t.profiles.work.sandbox_mode === "workspace-write" && t.sandbox_mode === undefined && t.approval_policy === "never", r.text);
}
{
  const src = "\uFEFFmodel = \"x\"\r\n[a]\r\nb = 1\r\n";
  const r = edit(src, { platform: "win32" });
  check("BOM and CRLF kept", r.text.startsWith("\uFEFF") && !/[^\r]\n/.test(r.text) && parse(r.text.slice(1)).windows.sandbox === "mxc", JSON.stringify(r.text));
}
{
  const r = applyEdits("this is = = not toml\n", [{ path: ["approval_policy"], value: "never" }]);
  check("unparseable file: nothing written, reason given", !r.text && /can't be read/.test(r.reason), JSON.stringify(r));
}
{
  const ok = 'sandbox_mode = "workspace-write"\napproval_policy = "never"\n[sandbox_workspace_write]\nnetwork_access = true\n';
  check("already right: no changes", planEdits(parse(ok), { platform: "darwin" }).length === 0);
  const r = edit(ok, { platform: "darwin", access: "full" });
  check("full access sets danger-full-access", parse(r.text).sandbox_mode === "danger-full-access" && r.changes.length === 1, r.text);
  const n = edit(r.text, { platform: "darwin" });
  check("existing full access is narrowed by default", parse(n.text).sandbox_mode === "workspace-write", n.text);
}
{
  const src = '[mcp_servers.browseros-neo]\nurl = "http://127.0.0.1:9010/mcp"\n\n[mcp_servers."my srv"]\ncommand = "x"\n';
  const r = edit(src, { platform: "darwin", approve: ["browseros-neo", "my srv"] });
  const t = parse(r.text);
  check("approve MCP servers, also with a quoted name", t.mcp_servers["browseros-neo"].default_tools_approval_mode === "approve" && t.mcp_servers["my srv"].default_tools_approval_mode === "approve", r.text);
}
{
  const src = 'notify = [\n  "a",\n  "b",\n]\n\n[x]\ny = 1\n';
  const r = edit(src, { platform: "darwin" });
  check("multi-line array before the first table stays valid", parse(r.text).notify.length === 2 && parse(r.text).sandbox_mode === "workspace-write", r.text);
}
{
  const r = edit('[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = ["/x"]\n', { platform: "darwin" });
  check("network_access false -> true, other keys in the table kept", parse(r.text).sandbox_workspace_write.network_access === true && parse(r.text).sandbox_workspace_write.writable_roots[0] === "/x", r.text);
}
{
  const f = path.join(T, "codex", "config.toml");
  check("first write: no backup", writeWithBackup(f, "a = 1\n") === null && fs.readFileSync(f, "utf8") === "a = 1\n");
  const b = writeWithBackup(f, "a = 2\n");
  check("second write backs up the old file", /config\.toml\.bak-gwr-\d{8}-\d{6}$/.test(b) && fs.readFileSync(b, "utf8") === "a = 1\n" && fs.readFileSync(f, "utf8") === "a = 2\n", b);
}

// ---- Browser ----
{
  const toml = parse('[mcp_servers.chrome-devtools]\ncommand = "npx"\nargs = ["chrome-devtools-mcp"]\n[mcp_servers.browseros-neo]\nurl = "http://127.0.0.1:9010/mcp"\n[mcp_servers.off]\nurl = "http://browser"\nenabled = false\n[mcp_servers.blender]\ncommand = "x"\n');
  const b = findBrowsers(toml);
  check("browsers found, BrowserOS neo first, disabled and non-browsers left out", b.length === 2 && b[0].name === "browseros-neo" && b[0].browseros && b[1].name === "chrome-devtools", JSON.stringify(b));
  const own = "# My rules\nBe brief.\n";
  const a = setBrowserBlock(own, "browseros-neo");
  const a2 = setBrowserBlock(a, "chrome-devtools");
  check("AGENTS.md block added after the user's text", a.startsWith(own) && a.includes("use the browseros-neo MCP server"), a);
  check("block replaced, not duplicated", a2.split("gptworkrouter:browser -->").length === 3 && a2.includes("chrome-devtools") && !a2.includes("browseros-neo"), a2);
  check("block removed leaves the user's text", setBrowserBlock(a2, null) === own, JSON.stringify(setBrowserBlock(a2, null)));
  check("empty AGENTS.md gets just the block", setBrowserBlock("", "x").startsWith("<!-- gptworkrouter:browser -->"));
}

// ---- Bundled Git/Node on PATH ----
{
  const app = path.join(T, "app");
  for (const d of ["git/bin", "git/libexec/git-core", "node/bin"]) fs.mkdirSync(path.join(app, d), { recursive: true });
  const e = bundledEnv(app, "darwin", { PATH: "/usr/bin" });
  check("macOS bundle: git and node first on PATH, git env set", e.PATH === `${app}/git/bin:${app}/node/bin:/usr/bin` && e.GIT_EXEC_PATH === `${app}/git/libexec/git-core` && e.GIT_TEMPLATE_DIR && e.GIT_CONFIG_SYSTEM, JSON.stringify(e));
  check("dev checkout (no git/ or node/): nothing changes", Object.keys(bundledEnv(root, "darwin", { PATH: "/usr/bin" })).length === 0);
  fs.mkdirSync(path.join(app, "git", "clangarm64", "bin"), { recursive: true });
  const w = bundledEnv(app, "win32", { Path: "C:\\Windows" });
  check("Windows ARM bundle: clangarm64 git first on Path", w.Path.startsWith(path.join(app, "git", "clangarm64", "bin") + ";") && w.Path.endsWith(";C:\\Windows"), JSON.stringify(w));
}

// ---- launchd plist (macOS; printed only, never loaded) ----
if (process.platform === "darwin") {
  const sh = path.join(root, "scripts", "service.sh");
  const run = (env) => execFileSync("sh", [sh, "plist"], { env: { HOME: T, PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
  const p = run({ GWR_NODE: "/opt/a&b/node" });
  const f = path.join(T, "p.plist");
  fs.writeFileSync(f, p);
  const lint = spawnSync("plutil", ["-lint", "-s", f]);
  check("plist without tunnel is valid, uses the given Node, no tunnel keys", lint.status === 0 && p.includes("/opt/a&amp;b/node") && !p.includes("TUNNEL"), p);
  const q = run({ GWR_NODE: "/x/node", HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "127.0.0.1,localhost" });
  check("proxy settings go into the plist", q.includes("<key>HTTPS_PROXY</key><string>http://proxy:8080</string>") && q.includes("<key>NO_PROXY</key>"), q);
  const t = run({ GWR_NODE: "/x/node", TUNNEL_CLIENT: "/d/tunnel-client", TUNNEL_PROFILE: "p" });
  check("hand-set tunnel settings still work", t.includes("<key>TUNNEL_PROFILE</key><string>p</string>") && t.includes(`${T}/.gptworkrouter/tunnel-client/tunnel-client`), t);
}

// ---- install.sh against a fake release served locally (macOS) ----
if (process.platform === "darwin") {
  const { renderBootstrap } = await import("../installer/build-release.mjs");
  const http = await import("node:http");
  const crypto = await import("node:crypto");
  const B = path.join(T, "boot");
  const stage = path.join(B, "stage");
  fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
  fs.mkdirSync(path.join(stage, "installer"), { recursive: true });
  // Stand-in Node: records its arguments, exits with FAKE_EXIT.
  fs.writeFileSync(path.join(stage, "node", "bin", "node"), `#!/bin/sh\necho "$@" > "${B}/ran.txt"\nexit \${FAKE_EXIT:-0}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stage, "installer", "setup.mjs"), "");
  const rel = path.join(B, "srv", "releases", "9.9.9");
  fs.mkdirSync(rel, { recursive: true });
  const tgz = path.join(rel, `gptworkrouter-9.9.9-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`);
  execFileSync("tar", ["-czf", tgz, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const sum = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
  let hits = 0;
  const srv = http.createServer((req, res) => {
    const f = path.join(B, "srv", decodeURIComponent(req.url));
    hits++;
    if (!f.startsWith(path.join(B, "srv")) || !fs.existsSync(f)) return res.writeHead(404).end();
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tpl = fs.readFileSync(path.join(root, "installer", "install.sh"), "utf8");
  const boot = (sums, env = {}) => {
    const f = path.join(B, "install.sh");
    fs.writeFileSync(f, renderBootstrap(tpl, { version: "9.9.9", base, sums }));
    return new Promise((resolve) => {
      const p = spawn("sh", [f, "--answers", "x.json"], { env: { ...process.env, DATA_DIR: path.join(B, "data"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ code, out }));
    });
  };
  const appDir = path.join(B, "data", "app", "9.9.9");
  const wrong = await boot({ "darwin-arm64": "0".repeat(64), "darwin-x64": "0".repeat(64) });
  check("bootstrap: damaged download refused, nothing installed", wrong.code === 1 && /checksum mismatch/.test(wrong.out) && !fs.existsSync(appDir), wrong.out);
  const good = await boot({ "darwin-arm64": sum, "darwin-x64": sum });
  check("bootstrap: verified, unpacked, wizard started with its arguments", good.code === 0 && fs.existsSync(path.join(appDir, "installer", "setup.mjs")) && fs.readFileSync(path.join(B, "ran.txt"), "utf8").includes("setup.mjs --answers x.json"), good.out);
  const before = hits;
  const again = await boot({ "darwin-arm64": sum, "darwin-x64": sum }, { FAKE_EXIT: "1" });
  check("bootstrap: already installed, no new download, wizard's exit code passed on", again.code === 1 && hits === before, `${again.code} ${hits - before}`);
  const un = await boot({ "darwin-arm64": sum, "darwin-x64": sum }, { FAKE_EXIT: "3" });
  check("bootstrap: wizard exit 3 (uninstalled) removes the app folders", un.code === 0 && !fs.existsSync(path.join(B, "data", "app")), un.out);
  srv.close();
  const ps = renderBootstrap(fs.readFileSync(path.join(root, "installer", "install.ps1"), "utf8"), { version: "9.9.9", base, sums: { "win32-x64": "ab" } });
  check("install.ps1 filled in, never calls exit or npm", ps.includes("'9.9.9'") && ps.includes("'ab'") && !/@\w+@/.test(ps.replace("@args", "")) && !/\bexit\b/.test(ps.replace(/^#.*$/gm, "")) && !/\bnpm\b/.test(ps.replace(/^#.*$/gm, "")));
}

// ---- Wizard end to end: install, menu, uninstall (temp dirs, stand-in Codex, no login task) ----
if (!process.env.SSH_CONNECTION) {
  const W = path.join(T, "wiz");
  const codexHome = path.join(W, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const fake = path.join(here, "fixtures", "fake-codex-login.cjs");
  fs.chmodSync(fake, 0o755);
  const seed = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.browseros-neo]\nurl = "http://127.0.0.1:9/mcp" # closed port\n';
  fs.writeFileSync(path.join(codexHome, "config.toml"), seed);
  const PORT = 3292;
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: path.join(W, "data"), CODEX_HOME: codexHome, WORKSPACE_ROOT: path.join(W, "work"), CODEX_PATH: fake, GWR_TEST_NO_SERVICE: "1", NOTIFY: "0", RELAY_URL: "http://127.0.0.1:9", GWR_KEY_STORE: "file", GWR_NO_BROWSER: "1" };
  delete env.TUNNEL_CLIENT;
  delete env.TUNNEL_PROFILE;
  const bridge = spawn(process.execPath, [path.join(root, "server.mjs")], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const wizard = (answers) => {
    const f = path.join(W, "answers.json");
    fs.writeFileSync(f, JSON.stringify(answers));
    return spawnSync(process.execPath, [path.join(root, "installer", "setup.mjs"), "--answers", f], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  };
  const r1 = wizard({ access: "1", browser: "1", "apply-settings": "y", probe: "n", proxy: "" });
  const out1 = r1.stdout + r1.stderr;
  const cfg = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const t = parse(cfg);
  const state = JSON.parse(fs.readFileSync(path.join(W, "data", "installed.json"), "utf8"));
  check("wizard install finishes", r1.status === 0 && /Step 6 of 6/.test(out1), out1);
  check("wizard set Codex settings, kept the user's", t.sandbox_mode === "workspace-write" && t.approval_policy === "never" && t.model === "gpt-5" && cfg.startsWith("# my settings"), cfg);
  check("wizard picked BrowserOS neo and allowed it", state.browser === "browseros-neo" && t.mcp_servers["browseros-neo"].default_tools_approval_mode === "approve", JSON.stringify(state));
  check("wizard wrote the AGENTS.md browser line", fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8").includes("use the browseros-neo MCP server"));
  check("wizard self-check reports the closed browser port as FIX, the rest OK", /FIX {2}Browser \(browseros-neo\)/.test(out1) && /OK {3}Codex settings/.test(out1) && /OK {3}Codex signed in/.test(out1), out1);
  check("install state recorded with the config backup", state.version && state.configBackup && fs.readFileSync(state.configBackup, "utf8") === seed, JSON.stringify(state));
  const r2 = wizard({ menu: "6" });
  check("second run opens the menu", r2.status === 0 && /is installed/.test(r2.stdout), r2.stdout + r2.stderr);
  const r3 = wizard({ menu: "5", "uninstall-confirm": "y", "restore-config": "y", "delete-data": "n" });
  check("uninstall exits 3 so the bootstrap deletes app/", r3.status === 3, r3.stdout + r3.stderr);
  check("uninstall put the original Codex settings back", fs.readFileSync(path.join(codexHome, "config.toml"), "utf8") === seed);
  check("uninstall removed the AGENTS.md block and the install state", !fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8").includes("gptworkrouter") && !fs.existsSync(path.join(W, "data", "installed.json")));
  const r4 = wizard({ access: "1", browser: "1", "apply-settings": "y", probe: "n", proxy: "" });
  check("install again after uninstall works", r4.status === 0 && fs.existsSync(path.join(W, "data", "installed.json")), r4.stdout + r4.stderr);
  const again = (fakeLogin, answers) => {
    fs.writeFileSync(path.join(W, "answers.json"), JSON.stringify(answers));
    return spawnSync(process.execPath, [path.join(root, "installer", "setup.mjs"), "--answers", path.join(W, "answers.json")], { env: { ...env, FAKE_LOGIN: fakeLogin, DATA_DIR: path.join(W, `data-${fakeLogin}`) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  };
  const r5 = again("error", {});
  check("Codex that can't start: wizard stops with a clear message", r5.status === 1 && /Codex can't start/.test(r5.stderr), r5.stdout + r5.stderr);
  const r6 = again("apikey", { "switch-to-chatgpt": "n", access: "1", browser: "1", "apply-settings": "y", probe: "n", proxy: "" });
  check("Codex on an API key: wizard warns about API billing and lets the user keep it", r6.status === 0 && /billed to the API/.test(r6.stdout), r6.stdout + r6.stderr);
  bridge.kill();

  // Relay step against a stub that is both the relay (pairing) and the bridge's /health.
  const http = await import("node:http");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  let paired = false, polls = 0;
  const stub = http.createServer((req, res) => {
    const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.url === "/pair/start") return json({ pair_code: "WXYZ-4821", verify_url: "http://stub/pair?code=WXYZ-4821", device_code: "d", interval: 1, expires_in: 60 });
    if (req.url === "/pair/poll") return (paired = true), json({ status: "approved", machine_id: "m_1", account_email: "ali@example.com", mcp_url: "https://relay.test/mcp" });
    if (req.url === "/health") {
      if (paired) polls++;
      return json({ ok: true, version, codex: { sandbox: "workspace-write", approval: "never" }, undo: "ready", tunnel: "connected", relay: paired ? "connected" : "off", relay_chatgpt_grants: paired ? (polls > 3 ? 1 : 0) : null });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const sp = stub.address().port;
  const runAsync = (answers, extra) =>
    new Promise((resolve) => {
      const f = path.join(W, "answers-relay.json");
      fs.writeFileSync(f, JSON.stringify(answers));
      // stdin stays open: the "press Enter to skip" prompt must wait, not see end-of-input.
      const p = spawn(process.execPath, [path.join(root, "installer", "setup.mjs"), "--answers", f], { env: { ...env, PORT: String(sp), GWR_KEY_STORE: "file", GWR_NO_BROWSER: "1", GWR_CONNECT: "relay", ...extra }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => p.kill(), 90000);
      p.on("exit", (code) => (clearTimeout(timer), p.stdin.destroy(), resolve({ code, out })));
    });
  const base = { access: "1", browser: "1", "apply-settings": "y", probe: "n" };
  const rr = await runAsync(base, { DATA_DIR: path.join(W, "data-relay"), RELAY_URL: `http://127.0.0.1:${sp}` });
  check("relay step: code shown, paired, connected", rr.code === 0 && /Your code: {2}WXYZ-4821/.test(rr.out) && /Connected to the account ali@example\.com/.test(rr.out) && /\n {2}Connected\.\n/.test(rr.out), rr.out);
  check("relay step: ChatGPT steps with the mcp_url, then waits until linked", /URL: https:\/\/relay\.test\/mcp/.test(rr.out) && /ChatGPT is linked/.test(rr.out) && /OK {3}ChatGPT linked/.test(rr.out), rr.out);
  check("relay step: relay.json written by relay.mjs, not by the wizard", JSON.parse(fs.readFileSync(path.join(W, "data-relay", "relay.json"), "utf8")).mcp_url === "https://relay.test/mcp");
  paired = false; // a new machine: the stub's /health says the relay is off again
  const net = await runAsync({ ...base, proxy: "" }, { DATA_DIR: path.join(W, "data-net"), RELAY_URL: "http://127.0.0.1:9" });
  check("relay unreachable: firewall text, proxy asked, setup still finishes with a FIX", net.code === 0 && /only makes outgoing connections/.test(net.out) && /Does your network use a proxy/.test(net.out) && /Not connected to ChatGPT yet/.test(net.out) && /FIX {2}Connected to the relay/.test(net.out), net.out);
  // Tunnel step (v1): own OpenAI tunnel. Stand-in tunnel-client, temp profile dir, key from the
  // environment (so the real Keychain is never read or written).
  const profDir = path.join(W, "tc-profiles");
  const tenv = { GWR_CONNECT: "tunnel", GWR_TUNNEL_CLIENT: fake, TUNNEL_CLIENT_PROFILE_DIR: profDir, CONTROL_PLANE_API_KEY: "test-not-a-key" };
  const tun = await runAsync({ ...base, "tunnel-id": "tunnel_abc123", "keep-key": "y" }, { DATA_DIR: path.join(W, "data-tunnel"), ...tenv });
  const prof = fs.existsSync(path.join(profDir, "gptworkrouter.yaml")) ? fs.readFileSync(path.join(profDir, "gptworkrouter.yaml"), "utf8") : "";
  check("tunnel step: OpenAI steps shown, profile written with the tunnel ID, no key in it", tun.code === 0 && /settings\/organization\/tunnels/.test(tun.out) && prof.includes('tunnel_id: "tunnel_abc123"') && prof.includes('api_key: "env:CONTROL_PLANE_API_KEY"') && prof.includes(`127.0.0.1:${sp}/mcp`) && !prof.includes("test-not-a-key"), tun.out + prof);
  check("tunnel step: connected, ChatGPT steps, self-check OK", /Connection: Tunnel/.test(tun.out) && /OK {3}Tunnel to ChatGPT connected/.test(tun.out), tun.out);
  const tstate = JSON.parse(fs.readFileSync(path.join(W, "data-tunnel", "installed.json"), "utf8"));
  check("tunnel recorded in the install state", tstate.connect === "tunnel" && tstate.tunnel?.id === "tunnel_abc123", JSON.stringify(tstate));
  const bad = await runAsync({ ...base, "tunnel-id": "not-an-id" }, { DATA_DIR: path.join(W, "data-tunnel-bad"), ...tenv });
  check("tunnel step: a wrong ID is refused, setup still finishes", bad.code === 0 && /isn't a tunnel ID/.test(bad.out), bad.out);
  const tun2 = await runAsync({ menu: "5", "uninstall-confirm": "y", "restore-config": "n", "delete-data": "n", "delete-key": "n" }, { DATA_DIR: path.join(W, "data-tunnel"), ...tenv });
  check("uninstall removes the tunnel profile", tun2.code === 3 && !fs.existsSync(path.join(profDir, "gptworkrouter.yaml")), tun2.out);
  stub.close();
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
