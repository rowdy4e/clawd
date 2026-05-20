#!/bin/bash
# Install the Cinnamon panel applet.
# Run as the user, no sudo needed.
set -e

UUID="claude-usage@rowdy4e"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"
SRC="$(cd "$(dirname "$0")/../cinnamon/applet" && pwd)"

mkdir -p "$DEST"
cp -v "$SRC"/* "$DEST/"
chmod +x "$DEST"/*.sh

# Make sure ccusage helper script can find node (only if user uses ccusage).
echo
echo "Applet installed to $DEST"
echo "Add it to your panel:"
echo "  Right-click the panel → Applets → Manage applets → enable 'Claude Usage'"
echo "  …or run:"
echo "    gsettings set org.cinnamon enabled-applets \"\$(gsettings get org.cinnamon enabled-applets | sed \"s/]$/, 'panel1:right:0:$UUID'\\]/\")\""
