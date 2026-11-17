#!/bin/sh
# Run the bridge at login via launchd. The tunnel is optional (set by the setup wizard, or by hand);
# installed users connect through the relay instead, which needs no setting here.
#   npm run service:install            (or: TUNNEL_CLIENT=/path/to/tunnel-client TUNNEL_PROFILE=<profile> npm run service:install)
#   npm run service:status | service:restart | service:logs | service:uninstall
#   sh scripts/service.sh plist        print the launchd plist install would write
set -e
LABEL=com.gptworkrouter.bridge
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/gptworkrouter.log"
DATA="${DATA_DIR:-$HOME/.gptworkrouter}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# service.mjs passes the Node it runs on (the installer's bundled one); else the one on PATH.
NODE="${GWR_NODE:-$(command -v node)}"
BIN="$DATA/tunnel-client"

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
envkey() { [ -n "$2" ] && printf '    <key>%s</key><string>%s</string>\n' "$1" "$(esc "$2")"; return 0; }

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(esc "$NODE")</string><string>$(esc "$DIR/server.mjs")</string></array>
  <key>WorkingDirectory</key><string>$(esc "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
EOF
  envkey PATH "$PATH"
  if [ -n "$TUNNEL_CLIENT" ]; then
    envkey TUNNEL_CLIENT "$BIN/$(basename "$TUNNEL_CLIENT")"
    envkey TUNNEL_PROFILE "$TUNNEL_PROFILE"
  fi
  # Only for users behind a proxy (set by the setup wizard).
  envkey HTTPS_PROXY "$HTTPS_PROXY"
  envkey NO_PROXY "$NO_PROXY"
  envkey NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS"
  # Another port when 3210 is taken (e.g. a second user on this Mac).
  # ponytail: not saved in installed.json; set PORT again when rerunning the installer.
  envkey PORT "${PORT:-}"
  cat <<EOF
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(esc "$LOG")</string>
  <key>StandardErrorPath</key><string>$(esc "$LOG")</string>
</dict>
</plist>
EOF
}

case "$1" in
plist) plist ;;
install)
  [ -x "$NODE" ] || { echo "Node not found: $NODE" >&2; exit 1; }
  if [ -n "$TUNNEL_CLIENT" ]; then
    : "${TUNNEL_PROFILE:?set TUNNEL_PROFILE to the tunnel-client profile name}"
    [ -f "$TUNNEL_CLIENT" ] && [ -x "$TUNNEL_CLIENT" ] || { echo "Not an executable file: $TUNNEL_CLIENT" >&2; exit 1; }
    # Background agents may be blocked from ~/Downloads, so keep a copy of the
    # tunnel-client folder (it ships its own cloudflared) next to the bridge data.
    SRC="$(cd "$(dirname "$TUNNEL_CLIENT")" && pwd)"
    if [ "$SRC" != "$BIN" ]; then
      mkdir -p "$DATA" && chmod 700 "$DATA"
      rm -rf "$BIN" && cp -R "$SRC" "$BIN"
    fi
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  plist > "$PLIST"
  plutil -lint -s "$PLIST" || { echo "Generated an invalid $PLIST; not loading it." >&2; exit 1; }
  # bootout returns before the old bridge has finished stopping; wait for it, or
  # bootstrap fails with "Input/output error".
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  n=0; while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $n -lt 30 ]; do sleep 0.5; n=$((n + 1)); done
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed. Starts at every login. Log: $LOG"
  ;;
uninstall)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed."
  ;;
restart) launchctl kickstart -k "$DOMAIN/$LABEL" ;;
status)
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "not installed"
  curl -s -m 3 "http://127.0.0.1:${PORT:-3210}/health" && echo || echo "bridge not answering"
  ;;
logs) tail -n 50 -f "$LOG" ;;
*) echo "usage: $0 install|uninstall|restart|status|logs|plist"; exit 1 ;;
esac
