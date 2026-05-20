# Clawd — Claude Code usage applet for Cinnamon

Animated pixel-art mascot ([Clawd](https://www.claudeclawd.fun/)) that lives in
your Cinnamon panel and shows real-time Claude Code subscription usage —
session %, weekly %, extra credits — pulled from Anthropic's `/api/oauth/usage`
endpoint using your existing Claude Code OAuth token.

Optionally also appears on the **lock screen**, with the same animations plus
a "grow" easter egg and rotating speech-bubble messages.

## Features

**Panel applet:**
- Real subscription usage from Anthropic (not theoretical API rates)
- Progress bar in popup menu: session / week / week-Sonnet / extra credits
- Auto-refresh every 5 min with exponential back-off on HTTP 429
- "Last updated / next in X" live timestamps in the menu
- Animated pixel-art Clawd:
  - 10 morph forms (heart, ghost, octopus, sparkle, blob, pacman, invader,
    crown, skull) with per-form colors
  - Idle animations: bounce, wiggle, squish, shake, tilt, walk, wink, yawn,
    lookAround, morph, glitch
  - Breath, blink with proper eyelid line
  - Animation playground in menu (Configure → "Show animation playground")
- Resolution-adaptive pixel size on the lock screen
- All animations skipped when the actor isn't on-screen (zero CPU when hidden)

**Lock screen widget** (optional, fully user-space — no sudo):
- Same animations as panel
- Rare "grow" easter egg (Clawd briefly fills the screen)
- Random speech-bubble messages (memes / wisdom / jokes)
- Toggle on/off from the panel applet — auto-restarts screensaver if not locked

## Install

```bash
# Panel applet
./install/install-applet.sh

# Lock screen widget (optional)
./install/install-lockscreen.sh
pkill -f /usr/share/cinnamon-screensaver/cinnamon-screensaver-main
```

Add the applet to the panel, then lock to see lock-screen Clawd.

## Architecture

```
clawd-cinnamon/
├── applet/                     # Cinnamon GJS applet
│   ├── applet.js               # Main applet — drawing, animations, menu, fetch
│   ├── metadata.json
│   ├── settings-schema.json
│   ├── stylesheet.css
│   └── fetch-usage.sh          # Wrapper that calls /api/oauth/usage
├── lockscreen/                 # cinnamon-screensaver widget (user-space hook)
│   ├── usercustomize.py        # site-package hook — patches Stage class
│   └── clawd_widget_user.py    # GTK/Cairo Clawd widget
└── install/
    ├── install-applet.sh
    ├── install-lockscreen.sh
    └── uninstall-lockscreen.sh
```

### Lock screen integration without sudo

`cinnamon-screensaver-main.py` is a regular Python script. We install
`usercustomize.py` into the user's site-packages so Python imports it at
startup. It checks `sys.argv[0]`, and if we're inside cinnamon-screensaver
it registers a meta-path finder. When that process imports the `stage`
module, the finder monkey-patches `Stage.setup_clawd` (and wraps
`setup_delayed_components` as a safety net) to instantiate our `ClawdWidget`.
For any other Python program the hook is a no-op.

### Configuration

The panel applet writes the lock-screen toggle to
`~/.config/clawd-lockscreen/enabled`. The widget reads that file on each
screensaver start.

The applet also restarts cinnamon-screensaver (async, never blocks the
Cinnamon main thread) when the toggle changes — but only if it's not
currently locked.

## Requirements

- **Cinnamon desktop environment** (any distro)
- Python 3 + GTK 3 (already installed by Cinnamon)
- A Claude Code session — credentials are read from `~/.claude/.credentials.json`

## Distro compatibility

This is **Cinnamon-specific, not Mint-specific**. Tested on Linux Mint 22.x
(Cinnamon 6.6.7) but should work on any distro that ships Cinnamon:

| Distro | Status |
|---|---|
| Linux Mint Cinnamon | ✅ Tested |
| Ubuntu Cinnamon Remix | ✅ Should work |
| Fedora Cinnamon spin | ✅ Should work |
| Debian + Cinnamon | ✅ Should work |
| openSUSE + Cinnamon | ✅ Should work |
| Arch + `cinnamon` AUR | ✅ Should work |
| **Anything without Cinnamon** | ❌ Won't load |

The install scripts auto-detect the Python user-site directory
(`python3 -c 'import site; print(site.USER_SITE)'`) so they're not tied
to a specific Python version.

### Porting to other desktops

If you use **GNOME / KDE / XFCE / Sway / Hyprland**, the panel applet
(Cinnamon-specific GJS API) and lock-screen widget (cinnamon-screensaver
specific) won't run. The reusable bits are:

- `applet/fetch-usage.sh` — pure curl + python3, works anywhere as a
  data source for the `/api/oauth/usage` endpoint
- The animation logic, Clawd pixel-art bitmaps, and message list are
  data — easy to port

The actual UI integration needs a per-DE rewrite:

- **GNOME**: a Shell extension (GJS, similar to Cinnamon but different API)
- **KDE Plasma**: a Plasmoid (QML)
- **XFCE / MATE / others**: a `genmon` plugin running `fetch-usage.sh`, or
  a standalone GTK tray app

Pull requests with ports welcome.
