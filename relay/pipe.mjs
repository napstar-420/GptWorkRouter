// The machine sockets: one outbound WebSocket per paired computer, and the pipe that carries
// each /mcp request down it and streams the bridge's reply back. The relay reads headers only;
// bodies pass through untouched (docs/plan-relay.md §4).
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export const MIN_BRIDGE_PROTOCOL = 1;
const MAX_INFLIGHT = 16;
const MAX_RESPONSE = 10 * 1024 * 1024;
const DEADLINE_MS = Number(process.env.RELAY_DEADLINE_MS || 90000);
const KEEPALIVE_MS = Number(process.env.RELAY_KEEPALIVE_MS || 15000);
const PING_MS = Number(process.env.RELAY_PING_MS || 25000);
// Hop-by-hop headers, the caller's credentials, and anything that must not cross the pipe.
const DROP_REQ = new Set(["host", "origin", "cookie", "authorization", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authorization", "te", "trailer", "content-length", "forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
  "x-forwarded-port", "x-real-ip", "fly-client-ip", "fly-forwarded-port", "fly-region", "fly-request-id", "via"]);
const DROP_RES = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "set-cookie", "upgrade", "trailer"]);

const raw = (socket, status, text, reason) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\n${reason ? `X-GWR-Reason: ${reason}\r\n` : ""}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export class Pipe {
  constructor({ store, log = console }) {
    this.store = store;
    this.log = log;
    this.conns = new Map(); // machineId -> { ws, machineId, accountId, inflight, alive }
    this.nonces = new Map(); // nonce -> expiry (ms)
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    this.timer = setInterval(() => this.#heartbeat(), PING_MS);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
  }

  // GWR-Machine <base64url(json)>.<base64url(ed25519 signature)>
  verifyMachine(header) {
    const m = /^GWR-Machine ([\w-]+)\.([\w-]+)$/.exec(String(header || ""));
    if (!m) return { status: 401 };
    let claims;
    try {
      claims = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    } catch {
      return { status: 401 };
    }
    const machine = typeof claims.machine_id === "string" ? this.store.machine(claims.machine_id) : null;
    const account = machine && this.store.account(machine.account_id);
    if (!machine || !account || account.disabled) return { status: 401, reason: "revoked" };
    let good = false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(machine.public_key, "base64"), format: "der", type: "spki" });
      good = crypto.verify(null, Buffer.from(m[1]), key, Buffer.from(m[2], "base64url"));
    } catch {}
    const now = Math.floor(Date.now() / 1000);
    if (!good || !(claims.iat - 60 <= now && now <= claims.exp + 30 && claims.exp - claims.iat <= 120)) return { status: 401 };
    if (typeof claims.nonce !== "string" || this.nonces.has(claims.nonce)) return { status: 401 };
    this.nonces.set(claims.nonce, Date.now() + 300000);
    return { machine, account };
  }

  handleUpgrade(req, socket, head) {
    socket.on("error", () => {});
    if (new URL(req.url, "http://x").pathname !== "/connect") return raw(socket, 404, "Not Found");
    if (Number(req.headers["x-gwr-protocol"] || 0) < MIN_BRIDGE_PROTOCOL) return raw(socket, 426, "Upgrade Required", "update_required");
    const v = this.verifyMachine(req.headers.authorization);
    if (!v.machine) return raw(socket, v.status, "Unauthorized", v.reason);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, v.machine));
  }

  #attach(ws, machine) {
    const old = this.conns.get(machine.id);
    if (old) {
      old.ws.close(4001, "replaced");
      this.#failAll(old);
    }
    const conn = { ws, machineId: machine.id, accountId: machine.account_id, inflight: new Map(), alive: true };
    this.conns.set(machine.id, conn);
    this.log.log(`[pipe] ${machine.id} connected`);
    ws.on("pong", () => (conn.alive = true));
    ws.on("error", () => {});
    ws.on("message", (data) => {
      let f;
      try { f = JSON.parse(String(data)); } catch { return; }
      const h = conn.inflight.get(f.id);
      if (!h) return;
      if (f.t === "head") h.head(f);
      else if (f.t === "data") h.data(f);
      else if (f.t === "end") h.end();
    });
    ws.on("close", () => {
      if (this.conns.get(machine.id) === conn) this.conns.delete(machine.id);
      this.#failAll(conn);
      this.log.log(`[pipe] ${machine.id} disconnected`);
    });
    this.#send(conn, { t: "hello", version: MIN_BRIDGE_PROTOCOL });
    this.#send(conn, { t: "grants", count: this.store.grantCount(machine.account_id) });
    if (this.store.machine(machine.id)?.revoke_pending) {
      this.#send(conn, { t: "revoked", scope: "chatgpt" });
      this.store.run("UPDATE machines SET revoke_pending = 0 WHERE id = ?", machine.id);
    }
  }

  #heartbeat() {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    for (const conn of this.conns.values()) {
      if (!this.store.machine(conn.machineId)) {
        conn.ws.close(4003, "revoked"); // unlinked (e.g. by the admin CLI)
        continue;
      }
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  #send(conn, f) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(f));
  }

  #failAll(conn) {
    for (const h of conn.inflight.values()) h.fail();
    conn.inflight.clear();
  }

  online(machineId) {
    return this.conns.has(machineId);
  }
  get(machineId) {
    return machineId ? this.conns.get(machineId) : undefined;
  }
  count() {
    return this.conns.size;
  }

  pushGrants(accountId) {
    const m = this.store.machineOf(accountId);
    const conn = m && this.conns.get(m.id);
    if (conn) this.#send(conn, { t: "grants", count: this.store.grantCount(accountId) });
  }

  // A ChatGPT grant was revoked: the bridge drops its event subscriptions, now or on next hello.
  revokeChatgpt(accountId) {
    const m = this.store.machineOf(accountId);
    if (!m) return;
    const conn = this.conns.get(m.id);
    if (conn) this.#send(conn, { t: "revoked", scope: "chatgpt" });
    else this.store.run("UPDATE machines SET revoke_pending = 1 WHERE id = ?", m.id);
  }

  kick(machineId, code = 4003, reason = "revoked") {
    this.conns.get(machineId)?.ws.close(code, reason);
  }

  // Pipe one HTTP request to the machine. Resolves with { status, bytesOut } when done.
  forward(conn, req, res, body) {
    if (conn.inflight.size >= MAX_INFLIGHT) {
      res.writeHead(429, { "content-type": "application/json" }).end('{"error":"too many requests at once for this computer"}');
      return Promise.resolve({ status: 429, bytesOut: 0 });
    }
    const id = crypto.randomUUID();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    const longStream = req.method === "GET" || String(req.headers["mcp-method"] || "") === "subscriptions/listen";
    return new Promise((resolve) => {
      let headSent = false, sse = false, status = 502, out = 0, done = false, lastWrite = Date.now(), clean = true;
      const finish = (s) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(keep);
        conn.inflight.delete(id);
        resolve({ status: s, bytesOut: out });
      };
      const cancel = () => this.#send(conn, { t: "cancel", id });
      const errorReply = (code, msg) => {
        if (!headSent) res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error: msg }));
        else res.end();
      };
      const deadline = longStream ? null : setTimeout(() => {
        cancel();
        errorReply(504, "your computer took too long to answer");
        finish(504);
      }, DEADLINE_MS);
      // SSE comments keep idle proxies from cutting a quiet stream; only between whole events.
      const keep = setInterval(() => {
        if (sse && clean && Date.now() - lastWrite >= KEEPALIVE_MS) {
          res.write(": keepalive\n\n");
          lastWrite = Date.now();
        }
      }, Math.min(5000, KEEPALIVE_MS));
      res.on("close", () => {
        if (!done) {
          cancel();
          finish(499);
        }
      });
      conn.inflight.set(id, {
        head: (f) => {
          if (headSent || done) return;
          headSent = true;
          status = Number.isInteger(f.status) && f.status >= 200 && f.status <= 599 ? f.status : 502;
          const h = {};
          for (const [k, v] of Object.entries(f.headers || {})) if (!DROP_RES.has(k.toLowerCase()) && typeof v === "string") h[k] = v;
          sse = /text\/event-stream/i.test(h["content-type"] || "");
          if (sse) Object.assign(h, { "x-accel-buffering": "no", "cache-control": "no-store" });
          res.writeHead(status, h);
          res.flushHeaders?.();
        },
        data: (f) => {
          if (!headSent || done) return;
          const b = Buffer.from(String(f.chunk || ""), "base64");
          out += b.length;
          if (out > MAX_RESPONSE) {
            cancel();
            res.end();
            return finish(502);
          }
          if (b.length) {
            res.write(b);
            lastWrite = Date.now();
            clean = b.toString("latin1").endsWith("\n\n");
          }
        },
        end: () => {
          if (done) return;
          if (!headSent) errorReply(502, "empty reply from your computer");
          else res.end();
          finish(status);
        },
        fail: () => {
          errorReply(502, "your computer disconnected");
          finish(502);
        },
      });
      this.#send(conn, { t: "req", id, method: req.method, path: req.url, headers, body: body?.length ? body.toString("base64") : undefined });
    });
  }
}
