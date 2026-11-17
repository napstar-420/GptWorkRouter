// Codex can read the whole disk (Codex's read limits need permission profiles, which do not
// mix with sandbox_mode), so anything that looks like a secret is masked before it reaches
// Chat: an injected page could otherwise have Codex print a key and Chat carry it off.
// ponytail: pattern list, not a guarantee; add patterns as new key formats show up.
const PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "[secret removed]");
  return out;
}
