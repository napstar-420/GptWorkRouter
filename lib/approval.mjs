// Human approval for risky capabilities: a dialog (macOS or Windows) that only a person can click,
// so a prompt-injected Chat cannot approve its own request. No answer in time = deny.
// APPROVE_CMD replaces the dialog (tests, or your own approver): exit 0 approves.
import { execFile } from "node:child_process";
import { config } from "./config.mjs";
import { dialogCommand, dialogAnswer, userCommand } from "./desktop.mjs";

export const CAPABILITIES = {
  network: "internet access for its commands (downloads, installs, git push)",
  write_anywhere: "writing anywhere on this computer, not just its folder",
};

export function askApproval({ id, folder, needs, reason, text }) {
  const title = "GPTWorkRouter: approve this task?";
  const message =
    `A ChatGPT task wants:\n${needs.map((n) => `• ${CAPABILITIES[n]}`).join("\n")}\n\n` +
    `Folder: ${folder}\nTask: ${id}\nReason given: ${reason || "(none)"}\n\n` +
    // Start and end of long instructions: a payload hidden after a harmless opening stays visible.
    `Instructions:\n${text.length > 1000 ? `${text.slice(0, 500)}\n…(${text.length - 1000} characters not shown)…\n${text.slice(-500)}` : text}\n\n` +
    "Approve only if you asked for this.";
  return new Promise((resolve) => {
    const done = (approved, how) => resolve({ approved, how });
    if (config.approveCmd) {
      const c = userCommand(config.approveCmd, [title, message]);
      execFile(c.cmd, c.args, { timeout: config.approvalSeconds * 1000, windowsHide: true }, (err) => done(!err, err ? "denied" : "approved"));
      return;
    }
    const cmd = dialogCommand(process.platform, title, message, config.approvalSeconds);
    if (!cmd) return done(false, "no way to ask on this system; set APPROVE_CMD");
    execFile(cmd.cmd, cmd.args, { timeout: (config.approvalSeconds + 15) * 1000, ...(cmd.env ? { env: cmd.env, windowsHide: true } : {}) }, (err, stdout) => {
      const answer = dialogAnswer(process.platform, stdout);
      if (answer === "approve") return done(true, "approved");
      if (answer === "timeout") return done(false, `no answer within ${config.approvalSeconds >= 120 ? `${Math.round(config.approvalSeconds / 60)} minutes` : `${config.approvalSeconds} seconds`}`);
      const cancelled = err && /-128/.test(err.message); // macOS: the Deny button
      if (err && !cancelled) console.error(`[approval] dialog failed: ${err.message.split("\n")[0]}`);
      done(false, err && !cancelled ? "the approval dialog could not be shown" : "denied");
    });
  });
}
