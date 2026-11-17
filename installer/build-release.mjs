// Build the release files. Default: for GitHub Releases of the public repo (scripts/publish.mjs uploads them):
//   install.sh, install.ps1, latest.json, releases/<version>/<archives>, SHA256SUMS
// For a test host instead, --base-url URL serves the same files at <base>/install.sh and <base>/releases/<version>/.
// Run on the Mac:  node installer/build-release.mjs [--platforms darwin-arm64,win32-x64] [--base-url URL] [--notes "one line"] [--out DIR]
// Each platform file is a .tar.gz with the app, its production node_modules (with that
// platform's Codex build), a pinned Node runtime and a portable Git (dugite-native).
// Downloads are checked against their published SHA-256 sums. Nothing is uploaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO } from "../lib/update.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"];
const NODE_VERSION = process.version; // ship the Node the tests ran on
const GIT_TAG = "v2.56.1"; // dugite-native release; bump together with a VM test
const GIT_BUILD = "238326e";
// What goes into the bundle (no tests, docs, relay service or dev files).
const FILES = ["server.mjs", "package.json", "package-lock.json", "apps.json", "README.md", "lib", "scripts", "installer"];

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
function untar(file, dest, strip = 0) {
  fs.mkdirSync(dest, { recursive: true });
  run("tar", ["-xf", file, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])]); // bsdtar reads .zip too
}

async function addNode(plat, dest, cache) {
  const [os_, arch] = plat.split("-");
  const name = os_ === "win32" ? `node-${NODE_VERSION}-win-${arch}.zip` : `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = path.join(cache, `node-${NODE_VERSION}-SHASUMS256.txt`);
  if (!fs.existsSync(sums)) await download(`${base}/SHASUMS256.txt`, sums);
  const want = fs.readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${name}`))?.split(" ")[0];
  if (!want) throw new Error(`${name} is not in Node's SHASUMS256.txt`);
  const file = path.join(cache, name);
  if (!fs.existsSync(file) || sha256(file) !== want) await download(`${base}/${name}`, file);
  if (sha256(file) !== want) throw new Error(`Node download ${name} doesn't match SHASUMS256.txt`);
  untar(file, path.join(dest, "node"), 1);
}

async function addGit(plat, dest, cache) {
  const suffix = { "darwin-arm64": "macOS-arm64", "darwin-x64": "macOS-x64", "win32-x64": "windows-x64", "win32-arm64": "windows-arm64" }[plat];
  const name = `dugite-native-${GIT_TAG}-${GIT_BUILD}-${suffix}.tar.gz`;
  const base = `https://github.com/desktop/dugite-native/releases/download/${GIT_TAG}`;
  const file = path.join(cache, name);
  const sumFile = path.join(cache, `${name}.sha256`);
  if (!fs.existsSync(sumFile)) await download(`${base}/${name}.sha256`, sumFile);
  const want = fs.readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
  if (!fs.existsSync(file) || sha256(file) !== want) await download(`${base}/${name}`, file);
  if (sha256(file) !== want) throw new Error(`Git download ${name} doesn't match its .sha256`);
  untar(file, path.join(dest, "git"));
}

// OpenAI's tunnel-client, cloudflared build (one `run` command, bundles cloudflared). The wizard
// writes its profile; the bridge runs it. Checked against the release's SHA256SUMS.txt.
const TC_TAG = "v0.0.21"; // bump together with a real tunnel test
export async function addTunnelClient(plat, dest, cache) {
  const [os_, arch] = plat.split("-");
  const name = `tunnel-client-runtime-cloudflared-${TC_TAG}-${os_ === "win32" ? "windows" : "darwin"}-${arch === "x64" ? "amd64" : "arm64"}.zip`;
  const base = `https://github.com/openai/tunnel-client/releases/download/${TC_TAG}`;
  const sums = path.join(cache, `tunnel-client-${TC_TAG}-SHA256SUMS.txt`);
  if (!fs.existsSync(sums)) await download(`${base}/SHA256SUMS.txt`, sums);
  const want = fs.readFileSync(sums, "utf8").split("\n").find((l) => l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`${name} is not in tunnel-client's SHA256SUMS.txt`);
  const file = path.join(cache, name);
  if (!fs.existsSync(file) || sha256(file) !== want) await download(`${base}/${name}`, file);
  if (sha256(file) !== want) throw new Error(`tunnel-client download ${name} doesn't match SHA256SUMS.txt`);
  untar(file, path.join(dest, "tunnel-client"));
}

// Production node_modules for the target: install here, then swap in that platform's Codex build.
function addModules(plat, dest, cache) {
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dest });
  const openai = path.join(dest, "node_modules", "@openai");
  for (const d of fs.readdirSync(openai)) if (/^codex-(darwin|win32|linux)-/.test(d)) fs.rmSync(path.join(openai, d), { recursive: true, force: true });
  const ver = JSON.parse(fs.readFileSync(path.join(openai, "codex", "package.json"), "utf8")).version;
  const tgz = execFileSync("npm", ["pack", `@openai/codex@${ver}-${plat}`, "--silent", "--pack-destination", cache], { cwd: cache, encoding: "utf8" }).trim().split("\n").at(-1);
  untar(path.join(cache, tgz), path.join(openai, `codex-${plat}`), 1);
}

// Fill the bootstrap templates with version, URLs and checksums. GitHub (`repo`): the one-liner uses
// releases/latest/download, and each bootstrap downloads its own version's archives. Test host (`base`):
// <base>/install.sh and <base>/releases/<version>/.
export function renderBootstrap(template, { version, base, repo, sums }) {
  const gh = !base && `https://github.com/${repo}/releases`;
  const installUrl = gh ? `${gh}/latest/download` : base;
  const filesUrl = gh ? `${gh}/download/v${version}` : `${base}/releases/${version}`;
  let out = template.replaceAll("@VERSION@", version).replaceAll("@INSTALL_URL@", installUrl).replaceAll("@FILES_URL@", filesUrl);
  for (const p of PLATFORMS) out = out.replaceAll(`@SHA_${p}@`, sums[p] ?? "missing");
  return out;
}

async function main() {
  const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
  const plats = arg("--platforms", PLATFORMS.join(",")).split(",");
  const base = arg("--base-url", "").replace(/\/$/, "");
  const notes = arg("--notes", "");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const out = path.resolve(arg("--out", path.join(ROOT, "dist", "release")));
  const rel = path.join(out, "releases", version);
  const cache = path.join(os.tmpdir(), "gwr-build-cache");
  fs.mkdirSync(rel, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const sums = {};
  for (const plat of plats) {
    if (!PLATFORMS.includes(plat)) throw new Error(`unknown platform ${plat}`);
    console.log(`\n== ${plat}`);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `gwr-stage-${plat}-`));
    for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });
    addModules(plat, stage, cache);
    await addNode(plat, stage, cache);
    await addGit(plat, stage, cache);
    await addTunnelClient(plat, stage, cache);
    const file = path.join(rel, `gptworkrouter-${version}-${plat}.tar.gz`);
    run("tar", ["-czf", file, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } }); // no macOS ._ files
    fs.rmSync(stage, { recursive: true, force: true });
    sums[plat] = sha256(file);
    console.log(`${path.basename(file)}  ${(fs.statSync(file).size / 1e6).toFixed(0)} MB  ${sums[plat]}`);
  }
  // Keep sums of platforms built earlier for this version.
  const sumsFile = path.join(rel, "SHA256SUMS");
  for (const l of fs.existsSync(sumsFile) ? fs.readFileSync(sumsFile, "utf8").split("\n") : []) {
    const m = l.match(/^([0-9a-f]{64}) {2}gptworkrouter-.+-(\w+-\w+)\.tar\.gz$/);
    if (m && !sums[m[2]]) sums[m[2]] = m[1];
  }
  fs.writeFileSync(sumsFile, Object.entries(sums).map(([p, s]) => `${s}  gptworkrouter-${version}-${p}.tar.gz`).join("\n") + "\n");
  for (const f of ["install.sh", "install.ps1"]) {
    fs.writeFileSync(path.join(out, f), renderBootstrap(fs.readFileSync(path.join(ROOT, "installer", f), "utf8"), { version, base, repo: REPO, sums }));
  }
  // What running bridges check for updates (lib/update.mjs).
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify({ version, date: new Date().toISOString().slice(0, 10), notes }) + "\n");
  console.log(`\nRelease files in ${out}. Nothing was uploaded${base ? "" : "; publish with: npm run publish"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => (console.error(err.message), process.exit(1)));
