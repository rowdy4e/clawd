#!/bin/bash
# Top-level installer. Detects the desktop environment and runs the matching
# per-DE installer in install/. Run with no args for an interactive flow, or
# pass flags to opt into specific components non-interactively.
#
#   ./install.sh                 # interactive — prompts for each piece
#   ./install.sh --auto          # install everything matching the detected DE
#   ./install.sh --applet        # Cinnamon panel applet only
#   ./install.sh --lockscreen    # Cinnamon lock-screen widget only
#   ./install.sh --gnome         # GNOME Shell extension only

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HERE/install"

# ── Detect desktop environment ─────────────────────────────────────
detect_de() {
    local d="${XDG_CURRENT_DESKTOP,,}"
    case "$d" in
        *cinnamon*) echo cinnamon; return ;;
        *gnome*)    echo gnome;    return ;;
    esac
    d="${DESKTOP_SESSION,,}"
    case "$d" in
        *cinnamon*) echo cinnamon; return ;;
        *gnome*)    echo gnome;    return ;;
    esac
    echo unknown
}

DE=$(detect_de)

# ── Parse args ──────────────────────────────────────────────────────
MODE=interactive
WANT_APPLET=0
WANT_LOCK=0
WANT_GNOME=0
for arg in "$@"; do
    case "$arg" in
        --auto)       MODE=auto ;;
        --applet)     MODE=manual; WANT_APPLET=1 ;;
        --lockscreen) MODE=manual; WANT_LOCK=1 ;;
        --gnome)      MODE=manual; WANT_GNOME=1 ;;
        -h|--help)
            sed -n '2,11p' "$0"; exit 0 ;;
        *)
            echo "Unknown flag: $arg"; sed -n '2,11p' "$0"; exit 1 ;;
    esac
done

ask() {
    local prompt="$1"; local default="${2:-Y}"
    local hint="[Y/n]"; [ "$default" = "N" ] && hint="[y/N]"
    read -r -p "$prompt $hint " ans
    ans=${ans:-$default}
    case "${ans,,}" in y|yes) return 0 ;; *) return 1 ;; esac
}

run_step() {
    local script="$1"; local label="$2"
    echo
    echo "▶  $label"
    "$INSTALL_DIR/$script"
}

# ── Flow ────────────────────────────────────────────────────────────
echo "Clawd installer"
echo "Detected desktop: $DE  (XDG_CURRENT_DESKTOP=$XDG_CURRENT_DESKTOP)"

if [ "$MODE" = manual ]; then
    [ "$WANT_APPLET" = 1 ] && run_step install-applet.sh     "Cinnamon panel applet"
    [ "$WANT_LOCK"   = 1 ] && run_step install-lockscreen.sh "Cinnamon lock-screen widget"
    [ "$WANT_GNOME"  = 1 ] && run_step install-gnome.sh      "GNOME Shell extension"
    echo; echo "Done."; exit 0
fi

case "$DE" in
    cinnamon)
        if [ "$MODE" = auto ] || ask "Install Cinnamon panel applet?" Y; then
            run_step install-applet.sh "Cinnamon panel applet"
        fi
        if [ "$MODE" = auto ] || ask "Install Cinnamon lock-screen widget?" Y; then
            run_step install-lockscreen.sh "Cinnamon lock-screen widget"
        fi
        ;;
    gnome)
        if [ "$MODE" = auto ] || ask "Install GNOME Shell extension?" Y; then
            run_step install-gnome.sh "GNOME Shell extension"
        fi
        ;;
    unknown)
        echo
        echo "Couldn't auto-detect a supported desktop."
        echo "Supported: Cinnamon, GNOME."
        echo
        echo "Run one of these explicitly if you know what you want:"
        echo "  $0 --applet         # Cinnamon panel applet"
        echo "  $0 --lockscreen     # Cinnamon lock-screen widget"
        echo "  $0 --gnome          # GNOME Shell extension"
        exit 1
        ;;
esac

echo
echo "All done."
