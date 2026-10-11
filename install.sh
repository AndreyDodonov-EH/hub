#!/usr/bin/env bash
# Hub installer:
#
#   curl -fsSL https://raw.githubusercontent.com/AndreyDodonov-EH/hub/main/install.sh | bash
#
# Clones the hub, installs its dependencies there and links `hub` onto your PATH.
# Run it again to update.
#
#   HUB_HOME=...   where the checkout goes (default ~/.local/share/hub)
#   HUB_BIN=...    where the `hub` link goes (default ~/.local/bin)
#   HUB_REPO=...   what to clone (default the GitHub repository)
set -euo pipefail

REPO=${HUB_REPO:-https://github.com/AndreyDodonov-EH/hub.git}
DIR=${HUB_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/hub}
BIN=${HUB_BIN:-$HOME/.local/bin}

say() { printf 'hub: %s\n' "$*"; }
die() { printf 'hub: %s\n' "$*" >&2; exit 1; }

# tmux 3.2 or later; a build that does not say a number (`tmux master`) is taken as new
tmux_ok() {
  local major minor
  read -r major minor <<<"$(tmux -V | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')"
  [ -z "${major:-}" ] || [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 2 ]; }
}

# all of it in a function, called on the last line: a download cut short runs nothing
main() {
  local tool missing="" updating=""
  for tool in git node npm tmux curl; do
    command -v "$tool" >/dev/null || missing="$missing $tool"
  done
  [ -z "$missing" ] || die "missing:$missing — the hub needs git, Node 20+ (with npm), tmux 3.2+ and curl"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
    die "Node 20 or later is needed, this is $(node -v)"
  tmux_ok || die "tmux 3.2 or later is needed, this is $(tmux -V)"

  if [ -d "$DIR/.git" ]; then
    updating=1
    say "updating $DIR"
    git -C "$DIR" pull --quiet --ff-only || die "$DIR has changes of its own — update it by hand"
  elif [ -e "$DIR" ]; then
    die "$DIR exists and is not a hub checkout — move it away, or set HUB_HOME"
  else
    say "cloning into $DIR"
    git clone --quiet --depth 1 "$REPO" "$DIR"
  fi

  say "installing dependencies"
  (cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error) ||
    die "npm install failed — on Linux node-pty compiles, which takes a C++ toolchain (Debian/Ubuntu: build-essential and python3)"

  mkdir -p "$BIN"
  ln -sf "$DIR/hub.mjs" "$BIN/hub"
  say "linked $BIN/hub"

  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "$BIN is not on your PATH — add it:  export PATH=\"$BIN:\$PATH\"" ;;
  esac
  # an older install (`npm link`) or another program of the same name
  local first
  first=$(command -v hub || true)
  if [ -n "$first" ] && [ "$first" != "$BIN/hub" ]; then
    say "another \`hub\` comes first on your PATH: $first"
  fi

  if [ -n "$updating" ]; then
    say "updated — a running server keeps the old code until \`hub stop\` and \`hub\`"
  else
    say "installed — in a git repository: \`hub init\`, then \`hub\`"
  fi
}

main "$@"
