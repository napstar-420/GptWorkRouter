// A checkpoint per task run, so undo_task can put a folder back. Each task gets its own
// shadow git repo under <data>/checkpoints/<task>.git with the task folder as work tree:
// the user's own .git (if any) is never read or written.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.mjs";

export const SKIP = ["node_modules", ".git", ".next", "dist", "build", ".venv", "__pycache__"];
const MAX_FILES = 20000;
const MAX_BYTES = 300_000_000;

const gitDir = (id) => path.join(config.dataDir, "checkpoints", `${id}.git`);

function git(id, folder, args) {
  return execFileSync(
    "git",
    ["-c", "user.name=GPTWorkRouter", "-c", "user.email=gwr@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "-c", "core.autocrlf=false", "-c", "core.quotepath=off", `--git-dir=${gitDir(id)}`, `--work-tree=${folder}`, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

// Stage everything, including files the project's own .gitignore hides (.env, local
// databases: exactly what a bad task might delete), minus the big generated folders.
const EXCLUDES = SKIP.map((d) => `:(exclude,glob)**/${d}/**`);
const stage = (id, folder) => git(id, folder, ["add", "-A", "-f", "--", ".", ...EXCLUDES]);

// Too big to copy? Counted with the same skips as the commit.
function tooBig(folder) {
  let files = 0, bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error("big");
      }
    }
  };
  try {
    walk(folder);
    return false;
  } catch (err) {
    return err.message === "big" ? `folder over ${MAX_FILES} files or ${MAX_BYTES / 1e6} MB` : false;
  }
}

// Records the folder as it is now; returns { commit } or { skipped } with the reason.
export function checkpoint(id, folder, label) {
  try {
    if (!fs.existsSync(gitDir(id))) {
      const big = tooBig(folder);
      if (big) return { skipped: big };
      fs.mkdirSync(path.dirname(gitDir(id)), { recursive: true, mode: 0o700 });
      execFileSync("git", ["init", "-q", "--bare", gitDir(id)], { stdio: "ignore" });
      fs.writeFileSync(path.join(gitDir(id), "info", "exclude"), SKIP.map((d) => `${d}/`).join("\n") + "\n");
    }
    stage(id, folder);
    git(id, folder, ["commit", "-q", "--allow-empty", "--no-verify", "-m", label]);
    return { commit: git(id, folder, ["rev-parse", "HEAD"]) };
  } catch (err) {
    if (err.code === "ENOENT") return { skipped: "undo is unavailable: Git is not installed (Windows: install Git for Windows)" };
    return { skipped: `checkpoint failed: ${String(err.stderr || err.message).split("\n")[0]}` };
  }
}

// Files that differ between a commit and the folder now.
export function changedSince(id, folder, commit) {
  stage(id, folder);
  const out = git(id, folder, ["diff", "--cached", "--name-status", commit]);
  return out ? out.split("\n") : [];
}

// Put the folder back to `commit`. The state just before is saved first, so this can be undone too.
export function restore(id, folder, commit) {
  const saved = checkpoint(id, folder, "before undo");
  if (!saved.commit) throw new Error(`Could not save the current state first (${saved.skipped}); nothing was changed.`);
  const changed = git(id, folder, ["diff", "--name-status", commit, saved.commit]);
  git(id, folder, ["reset", "-q", "--hard", commit]);
  // diff is target -> now: a file "added" since then gets removed, a "deleted" one comes back.
  const verb = { A: "removed", D: "restored", M: "reverted" };
  const lines = changed ? changed.split("\n") : [];
  return { saved: saved.commit, changed: lines.map((l) => { const [st, ...f] = l.split("\t"); return `${verb[st[0]] || "reverted"} ${f.at(-1)}`; }) };
}

// Undo needs git on PATH. Checked once at start, reported in the log and /health.
export function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
