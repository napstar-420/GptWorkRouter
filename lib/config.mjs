// Settings, all overridable with environment variables.
import os from "node:os";
import path from "node:path";

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const home = os.homedir();

export const config = {
  port: num(process.env.PORT, 3210),
  // Where task history, subscriptions and app settings are kept.
  dataDir: path.resolve(process.env.DATA_DIR || path.join(home, ".gptworkrouter")),
  // Default folder for tasks that don't name one. Tasks may name any absolute path;
  // what Codex may then touch is decided by the user's own Codex settings.
  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || path.join(home, "GPTWork")),
  // Optional overrides. Unset = use the user's ~/.codex/config.toml.
  codexSandbox: process.env.CODEX_SANDBOX || undefined, // read-only | workspace-write | danger-full-access
  codexApproval: process.env.CODEX_APPROVAL || undefined, // never | on-request | on-failure | untrusted
  codexNetwork: process.env.CODEX_NETWORK === undefined ? undefined : process.env.CODEX_NETWORK === "1",
  codexModel: process.env.CODEX_MODEL || undefined,
  codexPath: process.env.CODEX_PATH || undefined,
  codexHome: path.resolve(process.env.CODEX_HOME || path.join(home, ".codex")),
  maxRunning: num(process.env.MAX_RUNNING, 2),
  maxWaitSeconds: 45, // stay under ChatGPT's ~60 s tool-call timeout
  idleMinutes: num(process.env.IDLE_MINUTES, 10),
  maxMinutes: num(process.env.MAX_MINUTES, 60),
  autoResume: process.env.AUTO_RESUME !== "0",
  appCallTimeoutMs: num(process.env.APP_CALL_TIMEOUT_MS, 50000),
  // Optional: let the bridge run tunnel-client (see lib/tunnel.mjs).
  tunnelClient: process.env.TUNNEL_CLIENT || undefined,
  tunnelProfile: process.env.TUNNEL_PROFILE || undefined,
  // Desktop notification when a task ends (macOS). NOTIFY=0 turns it off; NOTIFY_CMD
  // runs your own command instead, called with two arguments: title and message.
  notify: process.env.NOTIFY !== "0",
  notifyCmd: process.env.NOTIFY_CMD || undefined,
  // Approval for risky capabilities: a Mac dialog. APPROVE_CMD runs your own approver
  // instead (called with title and message; exit 0 = approve). No answer in time = deny.
  approveCmd: process.env.APPROVE_CMD || undefined,
  approvalSeconds: num(process.env.APPROVAL_SECONDS, 300),
  // Testing only: allow http:// and private-network webhook URLs.
  allowInsecureWebhooks: process.env.ALLOW_INSECURE_WEBHOOKS === "1",
  // Hosted relay (see lib/relay.mjs, docs/plan-relay.md). Pairing writes relay.json in the data
  // dir; the relay starts whenever that file exists. RELAY_URL is only the default for pairing.
  relayUrl: process.env.RELAY_URL || "https://gptworkrouter-relay.fly.dev",
};
