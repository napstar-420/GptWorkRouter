// Relay admin, run where the database is (on Fly: fly ssh console, then cd /app):
//   node admin.mjs allow <email>      invite someone (they can then sign in)
//   node admin.mjs deny <email>       remove an invite (an existing account keeps working; use disable)
//   node admin.mjs disable <email>    turn an account off: ChatGPT links revoked, computer unlinked
//   node admin.mjs enable <email>
//   node admin.mjs list               invites, accounts, computers, ChatGPT links
import path from "node:path";
import { openDb } from "./db.mjs";

const store = openDb(path.resolve(process.env.DATA_DIR || "data"));
const [cmd, arg] = process.argv.slice(2);
const email = String(arg || "").trim().toLowerCase();
const needEmail = () => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Give an email address.");
    process.exit(1);
  }
};

if (cmd === "allow") {
  needEmail();
  store.allow(email);
  console.log(`Invited ${email}.`);
} else if (cmd === "deny") {
  needEmail();
  store.disallow(email);
  console.log(`Removed the invite for ${email}.`);
} else if (cmd === "disable" || cmd === "enable") {
  needEmail();
  const a = store.one("SELECT * FROM accounts WHERE email = ?", email);
  if (!a) {
    console.error(`No account for ${email}.`);
    process.exit(1);
  }
  store.run("UPDATE accounts SET disabled = ? WHERE id = ?", cmd === "disable" ? 1 : 0, a.id);
  if (cmd === "disable") {
    store.run("DELETE FROM oidc WHERE account_id = ?", a.id); // grants, tokens, sessions
    const m = store.machineOf(a.id);
    if (m) store.removeMachine(m.id); // the relay closes its socket within ~25 s
  }
  console.log(`${cmd === "disable" ? "Disabled" : "Enabled"} ${email}.`);
} else if (cmd === "list") {
  const invites = store.q("SELECT email FROM allow ORDER BY email").map((r) => r.email);
  console.log(`Invites (${invites.length}): ${invites.join(", ") || "none"}`);
  for (const a of store.q("SELECT * FROM accounts ORDER BY created_at")) {
    const m = store.machineOf(a.id);
    console.log(`- ${a.email}${a.disabled ? " (disabled)" : ""}: computer ${m ? `${m.name} (${m.os}, ${m.id})` : "none"}, ChatGPT links ${store.grantCount(a.id)}`);
  }
} else {
  console.error("Usage: node admin.mjs allow|deny|disable|enable <email> | list");
  process.exit(1);
}
