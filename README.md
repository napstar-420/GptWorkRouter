# GPTWorkRouter bridge v3

Lets ChatGPT, or any MCP client, hand real work to **your** computer:

- **Codex tasks**: Chat writes a brief, a Codex agent on your machine does the work, under your own Codex permissions.
- **Local apps**: Codex tasks use the MCP apps in your Codex config (BrowserOS neo, Blender, …). Optionally, apps can also be exposed to Chat directly (off by default).
- **Survives restarts**: task history is saved; a task interrupted by a restart resumes on the same Codex thread.
- **Tells Chat when it's done**: Work chats get a signed `task.finished` webhook (MCP Events). Regular chats poll.

```
ChatGPT ──> Secure MCP Tunnel ──> bridge (127.0.0.1:3210) ──┬─> Codex (your ~/.codex/config.toml)
   ^                                                         └─> your local MCP apps
   └──────────── task.finished webhook (outbound HTTPS) ─────┘
```

## 1. Install

### Quick install (recommended)

One command. It brings its own Node, Git, Codex and tunnel client, needs no admin rights, and a setup wizard
walks you through Codex sign-in, settings, starting at login and connecting ChatGPT through your own free OpenAI
Secure MCP Tunnel. Run the same command again later to update, repair or uninstall.

macOS (Terminal):

```bash
curl -fsSL https://github.com/napstar-420/GptWorkRouter/releases/latest/download/install.sh | sh
```

Windows 11 (PowerShell, not as administrator):

```powershell
irm https://github.com/napstar-420/GptWorkRouter/releases/latest/download/install.ps1 | iex
```

You need a ChatGPT plan that includes Codex, and an OpenAI Platform account to create the tunnel and a restricted
key (Tunnels: Read and Use); the wizard shows each step. The bridge checks once a day for a newer release and tells
you (in ChatGPT and with a notification); nothing installs by itself. `GWR_NO_UPDATE_CHECK=1` turns the check off.

### From source (developers)

Runs on **macOS and Windows** (Linux later). Needs Node 20+ and the Codex CLI signed in with your ChatGPT account
(tasks use your plan's Codex allowance, not an API key). On Windows, also install Git for Windows (undo_task needs it)
and run the commands below in PowerShell. Windows is tested in a Windows 11 VM (ARM, build 26300), not yet by a real
Windows user. A fresh Windows blocks `npm` in PowerShell ("running scripts is disabled"): type `npm.cmd` instead of
`npm`, or allow scripts for your account once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

```bash
cd gpt-work-router
npm install
npx codex login          # skip if Codex is already signed in
npm test                 # 136 offline checks, ~1 minute, no Codex allowance
npm run selftest         # real Codex end to end incl. kill-and-resume, ~3 minutes
npm start
```

## 2. Permissions come from your Codex config

The bridge does not set its own sandbox. Codex runs with whatever `~/.codex/config.toml` allows, and the
bridge prints it at startup and reports it on every new task. **Codex's default is read-only**, so for
tasks that create or edit files add:

```toml
sandbox_mode = "workspace-write"      # or "danger-full-access" for no sandbox at all
approval_policy = "never"             # nobody is at the terminal to approve
[sandbox_workspace_write]
network_access = true                 # optional: npm install, git clone, web

[windows]
sandbox = "mxc"                       # Windows only: required, see below
```

**Windows:** Codex needs `[windows] sandbox = "mxc"`. Tested on Windows 11 build 26300: with it, writes stay in the
task folder, `.git` is protected, network is off unless you approve it, and an approval lasts one run. Without it
Codex refuses every command, and `"unelevated"` runs them but does not block network. The bridge warns at startup
(and in `/health`) when it is missing. MXC needs a recent Windows 11; on an older build that cannot run it, Codex
refuses commands rather than run them unsandboxed. Codex's sandbox also needs your desktop session: run the bridge
from a terminal on your desktop or as the login task below, not over SSH or as a service.

Tasks may name any folder (`~/dev/site`, `/Users/me/x`) or a short name under `~/GPTWork`. What Codex
can touch there is decided by the sandbox above.

## 3. Local apps

Codex tasks can use every app in `[mcp_servers.*]` of your Codex config; BrowserOS neo adds itself there when you
click Connect next to Codex on its Connected agents page.

**With `approval_policy = "never"`, Codex refuses any MCP tool that needs approval** (nobody is there to approve it).
Allow each app the tasks should use:

```toml
[mcp_servers.browseros-neo]
url = "http://127.0.0.1:9010/mcp"
default_tools_approval_mode = "approve"   # or per tool: [mcp_servers.<name>.tools.<tool>] approval_mode = "approve"
```

The bridge lists servers missing this at startup, in `/health` (`codex.mcp_needs_approval`) and on new tasks.
Codex reads its config when each task starts, so no restart is needed.

### Optional: expose apps to Chat directly

Apps come from `[mcp_servers.*]` in your Codex config (Codex tasks can use them all) plus
`apps.json` (in `~/.gptworkrouter/` or next to `server.mjs`). Only apps listed in `expose` become tools Chat can call directly:

```json
{
  "expose": ["browseros"],
  "servers": {
    "browseros": { "url": "http://127.0.0.1:9010/mcp" }
  },
  "tools": { "browseros": ["navigate", "snapshot", "act", "read"] }
}
```

A server is either `{ "url": "...", "headers": {...} }` or `{ "command": "...", "args": [...], "env": {...} }`.
`tools` is an optional allowlist. Restart the bridge after changes; `list_apps` shows what was found.
Exposed tools appear as `app__tool` (e.g. `browseros__navigate`). Each call must finish within ~50 s.

## 4. Connect ChatGPT

1. Create a Secure MCP Tunnel (https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and run
   `tunnel-client` pointed at `http://127.0.0.1:3210/mcp`. Use a restricted API key with only Tunnels Read + Use.
2. ChatGPT web: Settings > Security and login > Developer mode on.
3. Plugins > + > Add custom MCP server > Connection: Tunnel > No authentication > Create as a plugin.
4. Nothing to paste: the rules for when and how to use the tools travel with the plugin, so it works in any chat,
   with or without a project. They live in the tool descriptions, the `next` hint on each task report, and
   `lib/instructions.md` (sent as MCP server instructions). ChatGPT shows the model only the first ~30 words of
   those, so the opening sentence carries the core rule. After changing any of it, restart the bridge and use Refresh tools.
   `test/routing-prompts.md` is the 20-prompt check that it routes well (19/20 or better).

**Let the bridge run the tunnel (recommended):** store the restricted key once, then start both with one command.
The bridge starts `tunnel-client` only after it is listening and restarts it if it exits.

macOS (the key goes in the login Keychain):

```bash
security add-generic-password -a "$USER" -s gptworkrouter-tunnel -w      # paste the key when asked
TUNNEL_CLIENT=/path/to/tunnel-client TUNNEL_PROFILE=gpt-work-router npm start
```

Windows, in PowerShell (the key is saved encrypted with Windows DPAPI, readable only by your Windows account):

```powershell
New-Item -ItemType Directory -Force "$HOME\.gptworkrouter" | Out-Null
Read-Host -AsSecureString 'Tunnel key' | ConvertFrom-SecureString | Set-Content "$HOME\.gptworkrouter\tunnel-key.dpapi"
$env:TUNNEL_CLIENT="C:\path\to\tunnel-client.exe"; $env:TUNNEL_PROFILE="gpt-work-router"; npm start
```

**Start at login (for daily use):** install it once instead of keeping a terminal open. It starts at every login,
restarts if it crashes, and copies the tunnel-client folder to `~/.gptworkrouter/tunnel-client` (background jobs can
be blocked from Downloads). On macOS it is a launchd agent logging to `~/Library/Logs/gptworkrouter.log`; on Windows a
Scheduled Task that runs at your logon (so approval dialogs reach your screen), logging to
`%LOCALAPPDATA%\gptworkrouter\gptworkrouter.log`; a small supervisor in it restarts the bridge if it dies, and
leftovers of the previous tunnel-client are stopped on restart. On Windows set the two variables with `$env:` as above first.

```bash
TUNNEL_CLIENT=/path/to/tunnel-client TUNNEL_PROFILE=gpt-work-router npm run service:install
npm run service:status      # service state + /health
npm run service:logs        # follow the log
npm run service:restart     # after changing code; running tasks resume
npm run service:uninstall
```

Don't also run `npm start` while the service is installed: both want port 3210.

**Notifications:** when a task completes, fails or is interrupted, your computer shows a notification (on macOS shown as
coming from Script Editor; allow it in System Settings > Notifications if you see nothing; on Windows a notification
from PowerShell). That is how a regular
chat gets picked up again after a long task: ChatGPT may stop calling `check_task`, so when the notification
comes, ask it to check the task. `NOTIFY=0` turns it off; `NOTIFY_CMD=/path/to/script` runs your own command
instead (called with title and message; a `.js`/`.cjs`/`.mjs` script runs with Node), e.g. to push to your phone. In a Work chat ChatGPT can also subscribe
to the `task.finished` event; the bridge posts to ChatGPT when the task ends.

**New tools after an update:** ChatGPT caches the tool list. After a bridge update adds tools, open
Settings > Plugins > GPTWorkRouter and click **Refresh tools**.

Without a folder (or given the work area itself), a task gets its own `~/GPTWork/task-<id>`, so other projects'
changes never appear in its file list or undo. An empty one is removed after the run.

### Or: through the hosted relay (friends and clients)

Later, a hosted GPTWorkRouter relay (`relay/`, not deployed yet) will let users connect without their own
tunnel. Pair the computer once: it shows a code, you sign in and click Connect in the browser,
and no key is ever typed or pasted:

```bash
node scripts/relay.mjs pair
```

Then restart the bridge (`npm run service:restart`) and add the `mcp_url` it printed in ChatGPT: turn on
Developer mode → Add custom MCP server → Authentication **OAuth** → sign in → **Allow**. Check it with
`node scripts/relay.mjs status` (or `/health` → `relay`, `relay_chatgpt_grants`). `node scripts/relay.mjs unpair` disconnects.
The relay sees requests and replies as they pass but stores none of them. The sandbox, approval dialog and masking
stay on your computer. Planned upgrade, once there are more than a handful of users: a hosted OAuth provider,
with the bridge checking ChatGPT's token itself, so that a hacked relay alone can't start tasks.

## Status page

Open http://127.0.0.1:3210/status to see every task from every chat: what is running, queued or waiting
for your approval, its folder, brief and latest activity, and recent results. Read-only (cancel and undo stay in
ChatGPT), local only, secrets masked; it refreshes every 5 seconds while a task is active.

## Tools

| Tool | What it does |
|---|---|
| `start_task(brief, folder?, needs?, reason?)` | Start a Codex task; `needs` (`network`, `write_anywhere`) asks you on your computer first |
| `check_task(task_id, wait_seconds?)` | Status, activity, result, files changed; works across restarts |
| `continue_task(task_id, instruction, needs?, reason?)` | Follow up on the same Codex thread; `needs` asks again (an approval covers one run) |
| `cancel_task(task_id)` | Stop a running task |
| `list_tasks(limit?)` | Recent tasks, including before restarts |
| `undo_task(task_id, force?)` | Put the task's folder back as it was before the task (refuses if files changed since, unless `force`) |
| `list_apps()` | Local apps found, which are exposed, their tools |
| `get_file(task_id or folder, path?, offset?)` | Read a file for Chat: text (100 KB pages), images (over 300 KB shrunk with `sips`), or a folder listing |
| `show_file(task_id or folder, path)` | Show an image (shrunk preview if over 300 KB) or the first 30 KB of a text file to the user in the chat |
| `put_file(task_id or folder, path?, content or file, overwrite?)` | Save text, or a file attached in Chat, for a task to use |
| `app__tool` | Tools of exposed local apps |

MCP Events: `events/list`, `events/subscribe`, `events/unsubscribe` with event `task.finished`.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `~/.gptworkrouter` | Task history, subscriptions, `apps.json` (private, 0700) |
| `WORKSPACE_ROOT` | `~/GPTWork` | Where short folder names go |
| `CODEX_SANDBOX`, `CODEX_APPROVAL`, `CODEX_NETWORK=1` | unset | Override the Codex config for this bridge |
| `CODEX_MODEL` | Codex default | Model override |
| `AUTO_RESUME` | `1` | Resume interrupted tasks on start; `0` marks them interrupted |
| `MAX_RUNNING` | `2` | Tasks running at once; more wait in line (status `queued`) and start by themselves. Two tasks never run at once in the same folder (or one inside the other) |
| `IDLE_MINUTES` / `MAX_MINUTES` | `10` / `60` | Stall and hard time limits (a running command is not a stall) |
| `PORT` | `3210` | Local port |
| `NOTIFY` / `NOTIFY_CMD` | on / unset | Desktop notification when a task ends (macOS, Windows); `0` = off; or your own command |
| `MAX_UPLOAD_MB` | `50` | Largest file `put_file` accepts |
| `APPROVAL_SECONDS` | `300` | How long the approval dialog waits; no answer = deny |
| `APPROVE_CMD` | unset | Your own approver instead of the dialog (called with title and message; exit 0 = approve; a `.js`/`.cjs`/`.mjs` script runs with Node). Required on Linux for now |

## Built on

- MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`, `/node`, `/express`, `/client`): `McpServer` with Zod
  input and output schemas (results carry `structuredContent`), served by `createMcpHandler`, which answers both
  2026-07-28 and 2025-era clients from one endpoint. Events are custom `events/*` methods (no SDK support yet).
- Codex SDK: one thread per task, `resumeThread` after restarts, a controlled environment.

## Safety notes

**Approval and sandbox (Phase 3).** Every task runs locked down, whatever your Codex config allows: it can change
files only inside its own folder (it can still read the disk), and its commands have no internet. Codex also
protects `.git` folders, so tasks cannot commit or push. If a task truly needs more, Chat passes `needs`
(`network` or `write_anywhere`) and a dialog pops up on your computer (Windows: answer Yes to approve) showing the request, the folder, the reason and the
instructions. Only a person can click it, so a web page that fools Chat cannot approve anything. No answer in 5
minutes counts as Deny. An approval covers one run: a follow-up that needs network again asks again (an
injection planted in a task's output can't ride on an earlier approval). Long instructions show their start and end
in the dialog. Your Codex config is the upper limit: approved network needs `network_access = true` under
`[sandbox_workspace_write]` in `~/.codex/config.toml`, and `write_anywhere` needs `sandbox_mode = "danger-full-access"`.
Browser tasks (BrowserOS neo) are not gated, by your choice: the browser runs outside Codex's sandbox and can act in
your logged-in accounts. **The gate holds for shell commands; a browser task can still send data out** (Codex can read
any file and visit a URL with it in), so masking only protects what reaches Chat.

**Undo.** Each task run is checkpointed in a private git repo under `~/.gptworkrouter/checkpoints/` (your own
`.git` is never touched; files your `.gitignore` hides, like `.env`, are included). `undo_task` puts the folder back as it was before the task; it refuses if files changed
after the task finished unless `force` is set, and saves the state just before the undo. Folders over 20,000 files or
300 MB, and `node_modules`, `.git`, `dist`, `build`, `.venv`, `.next`, `__pycache__`, are not covered, and nested git repos are
recorded only as a pointer, not their contents.

**Audit log.** `~/.gptworkrouter/audit.log` (0600, rotates at 10 MB) records every brief and follow-up, every command
and app call Codex made, every file-tool access, every approval decision, cancel and undo.

**Secrets.** Codex can read any file, so text that looks like a key (private keys, `sk-…`, GitHub, AWS, Slack, Google
keys, webhook secrets) is replaced with `[secret removed]` before it reaches Chat: in task results and activity, events,
and `get_file`/`show_file` text. It is a pattern list, not a guarantee.

- DNS-rebinding and Origin checks (`createMcpExpressApp`) stop web pages in your browser from calling the bridge.
- Codex gets the bridge's environment minus its secrets: `CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY` and
  `CODEX_API_KEY` are withheld, so commands can't read the tunnel key and tasks never bill the API.

- The bridge listens on 127.0.0.1 only and has no login of its own: reach it only through the Secure MCP
  Tunnel, never a plain public tunnel (ngrok, cloudflared) as it stands.
- Whatever your Codex config allows, a ChatGPT conversation can now ask for. With `danger-full-access`
  that is your whole account, and a malicious web page Chat reads could try to steer it.
- The file tools act with the bridge's own rights, not through the Codex sandbox, so they are fenced: only the
  work area and folders your tasks used (never your home folder itself or anything above it), checked after
  resolving symlinks, and never `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.codex`, the bridge's data folder, Keychains or Windows credential folders.
  `put_file` never replaces a file unless asked, and only downloads attachments from public HTTPS addresses.
- Webhooks only go to public HTTPS addresses (never your local network), signed with Standard Webhooks.
