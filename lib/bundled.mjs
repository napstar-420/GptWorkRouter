// When the bridge runs from an installer bundle (app/<version>/ with node/ and git/ next
// to server.mjs), put the bundled Git and Node first on PATH, for undo and for Codex tasks.
// A Git the user has is then never used, so its version can't break undo. The Git env vars
// are the ones dugite sets for the same dugite-native builds. Imported first by server.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function bundledEnv(root, platform = process.platform, env = process.env) {
  const git = path.join(root, "git");
  const out = {};
  const dirs = [];
  if (fs.existsSync(git)) {
    if (platform === "win32") {
      const sub = fs.existsSync(path.join(git, "clangarm64")) ? "clangarm64" : "mingw64";
      dirs.push(path.join(git, sub, "bin"));
      out.GIT_EXEC_PATH = path.join(git, sub, "libexec", "git-core");
    } else {
      dirs.push(path.join(git, "bin"));
      out.GIT_EXEC_PATH = path.join(git, "libexec", "git-core");
      out.GIT_TEMPLATE_DIR = path.join(git, "share", "git-core", "templates");
      if (!env.GIT_CONFIG_SYSTEM) out.GIT_CONFIG_SYSTEM = path.join(git, "etc", "gitconfig");
    }
  }
  const node = path.join(root, "node");
  if (fs.existsSync(node)) dirs.push(platform === "win32" ? node : path.join(node, "bin"));
  if (dirs.length) {
    const key = platform === "win32" ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "Path" : "PATH";
    out[key] = [...dirs, env[key]].filter(Boolean).join(platform === "win32" ? ";" : ":");
  }
  return out;
}

Object.assign(process.env, bundledEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
