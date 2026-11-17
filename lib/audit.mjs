// Append-only audit log: every brief, command, app call, file-tool access, approval and
// undo, one JSON object per line in <data>/audit.log (private, 0600). Rotates at 10 MB.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

const MAX_BYTES = 10_000_000;
const clip = (v) => (typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v);

export function audit(event, fields = {}) {
  try {
    const file = path.join(config.dataDir, "audit.log");
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    const line = { t: new Date().toISOString(), event };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = clip(v);
    fs.appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`[audit] ${err.message}`); // never let logging break a task
  }
}
