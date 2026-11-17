// npm run service:<install|uninstall|restart|status|logs> on any OS:
// launchd on macOS (service.sh), a logon Scheduled Task on Windows (service.ps1).
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] ?? "";
// The login task runs on the same Node as this script (the installer's bundled one when installed).
const opts = { stdio: "inherit", env: { ...process.env, GWR_NODE: process.execPath } };
const r =
  process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "service.ps1"), cmd], opts)
    : process.platform === "darwin"
      ? spawnSync("sh", [path.join(dir, "service.sh"), cmd], opts)
      : { status: 1, error: new Error("Running at login is supported on macOS and Windows for now. Start it with: npm start") };
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
