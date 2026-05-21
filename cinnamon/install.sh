#!/bin/bash
# Cinnamon installer — handles the panel applet and the lock-screen widget.
# Run with no args for interactive flow, or pass flags:
#   --auto                  install everything
#   --applet                panel applet only
#   --lockscreen            lock-screen widget only
#   --uninstall-lockscreen  remove the lock-screen widget
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SHARED="$HERE/../shared"
APPLET_UUID="claude-usage@rowdy4e"

install_applet() {
    local dest="$HOME/.local/share/cinnamon/applets/$APPLET_UUID"
    mkdir -p "$dest"
    cp -v "$HERE/applet"/* "$dest/"
    cp -v "$SHARED/"*.json "$dest/"
    chmod +x "$dest"/*.sh 2>/dev/null || true
    echo
    echo "Panel applet installed to $dest"
    echo "Add it to the panel: right-click panel → Applets → enable 'Claude Usage'"
}

install_lockscreen() {
    local pyuser
    pyuser=$(python3 -c 'import site; print(site.USER_SITE)')
    mkdir -p "$pyuser"
    for f in usercustomize.py clawd_widget_user.py; do
        if [ -e "$pyuser/$f" ] && [ ! -L "$pyuser/$f" ] && ! grep -q "Clawd" "$pyuser/$f" 2>/dev/null; then
            cp "$pyuser/$f" "$pyuser/$f.before-clawd-install"
            echo "Backed up existing $f to $f.before-clawd-install"
        fi
    done
    cp -v "$HERE/lockscreen/usercustomize.py" "$pyuser/"
    cp -v "$HERE/lockscreen/clawd_widget_user.py" "$pyuser/"
    cp -v "$HERE/lockscreen/anim_runner.py" "$pyuser/"
    cp -v "$SHARED/"*.json "$pyuser/"
    echo
    echo "Lock-screen widget installed to $pyuser"
    echo "Restart the screensaver to pick it up:"
    echo "  pkill -f /usr/share/cinnamon-screensaver/cinnamon-screensaver-main"
}

uninstall_lockscreen() {
    local pyuser
    pyuser=$(python3 -c 'import site; print(site.USER_SITE)')
    rm -fv "$pyuser/clawd_widget_user.py" "$pyuser/usercustomize.py" \
           "$pyuser/anim_runner.py" "$pyuser/forms.json" "$pyuser/animations.json"
    echo
    echo "Lock-screen widget removed."
    echo "Restart the screensaver to clear it from memory:"
    echo "  pkill -f /usr/share/cinnamon-screensaver/cinnamon-screensaver-main"
}

ask() {
    read -r -p "$1 [Y/n] " ans
    case "${ans:-Y}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if [ $# -eq 0 ]; then
    ask "Install Cinnamon panel applet?"     && install_applet
    ask "Install Cinnamon lock-screen widget?" && install_lockscreen
    exit 0
fi

for arg in "$@"; do
    case "$arg" in
        --auto)                 install_applet; install_lockscreen ;;
        --applet)               install_applet ;;
        --lockscreen)           install_lockscreen ;;
        --uninstall-lockscreen) uninstall_lockscreen ;;
        -h|--help)              sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done
