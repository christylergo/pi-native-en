#!/usr/bin/env bash
# Uninstall native-prompt completely.
# Removes: the extension directory and its state directory. Nothing else.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-native-translator"

rm -rf "$EXT_DIR"
rm -rf "$STATE_DIR"

echo "native-prompt uninstalled."
echo "Restart pi (or run /reload) to clear its commands and shortcuts."
