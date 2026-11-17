// Optional: run OpenAI's tunnel-client as a child of the bridge, started only
// after the bridge is listening (tunnel-client disables polling for good if the
// bridge is down when it starts) and restarted if it ever exits.
// Enable with TUNNEL_CLIENT=/path/to/tunnel-client and TUNNEL_PROFILE=<profile>;
// the key comes from CONTROL_PLANE_API_KEY or the OS key store (see tunnelKey).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.mjs";
import { keyCommand, keyStoreHint } from "./desktop.mjs";

// The tunnel key comes from the environment, or from the OS store: the macOS login Keychain,
// or on Windows a DPAPI-encrypted file only this user can decrypt (see lib/desktop.mjs).
// It is handed only to tunnel-client, never to Codex.
function tunnelKey() {
  if (process.env.CONTROL_PLANE_API_KEY) return process.env.CONTROL_PLANE_API_KEY;
  const cmd = keyCommand(process.platform, { user: os.userInfo().username, dataDir: config.dataDir });
  if (!cmd) return null;
  try {
    return execFileSync(cmd.cmd, cmd.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(cmd.env ? { env: cmd.env } : {}) }).trim() || null;
  } catch {
    return null;
  }
}

// Windows does not stop child processes when the bridge is killed (launchd on macOS stops
// the whole group), so a tunnel-client left over from a killed bridge would keep running
// beside the new one. Remember its pid and end that process tree before starting again.
const PID_FILE = () => path.join(config.dataDir, "tunnel-client.pid");
const killTree = (pid) => execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
// The PID file holds "<pid> <start ms>". A tunnel-client still running is stopped with its
// children. One that died with the bridge (Windows ends it, not its cloudflared) is gone,
// so its children are found by the parent pid they still record, created after it started
// (so a process that reused the pid, and its children, are never touched).
function killLeftover() {
  try {
    const [pid, since] = fs.readFileSync(PID_FILE(), "utf8").trim().split(/\s+/).map(Number);
    const row = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    if (pid > 0 && /tunnel-client/i.test(row)) killTree(pid);
    else if (pid > 0 && since > 0 && !row.includes(`"${pid}"`)) {
      const orphans = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CreationDate -ge [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime } | ForEach-Object { $_.ProcessId }`],
        { encoding: "utf8", windowsHide: true, timeout: 30000 }).match(/\d+/g) || [];
      for (const p of orphans) try { killTree(p); } catch {}
      if (orphans.length) console.log(`[tunnel] stopped ${orphans.length} process(es) left by the previous tunnel-client`);
    }
  } catch {}
  fs.rmSync(PID_FILE(), { force: true });
}

export class TunnelSupervisor {
  constructor({ binary, profile, log = console }) {
    this.binary = binary;
    this.profile = profile;
    this.log = log;
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    this.status = "off";
  }

  // Show `status` now; become "connected" after `ms` unless something else set a status meanwhile.
  settle(status, ms) {
    this.status = status;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { if (this.status === status) this.status = "connected"; }, ms);
    this.settleTimer.unref?.();
  }

  start() {
    if (!this.binary || !this.profile) return;
    const key = tunnelKey();
    if (!key) {
      this.status = "missing tunnel key";
      const hint = keyStoreHint(process.platform, config.dataDir);
      this.log.error(`[tunnel] No tunnel key. ${hint ? `Store it once with: ${hint}  (or set CONTROL_PLANE_API_KEY)` : "Set CONTROL_PLANE_API_KEY."}`);
      return;
    }
    const startedAt = Date.now();
    this.status = "starting";
    const win = process.platform === "win32";
    if (win) killLeftover();
    this.child = spawn(this.binary, ["run", "--profile", this.profile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CONTROL_PLANE_API_KEY: key },
      windowsHide: true,
    });
    if (win && this.child.pid) fs.writeFileSync(PID_FILE(), `${this.child.pid} ${startedAt}`);
    const onLine = (buf) => {
      for (const line of String(buf).split("\n")) {
        if (!line.trim()) continue;
        // tunnel-client logs JSON lines; surface only what matters.
        let msg = line;
        try {
          const j = JSON.parse(line);
          if (j.level === "DEBUG" || (j.level === "INFO" && !/started|stopped|polling|error/i.test(j.msg))) continue;
          msg = `${j.level} ${j.msg}${j.error ? `: ${j.error}` : ""}`;
          // v0.0.20 logs "tunnel-client started". The v0.0.21 runtime build logs "poller started" even
          // with a bad key (the first poll fails right after, seen on the Mac), and nothing on success,
          // so "connected" means: started, and no failure for 5 s.
          const text = `${j.msg} ${j.error ?? ""}`;
          if (/tunnel-client started/.test(j.msg)) this.status = "connected";
          if (/poller started/.test(j.msg)) this.settle("checking", 5000);
          if (j.level === "WARN" && /failed/.test(j.msg)) {
            if (/status 401/.test(text)) this.status = "key rejected"; // stays until restart
            else if (/status 403/.test(text)) this.status = "key lacks Tunnels access";
            // ponytail: network blips clear after 30 quiet s; a real success signal would be better if tunnel-client adds one.
            else if (!/^key/.test(this.status)) this.settle("poll failing", 30000);
          }
          if (/polling disabled/.test(j.msg)) this.status = "polling disabled";
        } catch {}
        this.log.log(`[tunnel] ${msg}`);
      }
    };
    this.child.stdout.on("data", onLine);
    this.child.stderr.on("data", onLine);
    this.child.on("exit", (code) => {
      this.child = null;
      if (this.stopping) return;
      this.status = `exited (${code})`;
      // Back off if it keeps dying quickly; reset after a stable hour.
      if (Date.now() - startedAt > 3600000) this.restarts = 0;
      const delay = Math.min(60000, 2000 * 2 ** this.restarts++);
      this.log.error(`[tunnel] tunnel-client exited with ${code}; restarting in ${delay / 1000}s`);
      setTimeout(() => this.start(), delay).unref();
    });
  }

  stop() {
    this.stopping = true;
    if (process.platform === "win32" && this.child?.pid) {
      try {
        killTree(this.child.pid); // tunnel-client and the cloudflared it started
      } catch {}
      fs.rmSync(PID_FILE(), { force: true });
    } else this.child?.kill("SIGTERM");
  }
}
