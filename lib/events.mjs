// MCP Events (webhook delivery), as ChatGPT implements it:
// https://developers.openai.com/plugins/build/mcp-events
// ChatGPT subscribes with events/subscribe and hands us a callback URL + secret;
// when a task finishes we POST a signed event there. ChatGPT delivers these in
// Work chats (web, or desktop with Cloud selected) and dots, not in regular Chat.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Webhook } from "standardwebhooks";
import { config } from "./config.mjs";
import { redact } from "./redact.mjs";

export const EVENT_DEFINITIONS = [
  {
    name: "task.finished",
    description:
      "Fires when a GPTWorkRouter task stops running: completed, failed or cancelled. " +
      "Pass task_id to watch one task; omit it to hear about every task.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "Only this task." } },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["completed", "failed", "cancelled", "interrupted", "denied"] },
        folder: { type: "string" },
        result: { type: "string" },
        error: { type: "string" },
        files_changed: { type: "array", items: { type: "string" } },
        next: { type: "string" },
      },
      required: ["task_id", "status"],
    },
  },
];

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 262144;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const canonical = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
    : JSON.stringify(v ?? null);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

// HTTPS only, no private or local addresses (the bridge must never be turned
// into a way to reach the user's own network).
export async function checkPublicUrl(raw, label = "Callback URL") {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RpcError(-32602, `${label} is not a valid URL`);
  }
  if (config.allowInsecureWebhooks) return url;
  if (url.protocol !== "https:") throw new RpcError(-32602, `${label} must use https`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let hosts;
  try {
    hosts = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    throw new RpcError(-32015, `${label} host does not resolve`, { reason: "unresolvable" });
  }
  if (!hosts.length || hosts.some((h) => isPrivateAddress(h.address))) {
    throw new RpcError(-32602, `${label} resolves to a private or local address`);
  }
  return url;
}

function checkSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) {
    throw new RpcError(-32602, "delivery.secret must start with whsec_");
  }
  let bytes = 0;
  try {
    bytes = Buffer.from(secret.slice(6), "base64").length;
  } catch {}
  if (bytes < 24 || bytes > 64) throw new RpcError(-32602, "delivery.secret must decode to 24-64 bytes");
}

function validateArguments(args) {
  const a = args ?? {};
  if (typeof a !== "object" || Array.isArray(a)) throw new RpcError(-32602, "arguments must be an object");
  for (const k of Object.keys(a)) if (k !== "task_id") throw new RpcError(-32602, `Unknown argument: ${k}`);
  if (a.task_id !== undefined && typeof a.task_id !== "string") throw new RpcError(-32602, "task_id must be a string");
  return a;
}

async function post(url, secret, subscriptionId, msgId, body) {
  const wh = new Webhook(secret);
  const now = new Date();
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": wh.sign(msgId, now, body),
      "X-MCP-Subscription-Id": subscriptionId,
    },
    body,
  });
  return res;
}

export class Events {
  constructor(store, log = console) {
    this.store = store; // persists subscriptions across restarts
    this.log = log;
    this.verified = new Map(); // principal|url -> verifiedAt
  }

  list() {
    return { events: EVENT_DEFINITIONS, nextCursor: null };
  }

  async subscribe(params, principal) {
    const { name, delivery, ttlMs } = params ?? {};
    if (!EVENT_DEFINITIONS.some((e) => e.name === name)) throw new RpcError(-32602, `Unknown event: ${name}`);
    const args = validateArguments(params.arguments);
    if (delivery?.mode !== "webhook") throw new RpcError(-32602, "Only webhook delivery is supported");
    checkSecret(delivery.secret);
    const url = (await checkPublicUrl(delivery.url)).toString();

    const id = "sub_" + crypto.createHash("sha256").update([principal, url, name, canonical(args)].join("\n")).digest("hex").slice(0, 32);
    await this.#verify(principal, url, delivery.secret, id);

    const lifetime = ttlMs === null ? null : Math.min(Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    const refreshBefore = lifetime === null ? null : new Date(Date.now() + lifetime).toISOString();
    this.store.save(id, { id, principal, name, arguments: args, url, secret: delivery.secret, refreshBefore, createdAt: new Date().toISOString() });
    this.log.log(`[events] subscribed ${id} to ${name} ${args.task_id ? `(task ${args.task_id})` : "(all tasks)"}`);
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  unsubscribe(params, principal) {
    const args = validateArguments(params?.arguments);
    const url = params?.delivery?.url;
    for (const sub of this.store.all()) {
      if (sub.principal === principal && sub.name === params?.name && sub.url === url && canonical(sub.arguments) === canonical(args)) {
        this.store.remove(sub.id);
        this.log.log(`[events] unsubscribed ${sub.id}`);
      }
    }
    return {};
  }

  // ChatGPT access was revoked on the relay: stop every delivery (the MCP Events rule).
  unsubscribeAll() {
    const subs = this.store.all();
    for (const sub of subs) this.store.remove(sub.id);
    if (subs.length) this.log.log(`[events] dropped ${subs.length} subscription(s): access revoked`);
  }

  async #verify(principal, url, secret, subscriptionId) {
    const key = `${principal}\n${url}`;
    const seen = this.verified.get(key);
    if (seen && Date.now() - seen < 3600 * 1000) return;
    const challenge = crypto.randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    let res, echoed;
    try {
      res = await post(url, secret, subscriptionId, `msg_verification_${crypto.randomBytes(8).toString("hex")}`, body);
      echoed = (await res.json().catch(() => ({})))?.challenge;
    } catch (err) {
      throw new RpcError(-32015, "Callback endpoint did not answer", { reason: "timeout", detail: String(err?.message || err) });
    }
    const ok =
      res.status >= 200 && res.status < 300 && typeof echoed === "string" && echoed.length === challenge.length &&
      crypto.timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    if (!ok) throw new RpcError(-32015, "Callback verification failed", { reason: "challenge_failed", status: res.status });
    this.verified.set(key, Date.now());
  }

  // Called by the task runner whenever a task stops running.
  emitTaskFinished(task) {
    const data = {
      task_id: task.id,
      status: task.status,
      folder: task.folder,
      ...(task.result ? { result: redact(task.result.slice(0, 16000)) } : {}),
      ...(task.error ? { error: redact(task.error.slice(0, 4000)) } : {}),
      files_changed: (task.files || []).slice(-100),
      next: "Call check_task with this task_id for the full report, or continue_task to follow up.",
    };
    const now = Date.now();
    for (const sub of this.store.all()) {
      if (sub.name !== "task.finished") continue;
      if (sub.arguments?.task_id && sub.arguments.task_id !== task.id) continue;
      if (sub.refreshBefore && Date.parse(sub.refreshBefore) < now) {
        this.store.remove(sub.id);
        continue;
      }
      // Each user only hears about their own tasks.
      if (sub.principal !== task.owner) continue;
      this.#deliver(sub, data).catch((err) => this.log.error(`[events] delivery to ${sub.id} failed:`, err?.message || err));
    }
  }

  async #deliver(sub, data) {
    const eventId = `evt_${crypto.randomBytes(12).toString("hex")}`;
    let body = JSON.stringify({ eventId, name: sub.name, timestamp: new Date().toISOString(), data, cursor: null });
    if (Buffer.byteLength(body) > MAX_BODY) {
      body = JSON.stringify({ eventId, name: sub.name, timestamp: new Date().toISOString(), data: { ...data, result: "(too long; call check_task)" }, cursor: null });
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await post(sub.url, sub.secret, sub.id, eventId, body);
        if (res.status >= 200 && res.status < 300) {
          this.log.log(`[events] delivered ${eventId} (${data.status}) to ${sub.id}`);
          return;
        }
        if (res.status === 410) {
          this.store.remove(sub.id); // ChatGPT says this subscription is gone
          return;
        }
        if (res.status === 413 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
      } catch {
        // network error: retry below
      }
      await new Promise((r) => setTimeout(r, Math.min(60000, 1000 * 2 ** attempt)));
    }
  }
}
