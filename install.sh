#!/usr/bin/env bash
# tg-bridge install: a thin wrapper. It builds the repo and runs `tg-bridge setup`, which asks the questions (token,
# owner id, optional ML worker). It makes no Claude Code changes: the plugin does the Claude side (docs/install.md step 5).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node 22.13 or newer is required (not found on PATH)"
command -v npm >/dev/null 2>&1 || die "npm is required (not found on PATH)"
node -p 'const [a, b] = process.versions.node.split(".").map(Number); a > 22 || (a === 22 && b >= 13)' \
  | grep -qx true || die "node 22.13 or newer is required (found $(node -p 'process.versions.node'))"

echo "==> build: npm ci and npm run build in $REPO"
(cd "$REPO" && npm ci && npm run build)

echo "==> setup"
node "$REPO/dist/cli/tg-bridge.js" setup

cat <<EOM

==> next steps
    - start the router: tg-bridge service install --start   (from $REPO/dist/cli/tg-bridge.js if tg-bridge is not on PATH: npm link)
    - group: create a private supergroup with Topics, add the bot as admin, send /bind in it (docs/install.md step 3)
    - plugin, inside Claude Code: /plugin marketplace add $REPO/plugin
                                  /plugin install tg-bridge@indicozy (docs/install.md step 5)
EOM
