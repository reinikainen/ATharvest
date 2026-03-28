#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/atharvest"

mkdir -p "$TARGET_DIR"
ln -sf "$SCRIPT_DIR/atharvest" "$TARGET_PATH"

printf 'Installed atharvest to %s\n' "$TARGET_PATH"
printf 'If needed, add this to your shell profile:\n'
printf 'export PATH="$HOME/.local/bin:$PATH"\n'
