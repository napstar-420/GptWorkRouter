// Read-only status page at /status: every task across all chats, newest first, active ones
// on top. Served on 127.0.0.1 behind the same Host/Origin checks as /mcp. No buttons:
// cancel and undo stay in Chat. Text goes through report() (redacted) and is HTML-escaped.
import os from "node:os";
import { redact } from "./redact.mjs";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const home = (p) => String(p).replace(os.homedir(), "~");
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const ACTIVE = ["running", "queued", "awaiting_approval"];
const LABEL = { awaiting_approval: "waiting for your approval" };

export function statusPage(tasks, { limit = 40 } = {}) {
  const all = tasks.store.all().sort((a, b) => b.startedAt - a.startedAt);
  const active = all.filter((t) => ACTIVE.includes(t.status));
  const recent = all.filter((t) => !ACTIVE.includes(t.status)).slice(0, limit);
  const card = (t) => {
    const r = tasks.report(t);
    const brief = redact(t.turns.at(-1)?.instruction || "");
    const body = r.error || r.result || "";
    return `<article class="${esc(t.status)}">
  <header><span class="badge">${esc(LABEL[t.status] || t.status)}</span> <code>${esc(home(t.folder))}</code>
  <span class="when">started ${esc(ago(t.startedAt))} · ${esc(r.minutes_running)} min · ${esc(t.id)}${t.turns.length > 1 ? ` · ${t.turns.length} runs` : ""}</span></header>
  <p class="brief">${esc(brief.length > 300 ? brief.slice(0, 300) + "…" : brief)}</p>
  ${r.recent_activity.length && ACTIVE.includes(t.status) ? `<ul>${r.recent_activity.map((a) => `<li>${esc(a.slice(0, 200))}</li>`).join("")}</ul>` : ""}
  ${body && !ACTIVE.includes(t.status) ? `<details><summary>${r.error ? "Error" : "Result"}</summary><pre>${esc(body)}</pre></details>` : ""}
  ${r.files_changed?.length ? `<p class="files">${esc(r.files_changed.slice(0, 8).join(", "))}${r.files_changed.length > 8 ? ` +${(r.files_changed_total || r.files_changed.length) - 8} more` : ""}</p>` : ""}
</article>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${active.length ? '<meta http-equiv="refresh" content="5">' : ""}<title>GPTWorkRouter tasks</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--run:#0a7cff;--ok:#1f8a3b;--bad:#c4302b;--wait:#b36b00}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f7;--mute:#9a9aa0;--line:#2c2c30;--run:#4aa3ff;--ok:#4cc26a;--bad:#ff6b63;--wait:#f0a63a}}
body{margin:0 auto;max-width:860px;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif}
h1{font-size:18px;margin:8px 0}h2{font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em;margin:24px 0 8px}
article{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}
header{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}.when{color:var(--mute);font-size:12px;margin-left:auto}
.badge{font-weight:600;font-size:12px}.running .badge{color:var(--run)}.queued .badge,.awaiting_approval .badge{color:var(--wait)}
.completed .badge{color:var(--ok)}.failed .badge,.denied .badge,.interrupted .badge{color:var(--bad)}.cancelled .badge{color:var(--mute)}
.brief{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}ul{margin:4px 0;padding-left:18px;color:var(--mute);font-size:12px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:6px 0}.files{color:var(--mute);font-size:12px;margin:4px 0;overflow-wrap:anywhere}
code{font-size:12px}.empty{color:var(--mute)}summary{cursor:pointer;color:var(--mute);font-size:12px}
</style></head><body><h1>GPTWorkRouter tasks</h1><p class="empty">${active.length ? "Updates every 5 seconds while a task is active." : "Reload to update."} Cancel or undo a task from ChatGPT.</p>
<h2>Active (${active.length})</h2>${active.map(card).join("") || '<p class="empty">Nothing running.</p>'}
<h2>Recent</h2>${recent.map(card).join("") || '<p class="empty">No tasks yet.</p>'}
</body></html>`;
}
