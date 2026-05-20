#!/bin/bash
# Install the GNOME Shell extension. No sudo needed.
set -e

UUID="clawd@rowdy4e"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC="$(cd "$(dirname "$0")/../gnome/extension" && pwd)"

mkdir -p "$DEST"
cp -v "$SRC"/* "$DEST/"
chmod +x "$DEST"/*.sh 2>/dev/null || true

echo
echo "Installed to $DEST"
echo
echo "Activate it:"
echo "  1. Log out + log back in (GNOME re-reads extensions only on session start)"
echo "  2. Open 'Extensions' app (or run gnome-extensions enable $UUID)"
echo "  3. Toggle Clawd on"
echo
echo "To enable from CLI immediately after log-in:"
echo "  gnome-extensions enable $UUID"
echo
echo "Check it loaded:"
echo "  gnome-extensions info $UUID"
