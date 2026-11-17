// Connect this bridge to the hosted relay (docs/plan-relay.md). The bridge dials out over one
// WebSocket, signs in with its machine key, and replays each MCP request the relay sends
// against its own loopback endpoint, streaming the reply back. Nothing listens on the network.
// Enabled whenever ~/.gptworkrouter/relay.json exists (written by `node scripts/relay.mjs pair`).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config.mjs";
import { keyCommand, storeKeyCommand, deleteKeyCommand, notifyCommand, userCommand } from "./desktop.mjs";

export const RELAY_PROTOCOL = 1;
export const relayConfigPath = () => path.join(config.dataDir, "relay.json");
const KEY_NAME = "gptworkrouter-relay";
const keyFile = () => path.join(config.dataDir, process.platform === "win32" ? "relay-key.dpapi" : "relay-key");

export function readRelayConfig() {
  try {
    return JSON.parse(fs.readFileSync(relayConfigPath(), "utf8"));
  } catch {
    return null;
  }
}

export function writeRelayConfig(cfg) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${relayConfigPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, relayConfigPath());
}

// ---- The machine key: an Ed25519 private key (PKCS#8 DER, base64). ----
// OS store on macOS (Keychain) and Windows (DPAPI file); a 0600 file elsewhere, or when
// GWR_KEY_STORE=file (tests). GWR_RELAY_KEY overrides it and is withheld from Codex.
const useFile = () => process.env.GWR_KEY_STORE === "file" || !["darwin", "win32"].includes(process.platform);
const user = () => os.userInfo().username;

export function loadKey() {
  if (process.env.GWR_RELAY_KEY) return process.env.GWR_RELAY_KEY;
  if (useFile()) {
    try {
      return fs.readFileSync(keyFile(), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const c = keyCommand(process.platform, { user: user(), dataDir: config.dataDir, name: KEY_NAME, file: keyFile() });
  try {
    return execFileSync(c.cmd, c.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(c.env ? { env: c.env } : {}) }).trim() || null;
  } catch {
    return null;
  }
}

export function saveKey(secret) {
  if (useFile()) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile(), secret + "\n", { mode: 0o600 });
    return;
  }
  const c = storeKeyCommand(process.platform, { user: user(), name: KEY_NAME, file: keyFile(), secret });
  execFileSync(c.cmd, c.args, { input: c.input, stdio: ["pipe", "ignore", "pipe"], windowsHide: true, ...(c.env ? { env: c.env } : {}) });
  if (loadKey() !== secret) throw new Error("the key store did not keep the key");
}

export function deleteKey() {
  fs.rmSync(keyFile(), { force: true });
  if (useFile()) return;
  const c = deleteKeyCommand(process.platform, { user: user(), name: KEY_NAME });
  if (c) try { execFileSync(c.cmd, c.args, { stdio: "ignore" }); } catch {}
}

export function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

// A short-lived signed token proving this machine holds its key: base64url(json).base64url(sig).
export function machineToken(machineId, privateKeyB64, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const body = Buffer.from(JSON.stringify({ machine_id: machineId, iat, exp: iat + 60, nonce: crypto.randomBytes(12).toString("base64url") })).toString("base64url");
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return `${body}.${crypto.sign(null, Buffer.from(body), key).toString("base64url")}`;
}

// ---- Proxy: HTTPS_PROXY / https_proxy, minus NO_PROXY (system proxy settings are not read). ----
export function proxyAgentFor(target) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  const host = new URL(target).hostname.toLowerCase();
  const skip = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",").map((s) => s.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean)
    .some((d) => d === "*" || host === d || host.endsWith(`.${d}`));
  return skip ? undefined : new HttpsProxyAgent(proxy);
}

// JSON over HTTPS to the relay (pairing, unpair), through the proxy if one is set.
export function requestJson(url, { method = "POST", body, headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      { method, agent: proxyAgentFor(url), timeout: timeoutMs, headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (text.length < 1e6) text += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

const wsUrl = (relay) => {
  const u = new URL("/connect", relay);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
};

// Headers that belong to one hop, or that would let a relayed request look like a local page.
const DROP = new Set(["host", "origin", "cookie", "authorization", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer", "content-length"]);
const MAX_INFLIGHT = 16;

function notify(title, body) {
  if (!config.notify) return;
  const c = config.notifyCmd ? userCommand(config.notifyCmd, [title, body]) : notifyCommand(process.platform, title, body);
  if (c) execFile(c.cmd, c.args, { windowsHide: true, ...(c.env ? { env: c.env } : {}) }, () => {});
}

export class RelaySupervisor {
  // events: the bridge's Events (to drop subscriptions on revocation).
  constructor({ port = config.port, events, version = "", log = console } = {}) {
    this.port = port;
    this.events = events;
    this.version = version;
    this.log = log;
    this.ws = null;
    this.stopping = false;
    this.attempt = 0;
    this.status = "off";
    this.grants = null; // ChatGPT grants on this account, known only while connected
    this.inflight = new Map(); // id -> AbortController
    this.timer = null;
  }

  // ChatGPT-linked count as /health reports it: null unless connected.
  get chatgptGrants() {
    return this.status === "connected" ? this.grants : null;
  }

  start() {
    this.cfg = readRelayConfig();
    if (!this.cfg) return; // not paired: status stays "off"
    this.key = loadKey();
    if (!this.key) {
      this.status = "key_missing";
      this.log.error("[relay] relay.json exists but the machine key is missing. Pair again: node scripts/relay.mjs pair");
      return;
    }
    this.stopping = false;
    this.#connect();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.ws?.close(1000, "bridge stopping");
    this.ws = null;
  }

  #halt(status, message) {
    this.status = status;
    this.stopping = true;
    if (message) this.log.error(`[relay] ${message}`);
  }

  #retry(reason) {
    if (this.stopping) return;
    this.status = `offline: ${reason}`;
    if (this.connectedAt && Date.now() - this.connectedAt > 600000) this.attempt = 0; // was up 10+ minutes
    const base = Math.min(60000, 1000 * 2 ** this.attempt++);
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.log.error(`[relay] ${reason}; reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.timer = setTimeout(() => this.#connect(), delay);
    this.timer.unref?.();
  }

  #connect() {
    if (this.stopping) return;
    this.status = "connecting";
    this.connectedAt = 0;
    let ws;
    try {
      ws = new WebSocket(wsUrl(this.cfg.relay), {
        agent: proxyAgentFor(this.cfg.relay),
        handshakeTimeout: 15000,
        maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false,
        headers: {
          authorization: `GWR-Machine ${machineToken(this.cfg.machine_id, this.key)}`,
          "x-gwr-protocol": String(RELAY_PROTOCOL),
        },
      });
    } catch (err) {
      return this.#retry(err.message);
    }
    this.ws = ws;
    let pingTimer;
    const alive = () => {
      clearTimeout(pingTimer);
      pingTimer = setTimeout(() => ws.terminate(), 40000); // the relay pings every 25 s
      pingTimer.unref?.();
    };
    let refused = false;
    ws.on("unexpected-response", (_req, res) => {
      refused = true;
      const reason = String(res.headers["x-gwr-reason"] || "");
      res.resume();
      ws.terminate();
      if (reason === "revoked") this.#revoked();
      else if (reason === "update_required") this.#halt("update_required", "The relay needs a newer GPTWorkRouter. Update, then restart.");
      else this.#retry(`relay answered ${res.statusCode}`);
    });
    ws.on("open", () => {
      alive();
      this.connectedAt = Date.now();
      this.status = "connected";
      this.log.log(`[relay] connected to ${this.cfg.relay} as ${this.cfg.account}`);
      this.#send({ t: "hello", version: RELAY_PROTOCOL, bridge: this.version, os: process.platform });
    });
    ws.on("ping", alive);
    ws.on("message", (data) => {
      let f;
      try { f = JSON.parse(String(data)); } catch { return; }
      this.#frame(f);
    });
    ws.on("error", () => {}); // "close" follows and handles it
    ws.on("close", (code, why) => {
      clearTimeout(pingTimer);
      if (this.ws === ws) this.ws = null;
      this.grants = null;
      for (const ac of this.inflight.values()) ac.abort();
      this.inflight.clear();
      if (refused || this.stopping) return;
      if (code === 4001) {
        notify("GPTWorkRouter connected from somewhere else", "If that wasn't you, pair this computer again: node scripts/relay.mjs pair");
        return this.#halt("offline: replaced by another connection", "Another connection with this computer's key replaced this one. If that wasn't you, pair again.");
      }
      if (code === 4003) return this.#revoked();
      if (code === 4026) return this.#halt("update_required", "The relay needs a newer GPTWorkRouter. Update, then restart.");
      this.#retry(String(why || "") || (this.connectedAt ? "connection lost" : "cannot reach the relay"));
    });
  }

  #revoked() {
    this.events?.unsubscribeAll?.();
    this.#halt("revoked", "This computer was unlinked from the relay. Pair again: node scripts/relay.mjs pair");
  }

  #send(f) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  #frame(f) {
    if (f.t === "grants" && Number.isInteger(f.count)) this.grants = f.count;
    else if (f.t === "revoked") {
      this.events?.unsubscribeAll?.();
      this.log.log("[relay] ChatGPT access was revoked on the relay; event subscriptions dropped");
    } else if (f.t === "cancel") this.inflight.get(f.id)?.abort();
    else if (f.t === "req" && typeof f.id === "string") this.#forward(f);
  }

  async #forward(f) {
    if (this.inflight.size >= MAX_INFLIGHT) {
      this.#send({ t: "head", id: f.id, status: 429, headers: { "content-type": "application/json" } });
      this.#send({ t: "data", id: f.id, chunk: Buffer.from('{"error":"too many requests at once"}').toString("base64") });
      return this.#send({ t: "end", id: f.id });
    }
    const ac = new AbortController();
    this.inflight.set(f.id, ac);
    try {
      const headers = {};
      for (const [k, v] of Object.entries(f.headers || {})) if (!DROP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
      const method = String(f.method || "POST").toUpperCase();
      const target = typeof f.path === "string" && /^\/mcp(\?|$)/.test(f.path) ? f.path : "/mcp";
      // fetch sets Host to 127.0.0.1:<port> itself and sends no Origin, so the bridge's
      // DNS-rebinding and Origin checks see a local client, exactly as with tunnel-client.
      const res = await fetch(`http://127.0.0.1:${this.port}${target}`, {
        method,
        headers,
        body: f.body && !["GET", "HEAD"].includes(method) ? Buffer.from(f.body, "base64") : undefined,
        signal: ac.signal,
      });
      const out = {};
      res.headers.forEach((v, k) => { if (!DROP.has(k) && k !== "content-encoding") out[k] = v; });
      this.#send({ t: "head", id: f.id, status: res.status, headers: out });
      if (res.body) for await (const chunk of res.body) this.#send({ t: "data", id: f.id, chunk: Buffer.from(chunk).toString("base64") });
      this.#send({ t: "end", id: f.id });
    } catch (err) {
      if (!ac.signal.aborted) {
        this.#send({ t: "head", id: f.id, status: 502, headers: { "content-type": "application/json" } });
        this.#send({ t: "data", id: f.id, chunk: Buffer.from(JSON.stringify({ error: "bridge error" })).toString("base64") });
        this.log.error(`[relay] local request failed: ${err.message}`);
      }
      this.#send({ t: "end", id: f.id });
    } finally {
      this.inflight.delete(f.id);
    }
  }
}
