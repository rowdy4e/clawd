#!/bin/bash
# GNOME Shell extension installer.
#   --auto       install
#   --uninstall  remove
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="clawd@rowdy4e"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

install_ext() {
    mkdir -p "$DEST"
    cp -v "$HERE/extension"/* "$DEST/"
    chmod +x "$DEST"/*.sh 2>/dev/null || true
    echo
    echo "Extension installed to $DEST"
    echo
    echo "Activate:"
    echo "  1. Log out + log back in (GNOME re-reads extensions only on session start)"
    echo "  2. gnome-extensions enable $UUID"
    echo "  Or use the 'Extensions' app to toggle Clawd on."
}

uninstall_ext() {
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rfv "$DEST"
}

ask() {
    read -r -p "$1 [Y/n] " ans
    case "${ans:-Y}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if [ $# -eq 0 ]; then
    ask "Install GNOME Shell extension?" && install_ext
    exit 0
fi

for arg in "$@"; do
    case "$arg" in
        --auto)      install_ext ;;
        --uninstall) uninstall_ext ;;
        -h|--help)   sed -n '2,5p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done
