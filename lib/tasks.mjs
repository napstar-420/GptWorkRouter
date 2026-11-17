// Task runner: each task is a Codex thread. Every change is saved to disk, so a
// bridge restart loses nothing: finished results stay readable, and tasks that
// were running are resumed on the same Codex thread.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { Codex } from "@openai/codex-sdk";
import { parse as parseToml } from "smol-toml";
import { config } from "./config.mjs";
import { audit } from "./audit.mjs";
import { redact } from "./redact.mjs";
import { askApproval, CAPABILITIES } from "./approval.mjs";
import { notifyCommand, userCommand } from "./desktop.mjs";
import { inside } from "./files.mjs";
import { checkpoint, changedSince, restore } from "./checkpoint.mjs";

// The permissions Codex will actually run with: the user's ~/.codex/config.toml,
// unless the operator overrode them with environment variables.
export function codexPermissions() {
  let toml = {};
  const warnings = [];
  const file = path.join(config.codexHome, "config.toml");
  try {
    toml = parseToml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`Could not read ${file} (${err.message.split("\n")[0]}); Codex may refuse to start.`);
  }
  // A selected Codex profile overrides the top-level settings.
  const profile = typeof toml.profile === "string" ? toml.profiles?.[toml.profile] : undefined;
  if (profile && typeof profile === "object") toml = { ...toml, ...profile };
  const sandbox = config.codexSandbox || toml.sandbox_mode || "read-only";
  const network =
    config.codexNetwork ?? (sandbox === "danger-full-access" ? true : Boolean(toml.sandbox_workspace_write?.network_access));
  const p = {
    sandbox,
    approval: config.codexApproval || (typeof toml.approval_policy === "string" ? toml.approval_policy : "default"),
    network,
    source: config.codexSandbox || config.codexApproval || config.codexNetwork !== undefined ? "bridge override" : "user's Codex config",
  };
  if (sandbox === "read-only") {
    warnings.push(
      "Codex is read-only: tasks can read but not create or change files. To allow edits, set " +
        'sandbox_mode = "workspace-write" in ~/.codex/config.toml (or start the bridge with CODEX_SANDBOX=workspace-write).',
    );
  }
  // Windows (tested on 11 build 26300): with no [windows] sandbox, Codex refuses every command
  // ("blocked by policy"); "unelevated" runs them but does not block network; "mxc" holds.
  if (process.platform === "win32" && sandbox !== "danger-full-access") {
    p.windows_sandbox = typeof toml.windows?.sandbox === "string" ? toml.windows.sandbox : "not set";
    if (p.windows_sandbox !== "mxc")
      warnings.push(
        `Codex's Windows sandbox is ${p.windows_sandbox === "not set" ? "not set, so Codex refuses every command" : `"${p.windows_sandbox}", which does not block network`}. ` +
          'Add this to ~/.codex/config.toml:  [windows]  sandbox = "mxc"',
      );
  }
  // With approval "never", Codex denies any MCP tool call that needs approval unless the
  // server (default_tools_approval_mode) or a tool (approval_mode) is set to "approve".
  if (p.approval === "never") {
    const servers = toml.mcp_servers && typeof toml.mcp_servers === "object" ? toml.mcp_servers : {};
    const blocked = Object.entries(servers)
      .filter(([, s]) => s?.enabled !== false && s?.default_tools_approval_mode !== "approve")
      .filter(([, s]) => !Object.values(s?.tools ?? {}).some((t) => t?.approval_mode === "approve"))
      .map(([name]) => name);
    if (blocked.length) {
      p.mcp_needs_approval = blocked;
      warnings.push(
        `approval_policy is "never", so Codex will refuse tools from these MCP servers: ${blocked.join(", ")}. ` +
          'To allow one, add default_tools_approval_mode = "approve" under its [mcp_servers.<name>] entry in ~/.codex/config.toml.',
      );
    }
  }
  if (warnings.length) p.warning = warnings.join(" ");
  return p;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__"]);
const ACTIVE = new Set(["running", "queued", "awaiting_approval"]);

function snapshot(root) {
  const seen = new Map();
  const walk = (dir) => {
    if (seen.size >= 20000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          seen.set(path.relative(root, full), `${st.size}:${st.mtimeMs}`);
        } catch {}
      }
    }
  };
  walk(root);
  return seen;
}

function diffSnapshots(before, after) {
  const out = [];
  for (const [f, sig] of after) {
    if (!before.has(f)) out.push(`added ${f}`);
    else if (before.get(f) !== sig) out.push(`modified ${f}`);
  }
  for (const f of before.keys()) if (!after.has(f)) out.push(`deleted ${f}`);
  return out;
}

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + ` …[+${s.length - max} chars]` : s;
};

function describe(item) {
  switch (item.type) {
    case "command_execution":
      return `ran: ${clip(item.command, 160)} (${item.status}${item.exit_code === undefined ? "" : `, exit ${item.exit_code}`})`;
    case "file_change":
      return `files: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")} (${item.status})`;
    case "mcp_tool_call":
      return `app: ${item.server}.${item.tool} (${item.status})`;
    case "web_search":
      return `searched: ${clip(item.query, 120)}`;
    case "todo_list":
      return `plan: ${item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join(" | ")}`;
    case "error":
      return `error: ${clip(item.message, 300)}`;
    case "agent_message":
      return `note: ${clip(item.text, 300)}`;
    default:
      return null;
  }
}

// Codex inherits the bridge's environment by default. Keep the bridge's own
// secrets out of it (the tunnel key must not be readable by commands Codex runs),
// and drop API keys so tasks always run on the user's ChatGPT sign-in, never on
// pay-per-use API billing.
const WITHHELD = new Set(["CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "TUNNEL_CLIENT", "TUNNEL_PROFILE", "GWR_RELAY_KEY"]);
export function codexEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !WITHHELD.has(k)));
}

export function folderPath(folder) {
  let target;
  if (!folder) target = config.workspaceRoot;
  else if ((process.platform === "win32" ? /^~([\\/]|$)/ : /^~(\/|$)/).test(folder)) target = path.join(os.homedir(), folder.slice(1));
  else if (path.isAbsolute(folder)) target = folder;
  else target = path.join(config.workspaceRoot, folder);
  return path.resolve(target);
}

export function resolveFolder(folder) {
  const target = folderPath(folder);
  fs.mkdirSync(target, { recursive: true });
  return fs.realpathSync(target);
}

// A desktop notification when a task ends, so a regular Chat (which only polls) can be
// picked up again. Text is passed as arguments, never spliced into the script: task
// results can contain anything. Fire and forget; a failure never affects the task.
export function notifyFinished(task) {
  if (!config.notify || !["completed", "failed", "interrupted"].includes(task.status)) return;
  const title = `GPTWorkRouter: task ${task.status}`;
  const summary = String((task.status === "completed" ? task.result : task.error) || "").replace(/\s+/g, " ").trim();
  const body = clip(`${path.basename(task.folder)}: ${summary || "no details"}`, 200) + ` (${task.id})`;
  const done = (err) => err && console.error(`[notify] ${err.message}`);
  if (config.notifyCmd) {
    const c = userCommand(config.notifyCmd, [title, body]);
    return execFile(c.cmd, c.args, { windowsHide: true }, done);
  }
  const cmd = notifyCommand(process.platform, title, body);
  if (cmd) execFile(cmd.cmd, cmd.args, cmd.env ? { env: cmd.env, windowsHide: true } : {}, done);
}

export class Tasks {
  constructor(store, events, log = console) {
    this.store = store;
    this.events = events;
    this.log = log;
    this.runtime = new Map(); // id -> { thread, abort, done, openCommands }
    this.pending = new Map(); // id -> promise of an open approval request
    this.shuttingDown = false; // set on exit so running tasks stay "running" and resume next start
    this.codex = new Codex({
      ...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
      env: codexEnv(),
    });
  }

  #threadOptions(folder, granted = []) {
    // Safe by default, whatever the Codex config allows: writes only in the task folder and
    // no network for commands. A capability the user approved on the Mac opens one up. The
    // user's Codex config stays the upper limit (read-only stays read-only).
    const p = codexPermissions();
    return {
      workingDirectory: folder,
      skipGitRepoCheck: true,
      sandboxMode: granted.includes("write_anywhere") ? "danger-full-access" : p.sandbox === "read-only" ? "read-only" : "workspace-write",
      networkAccessEnabled: granted.includes("network"),
      ...(config.codexApproval ? { approvalPolicy: config.codexApproval } : {}),
      ...(config.codexModel ? { model: config.codexModel } : {}),
    };
  }

  // A task may only ask for what the user's own Codex config would allow at all.
  #checkNeeds(needs) {
    const p = codexPermissions();
    for (const n of needs) {
      if (!CAPABILITIES[n]) throw new Error(`Unknown capability ${n}`);
      if (n === "network" && !p.network) {
        throw new Error('This computer does not allow tasks to use the internet. To allow it (each task still needs your approval), add network_access = true under [sandbox_workspace_write] in ~/.codex/config.toml.');
      }
      if (n === "write_anywhere" && p.sandbox !== "danger-full-access") {
        throw new Error('This computer only lets tasks write inside their own folder (Codex sandbox_mode is not "danger-full-access"). Start the task in the folder that needs the changes instead.');
      }
    }
  }

  // Ask the human (Mac dialog); launch on approval, finish as "denied" otherwise.
  #approve(task, needs, reason, text) {
    task.status = "awaiting_approval";
    task.awaiting = { needs, reason: reason || null, at: Date.now() };
    task.updatedAt = Date.now();
    this.store.save(task.id, task);
    audit("approval_requested", { task: task.id, needs, reason, folder: task.folder });
    const p = askApproval({ id: task.id, folder: task.folder, needs, reason, text }).then(({ approved, how }) => {
      audit("approval", { task: task.id, needs, approved, how });
      const t = this.get(task.id);
      if (!t || t.status !== "awaiting_approval" || this.shuttingDown) return; // cancelled meanwhile, or restarting
      delete t.awaiting;
      if (approved) {
        t.granted = [...new Set([...(t.granted || []), ...needs])];
        this.store.save(t.id, t);
        this.#launchOrQueue(t, text, { resume: Boolean(t.threadId) });
        return this.runtime.get(t.id)?.done;
      }
      t.status = "denied";
      t.error = `Not approved (${how}). Nothing was run.`;
      t.updatedAt = Date.now();
      this.store.save(t.id, t);
      this.events.emitTaskFinished(t);
    });
    this.pending.set(task.id, p);
    p.finally(() => this.pending.delete(task.id));
  }

  get(id) {
    return this.store.load(id);
  }

  list(owner) {
    return this.store
      .all()
      .filter((t) => t.owner === owner)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  runningCount() {
    return this.store.all().filter((t) => t.status === "running").length;
  }

  // At most maxRunning Codex processes; the rest wait in line (oldest first) instead of
  // failing, so a chat that starts a task while others run just keeps polling.
  #launchOrQueue(task, prompt, { resume }) {
    if (this.#canRun(task.folder)) return this.#launch(task, prompt, { resume });
    task.status = "queued";
    task.queued = { at: Date.now(), prompt, resume };
    task.updatedAt = Date.now();
    this.store.save(task.id, task);
  }

  // A free slot, and no other task working in the same folder (or one inside or above it):
  // two agents editing the same files would overwrite each other and mix up file lists and undo.
  #sameFolderBusy(folder) {
    return [...this.runtime.values()].some((rt) => inside(rt.folder, folder) || inside(folder, rt.folder));
  }

  #canRun(folder) {
    return this.runtime.size < config.maxRunning && !this.#sameFolderBusy(folder);
  }

  #drain() {
    if (this.shuttingDown) return;
    const waiting = this.store.all().filter((t) => t.status === "queued").sort((a, b) => a.queued.at - b.queued.at);
    for (const t of waiting) {
      if (this.runtime.size >= config.maxRunning) break;
      if (this.#sameFolderBusy(t.folder)) continue; // a later task in another folder may go first
      const { prompt, resume } = t.queued;
      delete t.queued;
      this.#launch(t, prompt, { resume });
    }
  }

  // On startup: anything that was running when the bridge stopped is resumed on
  // its Codex thread (or marked interrupted if it never got a thread).
  recover() {
    for (const t of this.store.all()) {
      if (!ACTIVE.has(t.status) || t.status === "queued") continue;
      if (t.status === "awaiting_approval") {
        // Never resume past an unanswered approval.
        t.status = "interrupted";
        t.error = "The bridge restarted while waiting for approval. Use continue_task (with the same needs) to ask again.";
        delete t.awaiting;
        t.updatedAt = Date.now();
        this.store.save(t.id, t);
        this.events.emitTaskFinished(t);
      } else if (config.autoResume && t.threadId) {
        t.log.push("bridge restarted: resuming on the same Codex thread");
        this.store.save(t.id, t);
        this.#launch(
          t,
          "The tool that was running you restarted while you were working, so your last command may not have finished. " +
            "Check the current state of the working folder, finish whatever is left of the original request, and report the result.",
          { resume: true },
        );
        this.log.log(`[tasks] resumed ${t.id}`);
      } else {
        t.status = "interrupted";
        t.error = "The bridge restarted before this task got going. Use continue_task to run it again.";
        t.updatedAt = Date.now();
        this.store.save(t.id, t);
        this.#finished(t);
      }
    }
    this.#drain(); // tasks that were waiting in line before the restart
  }

  start({ brief, folder, owner, needs = [], reason }) {
    if (this.shuttingDown) throw new Error("The bridge is restarting. Try again in a few seconds.");
    needs = [...new Set(needs)];
    this.#checkNeeds(needs);
    const id = crypto.randomBytes(4).toString("hex");
    // Never run in the work-area root: other tasks' project folders live under it, so its
    // file list and undo would pick up their changes. No folder (or the root) = its own folder.
    // A user-named parent of another task's folder (e.g. ~/dev) never runs at the same time as it (#sameFolderBusy).
    let dir = resolveFolder(folder);
    const auto = dir === resolveFolder("");
    if (auto) dir = resolveFolder(`task-${id}`);
    const now = Date.now();
    const task = {
      id,
      ...(auto ? { autoFolder: true } : {}),
      owner,
      folder: dir,
      turns: [{ at: now, instruction: brief }],
      status: "running",
      result: null,
      error: null,
      log: [],
      files: [],
      threadId: null,
      granted: [],
      checkpoints: [],
      startedAt: now,
      updatedAt: now,
    };
    this.store.save(task.id, task);
    audit("brief", { task: task.id, folder: dir, needs, reason, text: brief });
    if (needs.length) this.#approve(task, needs, reason, brief);
    else this.#launchOrQueue(task, brief, { resume: false });
    return task;
  }

  continue(id, instruction, owner, needs = [], reason) {
    if (this.shuttingDown) throw new Error("The bridge is restarting. Try again in a few seconds.");
    const task = this.#owned(id, owner);
    if (ACTIVE.has(task.status)) throw new Error("Task is still running. Wait for it or cancel it first.");
    // Approvals last one run, so any needs here go back to the user.
    const fresh = [...new Set(needs)].filter((n) => !(task.granted || []).includes(n));
    this.#checkNeeds(fresh);
    task.turns.push({ at: Date.now(), instruction });
    this.store.save(task.id, task);
    audit("instruction", { task: task.id, needs, reason, text: instruction });
    if (fresh.length) this.#approve(task, fresh, reason, instruction);
    else this.#launchOrQueue(task, instruction, { resume: Boolean(task.threadId) });
    return this.get(id);
  }

  // Put the task's folder back as it was before the task's first run.
  undo(id, owner, { force = false } = {}) {
    const task = this.#owned(id, owner);
    fs.mkdirSync(task.folder, { recursive: true });
    if (ACTIVE.has(task.status)) throw new Error("Task is still running. Cancel it first.");
    const cps = task.checkpoints || [];
    if (task.undone && task.undone.runs === cps.length) throw new Error("Already undone; nothing has run since.");
    const first = cps.find((c) => c.before);
    if (!first) throw new Error(`No checkpoint for this task${cps[0]?.skipped ? ` (${cps[0].skipped})` : ""}; nothing to undo.`);
    const last = [...cps].reverse().find((c) => c.after);
    if (last && !force) {
      const later = changedSince(task.id, task.folder, last.after);
      if (later.length) {
        throw new Error(
          `These files changed after the task finished (by you or another task): ${later.slice(0, 10).join(", ")}${later.length > 10 ? " …" : ""}. ` +
            "Undo would overwrite those changes too. Ask the user; pass force: true only if they agree.",
        );
      }
    }
    const r = restore(task.id, task.folder, first.before);
    task.undone = { at: Date.now(), saved: r.saved, runs: cps.length };
    task.updatedAt = Date.now();
    this.store.save(task.id, task);
    audit("undo", { task: task.id, folder: task.folder, force, restored: r.changed.length, saved: r.saved });
    return {
      task_id: task.id,
      folder: task.folder,
      restored_to: "the folder as it was before this task started",
      files_restored: r.changed.slice(0, 50),
      ...(r.changed.length > 50 ? { files_restored_total: r.changed.length } : {}),
      note: `The state just before the undo was saved (checkpoint ${r.saved.slice(0, 10)}), so nothing is lost.`,
    };
  }

  async cancel(id, owner) {
    const task = this.#owned(id, owner);
    audit("cancel", { task: id });
    if (task.status === "awaiting_approval" || task.status === "queued") {
      task.status = "cancelled";
      delete task.awaiting;
      delete task.queued;
      task.updatedAt = Date.now();
      this.store.save(id, task);
      this.events.emitTaskFinished(task);
      return task;
    }
    const rt = this.runtime.get(id);
    if (rt && ACTIVE.has(task.status)) {
      rt.cancelled = true;
      rt.abort.abort();
      await Promise.race([rt.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    return this.get(id);
  }

  // On shutdown: stop the Codex processes so they release their thread (a live
  // orphan keeps the thread's write lock and the resume after restart is refused).
  // shuttingDown keeps these tasks "running", so recover() resumes them next start.
  async stopAll() {
    this.shuttingDown = true;
    const running = [...this.runtime.values()];
    for (const rt of running) {
      rt.shutdown = true;
      rt.abort.abort();
    }
    await Promise.race([Promise.all(running.map((rt) => rt.done)), new Promise((r) => setTimeout(r, 5000))]);
  }

  async waitFor(id, seconds) {
    const deadline = Date.now() + Math.min(Math.max(seconds ?? 30, 0), config.maxWaitSeconds) * 1000;
    for (;;) {
      const t = this.get(id);
      const left = deadline - Date.now();
      if (!t || !ACTIVE.has(t.status) || left <= 0) return t;
      const until = this.runtime.get(id)?.done || this.pending.get(id);
      if (!until && t.status !== "queued") return t;
      await Promise.race([until || new Promise((r) => setTimeout(r, 1000)), new Promise((r) => setTimeout(r, until ? left : Math.min(left, 1000)))]);
    }
  }

  #finished(task) {
    this.events.emitTaskFinished(task);
    notifyFinished(task);
  }

  #owned(id, owner) {
    const task = this.get(id);
    if (!task || task.owner !== owner) throw new Error(`No task ${id}`);
    return task;
  }

  #launch(task, prompt, { resume }) {
    fs.mkdirSync(task.folder, { recursive: true }); // an empty auto folder is removed after its run
    task.granted ||= [];
    task.checkpoints ||= [];
    const run = task.checkpoints.length + 1;
    const cp = checkpoint(task.id, task.folder, `before run ${run}`);
    const cpEntry = { run, ...(cp.commit ? { before: cp.commit } : { skipped: cp.skipped }) };
    task.checkpoints.push(cpEntry);
    const opts = this.#threadOptions(task.folder, task.granted);
    const thread = resume && task.threadId ? this.codex.resumeThread(task.threadId, opts) : this.codex.startThread(opts);
    const rt = { thread, folder: task.folder, abort: new AbortController(), openCommands: new Set(), cancelled: false, stopReason: null };
    this.runtime.set(task.id, rt);

    task.status = "running";
    task.result = null;
    task.error = null;
    task.updatedAt = Date.now();
    this.store.save(task.id, task);

    let progressAt = Date.now();
    let lastSave = 0;
    const runStarted = Date.now();
    const before = snapshot(task.folder);
    const files = new Set(task.files);
    const save = (force) => {
      if (force || Date.now() - lastSave > 2000) {
        task.files = [...files];
        task.updatedAt = Date.now();
        this.store.save(task.id, task);
        lastSave = Date.now();
      }
    };
    const note = (line) => {
      if (line && task.log[task.log.length - 1] !== line) task.log.push(line);
      if (task.log.length > 200) task.log.splice(0, task.log.length - 200);
    };

    const watchdog = setInterval(() => {
      const busy = rt.openCommands.size > 0; // a slow build or test run is not a stall
      if (!busy && Date.now() - progressAt > config.idleMinutes * 60000) rt.stopReason = `No activity for ${config.idleMinutes} minutes; stopped.`;
      else if (Date.now() - runStarted > config.maxMinutes * 60000) rt.stopReason = `Hit the ${config.maxMinutes}-minute limit; stopped.`;
      if (rt.stopReason) rt.abort.abort();
    }, 15000);
    watchdog.unref();

    rt.done = (async () => {
      let lastStreamError = null;
      try {
        const { events } = await thread.runStreamed(prompt, { signal: rt.abort.signal });
        for await (const ev of events) {
          if (ev.type !== "error") progressAt = Date.now();
          if (ev.type === "thread.started") {
            task.threadId = ev.thread_id;
            save(true); // the thread id is what makes a resume possible
          } else if (ev.type === "item.started" && ev.item.type === "command_execution") {
            rt.openCommands.add(ev.item.id);
            note(`running: ${clip(ev.item.command, 160)}`);
            audit("command", { task: task.id, command: ev.item.command });
          } else if (ev.type === "item.completed") {
            rt.openCommands.delete(ev.item.id);
            if (ev.item.type === "agent_message") task.result = ev.item.text;
            if (ev.item.type === "mcp_tool_call") audit("app_call", { task: task.id, app: `${ev.item.server}.${ev.item.tool}`, args: JSON.stringify(ev.item.arguments ?? null), status: ev.item.status });
            if (ev.item.type === "file_change") audit("file_change", { task: task.id, changes: ev.item.changes.map((c) => `${c.kind} ${c.path}`).join(", ") });
            note(describe(ev.item));
          } else if (ev.type === "turn.completed") {
            task.error = null;
          } else if (ev.type === "turn.failed") {
            task.error = ev.error.message;
          } else if (ev.type === "error") {
            lastStreamError = ev.message; // often transient ("Reconnecting..."); a failed turn decides
            note(`warning: ${clip(ev.message.replace(/\d+\/\d+/, "n"), 200)}`);
          }
          save(false);
        }
        task.status = task.error ? "failed" : "completed";
      } catch (err) {
        if (rt.stopReason) {
          task.status = "failed";
          task.error = `${rt.stopReason}${lastStreamError ? ` Last warning: ${lastStreamError}` : ""}`;
        } else if (rt.cancelled) {
          task.status = "cancelled";
          task.error = null;
        } else {
          task.status = "failed";
          task.error = String(err?.message || err);
        }
      } finally {
        clearInterval(watchdog);
        // Stopped by shutdown: leave it "running" so recover() resumes it on the next start.
        // (A task that finished on its own during shutdown is saved as finished below.)
        if (rt.shutdown) return;
        for (const c of diffSnapshots(before, snapshot(task.folder))) files.add(c);
        if (cpEntry.before) {
          const after = checkpoint(task.id, task.folder, `after run ${run}`);
          if (after.commit) cpEntry.after = after.commit;
        }
        // An approval covers this run only: a follow-up (which might carry instructions an
        // injected page planted in this run's output) must ask the user again.
        task.granted = [];
        save(true);
        this.runtime.delete(task.id);
        // A read-only task (disk check, listing elsewhere) leaves no empty folder behind.
        if (task.autoFolder) try { fs.rmdirSync(task.folder); } catch {}
        this.#finished(task);
        this.#drain();
      }
    })();
  }

  report(task) {
    // Everything Chat sees passes redact(): task output may quote a secret Codex read.
    const out = {
      task_id: task.id,
      status: task.status,
      folder: task.folder,
      minutes_running: Math.round((task.updatedAt - task.startedAt) / 6000) / 10,
      recent_activity: task.log.slice(-8).map(redact),
    };
    if (task.status === "running" && task.log.length === 0) {
      // What this task really has: the sandbox is forced, network only if approved.
      const p = codexPermissions();
      out.codex_permissions = { ...p, sandbox: (task.granted || []).includes("write_anywhere") ? "danger-full-access" : p.sandbox === "read-only" ? "read-only" : "workspace-write", network: (task.granted || []).includes("network") };
    }
    if (task.granted?.length) out.approved_capabilities = task.granted;
    if (task.files.length) {
      out.files_changed = task.files.slice(-50);
      if (task.files.length > 50) out.files_changed_total = task.files.length;
    }
    if (task.status === "awaiting_approval") {
      out.waiting_for = task.awaiting?.needs;
      out.next =
        "A dialog is open on the user's Mac asking them to approve this. Mention it in one short line and keep calling " +
        "check_task with wait_seconds 45 in this same reply: the task starts the moment they approve, and ends as " +
        "'denied' if they refuse or do not answer in 5 minutes. You cannot approve it yourself.";
    } else if (task.status === "queued") {
      const ahead = this.store.all().filter((t) => t.status === "queued" && t.queued.at < task.queued.at).length;
      out.next =
        (this.#sameFolderBusy(task.folder)
          ? "Waiting for another task working in the same folder to finish (so they do not overwrite each other). "
          : `Waiting for a free slot: ${this.runningCount()} other task(s) are running${ahead ? ` and ${ahead} queued ahead` : ""}. `) +
        "It starts by itself. Keep calling check_task with wait_seconds 45 in this same reply; do not give up or do the work another way.";
    } else if (ACTIVE.has(task.status)) {
      out.next =
        "Still working. In a Work chat, subscribe to the task.finished event with this task_id and stop checking; " +
        "in a regular chat, call check_task again (the user gets a desktop notification when it ends).";
    } else if (task.status === "denied") {
      out.next = "The user did not approve it on their Mac. Ask them in chat before trying again; do not retry on your own.";
    } else {
      out.next =
        (task.status === "completed"
          ? "Check the result against what the user asked for; if something is wrong or missing, call continue_task with a precise fix. "
          : "Tell the user the exact error; continue_task can retry or fix it in the same folder. ") +
        (task.files.length ? "get_file reads its files for you only; to let the user see one (a chart, screenshot or document), call show_file. " : "") +
        "Report only what this result confirms, with the files changed and where.";
      if ((task.checkpoints || []).some((c) => c.before) && !task.undone) out.undo_available = true;
    }
    if (!ACTIVE.has(task.status)) {
      if (task.result) out.result = redact(clip(task.result, 12000));
      if (task.error) out.error = redact(clip(task.error, 2000));
    }
    return out;
  }
}
