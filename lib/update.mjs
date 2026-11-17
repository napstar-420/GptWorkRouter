// Update notice (notify only: nothing installs by itself; users rerun the install command).
// Checks the newest release's latest.json at start and once a day: a plain GET, no ID or data sent.
// GWR_NO_UPDATE_CHECK=1 turns it off; GWR_UPDATE_URL points it elsewhere (tests).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { notifyCommand } from "./desktop.mjs";

export const REPO = "napstar-420/GptWorkRouter";
const DAY = 86_400_000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const installCommand = (platform = process.platform) =>
  platform === "win32"
    ? `irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex`
    : `curl -fsSL https://github.com/${REPO}/releases/latest/download/install.sh | sh`;

export function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function desktopNotify(title, body) {
  const c = notifyCommand(process.platform, title, body);
  if (c) execFile(c.cmd, c.args, c.env ? { env: c.env, windowsHide: true } : {}, () => {});
}

export class UpdateChecker {
  constructor(version, { dataDir, url = process.env.GWR_UPDATE_URL || `https://github.com/${REPO}/releases/latest/download/latest.json`, notify = desktopNotify, log = console } = {}) {
    Object.assign(this, { version, url, notify, log, file: path.join(dataDir, "update.json") });
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.state = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch {}
  }

  // { version, notes } when a newer release exists, else null.
  get available() {
    const l = this.state.latest;
    return l && VERSION_RE.test(l.version) && newer(l.version, this.version) ? l : null;
  }

  async check() {
    if (process.env.GWR_NO_UPDATE_CHECK === "1") return;
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const j = await r.json();
      if (typeof j?.version !== "string" || !VERSION_RE.test(j.version)) return;
      this.state.latest = { version: j.version, notes: String(j.notes ?? "").replace(/\s+/g, " ").slice(0, 200) };
      const a = this.available;
      if (a && this.state.notified !== a.version) {
        this.state.notified = a.version;
        this.log.log(`[update] GPTWorkRouter ${a.version} is available (running ${this.version})`);
        this.notify(`GPTWorkRouter ${a.version} is available`, "To update, run the install command again.");
      }
      this.save();
    } catch {} // offline or GitHub down: try again tomorrow
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), DAY);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  // One line for a tool result, at most once a day. Only the version (checked format) and our own
  // fixed text go to ChatGPT, never the release notes.
  noticeLine(now = Date.now()) {
    const a = this.available;
    if (!a || (this.state.toldAt && now - this.state.toldAt < DAY)) return null;
    this.state.toldAt = now;
    this.save();
    return `Note for the user: GPTWorkRouter ${a.version} is available (this computer runs ${this.version}). To update, run this in ${process.platform === "win32" ? "PowerShell" : "Terminal"}: ${installCommand()}`;
  }
}
