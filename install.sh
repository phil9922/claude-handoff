#!/usr/bin/env sh
# macOS / Linux installer. Requires node (which you already have, since Claude Code runs on it).
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/install.js" "$@"
