// Pair this computer with the hosted relay, check it, or unpair it (docs/plan-relay.md §11).
//   node scripts/relay.mjs pair   [--relay URL] [--name NAME] [--json]
//   node scripts/relay.mjs status [--json]
//   node scripts/relay.mjs unpair [--json]
// Pairing shows a code and opens the browser; the user signs in there and clicks Connect.
// No secret is ever typed, pasted or printed: the machine key is made here and kept in the
// OS key store. Exit codes: 0 ok, 1 error, 2 pairing code expired.
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { config } from "../lib/config.mjs";
import { readRelayConfig, writeRelayConfig, relayConfigPath, loadKey, saveKey, deleteKey, newKeyPair, machineToken, requestJson } from "../lib/relay.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--json") flags.json = true;
  else if (a === "--relay" || a === "--name") flags[a.slice(2)] = rest[++i];
  else { console.error(`Unknown option: ${a}`); process.exit(1); }
}
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const emit = (event, text) => (flags.json ? console.log(JSON.stringify(event)) : text && console.log(text));
const fail = (reason, text, code = 1) => {
  emit({ event: "error", reason }, `Error: ${text}`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url) {
  if (process.env.GWR_NO_BROWSER === "1") return;
  const c =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] // no shell, so & in the URL is safe
    : ["xdg-open", [url]];
  execFile(c[0], c[1], { windowsHide: true }, () => {});
}

async function pair() {
  const relay = String(flags.relay || readRelayConfig()?.relay || config.relayUrl).replace(/\/+$/, "");
  try { new URL(relay); } catch { fail("network", `not a valid relay address: ${relay}`); }
  const name = String(flags.name || os.hostname().replace(/\.local$/i, "")).slice(0, 60);
  const keys = newKeyPair();
  let start;
  try {
    start = await requestJson(`${relay}/pair/start`, { body: { public_key: keys.publicKey, machine_name: name, os: process.platform, bridge_version: VERSION } });
  } catch (err) {
    fail("network", `cannot reach ${relay} (${err.message}). Check the internet connection or proxy (HTTPS_PROXY).`);
  }
  if (start.status !== 200 || !start.json?.pair_code) fail("network", `the relay refused to start pairing (${start.status}${start.json?.error ? `: ${start.json.error}` : ""})`);
  const { pair_code, verify_url, device_code, interval = 3, expires_in = 600 } = start.json;
  emit({ event: "code", code: pair_code, verify_url, expires_in },
    `Open ${verify_url} and check the code: ${pair_code}\nWaiting for you to approve in the browser… (expires in ${Math.round(expires_in / 60)} minutes)`);
  openBrowser(verify_url);
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(1, interval) * 1000);
    let r;
    try {
      r = await requestJson(`${relay}/pair/poll`, { body: { device_code } });
    } catch {
      continue; // a network blip: keep waiting until the code expires
    }
    const s = r.json?.status;
    if (s === "pending") continue;
    if (s === "denied") fail("denied", "pairing was cancelled in the browser.");
    if (s === "expired") break;
    if (s === "approved") {
      try {
        saveKey(keys.privateKey);
      } catch (err) {
        fail("key_store", `could not save the machine key in the OS key store (${err.message}).`);
      }
      const cfg = { relay, machine_id: r.json.machine_id, account: r.json.account_email, mcp_url: r.json.mcp_url, paired_at: new Date().toISOString() };
      writeRelayConfig(cfg);
      emit({ event: "paired", account: cfg.account, machine_id: cfg.machine_id, mcp_url: cfg.mcp_url },
        `Paired as ${cfg.account}. Restart GPTWorkRouter: node scripts/service.mjs restart\nThen add ${cfg.mcp_url} to ChatGPT (see README).`);
      process.exit(0);
    }
    if (r.status >= 400 && r.status !== 429) fail("network", `the relay answered ${r.status} while waiting`);
  }
  fail("expired", "the pairing code expired. Run the command again.", 2);
}

async function status() {
  const cfg = readRelayConfig();
  let relay = "off", grants = null;
  if (cfg) {
    try {
      const r = await requestJson(`http://127.0.0.1:${config.port}/health`, { method: "GET", timeoutMs: 5000 });
      relay = r.json?.relay ?? "bridge_not_running";
      grants = r.json?.relay_chatgpt_grants ?? null;
    } catch {
      relay = loadKey() ? "bridge_not_running" : "key_missing";
    }
  }
  const out = { relay, chatgpt_grants: grants, account: cfg?.account ?? null, machine: cfg?.machine_id ?? null, relay_url: cfg?.relay ?? null };
  if (flags.json) return console.log(JSON.stringify(out));
  if (!cfg) return console.log(`Not paired with a relay (${relayConfigPath()} is missing). Pair with: node scripts/relay.mjs pair`);
  console.log(`Relay:    ${cfg.relay}\nAccount:  ${cfg.account}\nComputer: ${cfg.machine_id}\nStatus:   ${relay}\nChatGPT accounts linked: ${grants ?? "unknown (not connected)"}`);
}

async function unpair() {
  const cfg = readRelayConfig();
  if (!cfg) return emit({ event: "unpaired", was_paired: false }, "Not paired; nothing to do.");
  const key = loadKey();
  let told = false;
  if (key) {
    try {
      const r = await requestJson(`${cfg.relay}/machine/unpair`, { headers: { authorization: `GWR-Machine ${machineToken(cfg.machine_id, key)}` }, body: {} });
      told = r.status === 200 || r.status === 401; // 401: the relay already forgot this computer
    } catch {}
  }
  deleteKey();
  fs.rmSync(relayConfigPath(), { force: true });
  emit({ event: "unpaired", was_paired: true, relay_told: told },
    `Unpaired. ${told ? "The relay no longer knows this computer." : "Could not reach the relay; unlink it on the relay's account page too."}\nRestart GPTWorkRouter: node scripts/service.mjs restart`);
}

const run = { pair, status, unpair }[cmd];
if (!run) {
  console.error("Usage: node scripts/relay.mjs pair [--relay URL] [--name NAME] [--json] | status [--json] | unpair [--json]");
  process.exit(1);
}
await run();
