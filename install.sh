#!/bin/bash
# Top-level installer — detects the desktop environment and delegates to the
# matching per-platform installer.
#
#   ./install.sh                   # interactive, asks what to install
#   ./install.sh --auto            # install everything for the detected DE
#   ./install.sh --cinnamon …      # force Cinnamon installer (forwards flags)
#   ./install.sh --gnome …         # GNOME; auto-picks legacy(42-44)/modern(45+)
#   ./install.sh --gnome-legacy …  # force the GNOME 42-44 build
#   ./install.sh --gnome-modern …  # force the GNOME 45+ build
#
# GNOME build is chosen by `gnome-shell --version`: 45+ uses the ESM build in
# gnome/, 42-44 uses the legacy imports build in gnome-legacy/.
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

# Major version of the running GNOME Shell (0 if it can't be read).
gnome_major() {
    local v
    v=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
    echo "${v:-0}"
}

# Pick the GNOME build by Shell version: 45+ = ESM (gnome/), 42-44 = legacy.
run_gnome() {
    local maj; maj=$(gnome_major)
    if [ "$maj" -ge 45 ] 2>/dev/null; then
        echo "GNOME Shell $maj → modern build (gnome/, ESM)"
        exec "$HERE/gnome/install.sh" "$@"
    elif [ "$maj" -ge 42 ] 2>/dev/null; then
        echo "GNOME Shell $maj → legacy build (gnome-legacy/, for 42-44)"
        exec "$HERE/gnome-legacy/install.sh" "$@"
    elif [ "$maj" = 0 ]; then
        echo "Couldn't read gnome-shell version — defaulting to the modern (45+) build."
        echo "On GNOME 42-44 run:  $0 --gnome-legacy $*"
        exec "$HERE/gnome/install.sh" "$@"
    else
        echo "GNOME Shell $maj is too old; Clawd needs GNOME 42+." >&2
        exit 1
    fi
}

# ── Forwarded mode: --cinnamon / --gnome[-legacy|-modern] ───────────
if [ "$1" = "--cinnamon" ]; then
    shift; exec "$HERE/cinnamon/install.sh" "$@"
fi
if [ "$1" = "--gnome" ]; then
    shift; run_gnome "$@"                                # auto-pick by version
fi
if [ "$1" = "--gnome-legacy" ]; then
    shift; exec "$HERE/gnome-legacy/install.sh" "$@"     # force 42-44 build
fi
if [ "$1" = "--gnome-modern" ]; then
    shift; exec "$HERE/gnome/install.sh" "$@"            # force 45+ build
fi

# ── Auto-detect ─────────────────────────────────────────────────────
DE=$(detect_de)
echo "Detected desktop: $DE  (XDG_CURRENT_DESKTOP=$XDG_CURRENT_DESKTOP)"

case "$DE" in
    cinnamon) exec "$HERE/cinnamon/install.sh" "$@" ;;
    gnome)    run_gnome "$@" ;;
    unknown)
        echo
        echo "Couldn't auto-detect a supported desktop."
        echo "Supported: Cinnamon, GNOME 42+."
        echo
        echo "If you know what you want, run one of:"
        echo "  $0 --cinnamon            # interactive Cinnamon install"
        echo "  $0 --cinnamon --auto     # all Cinnamon pieces"
        echo "  $0 --gnome --auto        # GNOME, auto-pick build by version"
        echo "  $0 --gnome-legacy --auto # force the GNOME 42-44 build"
        echo "  $0 --gnome-modern --auto # force the GNOME 45+ build"
        exit 1
        ;;
esac
