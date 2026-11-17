// Upload a built release (installer/build-release.mjs) to GitHub Releases of the public repo.
//   npm run release:publish [-- --dir dist/release]
// Checks the files first, asks before uploading, and never deletes or replaces a release:
// a bad release is fixed by publishing a higher version.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO } from "../lib/update.mjs";
import { PLATFORMS } from "../installer/build-release.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const dir = path.resolve(arg("--dir", path.join(ROOT, "dist", "release")));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const tag = `v${version}`;
const stop = (msg) => (console.error(msg), process.exit(1));
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

// Everything a user's install needs, present and matching.
const rel = path.join(dir, "releases", version);
const archives = PLATFORMS.map((p) => path.join(rel, `gptworkrouter-${version}-${p}.tar.gz`));
const files = [...archives, path.join(rel, "SHA256SUMS"), ...["install.sh", "install.ps1", "latest.json"].map((f) => path.join(dir, f))];
for (const f of files) if (!fs.existsSync(f)) stop(`Missing ${path.relative(dir, f)}: run npm run release first (all four platforms).`);
for (const f of archives) {
  const s = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const boot = f.includes("win32") ? "install.ps1" : "install.sh";
  if (!read(`releases/${version}/SHA256SUMS`).includes(`${s}  ${path.basename(f)}`) || !read(boot).includes(s)) stop(`${path.basename(f)} doesn't match SHA256SUMS or ${boot}: rebuild.`);
}
if (JSON.parse(read("latest.json")).version !== version) stop(`latest.json isn't for ${version}: rebuild.`);
for (const b of ["install.sh", "install.ps1"])
  if (!read(b).includes(`github.com/${REPO}/releases/download/${tag}`)) stop(`${b} wasn't built for GitHub (built with --base-url?): rebuild without it.`);
if (spawnSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" }).status === 0) stop(`${tag} is already published. Bump the version in package.json for a new release.`);

const notes = JSON.parse(read("latest.json")).notes || `GPTWorkRouter ${version}`;
const mb = files.reduce((n, f) => n + fs.statSync(f).size, 0) / 1e6;
console.log(`Publish ${tag} to https://github.com/${REPO}/releases (public): ${files.length} files, ${mb.toFixed(0)} MB.\nNotes: ${notes}`);
// --yes: no prompt (the release workflow; pushing the tag was the decision).
if (!process.argv.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const yes = /^y(es)?$/i.test((await rl.question("Upload now? (y/N) ")).trim());
  rl.close();
  if (!yes) stop("Nothing uploaded.");
}
const r = spawnSync("gh", ["release", "create", tag, ...files, "--repo", REPO, "--title", `GPTWorkRouter ${version}`, "--notes", notes, "--latest"], { stdio: "inherit" });
if (r.status !== 0) stop("Upload failed (see above). Check the Releases page before trying again.");
console.log(`Published. Users install or update with:\n  curl -fsSL https://github.com/${REPO}/releases/latest/download/install.sh | sh\n  irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex`);
