#!/usr/bin/python3
"""
Clawd floating widget for cinnamon-screensaver.

Animated pixel-art Clawd (Claude Code mascot) — kept feature-parity with the
Cinnamon panel applet: rebalanced form bitmaps, eyelid lines on closed eyes,
mouth overlay, body-only breath, plus wink / yawn / lookAround animations.

Toggle via the panel applet → Configure → Advanced → "Show Clawd on the lock
screen". That writes to ~/.config/clawd-lockscreen/enabled. We re-read the
file every time the screensaver starts up (after pkill or relaunch).
Also still honors the env var CLAWD_LOCKSCREEN=0.
"""

import math
import os
import random

import cairo
import gi
gi.require_version("PangoCairo", "1.0")
from gi.repository import GLib, Gtk, Gdk, Pango, PangoCairo

from floating import Floating
from baseWindow import BaseWindow


CONFIG_FILE = os.path.expanduser("~/.config/clawd-lockscreen/enabled")

# Target: Clawd's body width ≈ TARGET_WIDTH_RATIO of monitor width.
TARGET_WIDTH_RATIO = 0.10


def _is_lockscreen_enabled():
    try:
        with open(CONFIG_FILE) as f:
            return f.read().strip() != "0"
    except (IOError, OSError):
        return True  # default enabled


COLS = 18
ROWS = 6
TICK_MS = 33  # ~30 fps for the lock screen

# Random one-liners that Clawd occasionally throws at you on the lock screen.
# Mix of memes, programmer wisdom, short jokes.
MESSAGES = [
    # Claude memes
    "You're absolutely right!",
    "Let me think about this more carefully...",
    "Actually, on reflection — yes, that.",
    "Hmm, you raise a good point.",
    # Programmer life
    "404: Motivation not found.",
    "It works on my machine ¯\\_(ツ)_/¯",
    "Just one more refactor, I promise.",
    "TODO: rename this variable later.",
    "git push --force or die trying.",
    "Have you tried turning it off and on again?",
    "Stack Overflow is your spirit animal.",
    # Wisdom
    "Naming things is hard.",
    "There are 2 hard problems: cache invalidation, naming things, off-by-one errors.",
    "Today's bug is tomorrow's feature.",
    "Code never lies. Comments sometimes do.",
    "Make it work, make it right, make it fast.",
    "Premature optimization is the root of all evil.",
    # Short jokes
    "Why do programmers prefer dark mode? Bugs hate the light.",
    "There's no place like 127.0.0.1",
    "I'd tell you a UDP joke, but you might not get it.",
    "A SQL query walks into a bar — sees two tables — asks: mind if I join you?",
    # Friendly
    "Take a deep breath. The compiler can wait.",
    "Did you remember to commit?",
    "Sip your coffee. The bug will still be there.",
    "Step away for 5 minutes. Solutions appear in the shower.",
]
MESSAGE_DURATION_MS = 6500
MESSAGE_INTERVAL_MIN = 35000
MESSAGE_INTERVAL_MAX = 80000


def _detect_pixel_size(initial_monitor):
    """Compute a sensible (xUnit, yUnit) based on the monitor's geometry."""
    try:
        display = Gdk.Display.get_default()
        if display is None:
            return (10, 20)
        monitor = None
        try:
            monitor = display.get_monitor(initial_monitor)
        except Exception:
            monitor = None
        if monitor is None:
            try:
                monitor = display.get_primary_monitor()
            except Exception:
                monitor = None
        if monitor is None and display.get_n_monitors() > 0:
            monitor = display.get_monitor(0)
        if monitor is None:
            return (10, 20)
        geom = monitor.get_geometry()
        screen_w = geom.width or 1920
        # bitmap_w = COLS * x_unit ≈ TARGET_WIDTH_RATIO * screen_w
        x_unit = max(4, int(round(TARGET_WIDTH_RATIO * screen_w / COLS)))
        y_unit = x_unit * 2   # 2:1 aspect, matches CLI cell ratio
        return (x_unit, y_unit)
    except Exception:
        return (10, 20)

FORMS = {
    "clawd": {
        "color": (0.85, 0.47, 0.34),
        "pixels": [
            "...OOOOOOOOOOOO...",
            "...OOEOOOOOOEOO...",
            ".OOOOOOOOOOOOOOOO.",
            "...OOOOOOOOOOOO...",
            "....F.F....F.F....",
            "..................",
        ],
    },
    "heart": {
        "color": (0.93, 0.27, 0.49),
        "pixels": [
            "..................",
            "....OOO....OOO....",
            "...OOOOOOOOOOOO...",
            "....OOOOOOOOOO....",
            ".....OOOOOOOO.....",
            "......OOOOOO......",
        ],
    },
    "ghost": {
        "color": (0.88, 0.90, 0.96),
        "pixels": [
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "...OOEOOOOOOEOO...",
            "...OOOOOOOOOOOO...",
            "...OOOOOOOOOOOO...",
            "...O.OO.OO.OO.O...",
        ],
    },
    "octopus": {
        "color": (0.62, 0.40, 0.85),
        "pixels": [
            "....OOOOOOOO......",
            "...OOOOOOOOOO.....",
            "..OOEOOOOOOEOO....",
            "...OOOOOOOOOO.....",
            "..O.O.O.O.O.O.O...",
            "...O.O.O.O.O.O....",
        ],
    },
    "sparkle": {
        "color": (0.98, 0.78, 0.18),
        "pixels": [
            "........OO........",
            ".....OOOOOOOO.....",
            ".OOOOOOOOOOOOOOOO.",
            ".OOOOOOOOOOOOOOOO.",
            ".....OOOOOOOO.....",
            "........OO........",
        ],
    },
    "blob": {
        "color": (0.35, 0.82, 0.45),
        "pixels": [
            "..................",
            "....OOOOOOOOOO....",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            "...OOOOOOOOOOOO...",
            "..................",
        ],
    },
    "pacman": {
        "color": (0.98, 0.85, 0.10),
        "pixels": [
            ".....OOOOOOOOO....",
            "....OOOOOOOOOOO...",
            "...OOOOOOOO.......",
            "...OOOOOO.........",
            "...OOOOOOOO.......",
            "....OOOOOOOOOOO...",
        ],
    },
    "invader": {
        "color": (0.30, 0.90, 0.40),
        "pixels": [
            "....O......O......",
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "...OO.OOOO.OO.....",
            "...OOOOOOOOOO.....",
            "....O.OOOO.O......",
        ],
    },
    "crown": {
        "color": (0.96, 0.80, 0.20),
        "pixels": [
            "..O..O..O..O..O...",
            "..O..O..O..O..O...",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            "..................",
        ],
    },
    "skull": {
        "color": (0.92, 0.92, 0.95),
        "pixels": [
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "....OO.OOOO.OO....",
            ".....OOOOOOOO.....",
            "......OOOOOO......",
            "......O.O.O.O.....",
        ],
    },
}
MORPH_TARGETS = [k for k in FORMS if k != "clawd"]

# Pre-compile filled cells per form, split into body (rows 0..3) and feet (rows 4+).
for _key, _form in FORMS.items():
    _form["bodyCells"] = []
    _form["footCells"] = []
    for _row in range(ROWS):
        for _col in range(COLS):
            _ch = _form["pixels"][_row][_col]
            if _ch == '.':
                continue
            target = _form["bodyCells"] if _row < 4 else _form["footCells"]
            target.append((_row, _col, _ch))


# ───────── easing ─────────
def _linear(t): return t
def _ease_out_quad(t): return 1 - (1 - t) ** 2
def _ease_in_quad(t): return t * t
def _ease_in_out_quad(t):
    return 2 * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 2) / 2
def _ease_in_out_cubic(t):
    return 4 * t * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 3) / 2
def _ease_out_bounce(t):
    n1, d1 = 7.5625, 2.75
    if t < 1 / d1:
        return n1 * t * t
    elif t < 2 / d1:
        t -= 1.5 / d1
        return n1 * t * t + 0.75
    elif t < 2.5 / d1:
        t -= 2.25 / d1
        return n1 * t * t + 0.9375
    else:
        t -= 2.625 / d1
        return n1 * t * t + 0.984375
def _ease_out_back(t):
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2

EASINGS = {
    "linear": _linear,
    "ease_out_quad": _ease_out_quad,
    "ease_in_quad": _ease_in_quad,
    "ease_in_out_quad": _ease_in_out_quad,
    "ease_in_out_cubic": _ease_in_out_cubic,
    "ease_out_bounce": _ease_out_bounce,
    "ease_out_back": _ease_out_back,
}


class _Tween:
    def __init__(self, state, key, target, duration_ms, easing="linear", on_complete=None):
        self.state = state
        self.key = key
        self.start = state[key]
        self.target = target
        self.duration = max(1, duration_ms)
        self.elapsed = 0
        self.ease = EASINGS.get(easing, _linear)
        self.on_complete = on_complete
        self.done = False

    def step(self, dt_ms):
        if self.done:
            return
        self.elapsed += dt_ms
        t = min(1.0, self.elapsed / self.duration)
        eased = self.ease(t)
        self.state[self.key] = self.start + (self.target - self.start) * eased
        if t >= 1.0:
            self.done = True
            if self.on_complete:
                try:
                    self.on_complete()
                except Exception as e:
                    print("Clawd tween on_complete error: %s" % e)


class ClawdWidget(Floating, BaseWindow):
    """Floating GTK widget that paints animated pixel-art Clawd via Cairo."""

    def __init__(self, initial_monitor=0):
        super(ClawdWidget, self).__init__(initial_monitor, Gtk.Align.CENTER, Gtk.Align.END)
        self.set_property("margin-bottom", 140)

        # Default attrs so _on_destroy works even if we short-circuit.
        self.area = None
        self._tick_id = None
        self._blink_id = None
        self._idle_id = None
        self._tweens = []
        self._anim_busy = False
        self._s = {}
        self._breath_start = None

        # Check user toggle. If disabled, stay an empty hidden widget.
        if not _is_lockscreen_enabled():
            self.hide()
            return

        # Adapt pixel size to the monitor we're floating on.
        self._pixel_x, self._pixel_y = _detect_pixel_size(initial_monitor)
        # Generous canvas — leaves ~3× headroom for the "grow" easter egg.
        self._canvas_w = COLS * self._pixel_x * 4
        self._canvas_h = ROWS * self._pixel_y * 4

        self.area = Gtk.DrawingArea()
        self.area.set_size_request(self._canvas_w, self._canvas_h)
        self.area.connect("draw", self._on_draw)

        # Speech bubble is drawn directly with Cairo + Pango inside the canvas
        # (no Gtk.Label/Overlay) so its absolute position is pixel-precise.
        self._current_message = ""
        self.add(self.area)
        self.area.show()

        self._message_active = False
        self._message_hide_id = None
        self._mouth_anim_id = None

        self._s = {
            "body_x": 0.0, "body_y": 0.0,
            "tilt": 0.0,
            "scale_x": 1.0, "scale_y": 1.0,
            "eye_open": 1.0,
            "eye_state": "normal",
            "mouth_visible": 0.0,
            "mouth_shape": 0,
            "_blink_active": False, "_blink_phase": "closing", "_blink_t": 0.0,
            "_breath": 0.0,
            "morph_t": 0.0, "form_a": "clawd", "form_b": "clawd",
            "walking": 0.0, "walk_phase": 0.0,
            "excited": 0.0,
        }
        self._tweens = []
        self._anim_busy = False
        self._breath_start = None  # set on first tick

        self._tick_id = GLib.timeout_add(TICK_MS, self._on_tick)
        self._blink_id = GLib.timeout_add(random.randint(4000, 9000), self._begin_blink)
        self._idle_id = GLib.timeout_add(random.randint(12000, 22000), self._trigger_random)
        self._msg_id = GLib.timeout_add(
            random.randint(MESSAGE_INTERVAL_MIN, MESSAGE_INTERVAL_MAX),
            self._show_random_message
        )

        self.connect("destroy", self._on_destroy)

    def _on_destroy(self, *_):
        for tid in (self._tick_id, self._blink_id, self._idle_id,
                    getattr(self, "_msg_id", None),
                    getattr(self, "_message_hide_id", None),
                    getattr(self, "_mouth_anim_id", None)):
            if tid:
                try: GLib.source_remove(tid)
                except Exception: pass
        self._tick_id = self._blink_id = self._idle_id = None
        self._msg_id = None
        self._message_hide_id = None
        self._mouth_anim_id = None
        self._tweens = []

    # ── messages ─────────────────────────────────────────────────────
    def _show_random_message(self):
        try:
            if not self._message_active:
                self._current_message = random.choice(MESSAGES)
                self._message_active = True
                self._start_mouth_talk()
                self._message_hide_id = GLib.timeout_add(MESSAGE_DURATION_MS, self._hide_message)
                self.area.queue_draw()
        except Exception as e:
            sys.stderr.write("Clawd message error: %s\n" % e)
        self._msg_id = GLib.timeout_add(
            random.randint(MESSAGE_INTERVAL_MIN, MESSAGE_INTERVAL_MAX),
            self._show_random_message
        )
        return False

    def _hide_message(self):
        self._message_active = False
        self._current_message = ""
        self._message_hide_id = None
        self._stop_mouth_talk()
        self.area.queue_draw()
        return False

    def _draw_message_bubble(self, cr, canvas_w, canvas_h):
        """Render the active speech bubble above Clawd using Pango+Cairo."""
        if not self._message_active or not self._current_message:
            return
        try:
            layout = PangoCairo.create_layout(cr)
            fd = Pango.FontDescription(
                "Press Start 2P, VT323, PixelOperator, Monaco, DejaVu Sans Mono"
            )
            fd.set_size(11 * Pango.SCALE)
            fd.set_weight(Pango.Weight.BOLD)
            layout.set_font_description(fd)
            layout.set_text(self._current_message, -1)
            layout.set_alignment(Pango.Alignment.LEFT)
            max_text_w = min(440, canvas_w - 100)
            layout.set_width(max_text_w * Pango.SCALE)
            layout.set_wrap(Pango.WrapMode.WORD)

            ink, logical = layout.get_pixel_extents()
            tw_px = max(ink.width, 1)
            th_px = max(logical.height, ink.height)

            pad_x = 14
            pad_y = 9
            bubble_w = tw_px + 2 * pad_x
            bubble_h = th_px + 2 * pad_y
            bubble_x = (canvas_w - bubble_w) // 2
            bubble_y = max(20, canvas_h // 20)

            # Background
            cr.set_source_rgba(0.078, 0.094, 0.125, 0.92)
            cr.rectangle(bubble_x, bubble_y, bubble_w, bubble_h)
            cr.fill()
            # Border (Claude orange, 3 px)
            cr.set_source_rgba(0.851, 0.467, 0.341, 1.0)
            cr.set_line_width(3)
            cr.rectangle(bubble_x + 1.5, bubble_y + 1.5, bubble_w - 3, bubble_h - 3)
            cr.stroke()
            # Text — compensate for ink.x in case the font has bearing.
            cr.set_source_rgba(0.961, 0.878, 0.784, 1.0)
            cr.move_to(bubble_x + pad_x - ink.x, bubble_y + pad_y - ink.y)
            PangoCairo.show_layout(cr, layout)
        except Exception as e:
            sys.stderr.write("Clawd bubble draw error: %s\n" % e)

    def _start_mouth_talk(self):
        if self._mouth_anim_id:
            return
        # Toggle mouth open/closed every ~120 ms — looks like he's speaking.
        # Only run for ~2 s; after that he keeps the message visible silently.
        start_time = GLib.get_monotonic_time()
        TALK_LIMIT_US = 2_000_000  # 2 seconds in microseconds
        def tick():
            if not self._message_active or (GLib.get_monotonic_time() - start_time) > TALK_LIMIT_US:
                self._s["mouth_visible"] = 0.0
                self._s["mouth_shape"] = 0
                self._mouth_anim_id = None
                return False
            open_now = self._s["mouth_visible"] < 0.5
            self._s["mouth_visible"] = 1.0 if open_now else 0.0
            if open_now:
                # 70% line, 30% wider "O" shape for variety
                self._s["mouth_shape"] = 1 if random.random() < 0.3 else 0
            return True
        # First toggle = open immediately, then keep alternating
        self._s["mouth_visible"] = 1.0
        self._s["mouth_shape"] = 0
        self._mouth_anim_id = GLib.timeout_add(random.randint(110, 160), tick)

    def _stop_mouth_talk(self):
        if self._mouth_anim_id:
            try: GLib.source_remove(self._mouth_anim_id)
            except Exception: pass
            self._mouth_anim_id = None
        self._s["mouth_visible"] = 0.0
        self._s["mouth_shape"] = 0

    # ── tweens ────────────────────────────────────────────────────────
    def _add_tween(self, key, target, dur_ms, easing="linear", on_complete=None):
        self._tweens = [t for t in self._tweens if t.key != key]
        self._tweens.append(_Tween(self._s, key, target, dur_ms, easing, on_complete))

    def _anim_done(self):
        self._anim_busy = False

    # ── scheduling ────────────────────────────────────────────────────
    def _begin_blink(self):
        s = self._s
        if not s["_blink_active"]:
            s["_blink_active"] = True
            s["_blink_phase"] = "closing"
            s["_blink_t"] = 0.0
        self._blink_id = GLib.timeout_add(random.randint(4000, 9000), self._begin_blink)
        return False

    def _trigger_random(self):
        if not self._anim_busy:
            try:
                self._play_animation(self._pick_animation())
            except Exception as e:
                print("Clawd animation error: %s" % e)
                self._anim_busy = False
        self._idle_id = GLib.timeout_add(random.randint(12000, 22000), self._trigger_random)
        return False

    def _pick_animation(self):
        # ~4% chance for the rare "grow" easter egg
        if random.random() < 0.04:
            return "grow"
        return random.choice([
            "bounce", "wiggle", "squish", "shake", "tilt_pose",
            "walk", "wink", "yawn", "lookAround",
            "morph", "glitch",
        ])

    def _play_animation(self, name):
        self._reset_motion()
        method = getattr(self, "_anim_" + name, None)
        if not method:
            return
        self._anim_busy = True
        method()

    def _reset_motion(self):
        s = self._s
        self._tweens = [t for t in self._tweens if t.key not in (
            "body_x", "body_y", "tilt", "scale_x", "scale_y",
            "walking", "walk_phase", "excited", "morph_t", "mouth_visible"
        )]
        s["body_x"] = 0.0
        s["body_y"] = 0.0
        s["tilt"] = 0.0
        s["scale_x"] = 1.0
        s["scale_y"] = 1.0
        s["walking"] = 0.0
        s["walk_phase"] = 0.0
        s["excited"] = 0.0
        s["morph_t"] = 0.0
        s["form_a"] = "clawd"
        s["form_b"] = "clawd"
        s["mouth_visible"] = 0.0
        s["mouth_shape"] = 0
        s["eye_state"] = "normal"

    # ── tick ─────────────────────────────────────────────────────────
    def _on_tick(self):
        try:
            s = self._s
            now = GLib.get_monotonic_time() / 1000.0  # ms
            if self._breath_start is None:
                self._breath_start = now
            # Breath cycle — 4000 ms period (matches panel applet).
            phase = ((now - self._breath_start) % 4000.0) / 4000.0
            s["_breath"] = (1 - math.cos(phase * 2 * math.pi)) / 2

            # Blink state machine
            if s["_blink_active"]:
                if s["_blink_phase"] == "closing":
                    s["_blink_t"] += 0.18
                    s["eye_open"] = max(0.0, 1.0 - s["_blink_t"])
                    if s["_blink_t"] >= 1:
                        s["_blink_phase"] = "opening"; s["_blink_t"] = 0
                else:
                    s["_blink_t"] += 0.14
                    s["eye_open"] = min(1.0, s["_blink_t"])
                    if s["_blink_t"] >= 1:
                        s["_blink_active"] = False
                        s["eye_open"] = 1.0

            # Advance tweens
            for tw in self._tweens[:]:
                tw.step(TICK_MS)
            self._tweens = [t for t in self._tweens if not t.done]

            self.area.queue_draw()
        except Exception as e:
            print("Clawd tick error: %s" % e)
        return True

    # ── animations ───────────────────────────────────────────────────
    def _anim_bounce(self):
        def back():
            self._add_tween("body_y", 0, 400, "ease_out_bounce", on_complete=self._anim_done)
        self._add_tween("body_y", -10, 180, "ease_out_quad", on_complete=back)

    def _anim_wiggle(self):
        steps = [(-14, 100), (14, 120), (-8, 100), (0, 120)]
        def chain(i):
            if i >= len(steps):
                self._anim_done(); return
            tgt, dur = steps[i]
            self._add_tween("tilt", tgt, dur, "linear", on_complete=lambda: chain(i + 1))
        chain(0)

    def _anim_squish(self):
        def step3():
            self._add_tween("scale_x", 1.0, 240, "ease_out_bounce")
            self._add_tween("scale_y", 1.0, 240, "ease_out_bounce", on_complete=self._anim_done)
        def step2():
            self._add_tween("scale_x", 0.90, 180, "ease_out_quad")
            self._add_tween("scale_y", 1.12, 180, "ease_out_quad", on_complete=step3)
        self._add_tween("scale_x", 1.15, 120, "ease_out_quad")
        self._add_tween("scale_y", 0.80, 120, "ease_out_quad", on_complete=step2)

    def _anim_shake(self):
        steps = [5, -5, 4, -4, 2, -2, 0]
        def chain(i):
            if i >= len(steps):
                self._anim_done(); return
            self._add_tween("body_x", steps[i], 60, "linear", on_complete=lambda: chain(i + 1))
        chain(0)

    def _anim_tilt_pose(self):
        d = -18 if random.random() < 0.5 else 18
        def hold():
            GLib.timeout_add(450, lambda: (self._add_tween(
                "tilt", 0, 350, "ease_out_back", on_complete=self._anim_done), False)[1])
        self._add_tween("tilt", d, 250, "ease_out_quad", on_complete=hold)

    def _anim_walk(self):
        self._s["walking"] = 1.0
        self._s["walk_phase"] = 0.0
        max_steps = 4
        state = {"i": 0}
        def toggle():
            if state["i"] >= max_steps:
                self._add_tween("body_y", 0, 150, "linear")
                self._s["walking"] = 0.0
                self._s["walk_phase"] = 0.0
                self._anim_done()
                return
            next_phase = 0.99 if state["i"] % 2 == 0 else 0.0
            next_bob = -3 if state["i"] % 2 == 0 else 0
            self._add_tween("walk_phase", next_phase, 220, "ease_in_out_quad")
            self._add_tween("body_y", next_bob, 220, "ease_in_out_quad",
                            on_complete=lambda: (state.update(i=state["i"] + 1), toggle())[1])
        toggle()

    def _anim_wink(self):
        s = self._s
        s["eye_state"] = "wink-l" if random.random() < 0.5 else "wink-r"
        def back():
            s["eye_state"] = "normal"
            self._anim_done()
        GLib.timeout_add(450, lambda: (back(), False)[1])

    def _anim_yawn(self):
        s = self._s
        s["eye_state"] = "sleepy"
        s["mouth_shape"] = 1
        self._add_tween("mouth_visible", 1.0, 250, "ease_out_quad")
        def close_mouth():
            self._add_tween("mouth_visible", 0.0, 300, "ease_in_quad",
                            on_complete=lambda: (
                                self._s.update(eye_state="normal", mouth_shape=0),
                                self._anim_done()
                            )[1])
        GLib.timeout_add(900, lambda: (close_mouth(), False)[1])

    def _anim_lookAround(self):
        def step3():
            self._add_tween("tilt", 0, 250, "ease_out_quad", on_complete=self._anim_done)
        def step2():
            self._add_tween("tilt", 8, 350, "ease_in_out_quad",
                            on_complete=lambda: GLib.timeout_add(220, lambda: (step3(), False)[1]))
        self._add_tween("tilt", -8, 250, "ease_out_quad",
                        on_complete=lambda: GLib.timeout_add(220, lambda: (step2(), False)[1]))

    def _anim_morph(self):
        s = self._s
        s["form_a"] = "clawd"
        s["form_b"] = random.choice(MORPH_TARGETS)
        s["morph_t"] = 0.0
        def out():
            self._add_tween("morph_t", 0.0, 500, "ease_in_out_quad",
                            on_complete=lambda: (
                                self._s.update(form_b="clawd"),
                                self._anim_done()
                            )[1])
        self._add_tween("morph_t", 1.0, 600, "ease_in_out_quad",
                        on_complete=lambda: GLib.timeout_add(1400, lambda: (out(), False)[1]))

    # Easter egg — Clawd briefly grows huge with a delighted bounce, then shrinks back.
    def _anim_grow(self):
        def shrink():
            self._add_tween("scale_x", 1.0, 500, "ease_out_bounce")
            self._add_tween("scale_y", 1.0, 500, "ease_out_bounce", on_complete=self._anim_done)
        def hold():
            GLib.timeout_add(800, lambda: (shrink(), False)[1])
        self._add_tween("scale_x", 3.0, 500, "ease_out_back")
        self._add_tween("scale_y", 3.0, 500, "ease_out_back", on_complete=hold)

    def _anim_glitch(self):
        s = self._s
        state = {"i": 0}
        def tick():
            if state["i"] >= 6:
                s["form_a"] = "clawd"; s["form_b"] = "clawd"; s["morph_t"] = 0.0
                s["body_x"] = 0
                self._anim_done()
                return False
            pick = random.choice(MORPH_TARGETS)
            s["form_a"] = pick; s["form_b"] = pick; s["morph_t"] = 0.0
            s["body_x"] = random.uniform(-3, 3)
            state["i"] += 1
            GLib.timeout_add(70, tick)
            return False
        tick()

    # ── drawing ──────────────────────────────────────────────────────
    def _on_draw(self, area, cr):
        try:
            w = area.get_allocated_width()
            h = area.get_allocated_height()
            self._paint(cr, w, h)
            # Speech bubble is drawn after the body, in screen-space coordinates
            # (outside the transform stack used for Clawd's animations).
            self._draw_message_bubble(cr, w, h)
        except Exception as e:
            print("Clawd draw error: %s" % e)
        return False

    def _paint(self, cr, w, h):
        s = self._s
        try:
            cr.set_antialias(cairo.ANTIALIAS_NONE)
        except Exception:
            pass

        # Local aliases — read instance pixel sizes once per paint.
        PIXEL_X = self._pixel_x
        PIXEL_Y = self._pixel_y

        draw_w = COLS * PIXEL_X
        draw_h = ROWS * PIXEL_Y
        ox = (w - draw_w) // 2
        oy = (h - draw_h) // 2

        cx = ox + draw_w / 2 + s["body_x"]
        cy = oy + draw_h / 2 + s["body_y"]

        cr.save()
        cr.translate(cx, cy)
        cr.rotate(s["tilt"] * math.pi / 180)
        cr.scale(s["scale_x"], s["scale_y"])
        cr.translate(-cx, -cy)

        form_a = FORMS[s["form_a"]]
        form_b = FORMS[s["form_b"]]
        t = max(0.0, min(1.0, s["morph_t"]))
        morphing = (s["form_a"] != s["form_b"]) and (0.001 < t < 0.999)

        ra, ga, ba = form_a["color"]
        rb, gb, bb = form_b["color"]
        r = ra * (1 - t) + rb * t
        g = ga * (1 - t) + gb * t
        b = ba * (1 - t) + bb * t

        # Eye state
        left_closed = right_closed = False
        if not morphing:
            es = s["eye_state"]
            if es == "sleepy":
                left_closed = right_closed = True
            elif es == "wink-l":
                left_closed = True
            elif es == "wink-r":
                right_closed = True
            elif s["eye_open"] < 0.5:
                left_closed = right_closed = True

        # Walk pairs
        pair_a = {4, 13}
        pair_b = {6, 11}

        def push_body_cell(entry):
            row, col, ch = entry
            if ch == 'E':
                is_left = (col == 5)
                is_right = (col == 12)
                if morphing or (is_left and left_closed) or (is_right and right_closed):
                    cr.rectangle(ox + col * PIXEL_X, oy + row * PIXEL_Y, PIXEL_X, PIXEL_Y)
                return
            cr.rectangle(ox + col * PIXEL_X, oy + row * PIXEL_Y, PIXEL_X, PIXEL_Y)

        def push_foot_cell(entry):
            row, col, ch = entry
            y_off = 0
            if ch == 'F' and s["walking"] > 0 and not morphing:
                lift = PIXEL_Y
                if s["walk_phase"] < 0.5 and col in pair_a:
                    y_off = -lift
                elif s["walk_phase"] >= 0.5 and col in pair_b:
                    y_off = -lift
                y_off = int(round(y_off * s["walking"]))
            cr.rectangle(ox + col * PIXEL_X, oy + row * PIXEL_Y + y_off, PIXEL_X, PIXEL_Y)

        # Breath: applied only to body rows. Pivot at row 4 boundary so feet
        # stay grounded. We deliberately skip the breath_bob translation —
        # it caused a visible desync between body and feet during bouncing.
        breath_scale = 1.0 - s["_breath"] * 0.05
        pivot_y = oy + 4 * PIXEL_Y

        if not morphing:
            form = form_b if t >= 0.5 else form_a

            # BODY (with breath)
            cr.save()
            cr.translate(0, pivot_y)
            cr.scale(1.0, breath_scale)
            cr.translate(0, -pivot_y)
            cr.set_source_rgb(r, g, b)
            for entry in form["bodyCells"]:
                push_body_cell(entry)
            cr.fill()
            # Eyelids
            if left_closed or right_closed:
                openness = (s["eye_open"]
                            if (left_closed and right_closed and s["eye_state"] == "normal")
                            else 0.0)
                alpha = 1.0 - openness
                if alpha > 0.05:
                    lid_h = max(2, int(PIXEL_Y * 0.35))
                    lid_y = oy + 1 * PIXEL_Y + (PIXEL_Y - lid_h) // 2
                    lid_w = 3 * PIXEL_X
                    cr.set_source_rgba(r * 0.25, g * 0.18, b * 0.15, alpha)
                    if left_closed:
                        cr.rectangle(ox + 4 * PIXEL_X, lid_y, lid_w, lid_h)
                    if right_closed:
                        cr.rectangle(ox + 11 * PIXEL_X, lid_y, lid_w, lid_h)
                    cr.fill()
            # Mouth overlay
            if s["mouth_visible"] > 0.05:
                if s["mouth_shape"] == 1:
                    cols = [6, 7, 8, 9, 10, 11]
                    mh = max(2, int(PIXEL_Y * 0.7))
                else:
                    cols = [7, 8, 9, 10]
                    mh = max(2, int(PIXEL_Y * 0.45))
                my = oy + 3 * PIXEL_Y + (PIXEL_Y - mh) // 2
                cr.set_source_rgba(r * 0.45, g * 0.30, b * 0.20, s["mouth_visible"])
                for mc in cols:
                    cr.rectangle(ox + mc * PIXEL_X, my, PIXEL_X, mh)
                cr.fill()
            cr.restore()

            # FEET (no breath)
            cr.set_source_rgb(r, g, b)
            for entry in form["footCells"]:
                push_foot_cell(entry)
            cr.fill()
        else:
            both, only_a, only_b = [], [], []
            for row in range(ROWS):
                for col in range(COLS):
                    in_a = form_a["pixels"][row][col] in ('O', 'E', 'F')
                    in_b = form_b["pixels"][row][col] in ('O', 'E', 'F')
                    if in_a and in_b: both.append((row, col))
                    elif in_a: only_a.append((row, col))
                    elif in_b: only_b.append((row, col))

            def filt(cells, lo, hi):
                return [c for c in cells if lo <= c[0] < hi]

            # BODY with breath
            cr.save()
            cr.translate(0, pivot_y)
            cr.scale(1.0, breath_scale)
            cr.translate(0, -pivot_y)
            for cells, alpha in ((filt(both, 0, 4), 1.0),
                                 (filt(only_a, 0, 4), 1 - t),
                                 (filt(only_b, 0, 4), t)):
                if not cells:
                    continue
                cr.set_source_rgba(r, g, b, alpha)
                for (row, col) in cells:
                    cr.rectangle(ox + col * PIXEL_X, oy + row * PIXEL_Y, PIXEL_X, PIXEL_Y)
                cr.fill()
            cr.restore()

            # FEET without breath
            for cells, alpha in ((filt(both, 4, ROWS), 1.0),
                                 (filt(only_a, 4, ROWS), 1 - t),
                                 (filt(only_b, 4, ROWS), t)):
                if not cells:
                    continue
                cr.set_source_rgba(r, g, b, alpha)
                for (row, col) in cells:
                    cr.rectangle(ox + col * PIXEL_X, oy + row * PIXEL_Y, PIXEL_X, PIXEL_Y)
                cr.fill()

        cr.restore()
