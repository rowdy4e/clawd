#!/bin/bash
# Top-level installer — detects the desktop environment and delegates to the
# matching per-platform installer.
#
#   ./install.sh                   # interactive, asks what to install
#   ./install.sh --auto            # install everything for the detected DE
#   ./install.sh --cinnamon …      # force Cinnamon installer (forwards flags)
#   ./install.sh --gnome …         # force GNOME installer (forwards flags)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

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

# ── Forwarded mode: --cinnamon / --gnome ────────────────────────────
if [ "$1" = "--cinnamon" ]; then
    shift; exec "$HERE/cinnamon/install.sh" "$@"
fi
if [ "$1" = "--gnome" ]; then
    shift; exec "$HERE/gnome/install.sh" "$@"
fi

# ── Auto-detect ─────────────────────────────────────────────────────
DE=$(detect_de)
echo "Detected desktop: $DE  (XDG_CURRENT_DESKTOP=$XDG_CURRENT_DESKTOP)"

case "$DE" in
    cinnamon) exec "$HERE/cinnamon/install.sh" "$@" ;;
    gnome)    exec "$HERE/gnome/install.sh"    "$@" ;;
    unknown)
        echo
        echo "Couldn't auto-detect a supported desktop."
        echo "Supported: Cinnamon, GNOME."
        echo
        echo "If you know what you want, run one of:"
        echo "  $0 --cinnamon            # interactive Cinnamon install"
        echo "  $0 --cinnamon --auto     # all Cinnamon pieces"
        echo "  $0 --gnome               # interactive GNOME install"
        echo "  $0 --gnome --auto        # GNOME extension"
        exit 1
        ;;
esac
