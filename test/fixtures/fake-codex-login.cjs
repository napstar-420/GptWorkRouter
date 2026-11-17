#!/usr/bin/env node
// Stand-in for `codex login status` in the installer test: signed in with ChatGPT,
// unless FAKE_LOGIN says otherwise ("none", "apikey", "error").
const mode = process.env.FAKE_LOGIN || "chatgpt";
const out = { chatgpt: "Logged in using ChatGPT", none: "Not logged in", apikey: "API key configured - ***", error: "Error loading config.toml: bad" }[mode];
process.stderr.write(out + "\n");
process.exit(mode === "chatgpt" || mode === "apikey" ? 0 : 1);
