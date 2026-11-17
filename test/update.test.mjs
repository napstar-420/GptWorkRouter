// Update notice: daily check against a local latest.json, /health field, once-a-day ChatGPT line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { UpdateChecker, newer, installCommand } from "../lib/update.mjs";

let failed = 0;
const check = (name, ok, info = "") => (console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${info}`}`), ok || failed++);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwr-update-test-"));
let body = JSON.stringify({ version: "3.1.0", notes: "faster\nstart" });
const srv = http.createServer((_q, r) => r.end(body)).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}/latest.json`;
const quiet = { log() {} };

check("newer compares numbers, not strings", newer("3.10.0", "3.9.9") && !newer("3.0.0", "3.0.0") && !newer("2.9.9", "3.0.0"));
check("install command per OS", installCommand("win32").startsWith("irm ") && installCommand("darwin").startsWith("curl "));

const notes = [];
const u = new UpdateChecker("3.0.0", { dataDir: dir, url, notify: (t) => notes.push(t), log: quiet });
check("nothing before the first check", u.available === null && u.noticeLine() === null);
await u.check();
check("newer release found", u.available?.version === "3.1.0", JSON.stringify(u.available));
check("notes kept on one line", u.available?.notes === "faster start");
check("one desktop notification", notes.length === 1);
await u.check();
check("not notified twice for the same version", notes.length === 1);
const line = u.noticeLine(1000);
check("ChatGPT line has version and command, not the notes", /3\.1\.0/.test(line) && line.includes(installCommand()) && !line.includes("faster"), line);
check("at most once a day", u.noticeLine(2000) === null && typeof u.noticeLine(1000 + 86_400_001) === "string");
check("state survives a restart", new UpdateChecker("3.0.0", { dataDir: dir, url, log: quiet }).available?.version === "3.1.0");
check("same version running: no update", new UpdateChecker("3.1.0", { dataDir: dir, url, log: quiet }).available === null);

body = JSON.stringify({ version: "3.2.0; rm -rf /" });
const v = new UpdateChecker("3.0.0", { dataDir: fs.mkdtempSync(path.join(dir, "b-")), url, notify() {}, log: quiet });
await v.check();
check("bad version string ignored", v.available === null);
body = "not json";
await v.check();
check("bad JSON ignored", v.available === null);

// Release bootstraps for GitHub: the one-liner uses latest/download, archives come from this version's tag.
const { renderBootstrap } = await import("../installer/build-release.mjs");
const sh = renderBootstrap(fs.readFileSync(new URL("../installer/install.sh", import.meta.url), "utf8"), { version: "3.1.0", repo: "o/r", sums: {} });
check("GitHub bootstrap URLs", sh.includes("https://github.com/o/r/releases/latest/download/install.sh") && sh.includes('FILES="https://github.com/o/r/releases/download/v3.1.0"') && !/@[A-Z_]+@/.test(sh));

process.env.GWR_NO_UPDATE_CHECK = "1";
body = JSON.stringify({ version: "9.0.0" });
const off = new UpdateChecker("3.0.0", { dataDir: fs.mkdtempSync(path.join(dir, "c-")), url, notify() {}, log: quiet });
await off.check();
check("GWR_NO_UPDATE_CHECK=1 turns it off", off.available === null);

srv.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} failed` : "all passed"}`);
process.exit(failed ? 1 : 0);
