// End-to-end self-test against REAL Codex on this computer (uses a little Codex
// allowance). Checks: a task runs, the bridge survives being killed mid-task and
// resumes it, and a signed task.finished event is delivered.
//   npm run selftest
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Webhook } from "standardwebhooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3211;
const T = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-selftest-"));
const WORK = path.join(here, "selftest-workspace");
const report = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, checks: [] };
const check = (name, pass, detail = "") => {
  report.checks.push({ name, pass, detail: String(detail).slice(0, 1500) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge, bridgeLog = "";
function startBridge() {
  bridge = spawn(process.execPath, [path.join(here, "server.mjs")], {
    // Real Codex with the user's own Codex settings; only the work area and data dir are test-local.
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(T, "data"), WORKSPACE_ROOT: WORK, ALLOW_INSECURE_WEBHOOKS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (d) => (bridgeLog += d));
  bridge.stderr.on("data", (d) => (bridgeLog += d));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (bridgeLog.split("GPTWorkRouter bridge").length > startBridge.count + 1) {
        startBridge.count++;
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > 20000) {
        clearInterval(iv);
        reject(new Error("bridge did not start"));
      }
    }, 100);
  });
}
startBridge.count = 0;
const stopBridge = () => new Promise((r) => { bridge.once("exit", r); bridge.kill("SIGTERM"); });

let id = 0;
async function rpc(method, params) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}
async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: !!r.result?.isError, body: r.result.structuredContent ?? JSON.parse(r.result.content[0].text) };
}
async function waitDone(taskId, maxMinutes = 10) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < maxMinutes * 60000) {
    last = (await tool("check_task", { task_id: taskId, wait_seconds: 45 })).body;
    if (last.status !== "running") break;
  }
  return { last, seconds: Math.round((Date.now() - t0) / 1000) };
}
const read = (f) => { try { return fs.readFileSync(path.join(WORK, "selftest", f), "utf8"); } catch { return null; } };

// Local stand-in for ChatGPT's webhook endpoint.
const secret = "whsec_" + crypto.randomBytes(32).toString("base64");
const received = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let verified = false;
    try { new Webhook(secret).verify(body, req.headers); verified = true; } catch {}
    const msg = JSON.parse(body);
    received.push({ msg, verified });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(msg.type === "verification" ? { challenge: msg.challenge } : {}));
  });
}).listen(3212);

fs.rmSync(WORK, { recursive: true, force: true });
try {
  await startBridge();
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "selftest", version: "2" } });
  check("bridge starts, advertises events", !!init.result?.capabilities?.events);

  const sub = await rpc("events/subscribe", { name: "task.finished", arguments: {}, delivery: { mode: "webhook", url: "http://127.0.0.1:3212/cb", secret }, cursor: null });
  check("events/subscribe with callback verification", !!sub.result?.id, JSON.stringify(sub.error || ""));

  const t1 = await tool("start_task", {
    folder: "selftest",
    brief: "In the current folder create hello.txt containing exactly the line `bridge ok`, create sum.js that prints 2+3, run `node sum.js`, and include its output in your final message. Create nothing else.",
  });
  check("task starts", !t1.isError && !!t1.body.task_id, JSON.stringify(t1.body));
  const r1 = await waitDone(t1.body.task_id);
  report.firstTask = r1;
  check("real Codex task completes", r1.last.status === "completed", `${r1.last.status} in ${r1.seconds}s ${r1.last.error || ""}`);
  check("files written and tracked", (read("hello.txt") || "").trim() === "bridge ok" && (r1.last.files_changed || []).length >= 2, (r1.last.files_changed || []).join(", "));
  check("command output reported", /\b5\b/.test(r1.last.result || ""), r1.last.result);
  await sleep(1000);
  check("signed task.finished event received", received.some((r) => r.verified && r.msg.data?.task_id === t1.body.task_id && r.msg.data.status === "completed"));

  // Kill the bridge in the middle of a task, restart it, and expect a resume.
  const t2 = await tool("start_task", {
    folder: "selftest",
    brief: "Run the shell command `sleep 40` in full, then create resume.txt containing `resume ok`. Report when done.",
  });
  await sleep(15000);
  await stopBridge();
  check("bridge killed mid-task", true);
  await startBridge();
  const after = await tool("check_task", { task_id: t1.body.task_id, wait_seconds: 0 });
  check("finished task still readable after restart", after.body.status === "completed", after.body.status);
  const r2 = await waitDone(t2.body.task_id);
  report.resumedTask = r2;
  check("interrupted task resumed and finished", r2.last.status === "completed" && (read("resume.txt") || "").trim() === "resume ok", `${r2.last.status}: ${r2.last.result || r2.last.error}`);
} catch (err) {
  check("self-test ran without crashing", false, err?.stack || err);
} finally {
  await stopBridge().catch(() => {});
  hook.close();
  report.bridgeLog = bridgeLog.slice(-4000);
  report.passed = report.checks.every((c) => c.pass);
  fs.writeFileSync(path.join(here, "selftest-report.json"), JSON.stringify(report, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${report.passed ? "ALL PASSED" : "SOME FAILED"} — details in selftest-report.json`);
  process.exit(report.passed ? 0 : 1);
}
