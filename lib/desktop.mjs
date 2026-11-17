// The OS-specific commands: the approval dialog, the task-finished notification and
// reading the stored tunnel key, for macOS and Windows (Linux: later). Each returns
// { cmd, args, env } or null when this OS has no way. Text always travels as
// arguments (osascript) or environment variables read by a fixed PowerShell script,
// never spliced into a script: it can hold anything a task or web page wrote.
import path from "node:path";

// APPROVE_CMD / NOTIFY_CMD: a .js/.cjs/.mjs script runs with this Node (works on Windows,
// which cannot start a script file directly); anything else runs as a program.
export const userCommand = (cmd, args) => (/\.[cm]?js$/i.test(cmd) ? { cmd: process.execPath, args: [cmd, ...args] } : { cmd, args });

const ps = (script, env) => ({
  cmd: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  env: { ...process.env, ...env },
});

// Windows Popup: Yes/No (4) + warning icon (48) + No is the default (256) + on top (4096).
// It prints 6 for Yes, 7 for No, -1 when it timed out.
const WIN_DIALOG = "$r = (New-Object -ComObject WScript.Shell).Popup($env:GWR_MSG, [int]$env:GWR_SECS, $env:GWR_TITLE, 4404); Write-Output $r";

export function dialogCommand(platform, title, message, seconds) {
  if (platform === "darwin")
    return {
      cmd: "osascript",
      args: [
        "-e", "on run argv",
        "-e", `set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with icon caution giving up after ${seconds}`,
        "-e", 'if gave up of r then return "timeout"',
        "-e", "return button returned of r",
        "-e", "end run",
        title,
        message,
      ],
    };
  if (platform === "win32") return ps(WIN_DIALOG, { GWR_TITLE: title, GWR_MSG: `${message}\n\nYes = Approve    No = Deny`, GWR_SECS: String(seconds) });
  return null;
}

// What the dialog printed, as approve / deny / timeout.
export function dialogAnswer(platform, stdout) {
  const out = String(stdout || "").trim();
  if (platform === "win32") return out === "6" ? "approve" : out === "-1" ? "timeout" : "deny";
  return out === "Approve" ? "approve" : out === "timeout" ? "timeout" : "deny";
}

const WIN_NOTIFY = [
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Information",
  "$n.Text = 'GPTWorkRouter'",
  "$n.BalloonTipTitle = $env:GWR_TITLE",
  "$n.BalloonTipText = $env:GWR_MSG",
  "$n.Visible = $true",
  "$n.ShowBalloonTip(10000)",
  "Start-Sleep -Seconds 8",
  "$n.Dispose()",
].join("; ");

export function notifyCommand(platform, title, body) {
  if (platform === "darwin")
    return { cmd: "osascript", args: ["-e", "on run argv", "-e", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', "-e", "end run", title, body] };
  if (platform === "win32") return ps(WIN_NOTIFY, { GWR_TITLE: title, GWR_MSG: body });
  return null;
}

export const KEY_NAME = "gptworkrouter-tunnel";
export const winKeyFile = (dataDir) => path.join(dataDir, "tunnel-key.dpapi");

// Windows keeps the key in a file encrypted with DPAPI: only this Windows user can decrypt it.
const WIN_KEY = [
  "$f = $env:GWR_KEYFILE",
  "if (Test-Path -LiteralPath $f) {",
  "  $s = (Get-Content -LiteralPath $f -TotalCount 1) | ConvertTo-SecureString",
  "  [System.Net.NetworkCredential]::new('', $s).Password",
  "}",
].join("\n");

// name/file pick which key: the tunnel key by default, or the relay machine key.
export function keyCommand(platform, { user, dataDir, name = KEY_NAME, file }) {
  if (platform === "darwin") return { cmd: "security", args: ["find-generic-password", "-a", user, "-s", name, "-w"] };
  if (platform === "win32") return ps(WIN_KEY, { GWR_KEYFILE: file || winKeyFile(dataDir) });
  return null;
}

// Storing a key the bridge made itself (the relay machine key). The secret never goes on a
// command line (other processes can read those): on macOS it goes to `security -i` on stdin,
// on Windows through an environment variable read by a fixed script. null = no OS store.
const WIN_STORE = [
  "$f = $env:GWR_KEYFILE",
  "New-Item -ItemType Directory -Force (Split-Path -LiteralPath $f) | Out-Null",
  "ConvertTo-SecureString $env:GWR_SECRET -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $f",
].join("\n");
const quoted = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;

export function storeKeyCommand(platform, { user, name, file, secret }) {
  if (platform === "darwin")
    return { cmd: "security", args: ["-i"], input: `add-generic-password -U -a ${quoted(user)} -s ${quoted(name)} -w ${quoted(secret)}\n` };
  if (platform === "win32") return ps(WIN_STORE, { GWR_KEYFILE: file, GWR_SECRET: secret });
  return null;
}

// Removing it again. Windows: the caller deletes the file itself.
export function deleteKeyCommand(platform, { user, name }) {
  if (platform === "darwin") return { cmd: "security", args: ["delete-generic-password", "-a", user, "-s", name] };
  return null;
}

// The one-time command the user runs (and types the key into) to store it.
export function keyStoreHint(platform, dataDir) {
  if (platform === "darwin") return `security add-generic-password -a "$USER" -s ${KEY_NAME} -w`;
  if (platform === "win32")
    return `New-Item -ItemType Directory -Force '${dataDir}' | Out-Null; Read-Host -AsSecureString 'Tunnel key' | ConvertFrom-SecureString | Set-Content -LiteralPath '${winKeyFile(dataDir)}'   (in PowerShell)`;
  return null;
}
