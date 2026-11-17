#!/bin/sh
# GPTWorkRouter installer for macOS. Run in Terminal:
#   curl -fsSL @INSTALL_URL@/install.sh | sh
# Downloads this version once into ~/.gptworkrouter/app/<version>, checks it, then starts
# the setup wizard. Running it again opens the wizard's menu (repair, update, uninstall).
set -eu
VERSION="@VERSION@"
# This version's archives. GWR_BASE_URL: a test host laid out as <base>/releases/<version>/.
FILES="@FILES_URL@"
[ -n "${GWR_BASE_URL:-}" ] && FILES="$GWR_BASE_URL/releases/$VERSION"
DATA="${DATA_DIR:-$HOME/.gptworkrouter}"

case "$(uname -s)" in
Darwin) ;;
*) echo "This installer is for macOS. On Windows, use the PowerShell command instead." >&2; exit 1 ;;
esac
case "$(uname -m)" in
arm64) PLAT=darwin-arm64; SUM="@SHA_darwin-arm64@" ;;
x86_64) PLAT=darwin-x64; SUM="@SHA_darwin-x64@" ;;
*) echo "This Mac's processor ($(uname -m)) is not supported." >&2; exit 1 ;;
esac

APP="$DATA/app/$VERSION"
if [ ! -x "$APP/node/bin/node" ]; then
  FILE="gptworkrouter-$VERSION-$PLAT.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading GPTWorkRouter $VERSION (about 300 MB)..."
  if ! curl -fL --progress-bar -o "$TMP/$FILE" "$FILES/$FILE"; then
    echo "The download failed. Check your internet connection and run the command again." >&2
    exit 1
  fi
  GOT="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"
  if [ "$GOT" != "$SUM" ]; then
    echo "The download is damaged (checksum mismatch), so nothing was installed. Run the command again." >&2
    exit 1
  fi
  mkdir -p "$TMP/x" "$DATA/app"
  chmod 700 "$DATA"
  tar -xzf "$TMP/$FILE" -C "$TMP/x"
  rm -rf "$APP"
  mv "$TMP/x" "$APP"
fi

# With `curl | sh` our stdin is the download, so the wizard reads from the terminal instead.
set +e
if [ ! -t 0 ] && (exec </dev/tty) 2>/dev/null; then
  "$APP/node/bin/node" "$APP/installer/setup.mjs" "$@" </dev/tty
else
  "$APP/node/bin/node" "$APP/installer/setup.mjs" "$@"
fi
CODE=$?
# 3 = uninstalled: remove the app folders too.
if [ "$CODE" -eq 3 ]; then rm -rf "$DATA/app"; rmdir "$DATA" 2>/dev/null || true; CODE=0; fi
exit "$CODE"
