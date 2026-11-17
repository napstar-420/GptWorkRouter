// Local apps: the user's own MCP servers (BrowserOS neo, Blender, ...) made
// callable from ChatGPT through the bridge, so Chat can drive them directly
// instead of going through a Codex task.
//
// Where apps come from:
//   1. [mcp_servers.*] in the user's Codex config (~/.codex/config.toml), the
//      same apps their Codex tasks can already use;
//   2. apps.json (~/.gptworkrouter/apps.json or next to server.mjs), which can add or override servers.
// Nothing is exposed to Chat unless its name is listed in apps.json "expose".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { config } from "./config.mjs";

const SEP = "__";
const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function codexServers() {
  try {
    const toml = parseToml(fs.readFileSync(path.join(config.codexHome, "config.toml"), "utf8"));
    return toml.mcp_servers || {};
  } catch {
    return {};
  }
}

// ~/.gptworkrouter/apps.json, or apps.json next to server.mjs.
export function appsConfigPath() {
  const candidates = [path.join(config.dataDir, "apps.json"), path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps.json")];
  return path.resolve(candidates.find((f) => fs.existsSync(f)) || candidates[0]);
}

export class Apps {
  constructor(log = console) {
    this.log = log;
    this.apps = new Map(); // name -> { def, client, tools, status, error }
  }

  async start() {
    const file = readJson(appsConfigPath()) || {};
    const servers = { ...codexServers(), ...(file.servers || {}) };
    const expose = new Set(file.expose || []);
    const allow = file.tools || {};
    for (const [name, def] of Object.entries(servers)) {
      if (def?.enabled === false) continue;
      this.apps.set(name, {
        name,
        def,
        exposed: expose.has(name),
        allow: allow[name] || def.enabled_tools || null,
        deny: def.disabled_tools || [],
        client: null,
        tools: [],
        status: "idle",
      });
    }
    await Promise.all([...this.apps.values()].filter((a) => a.exposed).map((a) => this.#connect(a)));
    // Apps that were not running yet (e.g. the browser was closed) are retried,
    // so they appear in Chat once they start, without restarting the bridge.
    this.retry = setInterval(() => {
      for (const a of this.apps.values()) {
        if (a.exposed && a.status !== "connected" && !a.connecting) this.#connect(a, { quiet: true });
      }
    }, 30000);
    this.retry.unref();
  }

  async #connect(app, { quiet = false } = {}) {
    const d = app.def;
    app.connecting = true;
    try {
      let transport;
      if (d.url) {
        const headers = { ...(d.http_headers || d.headers || {}) };
        if (d.bearer_token_env_var && process.env[d.bearer_token_env_var]) {
          headers.Authorization = `Bearer ${process.env[d.bearer_token_env_var]}`;
        }
        transport = new StreamableHTTPClientTransport(new URL(d.url), { requestInit: { headers } });
      } else if (d.command) {
        transport = new StdioClientTransport({
          command: d.command,
          args: d.args || [],
          env: { ...process.env, ...(d.env || {}) },
          cwd: d.cwd,
          stderr: "ignore",
        });
      } else {
        throw new Error("needs either command or url");
      }
      const client = new Client({ name: "gpt-work-router", version: "3.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      app.client = client;
      app.tools = tools.filter((t) => (!app.allow || app.allow.includes(t.name)) && !app.deny.includes(t.name));
      app.status = "connected";
      app.error = undefined;
      transport.onclose = () => {
        app.status = "disconnected";
        app.client = null;
      };
      this.log.log(`[apps] ${app.name}: ${app.tools.length} tools`);
    } catch (err) {
      const was = app.error;
      app.status = "error";
      app.error = String(err?.message || err);
      if (!quiet || was !== app.error) this.log.error(`[apps] ${app.name} not reachable yet (${app.error}); retrying every 30 s`);
    } finally {
      app.connecting = false;
    }
  }

  summary() {
    return [...this.apps.values()].map((a) => ({
      app: a.name,
      exposed_to_chat: a.exposed,
      status: a.exposed ? a.status : "not exposed",
      tools: a.exposed ? a.tools.map((t) => `${slug(a.name)}${SEP}${t.name}`) : [],
      ...(a.error ? { error: a.error } : {}),
    }));
  }

  // Tool definitions as ChatGPT sees them: app__tool, with the app's own schema.
  toolDefinitions() {
    const out = [];
    for (const a of this.apps.values()) {
      if (!a.exposed || a.status !== "connected") continue;
      for (const t of a.tools) {
        const name = `${slug(a.name)}${SEP}${t.name}`.slice(0, 64);
        out.push({
          name,
          title: t.title || t.name,
          description: `[${a.name}, on the user's computer] ${t.description || ""}`.trim(),
          inputSchema: t.inputSchema || { type: "object" },
          annotations: t.annotations,
        });
      }
    }
    return out;
  }

  owns(toolName) {
    return toolName.includes(SEP) && this.toolDefinitions().some((t) => t.name === toolName);
  }

  async call(toolName, args) {
    const i = toolName.indexOf(SEP);
    const appSlug = toolName.slice(0, i);
    const tool = toolName.slice(i + SEP.length);
    const app = [...this.apps.values()].find((a) => slug(a.name) === appSlug);
    if (!app || !app.exposed) throw new Error(`No app for ${toolName}`);
    if (!app.client) await this.#connect(app); // reconnect after the app restarted
    if (!app.client) throw new Error(`${app.name} is not running: ${app.error || "disconnected"}`);
    return app.client.callTool({ name: tool, arguments: args || {} }, { timeout: config.appCallTimeoutMs });
  }

  async stop() {
    clearInterval(this.retry);
    await Promise.all([...this.apps.values()].map((a) => a.client?.close().catch(() => {})));
  }
}
