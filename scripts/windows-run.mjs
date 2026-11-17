// Windows only: what the GPTWorkRouter logon task runs (see service.ps1). Loads the
// settings saved at install and keeps the bridge running, its output in the log file
// (a Scheduled Task has no console). Task Scheduler restarts a task only when it fails
// to start, not when its process dies, so this restarts the bridge itself, like launchd.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const data = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), ".gptworkrouter"));
// PowerShell 5 writes UTF-8 with a byte-order mark.
const settings = JSON.parse(fs.readFileSync(path.join(data, "service.json"), "utf8").replace(/^﻿/, ""));
const env = { ...process.env };
if (settings.tunnelClient) env.TUNNEL_CLIENT = settings.tunnelClient;
if (settings.tunnelProfile) env.TUNNEL_PROFILE = settings.tunnelProfile;
Object.assign(env, settings.env); // proxy settings, if any

fs.mkdirSync(path.dirname(settings.log), { recursive: true });
const log = fs.createWriteStream(settings.log, { flags: "a" });
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

let delay = 2000;
function run() {
  const startedAt = Date.now();
  // If this process is killed (task stopped), Windows ends this direct child with it.
  const child = spawn(process.execPath, [server], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on("exit", (code) => {
    if (Date.now() - startedAt > 60000) delay = 2000; // ran a while: not a crash loop
    log.write(`${new Date().toISOString()} bridge exited (${code}); restarting in ${delay / 1000}s\n`);
    setTimeout(run, delay);
    delay = Math.min(delay * 2, 60000);
  });
}
run();
