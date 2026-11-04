#!/usr/bin/env bash
# Install native-prompt into pi's global extension directory.
# Existing config.json is preserved; everything else is overwritten.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions/native-prompt"

mkdir -p "$DEST_DIR"
for file in index.ts translator.ts panel.ts uninstall.sh README.md; do
	cp "$SRC_DIR/$file" "$DEST_DIR/$file"
done
if [[ ! -f "$DEST_DIR/config.json" && -f "$SRC_DIR/config.example.json" ]]; then
	cp "$SRC_DIR/config.example.json" "$DEST_DIR/config.json"
fi

echo "native-prompt installed to $DEST_DIR"
echo "Run /reload in pi (or restart it) to activate, then /native model to pick a model."
