#!/bin/bash
# Install the lock-screen widget into the user's Python site-packages.
# Run as the user, no sudo needed.
set -e

PY_USERSITE=$(python3 -c 'import site; print(site.USER_SITE)')
SRC="$(cd "$(dirname "$0")/../cinnamon/lockscreen" && pwd)"

mkdir -p "$PY_USERSITE"

# Backup any existing user files first so we don't blow away surprises.
for f in usercustomize.py clawd_widget_user.py; do
    if [ -e "$PY_USERSITE/$f" ] && [ ! -L "$PY_USERSITE/$f" ]; then
        cp "$PY_USERSITE/$f" "$PY_USERSITE/$f.before-clawd-install"
    fi
done

cp -v "$SRC/usercustomize.py" "$PY_USERSITE/"
cp -v "$SRC/clawd_widget_user.py" "$PY_USERSITE/"

echo
echo "Installed to $PY_USERSITE"
echo "Restart cinnamon-screensaver to pick up the new widget:"
echo "  pkill -f /usr/share/cinnamon-screensaver/cinnamon-screensaver-main"
echo "Then lock the screen (Ctrl+Alt+L) to see Clawd."
