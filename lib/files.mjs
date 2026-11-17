// Move files between Chat and this computer. These tools act with the bridge's own
// rights, not through the Codex sandbox, so they are fenced in: only the work area
// and folders the owner's tasks already use, never home itself, never secrets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { config } from "./config.mjs";
import { checkPublicUrl } from "./events.mjs";
import { redact } from "./redact.mjs";

export const MAX_TEXT_BYTES = 100_000; // per get_file call; page with offset
export const MAX_IMAGE_BYTES = 40_000_000; // source file; what is sent is shrunk below
// Image bytes sent to Chat count toward the conversation's length: one 3 MB image used up a
// whole chat. Anything larger is shrunk with macOS sips (built in) before it is sent.
export const SEND_IMAGE_BYTES = 300_000;
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 50) * 1_000_000;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
// Is child the same folder as parent or inside it? Windows paths ignore case.
export function inside(child, parent, platform = process.platform) {
  const sep = platform === "win32" ? "\\" : "/";
  if (platform === "win32") [child, parent] = [child.toLowerCase(), parent.toLowerCase()];
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// Where secrets live: refused even inside an allowed folder.
function secretDirs() {
  const home = os.homedir();
  return [config.dataDir, config.codexHome, ...[".ssh", ".aws", ".gnupg", ".config/gh", ".docker", "Library/Keychains",
    "AppData/Roaming/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect", "AppData/Local/Microsoft/Credentials"].map((d) => path.join(home, d))].map(real);
}

// The work area plus every folder the owner's tasks ran in, except folders that are
// home or above it (a task in "~" must not open the whole home folder to Chat).
export function allowedRoots(taskFolders) {
  const home = real(os.homedir());
  return [real(config.workspaceRoot), ...taskFolders.map(real)].filter((r) => !inside(home, r));
}

// Nearest existing ancestor, resolved: so a symlinked parent cannot point outside.
function realOrParent(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(real(cur), ...rest);
}

export function resolveInside(base, rel, roots) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  if (path.isAbsolute(rel) || rel.startsWith("~")) throw new Error("path must be relative to the folder (no leading / or ~)");
  const target = realOrParent(path.resolve(base, rel));
  if (!roots.some((r) => inside(target, r))) {
    throw new Error("That path is outside the work area and the folders your tasks use.");
  }
  if (secretDirs().some((d) => inside(target, d))) throw new Error("That path holds credentials and is never shared.");
  return target;
}

// ponytail: macOS-only shrink (sips); on Windows large images are refused. Add sharp if that matters.
function imageToSend(file, size, mime) {
  if (size <= SEND_IMAGE_BYTES) return { data: fs.readFileSync(file), mime, resized: false };
  if (process.platform !== "darwin") throw new Error(`Image is ${size} bytes; ask a task to save a copy under ${SEND_IMAGE_BYTES / 1000} KB.`);
  const tmp = path.join(os.tmpdir(), `gwr-${crypto.randomBytes(4).toString("hex")}.jpg`);
  try {
    for (const [px, q] of [["1600", "70"], ["1000", "50"], ["640", "40"]]) {
      execFileSync("sips", ["-Z", px, "-s", "format", "jpeg", "-s", "formatOptions", q, file, "--out", tmp], { stdio: "ignore", timeout: 20000 });
      const data = fs.readFileSync(tmp);
      if (data.length <= SEND_IMAGE_BYTES) return { data, mime: "image/jpeg", resized: true };
    }
  } catch (err) {
    throw new Error(`Could not shrink the image (${err.message.split("\n")[0]}); ask a task to save a smaller copy.`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  throw new Error(`Image is still over ${SEND_IMAGE_BYTES / 1000} KB after shrinking; ask a task to save a smaller copy.`);
}

const looksText = (buf) => !buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").equals(buf);

// Returns MCP tool content: text, an image, or a folder listing.
export function readFile(target, { offset = 0 } = {}) {
  if (!fs.existsSync(target)) throw new Error("No such file or folder.");
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
    const items = entries.slice(0, 200).map((e) => {
      const full = path.join(target, e.name);
      let size;
      try {
        size = e.isFile() ? fs.statSync(full).size : undefined;
      } catch {}
      return { name: e.name + (e.isDirectory() ? "/" : ""), ...(size === undefined ? {} : { bytes: size }) };
    });
    const meta = { path: target, kind: "folder", entries: items, ...(entries.length > 200 ? { entries_total: entries.length } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }], structuredContent: meta };
  }
  if (!st.isFile()) throw new Error("Not a regular file.");
  const ext = path.extname(target).toLowerCase();
  if (IMAGE_TYPES[ext]) {
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`Image is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}. Ask a task to make a smaller copy.`);
    const { data, mime, resized } = imageToSend(target, st.size, IMAGE_TYPES[ext]);
    const meta = { path: target, kind: "image", bytes: st.size, mime_type: mime, ...(resized ? { sent_as: `${mime}, ${data.length} bytes (shrunk to fit the chat)` } : {}) };
    return {
      content: [{ type: "text", text: JSON.stringify(meta) }, { type: "image", data: data.toString("base64"), mimeType: mime }],
      structuredContent: meta,
    };
  }
  const start = Math.max(0, Math.min(offset, st.size));
  const fd = fs.openSync(target, "r");
  let buf;
  try {
    buf = Buffer.alloc(Math.min(MAX_TEXT_BYTES + 4, st.size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Cut on a UTF-8 character boundary so a page never ends mid-character.
  let end = Math.min(buf.length, MAX_TEXT_BYTES);
  if (start + end < st.size) while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  buf = buf.subarray(0, end);
  if (!looksText(buf)) {
    throw new Error(`Binary file (${st.size} bytes, ${ext || "no extension"}). Only text and images (png, jpg, gif, webp) can be sent to Chat; ask a task to convert or summarize it.`);
  }
  const meta = { path: target, kind: "text", bytes: st.size, offset: start, returned_bytes: buf.length };
  if (start + buf.length < st.size) meta.next_offset = start + buf.length;
  const text = redact(buf.toString("utf8")); // keys in a .env or log never reach Chat
  return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "text", text }], structuredContent: { ...meta, text } };
}

// Download a Chat attachment, refusing private addresses at every redirect hop.
// ponytail: DNS is checked before connecting, not pinned; pin the IP if this ever faces untrusted callers.
async function download(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    await checkPublicUrl(url, "File download URL");
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(40000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Downloading the attachment failed: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length")) > MAX_UPLOAD_BYTES) throw new Error(`Attachment is over the ${MAX_UPLOAD_BYTES / 1e6} MB limit.`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) throw new Error(`Attachment is over the ${MAX_UPLOAD_BYTES / 1e6} MB limit.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many redirects downloading the attachment.");
}

export async function writeFile(target, { content, file, overwrite }) {
  if ((content === undefined) === (file === undefined)) throw new Error("Give exactly one of content (text) or file (a Chat attachment).");
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error("That path is a folder; name the file inside it.");
  if (fs.existsSync(target) && !overwrite) throw new Error("A file already exists there. Pass overwrite: true to replace it.");
  let data;
  if (file) {
    if (!file.download_url) throw new Error("The attachment has no download_url.");
    data = await download(file.download_url);
  } else {
    data = Buffer.from(content, "utf8");
    if (data.length > MAX_UPLOAD_BYTES) throw new Error(`Content is over the ${MAX_UPLOAD_BYTES / 1e6} MB limit.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  return { path: target, bytes: data.length, replaced: Boolean(overwrite) };
}
