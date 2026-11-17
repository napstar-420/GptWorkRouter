// Safe edits to the user's Codex config.toml: change only the lines for the keys we set,
// keep comments, order, line endings and BOM. smol-toml only reads: it drops comments
// when writing. After editing we parse the new text and require that it equals the old
// parse plus exactly our changes; anything else and we write nothing (the user gets the
// lines to add by hand instead).
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";

const BARE = /^[A-Za-z0-9_-]+$/;
const fmtKey = (seg) => (BARE.test(seg) ? seg : JSON.stringify(seg));
export const fmtPath = (p) => p.map(fmtKey).join(".");
const fmtValue = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const get = (obj, p) => p.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

// What should change, given the parsed config. access: "sandboxed" | "full".
// approve: MCP server names to allow under approval "never".
export function planEdits(toml, { platform = process.platform, access = "sandboxed", approve = [] } = {}) {
  const want = [
    [["sandbox_mode"], access === "full" ? "danger-full-access" : "workspace-write"],
    [["approval_policy"], "never"],
    [["sandbox_workspace_write", "network_access"], true],
  ];
  if (platform === "win32") want.push([["windows", "sandbox"], "mxc"]); // required on Windows, see README
  for (const name of approve) want.push([["mcp_servers", name, "default_tools_approval_mode"], "approve"]);
  // A selected profile wins over the top level (as in codexPermissions()), so a key the
  // profile sets is changed inside the profile.
  const name = typeof toml.profile === "string" ? toml.profile : null;
  const prof = name ? toml.profiles?.[name] : null;
  return want
    .map(([p, value]) => ({
      path: prof && typeof prof === "object" && p[0] !== "mcp_servers" && Object.hasOwn(prof, p[0]) ? ["profiles", name, ...p] : p,
      value,
    }))
    .filter((e) => get(toml, e.path) !== e.value);
}

// Key path at the start of a line ("a.b" = …, "x"."y" = …), or null.
function keyAt(line) {
  const segs = [];
  let i = line.match(/^\s*/)[0].length;
  for (;;) {
    const m = line.slice(i).match(/^([A-Za-z0-9_-]+)|^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
    if (!m) return null;
    segs.push(m[1] ?? (m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : m[3]));
    i += m[0].length;
    const sep = line.slice(i).match(/^\s*([.=])\s*/);
    if (!sep) return null;
    i += sep[0].length;
    if (sep[1] === "=") return { path: segs, valueAt: i };
  }
}

// [table] / [[array]] header, or null.
function headerAt(line) {
  const m = line.match(/^\s*(\[\[?)\s*(.+?)\s*(\]\]?)\s*(#.*)?$/);
  if (!m || m[1].length !== m[3].length) return null;
  const k = keyAt(`${m[2]} =`);
  return k ? { path: k.path, array: m[1] === "[[" } : null;
}

// End of a simple one-line value starting at i, or -1 (multi-line, arrays, tables: not ours).
function valueEnd(line, i) {
  const c = line[i];
  if (line.startsWith('"""', i) || line.startsWith("'''", i) || c === "[" || c === "{") return -1;
  if (c === '"') {
    for (let j = i + 1; j < line.length; j++) {
      if (line[j] === "\\") j++;
      else if (line[j] === '"') return j + 1;
    }
    return -1;
  }
  if (c === "'") {
    const j = line.indexOf("'", i + 1);
    return j < 0 ? -1 : j + 1;
  }
  const m = line.slice(i).match(/^[^\s#]+/);
  return m ? i + m[0].length : -1;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function scan(lines) {
  let table = [];
  return lines.map((line) => {
    const h = headerAt(line);
    if (h) {
      table = h.array ? null : h.path;
      return { header: h };
    }
    const k = table && keyAt(line);
    return k ? { table, key: k } : { table };
  });
}

function setOne(lines, path, value, changes) {
  const T = path.slice(0, -1);
  const info = scan(lines);
  // 1. The key exists (also as a dotted key in a parent table): replace its value.
  for (let i = 0; i < lines.length; i++) {
    const k = info[i].key;
    if (!k || !same([...info[i].table, ...k.path], path)) continue;
    const end = valueEnd(lines[i], k.valueAt);
    if (end < 0) return false;
    const old = lines[i];
    lines[i] = old.slice(0, k.valueAt) + fmtValue(value) + old.slice(end);
    changes.push({ table: T, old, new: lines[i] });
    return true;
  }
  const line = `${fmtKey(path.at(-1))} = ${fmtValue(value)}`;
  // 2. The table has a header: add the key right under it.
  const h = info.findIndex((x) => x.header && !x.header.array && same(x.header.path, T));
  if (h >= 0) {
    lines.splice(h + 1, 0, line);
    changes.push({ table: T, new: line });
    return true;
  }
  // 3. Top level: before the first table header (appended at the end it would land in the last table).
  if (T.length === 0) {
    let at = info.findIndex((x) => x.header);
    if (at < 0) at = lines.length;
    while (at > 0 && /^\s*(#.*)?$/.test(lines[at - 1])) at--; // keep the next table's comment with it
    lines.splice(at, 0, line);
    changes.push({ table: T, new: line });
    return true;
  }
  // 4. New table at the end.
  while (lines.length && lines.at(-1).trim() === "") lines.pop();
  if (lines.length) lines.push("");
  lines.push(`[${fmtPath(T)}]`, line);
  changes.push({ table: T, new: `[${fmtPath(T)}]` }, { table: T, new: line });
  return true;
}

// Apply edits to the config text. Returns { text, changes } or { manual, reason } (lines to add by hand).
export function applyEdits(original, edits) {
  const manual = edits.map((e) => (e.path.length > 1 ? `[${fmtPath(e.path.slice(0, -1))}]  ` : "") + `${fmtKey(e.path.at(-1))} = ${fmtValue(e.value)}`);
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const body = original.slice(bom.length);
  try {
    parse(body);
  } catch (err) {
    return { manual, reason: `config.toml can't be read: ${err.message.split("\n")[0]}` };
  }
  if (!edits.length) return { text: original, changes: [] };
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const changes = [];
  for (const e of edits) if (!setOne(lines, e.path, e.value, changes)) return { manual, reason: `can't safely change ${fmtPath(e.path)}` };
  const text = lines.join(eol) + eol;
  // Check: the new file must parse to the old one plus exactly our changes.
  const want = parse(body);
  for (const e of edits) {
    let o = want;
    // New tables get the parser's own prototype, or the deep-equal check would differ on that alone.
    for (const k of e.path.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = Object.create(Object.getPrototypeOf(o)));
    o[e.path.at(-1)] = e.value;
  }
  let after;
  try {
    after = parse(text);
  } catch {
    return { manual, reason: "the edited file would not be valid" };
  }
  if (!isDeepStrictEqual(after, want)) return { manual, reason: "the edit would change more than intended" };
  return { text: bom + text, changes };
}

// Lines for the user: "+ added" / "- old" / "+ new", grouped under their table.
export function describe(changes) {
  const out = [];
  let last;
  for (const c of changes) {
    const t = c.table.length ? `[${fmtPath(c.table)}]` : "(top of file)";
    if (t !== last) out.push(`  ${t}`), (last = t);
    if (c.old !== undefined) out.push(`  - ${c.old.trim()}`);
    if (!c.new.startsWith("[")) out.push(`  + ${c.new.trim()}`);
  }
  return out.join("\n");
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

// Back up (<file>.bak-gwr-YYYYMMDD-HHMMSS) and write via temp file + rename. Returns the backup path or null.
export function writeWithBackup(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-gwr-${stamp()}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.gwr-tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return backup;
    } catch (err) {
      // Windows: another program may hold the file for a moment.
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
