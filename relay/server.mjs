// GPTWorkRouter relay (docs/plan-relay.md): the OAuth server ChatGPT signs in to, the public
// MCP URL it calls, and the pipe down each paired computer's own outbound socket.
// Settings (environment):
//   PUBLIC_URL      https address users see, e.g. https://gptworkrouter-relay.fly.dev (default http://localhost:8080)
//   PORT, HOST      listen address (default 8080; 127.0.0.1 when PUBLIC_URL is localhost, else 0.0.0.0)
//   DATA_DIR        SQLite, logs and downloads (default ./data)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   sign-in providers
//   DEV_LOGIN=1     type-an-email sign-in, only when PUBLIC_URL is http://localhost (tests, local trials)
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Provider, { errors } from "oidc-provider";
import { openDb } from "./db.mjs";
import { Pipe } from "./pipe.mjs";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(PUBLIC_URL);
const HOST = process.env.HOST || (LOCAL ? "127.0.0.1" : "0.0.0.0");
const SECURE = PUBLIC_URL.startsWith("https://");
const DEV_LOGIN = process.env.DEV_LOGIN === "1" && LOCAL;
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DOWNLOADS = path.join(DATA_DIR, "downloads");
const MCP_URL = `${PUBLIC_URL}/mcp`;
const PRM_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;
const OFFLINE = "GPTWorkRouter on your computer isn't connected. Turn the computer on or start GPTWorkRouter, then ask again.";
const UNPAIRED = "No computer is paired with this GPTWorkRouter account yet. On your computer, run: node scripts/relay.mjs pair";
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
const github = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET;
if (!LOCAL && !SECURE) throw new Error("PUBLIC_URL must be https:// (or http://localhost for local use)");

for (const level of ["log", "error"]) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(new Date().toISOString(), ...args);
}

const store = openDb(DATA_DIR);
const pipe = new Pipe({ store });
store.onGrantChange = (accountId) => pipe.pushGrants(accountId);

// ---- Secrets made on first start, kept in the database ----
const SESSION_KEY = Buffer.from(store.secret("session_key", () => crypto.randomBytes(32).toString("base64")), "base64");
const COOKIE_KEYS = store.secret("cookie_keys", () => [crypto.randomBytes(32).toString("base64url"), crypto.randomBytes(32).toString("base64url")]);
const JWKS = store.secret("jwks", () => {
  const jwk = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
  return { keys: [{ ...jwk, kid: crypto.randomBytes(8).toString("hex"), use: "sig", alg: "RS256" }] };
});

// ---- OAuth server (oidc-provider) ----
// ChatGPT is a public client registered by CIMD (preferred) or DCR, using code + PKCE S256 with
// resource=MCP_URL. Access tokens are opaque, live 1 hour, and are only for MCP_URL.
const CIMD_HOSTS = ["https://chatgpt.com/"];
const provider = new Provider(PUBLIC_URL, {
  adapter: store.adapterClass(),
  clients: [],
  findAccount: async (_ctx, id) => {
    const a = store.account(id);
    if (!a || a.disabled) return undefined;
    return { accountId: id, claims: async () => ({ sub: id, email: a.email, email_verified: true }) };
  },
  claims: { openid: ["sub"], email: ["email", "email_verified"] },
  scopes: ["openid", "offline_access", "email", "mcp"],
  jwks: JWKS,
  cookies: { keys: COOKIE_KEYS },
  features: {
    devInteractions: { enabled: false },
    pushedAuthorizationRequests: { enabled: false },
    rpInitiatedLogout: { enabled: false },
    registration: { enabled: true },
    revocation: { enabled: true },
    clientIdMetadataDocument: { enabled: true, ack: "draft-03", allowFetch: async (_ctx, id) => CIMD_HOSTS.some((h) => id.startsWith(h)) },
    resourceIndicators: {
      enabled: true,
      defaultResource: () => MCP_URL,
      useGrantedResource: () => true,
      getResourceServerInfo: (_ctx, indicator) => {
        if (indicator.replace(/\/+$/, "") !== MCP_URL) throw new errors.InvalidTarget();
        return { scope: "mcp", audience: MCP_URL, accessTokenTTL: 3600, accessTokenFormat: "opaque" };
      },
    },
  },
  // Every client (DCR, CIMD, or one loaded from the database) may only send codes back to
  // ChatGPT. Checked here, not just on the consent page, because a remembered sign-in and an
  // earlier grant skip that page: a client with one ChatGPT URI and one foreign URI could
  // otherwise collect codes at the foreign one.
  extraClientMetadata: {
    properties: ["gwr_redirect_check"],
    validator: (_ctx, key, _value, metadata) => {
      if (key !== "gwr_redirect_check") return;
      const uris = [].concat(metadata.redirect_uris || []);
      if (!uris.length || !uris.every(okRedirect)) throw new errors.InvalidClientMetadata("redirect_uris must all be ChatGPT addresses");
    },
  },
  pkce: { required: () => true },
  responseTypes: ["code"],
  issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
  interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  ttl: { AccessToken: 3600, AuthorizationCode: 300, IdToken: 3600, Interaction: 3600, Session: 14 * 86400, Grant: 365 * 86400, RefreshToken: 30 * 86400 },
  routes: { authorization: "/oauth/auth", token: "/oauth/token", registration: "/oauth/reg", jwks: "/oauth/jwks", revocation: "/oauth/revoke", userinfo: "/oauth/me", end_session: "/oauth/logout" },
  renderError: async (ctx, out) => {
    ctx.type = "html";
    ctx.body = page("Sign-in problem", `<p>${esc(out.error_description || out.error || "Something went wrong.")}</p><p>Close this tab and try connecting again from ChatGPT.</p>`);
  },
});
if (SECURE) provider.proxy = true; // behind Fly's TLS proxy
// A sign-in that asks for no scope gets the one scope there is, instead of being refused.
provider.use(async (ctx, next) => {
  if (ctx.path === "/oauth/auth" && ctx.method === "GET" && !ctx.query.scope) ctx.query = { ...ctx.query, scope: "mcp" };
  await next();
});
const oidc = provider.callback();

// ---- Small helpers ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · GPTWorkRouter</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafaf8}h1{font-size:1.4rem}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:1.2rem 1.4rem;margin:1rem 0}code{font-size:1.25rem;letter-spacing:.08em}
button,.btn{display:inline-block;font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid #888;background:#fff;color:#1a1a1a;text-decoration:none;cursor:pointer;margin:.2rem .4rem .2rem 0}
.primary{background:#1a1a1a;color:#fff;border-color:#1a1a1a}.warn{color:#8a4b00}.muted{color:#666;font-size:.9rem}input{font:inherit;padding:.45rem;width:100%;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}.card{background:#1f1f1f;border-color:#333}button,.btn{background:#222;color:#eee}.primary{background:#eee;color:#111}.muted{color:#aaa}}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
const send = (res, status, html, extra = {}) => res.writeHead(status, { ...PAGE_HEADERS, ...extra }).end(html);
const json = (res, status, obj, extra = {}) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(JSON.stringify(obj));
const redirect = (res, to, extra = {}) => res.writeHead(303, { location: to, "cache-control": "no-store", ...extra }).end();
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&%~+]*$/.test(n) ? n : "/account");
const clientIp = (req) => String(req.headers["fly-client-ip"] || req.socket.remoteAddress || "");

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
const readForm = async (req) => Object.fromEntries(new URLSearchParams((await readBody(req, 16384)).toString("utf8")));
const readJson = async (req) => {
  try {
    return JSON.parse((await readBody(req, 16384)).toString("utf8"));
  } catch (err) {
    if (err.status) throw err;
    return null;
  }
};

// Fixed-window rate limits.
const windows = new Map();
function limited(key, max, ms) {
  const t = Date.now();
  let w = windows.get(key);
  if (!w || w.reset < t) windows.set(key, (w = { n: 0, reset: t + ms }));
  return ++w.n > max;
}

// ---- Relay pages' own sign-in session (signed cookie) ----
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), decodeURIComponent(c.slice(c.indexOf("=") + 1))]));
const mac = (s) => crypto.createHmac("sha256", SESSION_KEY).update(s).digest("base64url");
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`;
const SESSION_DAYS = 7;
function sessionCookie(accountId) {
  const v = `${accountId}.${Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400}`;
  return cookie("gwr_s", `${v}.${mac(v)}`, SESSION_DAYS * 86400);
}
function session(req) {
  const raw = cookies(req).gwr_s;
  const m = /^([\w-]+)\.(\d+)\.([\w-]+)$/.exec(raw || "");
  if (!m) return null;
  const v = `${m[1]}.${m[2]}`;
  const good = mac(v);
  if (good.length !== m[3].length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(m[3])) || Number(m[2]) < Date.now() / 1000) return null;
  const a = store.account(m[1]);
  return a && !a.disabled ? { ...a, raw } : null;
}
const csrf = (s, action) => mac(`csrf.${s.raw}.${action}`);
const csrfOk = (s, action, token) => typeof token === "string" && token === csrf(s, action);
const needLogin = (res, next) => redirect(res, `/login?next=${encodeURIComponent(next)}`);

// ---- Upstream sign-in: Google and GitHub, then the allowlist ----
const CALLBACK = (p) => `${PUBLIC_URL}/login/callback/${p}`;
async function upstreamEmail(provider, code) {
  if (provider === "google") {
    const t = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: CALLBACK("google"), grant_type: "authorization_code" }),
    }).then((r) => r.json());
    if (!t.access_token) return [];
    const u = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json());
    return u.email && u.email_verified === true ? [u.email] : [];
  }
  const t = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: CALLBACK("github") }),
  }).then((r) => r.json());
  if (!t.access_token) return [];
  const emails = await fetch("https://api.github.com/user/emails", {
    headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "gptworkrouter-relay" },
  }).then((r) => r.json());
  return Array.isArray(emails) ? emails.filter((e) => e.verified).sort((a, b) => b.primary - a.primary).map((e) => e.email) : [];
}

function signIn(res, emails, next) {
  const email = emails.find((e) => store.allowed(e));
  if (!email)
    return send(res, 403, page("Not invited yet", `<p>${emails.length ? `<b>${esc(emails[0])}</b> is not on the invite list.` : "We could not read a verified email address from that account."}</p><p>Ask the person who invited you to add your email, then try again.</p><p><a class="btn" href="/login?next=${encodeURIComponent(next)}">Back</a></p>`));
  const a = store.accountFor(email);
  if (a.disabled) return send(res, 403, page("Account disabled", "<p>This account has been disabled.</p>"));
  console.log(`[login] ${a.id} signed in`);
  redirect(res, next, { "set-cookie": [sessionCookie(a.id), cookie("gwr_state", "", 0)] });
}

async function login(req, res, url) {
  const next = safeNext(url.searchParams.get("next"));
  const p = url.pathname;
  if (p === "/login") {
    if (session(req)) return redirect(res, next);
    const q = `?next=${encodeURIComponent(next)}`;
    const buttons = [google && `<a class="btn primary" href="/login/google${q}">Continue with Google</a>`, github && `<a class="btn primary" href="/login/github${q}">Continue with GitHub</a>`].filter(Boolean).join(" ");
    const dev = DEV_LOGIN ? `<form method="post" action="/login/dev"><input type="hidden" name="next" value="${esc(next)}"><p class="muted">Local test sign-in</p><input name="email" type="email" required placeholder="you@example.com"><p><button class="primary">Sign in</button></p></form>` : "";
    return send(res, 200, page("Sign in to GPTWorkRouter", `<div class="card">${buttons || (dev ? "" : "<p>Sign-in is not set up on this relay yet.</p>")}${dev}</div><p class="muted">Use the account your invite was sent to.</p>`));
  }
  if (p === "/login/dev" && req.method === "POST" && DEV_LOGIN) {
    const f = await readForm(req);
    return signIn(res, [String(f.email || "").trim()].filter(Boolean), safeNext(f.next));
  }
  const start = /^\/login\/(google|github)$/.exec(p);
  if (start && ({ google, github })[start[1]]) {
    const state = crypto.randomBytes(18).toString("base64url");
    const setState = cookie("gwr_state", `${state}.${Buffer.from(next).toString("base64url")}`, 600);
    const to = start[1] === "google"
      ? `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: CALLBACK("google"), response_type: "code", scope: "openid email", state, prompt: "select_account" })}`
      : `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: CALLBACK("github"), scope: "user:email", state, allow_signup: "false" })}`;
    return redirect(res, to, { "set-cookie": setState });
  }
  const back = /^\/login\/callback\/(google|github)$/.exec(p);
  if (back && ({ google, github })[back[1]]) {
    const [state, nextB64] = String(cookies(req).gwr_state || "").split(".");
    if (!state || state !== url.searchParams.get("state") || !url.searchParams.get("code"))
      return send(res, 400, page("Sign-in expired", `<p>That sign-in link expired. <a href="/login">Try again</a>.</p>`));
    let emails = [];
    try {
      emails = await upstreamEmail(back[1], url.searchParams.get("code"));
    } catch (err) {
      console.error(`[login] ${back[1]} failed: ${err.message}`);
    }
    return signIn(res, emails, safeNext(Buffer.from(nextB64 || "", "base64url").toString("utf8")));
  }
  if (p === "/logout" && req.method === "POST") return redirect(res, "/login", { "set-cookie": cookie("gwr_s", "", 0) });
  return send(res, 404, page("Not found", "<p>No such page.</p>"));
}

// ---- OAuth interaction: login, then consent ("ChatGPT wants to run tasks on your computer") ----
function okRedirect(uri) {
  return typeof uri === "string" && (uri.startsWith("https://chatgpt.com/") || (LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)));
}

async function interaction(req, res, uid, action) {
  const details = await provider.interactionDetails(req, res);
  const s = session(req);
  const here = `/interaction/${uid}`;
  if (action === "abort" && req.method === "POST") {
    const f = await readForm(req);
    if (!s || !csrfOk(s, `ia.${uid}`, f.csrf)) return send(res, 403, page("Expired", "<p>Please try again from ChatGPT.</p>"));
    return provider.interactionFinished(req, res, { error: "access_denied", error_description: "The user said no." }, { mergeWithLastSubmission: false });
  }
  if (details.prompt.name === "login" || (s && details.session?.accountId && details.session.accountId !== s.id)) {
    if (!s) return needLogin(res, here);
    return provider.interactionFinished(req, res, { login: { accountId: s.id } }, { mergeWithLastSubmission: false });
  }
  if (details.prompt.name !== "consent") return send(res, 400, page("Unexpected step", "<p>Please try again from ChatGPT.</p>"));
  if (!s) return needLogin(res, here);
  if (!okRedirect(details.params.redirect_uri))
    return send(res, 403, page("Not ChatGPT", "<p>Only ChatGPT can connect to GPTWorkRouter. This request came from somewhere else, so it was stopped.</p>"));
  if (action === "confirm" && req.method === "POST") {
    const f = await readForm(req);
    if (!csrfOk(s, `ic.${uid}`, f.csrf)) return send(res, 403, page("Expired", "<p>Please try again from ChatGPT.</p>"));
    const { prompt: { details: missing }, params, session: { accountId }, grantId } = details;
    if (accountId !== s.id) return send(res, 403, page("Wrong account", "<p>Please try again from ChatGPT.</p>"));
    const grant = (grantId && (await provider.Grant.find(grantId))) || new provider.Grant({ accountId, clientId: params.client_id });
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes || {})) grant.addResourceScope(indicator, scopes.join(" "));
    const id = await grant.save();
    console.log(`[oauth] ${s.id} allowed a ChatGPT link`);
    return provider.interactionFinished(req, res, { consent: { grantId: id } }, { mergeWithLastSubmission: true });
  }
  const machine = store.machineOf(s.id);
  const client = await provider.Client.find(details.params.client_id);
  const who = esc(client?.clientName || "ChatGPT");
  const target = machine
    ? `your computer <b>${esc(machine.name)}</b> (${esc(osName(machine.os))})`
    : `your computer. <span class="warn">No computer is paired yet: on your computer, run <b>node scripts/relay.mjs pair</b> first, or tasks will fail until you do.</span>`;
  send(res, 200, page("Allow ChatGPT?", `<div class="card"><p><b>${who}</b> wants to run tasks on ${target}</p>
<p class="muted">Signed in as ${esc(s.email)}. Risky steps still ask on your computer first. You can remove this access any time on your <a href="/account">account page</a>.</p>
<form method="post" action="${here}/confirm"><input type="hidden" name="csrf" value="${csrf(s, `ic.${uid}`)}"><button class="primary">Allow</button></form>
<form method="post" action="${here}/abort"><input type="hidden" name="csrf" value="${csrf(s, `ia.${uid}`)}"><button>Cancel</button></form></div>`));
}
const osName = (o) => ({ darwin: "Mac", win32: "Windows", linux: "Linux" })[o] || "computer";

// ---- Pairing (device-code style; docs/plan-relay.md §5) ----
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const userCode = () => Array.from(crypto.randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("") + "-" + String(crypto.randomInt(0, 10000)).padStart(4, "0");
const PAIR_SECONDS = 600;

async function pairing(req, res, url) {
  const p = url.pathname;
  if (p === "/pair/start" && req.method === "POST") {
    if (limited(`pair:${clientIp(req)}`, 10, 3600000)) return json(res, 429, { error: "too many pairing attempts; try again later" });
    const b = await readJson(req);
    let okKey = false;
    try {
      okKey = crypto.createPublicKey({ key: Buffer.from(String(b?.public_key || ""), "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
    } catch {}
    if (!okKey) return json(res, 400, { error: "public_key must be an Ed25519 SPKI key, base64" });
    const code = userCode();
    const deviceCode = crypto.randomBytes(32).toString("base64url");
    store.addPairing({
      deviceCode, userCode: code, publicKey: b.public_key,
      name: String(b.machine_name || "computer").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 60) || "computer",
      os: ["darwin", "win32", "linux"].includes(b.os) ? b.os : "other",
      bridgeVersion: String(b.bridge_version || "").slice(0, 20), expiresAt: Math.floor(Date.now() / 1000) + PAIR_SECONDS,
    });
    return json(res, 200, { pair_code: code, verify_url: `${PUBLIC_URL}/pair?code=${code}`, device_code: deviceCode, interval: 3, expires_in: PAIR_SECONDS });
  }
  if (p === "/pair/poll" && req.method === "POST") {
    const b = await readJson(req);
    const row = typeof b?.device_code === "string" ? store.pairingByDevice(b.device_code) : null;
    if (!row || row.expires_at < Date.now() / 1000) {
      if (row) store.deletePairing(row.device_code);
      return json(res, 200, { status: "expired" });
    }
    if (row.status === "pending") return json(res, 200, { status: "pending" });
    store.deletePairing(row.device_code);
    if (row.status === "denied") return json(res, 200, { status: "denied" });
    return json(res, 200, { status: "approved", machine_id: row.machine_id, account_email: store.account(row.account_id)?.email, mcp_url: MCP_URL });
  }
  if (p === "/pair") {
    const s = session(req);
    const code = String((req.method === "POST" ? "" : url.searchParams.get("code")) || "").toUpperCase().trim();
    if (!s) return needLogin(res, `/pair${code ? `?code=${encodeURIComponent(code)}` : ""}`);
    if (req.method === "POST") {
      const f = await readForm(req);
      const row = store.pairingByCode(String(f.code || "").toUpperCase());
      if (!row || !csrfOk(s, `pair.${row.user_code}`, f.csrf) || row.status !== "pending" || row.expires_at < Date.now() / 1000)
        return send(res, 400, page("Code expired", "<p>That code is no longer valid. Run the pair command again on your computer.</p>"));
      if (f.action !== "connect") {
        store.setPairing(row.device_code, { status: "denied" });
        return send(res, 200, page("Cancelled", "<p>Nothing was connected. You can close this tab.</p>"));
      }
      const old = store.machineOf(s.id);
      const machineId = store.addMachine({ accountId: s.id, name: row.name, os: row.os, bridgeVersion: row.bridge_version, publicKey: row.public_key });
      if (old) pipe.kick(old.id, 4003, "replaced by a new computer");
      store.setPairing(row.device_code, { status: "approved", account_id: s.id, machine_id: machineId });
      console.log(`[pair] ${s.id} paired ${machineId}${old ? ` (replaced ${old.id})` : ""}`);
      return send(res, 200, page("Computer connected", `<div class="card"><p><b>${esc(row.name)}</b> is now connected to ${esc(s.email)}.</p><p>Go back to your computer; setup continues there.</p></div>`));
    }
    const row = code ? store.pairingByCode(code) : null;
    if (!row || row.status !== "pending" || row.expires_at < Date.now() / 1000)
      return send(res, 200, page("Connect a computer", `<div class="card"><form method="get" action="/pair"><p>Type the code shown on your computer:</p><input name="code" required placeholder="ABCD-1234" autocomplete="off"><p><button class="primary">Continue</button></p></form></div>${code ? '<p class="warn">That code is not valid or has expired.</p>' : ""}`));
    const old = store.machineOf(s.id);
    return send(res, 200, page("Connect this computer?", `<div class="card"><p>Connect <b>${esc(row.name)}</b> (${esc(osName(row.os))}) to <b>${esc(s.email)}</b>?</p>
<p>Check that your computer shows this code:</p><p><code>${esc(row.user_code)}</code></p>
${old ? `<p class="warn">This replaces your current computer, <b>${esc(old.name)}</b>. It will stop working with ChatGPT.</p>` : ""}
<form method="post" action="/pair"><input type="hidden" name="code" value="${esc(row.user_code)}"><input type="hidden" name="csrf" value="${csrf(s, `pair.${row.user_code}`)}">
<button class="primary" name="action" value="connect">Connect</button><button name="action" value="cancel">Cancel</button></form>
<p class="muted">If you did not start this on your own computer just now, press Cancel.</p></div>`));
  }
  if (p === "/machine/unpair" && req.method === "POST") {
    const v = pipe.verifyMachine(req.headers.authorization);
    if (!v.machine) return json(res, 401, { error: "unknown computer" });
    store.removeMachine(v.machine.id);
    pipe.kick(v.machine.id, 4003, "unpaired");
    console.log(`[pair] ${v.machine.id} unpaired itself`);
    return json(res, 200, { ok: true });
  }
  return send(res, 404, page("Not found", "<p>No such page.</p>"));
}

// ---- Account page: computer, ChatGPT links, revoke and unlink ----
async function account(req, res, url) {
  const s = session(req);
  if (!s) return needLogin(res, "/account");
  if (req.method === "POST") {
    const f = await readForm(req);
    if (url.pathname === "/account/revoke" && csrfOk(s, `revoke.${f.grant}`, f.csrf)) {
      const g = store.grants(s.id).find((x) => x.id === f.grant);
      if (g) {
        const grant = await provider.Grant.find(g.id);
        if (grant) await grant.destroy();
        await new (store.adapterClass())("AccessToken").revokeByGrantId(g.id);
        pipe.revokeChatgpt(s.id);
        pipe.pushGrants(s.id);
        console.log(`[account] ${s.id} revoked a ChatGPT link`);
      }
    } else if (url.pathname === "/account/unlink" && csrfOk(s, "unlink", f.csrf)) {
      const m = store.machineOf(s.id);
      if (m) {
        store.removeMachine(m.id);
        pipe.kick(m.id, 4003, "unlinked");
        console.log(`[account] ${s.id} unlinked ${m.id}`);
      }
    } else return send(res, 403, page("Expired", '<p>Please <a href="/account">reload the page</a> and try again.</p>'));
    return redirect(res, "/account");
  }
  const m = store.machineOf(s.id);
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const grants = store.grants(s.id);
  const rows = grants.length
    ? grants.map((g) => `<li>${esc(store.clientName(g.clientId))}, linked ${day(g.iat || 0)} <form method="post" action="/account/revoke" style="display:inline"><input type="hidden" name="grant" value="${esc(g.id)}"><input type="hidden" name="csrf" value="${csrf(s, `revoke.${g.id}`)}"><button>Remove</button></form></li>`).join("")
    : "<li>None yet. Add GPTWorkRouter in ChatGPT to link it.</li>";
  send(res, 200, page("Your GPTWorkRouter", `<p class="muted">Signed in as ${esc(s.email)}</p>
<div class="card"><b>Computer</b><p>${m ? `${esc(m.name)} (${esc(osName(m.os))}), paired ${day(m.created_at)}, ${pipe.online(m.id) ? "connected now" : "not connected right now"}` : "None paired. On your computer, run <b>node scripts/relay.mjs pair</b>."}</p>
${m ? `<form method="post" action="/account/unlink"><input type="hidden" name="csrf" value="${csrf(s, "unlink")}"><button>Unlink this computer</button></form>` : ""}</div>
<div class="card"><b>ChatGPT accounts linked</b><ul>${rows}</ul><p class="muted">Removing a link makes that ChatGPT account sign in again before it can run tasks.</p></div>
<form method="post" action="/logout"><button>Sign out</button></form>`));
}

// ---- The MCP front door ----
function logLine(fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...fields }) + "\n";
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(LOG_DIR, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 });
  } catch {}
}
const clean = (v) => String(v ?? "-").replace(/[^\w.\-/]/g, "").slice(0, 80) || "-";

async function mcp(req, res) {
  const started = Date.now();
  const token = /^Bearer (\S+)$/i.exec(String(req.headers.authorization || ""))?.[1];
  const challenge = (err) => `Bearer resource_metadata="${PRM_URL}", scope="mcp"${err ? `, error="invalid_token", error_description="${err}"` : ""}`;
  if (!token) return json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge() });
  const at = await provider.AccessToken.find(token).catch(() => undefined);
  const aud = at && [].concat(at.aud || []);
  const acct = at && store.account(at.accountId);
  if (!at || at.isExpired || !aud.includes(MCP_URL) || !acct || acct.disabled)
    return json(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge("The access token is invalid or expired") });
  if (limited(`acct:${acct.id}`, 120, 60000)) return json(res, 429, { error: "too many requests; slow down" }, { "retry-after": "30" });
  let body;
  try {
    body = ["GET", "HEAD", "DELETE"].includes(req.method) ? Buffer.alloc(0) : await readBody(req, 4 * 1024 * 1024);
  } catch (err) {
    return json(res, err.status || 400, { error: err.status === 413 ? "request too large" : "bad request" });
  }
  const machine = store.machineOf(acct.id);
  const conn = pipe.get(machine?.id);
  let r;
  if (conn) r = await pipe.forward(conn, req, res, body);
  else r = offline(req, res, body, machine ? OFFLINE : UNPAIRED);
  logLine({ account: acct.id, machine: machine?.id || "-", method: clean(req.headers["mcp-method"] || req.method), name: clean(req.headers["mcp-name"]), status: r.status, ms: Date.now() - started, bytes_in: body.length, bytes_out: r.bytesOut });
}

// The computer is not connected: answer in MCP terms (never 401, or ChatGPT would loop into sign-in).
function offline(req, res, body, message) {
  if (req.method !== "POST") {
    json(res, 503, { error: message });
    return { status: 503, bytesOut: 0 };
  }
  let m = null;
  try { m = JSON.parse(body.toString("utf8")); } catch {}
  if (!m || Array.isArray(m) || m.jsonrpc !== "2.0") {
    json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return { status: 400, bytesOut: 0 };
  }
  if (m.id === undefined) {
    res.writeHead(202).end();
    return { status: 202, bytesOut: 0 };
  }
  const v = String(req.headers["mcp-protocol-version"] || m.params?._meta?.["io.modelcontextprotocol/protocolVersion"] || "");
  const out = m.method === "tools/call"
    ? { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: message }], isError: true, ...(v >= "2026-07-28" ? { resultType: "complete" } : {}) } }
    : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message } };
  const text = JSON.stringify(out);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(text);
  return { status: 200, bytesOut: text.length };
}

// ---- Installer downloads (the repo is private, so the relay serves them) ----
const TYPES = { ".sh": "text/x-shellscript; charset=utf-8", ".ps1": "text/plain; charset=utf-8", ".json": "application/json", ".zip": "application/zip", ".tgz": "application/gzip", ".gz": "application/gzip", ".txt": "text/plain; charset=utf-8" };
function download(req, res, p) {
  let rel = null, immutable = false;
  if (p === "/install.sh" || p === "/install.ps1" || p === "/releases/latest.json") rel = p.slice(1);
  const m = /^\/releases\/(v?\d+\.\d+\.\d+(?:-[\w.]+)?)\/([\w][\w.-]*)$/.exec(p);
  if (m && !m[2].includes("..")) (rel = `releases/${m[1]}/${m[2]}`), (immutable = true);
  if (!rel) return false;
  const file = path.join(DOWNLOADS, rel);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, page("Not found", "<p>No such download.</p>"));
    const name = path.basename(file);
    res.writeHead(200, {
      "content-type": name === "SHA256SUMS" ? "text/plain; charset=utf-8" : TYPES[path.extname(name)] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

// ---- Routing ----
const PRM = JSON.stringify({ resource: MCP_URL, authorization_servers: [PUBLIC_URL], scopes_supported: ["mcp"], bearer_methods_supported: ["header"], resource_name: "GPTWorkRouter" });
async function route(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;
  if (p === "/mcp") return mcp(req, res);
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")
    return res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=300" }).end(PRM);
  if (p === "/healthz") return json(res, 200, { ok: true, computers_connected: pipe.count() });
  if (p === "/login" || p.startsWith("/login/") || p === "/logout") return login(req, res, url);
  if (p === "/pair" || p.startsWith("/pair/") || p === "/machine/unpair") return pairing(req, res, url);
  if (p === "/account" || p.startsWith("/account/")) return account(req, res, url);
  const ia = /^\/interaction\/([\w-]+)(?:\/(confirm|abort))?$/.exec(p);
  if (ia) return interaction(req, res, ia[1], ia[2]);
  if ((req.method === "GET" || req.method === "HEAD") && download(req, res, p)) return;
  if (p === "/") return send(res, 200, page("GPTWorkRouter", `<p>This is the GPTWorkRouter relay. It connects ChatGPT to GPTWorkRouter on your own computer.</p><p><a class="btn primary" href="/account">Your account</a></p>`));
  return oidc(req, res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const expired = err instanceof errors.SessionNotFound || err?.name === "SessionNotFound";
    if (!expired) console.error(`[http] ${req.method} ${new URL(req.url, PUBLIC_URL).pathname}: ${err.message}`);
    if (res.headersSent) return res.end();
    send(res, expired ? 400 : err.status || 500, page(expired ? "This sign-in expired" : "Something went wrong", `<p>${expired ? "Start again from ChatGPT." : "Please try again."}</p>`));
  });
});
server.keepAliveTimeout = 65000;
server.on("upgrade", (req, socket, head) => pipe.handleUpgrade(req, socket, head));

// Hourly: expired OAuth records and pairing codes, and request logs older than 30 days.
const sweep = () => {
  try {
    store.sweep();
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const f of fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []) {
      const d = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1];
      if (d && d < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
    }
  } catch (err) {
    console.error(`[sweep] ${err.message}`);
  }
};
setInterval(sweep, 3600000).unref();
sweep();

server.listen(PORT, HOST, () => {
  console.log(`GPTWorkRouter relay on ${HOST}:${PORT}, public ${PUBLIC_URL}, MCP ${MCP_URL}`);
  console.log(`Sign-in: ${[google && "Google", github && "GitHub", DEV_LOGIN && "dev (local only)"].filter(Boolean).join(", ") || "none configured"}`);
});
const shutdown = () => {
  pipe.close();
  server.close();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
