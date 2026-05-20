#!/bin/bash
# Remove the lock-screen widget (no sudo needed).
set -e
PY_USERSITE=$(python3 -c 'import site; print(site.USER_SITE)')
rm -fv "$PY_USERSITE/clawd_widget_user.py"
rm -fv "$PY_USERSITE/usercustomize.py"
echo
echo "Lockscreen widget removed. Restart cinnamon-screensaver to clear:"
echo "  pkill -f /usr/share/cinnamon-screensaver/cinnamon-screensaver-main"
