// GPTWorkRouter setup wizard (macOS + Windows). Started by install.sh / install.ps1 with
// the bundled Node; run again from the same one-line command to repair, update or uninstall.
//   node installer/setup.mjs [--answers answers.json]
// --answers: {"question-id": "answer"} for unattended test runs; anything not in it is asked.
// Exit codes: 0 done, 1 stopped with a problem, 3 uninstalled (the bootstrap then deletes app/).
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { config } from "../lib/config.mjs";
import { redact } from "../lib/redact.mjs";
import { planEdits, applyEdits, describe, writeWithBackup } from "./codex-config.mjs";
import { findBrowsers, browserOSInstalled, setBrowserBlock } from "./browser.mjs";
import { KEY_NAME, winKeyFile } from "../lib/desktop.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).version;
const WIN = process.platform === "win32";
const DATA = config.dataDir;
const STATE = path.join(DATA, "installed.json");
const CODEX_JS = path.join(APP, "node_modules", "@openai", "codex", "bin", "codex.js");
const CONFIG = path.join(config.codexHome, "config.toml");
const AGENTS = path.join(config.codexHome, "AGENTS.md");
const HEALTH = `http://127.0.0.1:${config.port}/health`;
const LOG = WIN ? path.join(process.env.LOCALAPPDATA || os.homedir(), "gptworkrouter", "gptworkrouter.log") : path.join(os.homedir(), "Library", "Logs", "gptworkrouter.log");
const HAS_RELAY = fs.existsSync(path.join(APP, "scripts", "relay.mjs"));

// ---- Prompts ----
const argAnswers = process.argv.indexOf("--answers");
const ANSWERS = argAnswers > 0 ? JSON.parse(fs.readFileSync(process.argv[argAnswers + 1], "utf8")) : {};
let rl;
const say = (s = "") => console.log(s);
async function ask(id, question, def = "", signal) {
  if (id in ANSWERS) {
    say(`${question} ${ANSWERS[id]}`);
    return String(ANSWERS[id]);
  }
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} `, signal ? { signal } : {})).trim();
  return a || def;
}
const yes = async (id, q, def = true) => /^y/i.test(await ask(id, `${q} (${def ? "Y/n" : "y/N"})`, def ? "y" : "n"));
async function choose(id, q, options, def = 0) {
  say(q);
  options.forEach((o, i) => say(`  ${i + 1}) ${o}${i === def ? "  (press Enter for this)" : ""}`));
  for (;;) {
    const n = Number(await ask(id, ">", String(def + 1)));
    if (n >= 1 && n <= options.length) return n - 1;
    if (id in ANSWERS) throw new Error(`answer for ${id} is not a choice`);
  }
}
const pause = (id, q = "Press Enter when done.") => ask(id, q);
const step = (n, title) => n && say(`\n— Step ${n} of 6: ${title}`);
class Stop extends Error {}
const stop = (msg) => {
  throw new Stop(msg);
};

// ---- Helpers ----
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
};
const saveState = (s) => {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
};
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
// CODEX_PATH (as for the bridge) points at another Codex; the offline test uses a stand-in.
const codex = (args, opts = {}) =>
  config.codexPath ? spawnSync(config.codexPath, args, { encoding: "utf8", ...opts }) : spawnSync(process.execPath, [CODEX_JS, ...args], { encoding: "utf8", ...opts });
// ponytail: test seam so the offline test never touches the real login task.
const service = (cmd, node = process.execPath, app = APP) =>
  process.env.GWR_TEST_NO_SERVICE === "1" ? { status: 0 } : spawnSync(node, [path.join(app, "scripts", "service.mjs"), cmd], { stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function health(url = HEALTH) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch {
    return null;
  }
}
async function waitHealth(version, seconds = 30, url = HEALTH) {
  for (let i = 0; i < seconds; i++) {
    const h = await health(url);
    if (h?.ok && (!version || h.version === version)) return h;
    await sleep(1000);
  }
  return null;
}
const portFree = (port) =>
  new Promise((r) => {
    const s = net.createServer().once("error", () => r(false)).listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
function openFile(f) {
  if (WIN) spawn("notepad.exe", [f], { detached: true, stdio: "ignore" }).unref();
  else spawn("open", ["-e", f], { detached: true, stdio: "ignore" }).unref();
}
// Servers Codex refuses under approval "never" (same rule as codexPermissions() in lib/tasks.mjs).
const needsApproval = (toml) =>
  Object.entries(toml.mcp_servers && typeof toml.mcp_servers === "object" ? toml.mcp_servers : {})
    .filter(([, s]) => s?.enabled !== false && s?.default_tools_approval_mode !== "approve")
    .filter(([, s]) => !Object.values(s?.tools ?? {}).some((t) => t?.approval_mode === "approve"))
    .map(([n]) => n);

// ---- 1. Checks ----
async function checks() {
  step(1, "checking this computer");
  if (!["darwin", "win32"].includes(process.platform)) stop("GPTWorkRouter runs on macOS and Windows for now.");
  if (WIN) {
    if (Number(os.release().split(".")[2]) < 22000) stop("GPTWorkRouter needs Windows 11.");
    if (process.env.SSH_CONNECTION) stop("Run this in PowerShell on your desktop, not over SSH: Codex's sandbox needs your desktop.");
  } else {
    const v = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim();
    if (Number(v.split(".")[0]) < 13) stop(`GPTWorkRouter needs macOS 13 or newer (this Mac has ${v}).`);
  }
  const h = await health();
  if (h?.version) say(`  GPTWorkRouter ${h.version} is running here; it will be replaced.`);
  else if (!(await portFree(config.port))) stop(`Another app is using port ${config.port}. Close it, then run this again.`);
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const s = fs.statfsSync(DATA);
  if (s.bavail * s.bsize < 1e9) stop("Less than 1 GB of disk space is free. Free some space, then run this again.");
  say("  OK");
}

// ---- 2. Codex sign-in ----
function loginStatus() {
  const r = codex(["login", "status"]);
  const out = `${r.stdout}${r.stderr}`.trim();
  return { kind: /using ChatGPT/i.test(out) ? "chatgpt" : /API key/i.test(out) ? "apikey" : /Not logged in/i.test(out) ? "none" : "error", out };
}
async function signIn(n = 2) {
  step(n, "signing in to Codex");
  let s = loginStatus();
  if (s.kind === "chatgpt") return say("  Already signed in with ChatGPT.");
  if (s.kind === "error") stop(`Codex can't start: ${s.out.split("\n")[0]}\nCheck ${CONFIG}, then run this again.`);
  if (s.kind === "apikey") {
    say("  Codex is signed in with an OpenAI API key, so tasks would be billed to the API, not your ChatGPT plan.");
    if (!(await yes("switch-to-chatgpt", "  Sign in with your ChatGPT account instead?"))) return;
    codex(["logout"], { stdio: "inherit" });
  }
  say("  Codex tasks use your ChatGPT plan's Codex allowance. Free and Go plans allow only a little;");
  say("  Plus or higher is better for regular use.");
  say("  Your browser will open. Sign in with your own ChatGPT account, then come back here.");
  let r = codex(["login"], { stdio: "inherit" });
  if (r.status !== 0 && (await yes("device-login", "  Didn't work? Try with a code you type on a web page instead?"))) r = codex(["login", "--device-auth"], { stdio: "inherit" });
  s = loginStatus();
  if (s.kind !== "chatgpt") stop("Codex is not signed in with ChatGPT. Run this again to retry.");
  say("  Signed in.");
}

// ---- 3. Codex settings and browser ----
async function settings(n = 3, { state = readState() ?? {}, quiet = false, askAccess = true, askBrowser = true } = {}) {
  step(n, "Codex settings");
  for (;;) {
    const text = readText(CONFIG);
    let toml;
    try {
      toml = parse(text.replace(/^﻿/, ""));
    } catch (err) {
      say(`  Codex's settings file can't be read: ${err.message.split("\n")[0]}`);
      say(`  File: ${CONFIG}`);
      openFile(CONFIG);
      await pause("config-fixed", "  Fix it (or delete the file), then press Enter.");
      continue;
    }
    // Access level: sandboxed by default, also over an existing full access (decided 17 Nov).
    let access = toml.sandbox_mode === "danger-full-access" ? "full" : "sandboxed";
    if (askAccess) {
      const i = await choose("access", "  How much may Codex tasks do on this computer?", [
        "Sandboxed: tasks change files only in their own folder, no internet unless you approve (recommended)",
        "Full access: no sandbox, tasks can change anything your account can",
      ]);
      access = i === 1 ? "full" : "sandboxed";
    }
    // Browser for tasks: BrowserOS neo by default.
    let browser = state.browser ?? null;
    if (askBrowser) {
      const found = findBrowsers(toml);
      if (!found.some((b) => b.browseros) && browserOSInstalled()) {
        say("  BrowserOS is installed but not connected to Codex. In BrowserOS open Connected agents and click Connect next to Codex.");
        if (await yes("browseros-connect", "  Connect it now? (press Enter when done, or n to skip)")) continue; // re-read the config
      }
      if (found.length) {
        const i = await choose("browser", "  Which browser should tasks use?", [...found.map((b) => b.label), "None"]);
        browser = found[i]?.name ?? null;
      } else {
        say("  No browser for Codex found. Browser tasks work best with BrowserOS neo (browseros.com); add it later with \"Change browser\".");
        browser = null;
      }
    }
    let approve = browser ? [browser] : [];
    const others = needsApproval(toml).filter((s) => s !== browser);
    if (askBrowser && others.length && (await yes("approve-apps", `  Let tasks also use these apps: ${others.join(", ")}?`))) approve.push(...others);
    approve = approve.filter((s) => needsApproval(toml).includes(s));

    const r = applyEdits(text, planEdits(toml, { access, approve }));
    if (r.manual) {
      say(`  I can't change the settings file safely (${r.reason}). Please add these lines yourself:`);
      r.manual.forEach((l) => say(`    ${l}`));
      say(`  File: ${CONFIG}`);
      openFile(CONFIG);
      await pause("config-manual", "  Save the file, then press Enter to check again.");
      continue;
    }
    const agentsOld = readText(AGENTS);
    const agentsNew = askBrowser ? setBrowserBlock(agentsOld, browser) : agentsOld;
    if (!r.changes.length && agentsNew === agentsOld) {
      if (!quiet) say("  Codex settings: already fine.");
      return { ...state, browser };
    }
    say(`  These changes will be made to ${CONFIG}:`);
    if (r.changes.length) say(describe(r.changes));
    if (agentsNew !== agentsOld) say(`  and in ${AGENTS}:\n  + ${browser ? `For browser work, use the ${browser} MCP server.` : "(the GPTWorkRouter browser line removed)"}`);
    if (!(await yes("apply-settings", "  Apply these changes?"))) stop("Nothing was changed. Run this again when you're ready.");
    let next = { ...state, browser };
    if (r.changes.length) {
      const backup = writeWithBackup(CONFIG, r.text);
      // Codex loads its config for `login status`, so a config it rejects shows up here.
      const s = loginStatus();
      if (s.kind === "error") {
        if (backup) fs.copyFileSync(backup, CONFIG);
        else fs.rmSync(CONFIG, { force: true });
        stop(`Codex rejected the new settings, so the old file was put back. Codex said: ${s.out.split("\n")[0]}`);
      }
      next = {
        ...next,
        configFile: CONFIG,
        configBackup: "configBackup" in state ? state.configBackup : backup, // the first backup holds the user's original
        configHash: sha(r.text),
        configChanges: [state.configChanges, describe(r.changes)].filter(Boolean).join("\n"),
      };
      say(backup ? `  Saved. Old file kept as ${backup}` : "  Saved.");
    }
    if (agentsNew !== agentsOld) writeWithBackup(AGENTS, agentsNew);
    return next;
  }
}

// ---- 4. Start at login ----
async function startAtLogin(n = 4, app = APP, node = process.execPath, version = VERSION) {
  step(n, "start at every login");
  if (service("install", node, app).status !== 0) return false;
  const h = await waitHealth(version, 30);
  if (h && n) say("  Running.");
  return !!h;
}

// ---- 5. Connect to ChatGPT (relay; contract: docs/plan-relay.md section 11) ----
const FIREWALL = `  GPTWorkRouter only makes outgoing connections, to ${new URL(config.relayUrl).host} on port 443 (secure web and WebSocket).\n  If your network blocks it, ask IT to allow that address, or enter your company's proxy address below.`;
// A relay problem never undoes the rest of setup: say so, and the self-check shows it as FIX.
const notConnected = (next) => say(`  Not connected to ChatGPT yet. ${next}`);
const applyProxy = (proxy) => proxy && Object.assign(process.env, proxy); // the login task picks these up at install

// `relay.mjs pair --json`: one JSON line per event. It writes relay.json and the key itself; we never do.
function runPair() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(APP, "scripts", "relay.mjs"), "pair", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    const res = { reason: null, mcpUrl: null };
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        let e;
        try {
          e = JSON.parse(buf.slice(0, i));
        } catch {}
        buf = buf.slice(i + 1);
        if (e?.event === "code") {
          say(`\n  Your code:  ${e.code}`);
          say(`  Your browser opens ${e.verify_url}`);
          say("  Sign in there, check the code matches, then click Connect. (The code works for 10 minutes.)");
        } else if (e?.event === "paired") {
          res.mcpUrl = e.mcp_url;
          say(`  Connected to the account ${e.account}.`);
        } else if (e?.event === "error") res.reason = e.reason;
      }
    });
    p.on("exit", (code) => resolve({ ...res, code }));
  });
}

// ---- 5. Connect to ChatGPT ----
// v1 (decided 17 Nov): each user's own OpenAI Secure MCP Tunnel. The hosted relay stays for
// later and is used only with GWR_CONNECT=relay.
const connect = (n = 5, state = readState() ?? {}) => (process.env.GWR_CONNECT === "relay" ? relayConnect(n, state) : tunnelConnect(n, state));

const TUNNEL_PROFILE = "gptworkrouter";
// The release bundles OpenAI's tunnel-client (the cloudflared build: one `run` command, no `init`).
const tunnelBin = () => process.env.GWR_TUNNEL_CLIENT || path.join(APP, "tunnel-client", `tunnel-client-runtime-cloudflared${WIN ? ".exe" : ""}`);
// tunnel-client's default profile dir (seen in the VM test): %APPDATA% on Windows, XDG/~/.config on macOS.
const profileDir = () => process.env.TUNNEL_CLIENT_PROFILE_DIR || path.join(WIN ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tunnel-client");
const keyUser = os.userInfo().username;
// Where the bridge reads the key (lib/tunnel.mjs, lib/desktop.mjs): Keychain item or DPAPI file.
const keySaved = () =>
  !!process.env.CONTROL_PLANE_API_KEY ||
  (WIN ? fs.existsSync(winKeyFile(DATA)) : spawnSync("security", ["find-generic-password", "-a", keyUser, "-s", KEY_NAME], { stdio: "ignore" }).status === 0);
// The user types the key into the OS's own prompt; the wizard never sees it.
// Read a line without echo, straight from the terminal (Ctrl-C gives "").
async function askHidden(question) {
  rl?.close();
  rl = undefined;
  const { stdin } = process;
  process.stdout.write(`${question} `);
  stdin.setRawMode?.(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  try {
    return await new Promise((resolve) => {
      let s = "";
      const on = (chunk) => {
        for (const c of chunk) {
          if (c === "\r" || c === "\n" || c === "\u0003") return stdin.off("data", on), resolve(c === "\u0003" ? "" : s.trim());
          if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
          else if (c >= " ") s += c;
        }
      };
      stdin.on("data", on);
    });
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
    process.stdout.write("\n");
  }
}

async function saveKey() {
  if (WIN) {
    const script = "New-Item -ItemType Directory -Force $env:GWR_DIR | Out-Null; Read-Host -AsSecureString 'Tunnel key' | ConvertFrom-SecureString | Set-Content -LiteralPath $env:GWR_FILE";
    return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "inherit", env: { ...process.env, GWR_DIR: DATA, GWR_FILE: winKeyFile(DATA) } }).status === 0;
  }
  // Not `security add-generic-password -w` with its own prompt: that silently keeps only the first
  // 128 characters, and sk-proj keys are longer (found on the Mac). `security -i` reads the command
  // from stdin, so the key isn't in any process's arguments; read it back to be sure it was kept whole.
  const key = await askHidden("  Tunnel key:");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) return say("  That doesn't look like an OpenAI key."), false;
  spawnSync("security", ["-i"], { input: `add-generic-password -U -a "${keyUser}" -s "${KEY_NAME}" -w "${key}"\n`, stdio: ["pipe", "ignore", "inherit"] });
  const back = spawnSync("security", ["find-generic-password", "-a", keyUser, "-s", KEY_NAME, "-w"], { encoding: "utf8" }).stdout?.trim();
  return back === key;
}
function forgetKey() {
  if (process.env.CONTROL_PLANE_API_KEY) return; // not ours to delete
  if (WIN) fs.rmSync(winKeyFile(DATA), { force: true });
  else spawnSync("security", ["delete-generic-password", "-a", keyUser, "-s", KEY_NAME], { stdio: "ignore" });
}
// Same shape as a hand-made profile in daily use, no OAuth: the tunnel is reachable only from the user's own OpenAI org.
const profileYaml = (tunnelId) =>
  [
    "# Written by GPTWorkRouter setup. The key is not in this file: the bridge passes it in CONTROL_PLANE_API_KEY.",
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${tunnelId}"`,
    '  api_key: "env:CONTROL_PLANE_API_KEY"',
    "health:",
    '  listen_addr: "127.0.0.1:0"',
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "http://127.0.0.1:${config.port}/mcp"`,
    "",
  ].join("\n");
// The login task gets TUNNEL_CLIENT/TUNNEL_PROFILE from the environment at install.
const applyTunnel = (state) => state?.tunnel && Object.assign(process.env, { TUNNEL_CLIENT: tunnelBin(), TUNNEL_PROFILE: TUNNEL_PROFILE });

async function tunnelConnect(n = 5, state = readState() ?? {}) {
  step(n, "connect to ChatGPT");
  if (!fs.existsSync(tunnelBin())) return notConnected("tunnel-client is missing from this install: run the install command again."), state;
  let h = await health();
  const keep = state.tunnel && h?.tunnel === "connected" && (await yes("keep-tunnel", "  The tunnel to ChatGPT is already connected. Keep it?"));
  if (!keep) {
    say("  ChatGPT reaches this computer through your own OpenAI tunnel (free). On platform.openai.com, signed in with");
    say("  your OpenAI account (a personal account works):");
    say("  1. Open https://platform.openai.com/settings/organization/tunnels , click Create, name it GPTWorkRouter,");
    say("     and copy its ID (it starts with tunnel_).");
    say("  2. Open https://platform.openai.com/settings/organization/api-keys , create a new secret key, choose");
    say("     Restricted, set Tunnels to Read and Use (everything else None), and copy it.");
    let tunnelId;
    for (;;) {
      tunnelId = (await ask("tunnel-id", "  Paste the tunnel ID:")).trim();
      if (/^tunnel_[A-Za-z0-9]+$/.test(tunnelId)) break;
      if ("tunnel-id" in ANSWERS) return notConnected("That isn't a tunnel ID."), state;
      say("  That doesn't look like a tunnel ID (it starts with tunnel_). Try again.");
    }
    if (!keySaved() || !(await yes("keep-key", "  A tunnel key is already saved on this computer. Keep it?"))) {
      say("  Paste the key at the prompt below (it won't show), then press Enter.");
      if (!(await saveKey()) || !keySaved()) return notConnected("The key wasn't saved. Run the same command again and choose Check and repair."), state;
      say("  Key saved in your " + (WIN ? "Windows account (encrypted)." : "Keychain."));
    }
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(path.join(profileDir(), `${TUNNEL_PROFILE}.yaml`), profileYaml(tunnelId), { mode: 0o600 });
    state = { ...state, connect: "tunnel", tunnel: { id: tunnelId, profile: TUNNEL_PROFILE } };
    applyTunnel(state);
    if (!(await startAtLogin(0))) return notConnected(`GPTWorkRouter didn't restart. The log is at ${LOG}.`), state;
  }
  say("  Connecting the tunnel…");
  for (let i = 0; i < 60 && (h = await health())?.tunnel !== "connected"; i++) await sleep(1000);
  const ts = h?.tunnel ?? "not answering";
  if (ts !== "connected") {
    if (ts === "missing tunnel key") notConnected("The tunnel key wasn't found. Choose Check and repair to enter it again.");
    else if (/^key/.test(ts)) notConnected(`OpenAI says: ${ts}. Make a new restricted key with Tunnels Read and Use, then choose Check and repair and don't keep the saved key.`);
    else notConnected(`The tunnel says "${ts}". Check the tunnel ID and that the key has Tunnels Read and Use, then choose Check and repair. The log is at ${LOG}.`);
    return state;
  }
  say("  Connected.");
  say("\n  Now add GPTWorkRouter to ChatGPT (chatgpt.com, on the web):");
  say("  1. Settings > Security and login > turn on Developer mode.");
  say("  2. Plugins > + > Add custom MCP server. Connection: Tunnel, pick GPTWorkRouter. Authentication: No authentication.");
  say("     Create it as a plugin.");
  say('  3. Try it in a new chat: "Use GPTWorkRouter to create hello.txt in my work area saying hi."');
  return state;
}

async function relayConnect(n = 5, state = readState() ?? {}) {
  step(n, "connect to ChatGPT");
  if (!HAS_RELAY) return say("  Not in this version yet; skipped."), state;
  let h = await health();
  let mcpUrl = null;
  try {
    mcpUrl = JSON.parse(fs.readFileSync(path.join(DATA, "relay.json"), "utf8")).mcp_url;
  } catch {}
  const keep = mcpUrl && h?.relay === "connected" && (await yes("keep-relay", "  This computer is already connected. Keep that connection?"));
  if (!keep) {
    for (;;) {
      const r = await runPair();
      if (r.code === 0) {
        mcpUrl = r.mcpUrl ?? mcpUrl;
        break;
      }
      if (r.code === 2 || r.reason === "expired") {
        await pause("pair-again", "  The code ran out. Press Enter for a new one.");
        continue;
      }
      if (r.reason === "denied") {
        if (await yes("pair-retry", "  You clicked Cancel in the browser. Try again?")) continue;
        return notConnected("Run the same command again when you're ready, and choose Check and repair."), state;
      }
      if (r.reason === "network") {
        say("  Can't reach the GPTWorkRouter relay. Check your internet connection.");
        say(FIREWALL);
        const proxy = await ask("proxy", "  Does your network use a proxy? Enter its address (like http://proxy:8080), or press Enter for none:");
        if (!proxy) return notConnected("Check the internet connection, then run the same command again and choose Check and repair."), state;
        const ca = await ask("proxy-ca", "  If your company gave you a root certificate file (.pem), enter its path, or press Enter for none:");
        state = { ...state, proxy: { HTTPS_PROXY: proxy, NO_PROXY: "127.0.0.1,localhost", ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}) } };
        applyProxy(state.proxy);
        continue;
      }
      return notConnected(`(${r.reason ?? `exit ${r.code}`}) Run the same command again, or choose "Make a support file".`), state;
    }
    // A new proxy must reach the login task's environment: reinstall it. Otherwise a restart is enough.
    if (state.proxy) await startAtLogin(0);
    else service("restart");
  }
  say("  Connecting…");
  for (let i = 0; i < 30 && (h = await health())?.relay !== "connected"; i++) await sleep(1000);
  const rs = h?.relay ?? "not answering";
  if (rs !== "connected") {
    if (/^(revoked|key_missing)$/.test(rs)) say("  This computer was unlinked. Run the same command again and choose Check and repair to connect again.");
    else if (rs === "update_required") say("  This version is too old for the relay. Run the same command again to update.");
    else say(`  Not connected yet (${rs}). It keeps trying in the background.`);
    return state;
  }
  say("  Connected.");
  // Show the ChatGPT steps, then wait for the grant count to go up (relay section 11 step 6).
  const start = h.relay_chatgpt_grants ?? 0;
  if (start >= 1) return say("  ChatGPT is already linked."), state;
  say("\n  Now add GPTWorkRouter to ChatGPT:");
  say("  1. On chatgpt.com: Settings > Security and login (or Apps) > turn on Developer mode.");
  say("  2. Plugins > + > Add custom MCP server.");
  say(`  3. URL: ${mcpUrl}   Authentication: OAuth. Create.`);
  say("  4. Sign in with the same account you used in the browser a moment ago, and click Allow.");
  const ac = new AbortController();
  const skipped = ask("chatgpt-skip", "\n  Waiting for ChatGPT… (press Enter to skip and finish later)", "", ac.signal).then(() => true, () => false);
  let linked = false;
  const deadline = Date.now() + 15 * 60000;
  while (!linked && Date.now() < deadline) {
    if (await Promise.race([skipped, sleep(2000).then(() => false)])) break;
    linked = ((await health())?.relay_chatgpt_grants ?? 0) > start;
  }
  ac.abort();
  say(linked ? '  ChatGPT is linked. Try it in a new chat: "Use GPTWorkRouter to create hello.txt in my work area saying hi."' : "  You can finish the ChatGPT steps later; they stay above.");
  return state;
}

// ---- 6. Self-check ----
async function rpc(method, params, id) {
  const res = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}
// One tiny real Codex task through the bridge: proves sign-in, sandbox and desktop session together.
async function sandboxProbe() {
  const folder = path.join(config.workspaceRoot, "gwr-setup-check");
  fs.rmSync(folder, { recursive: true, force: true });
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "gwr-setup", version: VERSION } }, 1);
  const tool = async (name, args, id) => {
    const r = await rpc("tools/call", { name, arguments: args }, id);
    return r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? "{}");
  };
  let t = await tool("start_task", { folder: "gwr-setup-check", brief: "Create a file named ok.txt containing the word ok. Do nothing else." }, 2);
  for (let i = 0; i < 6 && t.task_id && ["running", "queued"].includes(t.status); i++) t = await tool("check_task", { task_id: t.task_id, wait_seconds: 30 }, 3 + i);
  const ok = readText(path.join(folder, "ok.txt")).trim().toLowerCase().startsWith("ok");
  fs.rmSync(folder, { recursive: true, force: true });
  if (ok) return { ok };
  const why = `${t.error ?? ""} ${t.result ?? ""} ${(t.recent_activity ?? []).join(" ")}`;
  return {
    ok,
    why: /0xC0000142/i.test(why)
      ? "Codex's sandbox needs your desktop session. Run setup from PowerShell on your desktop, not over SSH."
      : /blocked by policy/i.test(why)
        ? "Codex's sandbox refused to run. On Windows this needs a recent Windows 11: install Windows updates, then choose Check and repair."
        : /usage limit|rate limit/i.test(why)
          ? "Your Codex allowance is used up for now. Try again later."
          : `The test task ended as ${t.status ?? "unknown"}. ${redact(t.error ?? "").slice(0, 200)}`,
  };
}
async function selfCheck(n = 6, state = readState() ?? {}) {
  step(n, "checking everything works");
  const h = await health();
  const res = [];
  const add = (name, ok, fix) => res.push({ name, ok, fix });
  add("GPTWorkRouter is running", !!h?.ok, `Choose Check and repair to restart it. The log is at ${LOG}`);
  if (h?.ok) {
    add(`Version ${VERSION}`, h.version === VERSION, "Choose Check and repair to restart it.");
    add("Codex settings", ["workspace-write", "danger-full-access"].includes(h.codex?.sandbox) && h.codex?.approval === "never", "Choose Check and repair to fix Codex settings.");
    if (WIN) add("Windows sandbox (mxc)", h.codex?.windows_sandbox === "mxc" || h.codex?.sandbox === "danger-full-access", "Choose Check and repair to fix Codex settings.");
    add("Undo ready", h.undo === "ready", "Run the install command again: the bundled Git is missing.");
    if (state.tunnel) add("Tunnel to ChatGPT connected", h.tunnel === "connected", h.tunnel === "missing tunnel key" ? "Choose Check and repair to enter the tunnel key again." : /^key/.test(h.tunnel) ? `OpenAI says: ${h.tunnel}. Choose Check and repair, and enter a new key (don't keep the saved one).` : `Choose Check and repair. The tunnel says "${h.tunnel}".`);
    if (HAS_RELAY && "relay" in h && (process.env.GWR_CONNECT === "relay" || fs.existsSync(path.join(DATA, "relay.json")))) {
      add("Connected to the relay", h.relay === "connected", h.relay === "update_required" ? "Run the install command again to update." : "Choose Check and repair to connect again.");
      if (h.relay === "connected") add("ChatGPT linked", (h.relay_chatgpt_grants ?? 0) >= 1, "Add GPTWorkRouter in ChatGPT: choose Check and repair to see the steps again.");
    }
  }
  add("Codex signed in with ChatGPT", loginStatus().kind === "chatgpt", "Choose Check and repair to sign in again.");
  if (state.browser) {
    let toml = {};
    try {
      toml = parse(readText(CONFIG).replace(/^﻿/, ""));
    } catch {}
    const s = toml.mcp_servers?.[state.browser];
    let up = !!s && s.enabled !== false;
    if (up && typeof s.url === "string") up = await fetch(s.url, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
    add(`Browser (${state.browser})`, up, /browseros/i.test(state.browser) ? "Open BrowserOS, then check again." : "Choose Change browser.");
  }
  if (h?.ok && (await yes("probe", "  Run one small real task to check Codex works? It uses a few seconds of your Codex allowance."))) {
    say("  Running a test task (up to 3 minutes)…");
    const p = await sandboxProbe().catch((err) => ({ ok: false, why: err.message }));
    add("A real Codex task works", p.ok, p.why);
  }
  for (const r of res) say(`  ${r.ok ? "OK " : "FIX"}  ${r.name}${r.ok ? "" : `\n        ${r.fix}`}`);
  return res;
}

// ---- Support file ----
async function supportFile(checksRes) {
  const desk = path.join(os.homedir(), "Desktop");
  const f = path.join(fs.existsSync(desk) ? desk : os.homedir(), `gptworkrouter-support-${new Date().toISOString().slice(0, 10)}.txt`);
  const text = [
    `GPTWorkRouter support file, ${new Date().toISOString()}`,
    `version ${VERSION}, ${process.platform} ${os.release()} ${process.arch}, node ${process.version}`,
    "", "== health", JSON.stringify(await health(), null, 2),
    "", "== self-check", ...checksRes.map((r) => `${r.ok ? "OK " : "FIX"} ${r.name}`),
    "", "== last 200 log lines", readText(LOG).split("\n").slice(-200).join("\n"),
  ].join("\n");
  fs.writeFileSync(f, redact(text));
  say(`  Saved ${f}. Send it to the person who set this up for you. Secrets are masked.`);
}

// ---- Uninstall ----
async function uninstall() {
  if (!(await yes("uninstall-confirm", "Remove GPTWorkRouter from this computer?", false))) return 0;
  const state = readState() ?? {};
  if (HAS_RELAY && fs.existsSync(path.join(DATA, "relay.json"))) {
    const r = spawnSync(process.execPath, [path.join(APP, "scripts", "relay.mjs"), "unpair"], { stdio: "inherit" });
    if (r.status !== 0) say("  Couldn't reach the relay. You can also click Unlink computer on your relay account page.");
  }
  service("uninstall");
  if (state.tunnel) {
    fs.rmSync(path.join(profileDir(), `${TUNNEL_PROFILE}.yaml`), { force: true });
    if (await yes("delete-key", "Also delete the saved tunnel key from this computer?")) forgetKey();
    say("You can also delete the tunnel and its key on platform.openai.com.");
  }
  // Codex settings: put the original back only if nobody changed the file since we wrote it.
  if (state.configHash && sha(readText(CONFIG)) === state.configHash) {
    if (await yes("restore-config", "Put Codex's settings back the way they were before GPTWorkRouter?")) {
      if (state.configBackup && fs.existsSync(state.configBackup)) fs.copyFileSync(state.configBackup, CONFIG);
      else fs.rmSync(CONFIG, { force: true });
    }
  } else if (state.configChanges) say(`Codex's settings were changed since setup, so they stay. GPTWorkRouter had added:\n${state.configChanges}`);
  const agents = readText(AGENTS);
  if (agents && setBrowserBlock(agents, null) !== agents) writeWithBackup(AGENTS, setBrowserBlock(agents, null));
  if (await yes("delete-data", "Also delete task history, undo data and the audit log?", false))
    for (const e of fs.readdirSync(DATA)) if (e !== "app") fs.rmSync(path.join(DATA, e), { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  say("\nRemoved. In ChatGPT, open Settings > Plugins and remove GPTWorkRouter there too.");
  say("Your Codex sign-in stays; it belongs to your ChatGPT account.");
  return 3;
}

// ---- Install, update, menu ----
function cleanupVersions(keep) {
  const dir = path.join(DATA, "app");
  if (!fs.existsSync(dir) || !APP.startsWith(dir)) return; // only for installed bundles, never a dev checkout
  for (const v of fs.readdirSync(dir)) if (!keep.includes(v)) fs.rmSync(path.join(dir, v), { recursive: true, force: true });
}
const record = (state) => saveState({ ...state, version: VERSION, app: APP, node: process.execPath, installedAt: new Date().toISOString() });

async function install() {
  say(`GPTWorkRouter ${VERSION} setup. It lets ChatGPT hand tasks to Codex on this computer.`);
  await checks();
  await signIn();
  const state = await settings();
  if (!(await startAtLogin())) stop(`GPTWorkRouter didn't start. The log is at ${LOG}. Run the install command again.`);
  record(state);
  const connected = await connect(5, state);
  record(connected);
  const res = await selfCheck(6, connected);
  cleanupVersions([VERSION]);
  say(res.every((r) => r.ok) ? "\nAll set." : '\nSome checks need attention (see FIX above). Run the same command again and choose "Check and repair".');
  return 0;
}

async function update(old) {
  say(`Updating GPTWorkRouter from ${old.version} to ${VERSION}.`);
  // Smoke test on a spare port with an empty data folder: no relay.json there, so the relay stays off.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-update-"));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATA_DIR: tmp };
  delete env.TUNNEL_CLIENT;
  delete env.TUNNEL_PROFILE;
  const child = spawn(process.execPath, [path.join(APP, "server.mjs")], { env, stdio: "ignore" });
  const h = await waitHealth(VERSION, 20, `http://127.0.0.1:${port}/health`);
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!h || (h.relay && h.relay !== "off")) stop(`The new version didn't start correctly, so nothing was changed. You still have ${old.version}.`);
  const state = await settings(0, { state: old, quiet: true, askAccess: false, askBrowser: false });
  if (!(await startAtLogin(0))) {
    say("  The new version didn't come up; going back to the old one.");
    await startAtLogin(0, old.app, old.node, old.version);
    stop(`Update failed; ${old.version} is running again. The log is at ${LOG}.`);
  }
  record(state);
  cleanupVersions([VERSION, old.version]);
  say(`Updated to ${VERSION}. Running tasks carry on.`);
  return 0;
}

async function menu(state) {
  say(`GPTWorkRouter ${VERSION} is installed.`);
  const i = await choose("menu", "What would you like to do?", ["Check and repair", "Change Codex access level", "Change browser", "Make a support file", "Uninstall", "Quit"]);
  if (i === 0) {
    const bad = (await selfCheck(0, state)).filter((r) => !r.ok).map((r) => r.name).join("\n");
    if (!bad) return say("Everything is fine."), 0;
    if (/signed in/.test(bad)) await signIn(0);
    if (/settings|sandbox/i.test(bad)) record(await settings(0, { state, askBrowser: false }));
    if (/running|Version|Undo/.test(bad)) await startAtLogin(0);
    if (/Tunnel/.test(bad)) record(await tunnelConnect(0, readState() ?? state));
    if (/relay|ChatGPT linked/.test(bad)) record(await relayConnect(0, readState() ?? state));
    await selfCheck(0, readState() ?? state);
  } else if (i === 1) {
    record(await settings(0, { state, askBrowser: false }));
    service("restart");
  } else if (i === 2) record(await settings(0, { state, askAccess: false }));
  else if (i === 3) await supportFile(await selfCheck(0, state));
  else if (i === 4) return uninstall();
  return 0;
}

async function main() {
  const state = readState();
  applyProxy(state?.proxy); // keep a proxy and the tunnel chosen earlier when the login task is reinstalled
  applyTunnel(state);
  if (state?.version === VERSION) return menu(state);
  if (state?.version) return update(state);
  return install();
}

main()
  .then((code) => {
    rl?.close();
    process.exit(code ?? 0);
  })
  .catch((err) => {
    rl?.close();
    console.error(err instanceof Stop ? `\n${err.message}` : `\nSetup hit an error: ${err.message}`);
    process.exit(1);
  });
