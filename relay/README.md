# GPTWorkRouter relay

The hosted service that lets friends and clients use GPTWorkRouter without their own tunnel or OpenAI key.
ChatGPT signs in to it with OAuth and calls `https://<relay>/mcp`. The relay passes each call down the
outbound connection of that person's own computer, where the bridge runs Codex. Design: `../docs/plan-relay.md`.

Files: `server.mjs` (routes, OAuth, sign-in, pages), `pipe.mjs` (computer sockets), `db.mjs` (SQLite),
`admin.mjs` (invites), `test/relay.test.mjs` (end-to-end, offline), `Dockerfile`, `fly.toml`.

## Run and test locally

```bash
cd relay
npm install
npm test
```

To try it by hand: start it with a type-your-email sign-in (works only on localhost), invite yourself, then pair a bridge with it.

```bash
DEV_LOGIN=1 npm start
```

```bash
node admin.mjs allow you@example.com
```

```bash
cd .. && node scripts/relay.mjs pair --relay http://localhost:8080
```

## Settings

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | The address users see, `https://…`. Default `http://localhost:8080` |
| `DATA_DIR` | SQLite, request logs (`logs/`, kept 30 days) and downloads (`downloads/`). Default `./data` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in |
| `DEV_LOGIN=1` | Type-an-email sign-in, only when `PUBLIC_URL` is `http://localhost…` |

Signing keys and cookie keys are made on first start and kept in the database.

## Put it online (Zohaib does this; nothing here was created or deployed)

Use the same app name everywhere. `gptworkrouter-relay` is the placeholder. If Fly says the name is taken, pick
another one and change it in `fly.toml` (`app`, `PUBLIC_URL`), in `../lib/config.mjs` (`relayUrl`) and in
`../installer/build-release.mjs` (`DEFAULT_BASE`).

1. Install Fly's tool and sign in:

   ```bash
   brew install flyctl
   ```

   ```bash
   fly auth login
   ```

2. Check that Singapore is still offered (nearest to Pakistan):

   ```bash
   fly platform regions
   ```

3. Create the app and its disk:

   ```bash
   cd ~/dev/gpt-work-router/relay && fly apps create gptworkrouter-relay
   ```

   ```bash
   fly volumes create relay_data --region sin --size 1
   ```

4. Create the two sign-in apps, using these exact callback addresses:
   - Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID, type Web application.
     Authorised redirect URI: `https://gptworkrouter-relay.fly.dev/login/callback/google`
   - GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
     Homepage `https://gptworkrouter-relay.fly.dev`, callback `https://gptworkrouter-relay.fly.dev/login/callback/github`

5. Store the four values in Fly. Type each one yourself; never paste them into a chat. Client IDs are not secret:

   ```bash
   fly secrets set --stage GOOGLE_CLIENT_ID=paste-the-google-client-id GITHUB_CLIENT_ID=paste-the-github-client-id
   ```

   Secrets go in through a hidden prompt, so they stay out of your shell history:

   ```bash
   read -s "S?Google client secret: " && fly secrets set --stage GOOGLE_CLIENT_SECRET="$S"; unset S
   ```

   ```bash
   read -s "S?GitHub client secret: " && fly secrets set --stage GITHUB_CLIENT_SECRET="$S"; unset S
   ```

6. Deploy:

   ```bash
   fly deploy
   ```

7. Invite yourself (and later each friend):

   ```bash
   fly ssh console -C "node /app/admin.mjs allow you@gmail.com"
   ```

8. Check it: `https://gptworkrouter-relay.fly.dev/healthz` should say `{"ok":true,…}`.

## Admin

```bash
fly ssh console -C "node /app/admin.mjs list"
```

Commands: `allow <email>` (invite), `deny <email>` (remove the invite), `disable <email>` (revoke all ChatGPT links
and unlink the computer), `enable <email>`, `list`.

## Downloads for the installer

The repo is private, so the relay serves the installer from `DATA_DIR/downloads/`:

| URL | File |
|---|---|
| `/install.sh`, `/install.ps1` | `downloads/install.sh`, `downloads/install.ps1` (no-cache) |
| `/releases/latest.json` | `downloads/releases/latest.json` (no-cache) |
| `/releases/<version>/<file>` | `downloads/releases/<version>/<file>`, e.g. the zip and `SHA256SUMS` (cached for good) |

`npm run release` in the repo root builds these files (installer plan). Copy them onto the volume, for example
with `fly ssh sftp shell`.

## What the relay can see

It sees every request and reply between ChatGPT and the computers. It stores none of them. The request log has one
line per call (account, computer, MCP method, tool name, status, time, sizes), never content or tokens. The
sandbox, approval dialog and secret masking all stay on each user's computer. Upgrade planned for when there are
more than a handful of users: a hosted OAuth provider, with the bridge checking ChatGPT's token itself, so a hacked
relay alone can't start tasks. See `../docs/plan-relay.md` §8.
