// Which browser Codex tasks use. Codex drives a browser only through an MCP server in its
// config, so the choices are the browser servers there; BrowserOS neo is the default.
// The choice goes into AGENTS.md as one marked block we can replace or remove later.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ponytail: name/URL match, add entries when users report other browser servers.
const KNOWN = [
  { re: /browseros|127\.0\.0\.1:9010/i, label: "BrowserOS neo", browseros: true },
  { re: /chrome-devtools/i, label: "Chrome (DevTools)" },
  { re: /playwright/i, label: "Playwright browser" },
  { re: /puppeteer/i, label: "Puppeteer browser" },
  { re: /browser/i, label: null },
];

export function findBrowsers(toml) {
  const servers = toml?.mcp_servers && typeof toml.mcp_servers === "object" ? toml.mcp_servers : {};
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || s.enabled === false) continue;
    const text = [name, s.url, s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x) => typeof x === "string").join(" ");
    const k = KNOWN.find((x) => x.re.test(text));
    if (k) out.push({ name, label: k.label ? `${k.label} (${name})` : name, browseros: !!k.browseros });
  }
  // BrowserOS neo first: it is the default choice.
  return out.sort((a, b) => b.browseros - a.browseros);
}

// BrowserOS installed but not connected to Codex yet? ponytail: Windows path is a guess, check in the VM.
export function browserOSInstalled(platform = process.platform) {
  const candidates =
    platform === "darwin"
      ? ["/Applications/BrowserOS.app", path.join(os.homedir(), "Applications", "BrowserOS.app")]
      : platform === "win32"
        ? [path.join(process.env.LOCALAPPDATA || "", "BrowserOS")]
        : [];
  return candidates.some((p) => p && fs.existsSync(p));
}

const START = "<!-- gptworkrouter:browser -->";
const END = "<!-- /gptworkrouter:browser -->";
const BLOCK = new RegExp(`(\\r?\\n)*${START}[\\s\\S]*?${END}(\\r?\\n)*`);

// AGENTS.md text with our block set to this server (or removed when server is null).
// The user's own text is kept as it is.
export function setBrowserBlock(text, server) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rest = text.replace(BLOCK, eol).replace(/\s+$/, "");
  const block = server ? [START, `For browser work, use the ${server} MCP server. Don't use other browser tools.`, END].join(eol) : "";
  return [rest, block].filter(Boolean).join(eol + eol) + (rest || block ? eol : "");
}
