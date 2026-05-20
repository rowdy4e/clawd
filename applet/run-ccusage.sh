#!/bin/bash
# Wrapper so Cinnamon (without fnm-init PATH) can run ccusage.
FNM_DIR="$HOME/.local/share/fnm/aliases/default"
exec "$FNM_DIR/bin/node" "$FNM_DIR/lib/node_modules/ccusage/dist/cli.js" "$@"
