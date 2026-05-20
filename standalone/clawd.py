#!/usr/bin/python3
"""
Clawd — standalone GTK app.

A regular floating window with animated pixel-art Clawd plus Claude Code
subscription usage info (session %, week %, extra credits) pulled from
/api/oauth/usage. Works on any Linux desktop environment (GNOME, KDE,
XFCE, Cinnamon, MATE, Sway, …) as long as Python 3 + GTK 3 are installed.

  $ ./clawd.py                # default window
  $ ./clawd.py --keep-above   # stay on top of other windows
  $ ./clawd.py --sticky       # show on every workspace
  $ ./clawd.py --refresh 600  # refresh every N seconds (default 300)
"""

import argparse
import json
import math
import os
import random
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

import cairo
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango, PangoCairo

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ──────────────── pixel-art Clawd ────────────────
COLS = 18
ROWS = 6

FORMS = {
    "clawd": {"color": (0.85, 0.47, 0.34), "pixels": [
        "...OOOOOOOOOOOO...",
        "...OOEOOOOOOEOO...",
        ".OOOOOOOOOOOOOOOO.",
        "...OOOOOOOOOOOO...",
        "....F.F....F.F....",
        "..................",
    ]},
    "heart":   {"color": (0.93, 0.27, 0.49), "pixels": [
        "..................", "....OOO....OOO....", "...OOOOOOOOOOOO...",
        "....OOOOOOOOOO....", ".....OOOOOOOO.....", "......OOOOOO......",
    ]},
    "ghost":   {"color": (0.88, 0.90, 0.96), "pixels": [
        ".....OOOOOOOO.....", "....OOOOOOOOOO....", "...OOEOOOOOOEOO...",
        "...OOOOOOOOOOOO...", "...OOOOOOOOOOOO...", "...O.OO.OO.OO.O...",
    ]},
    "octopus": {"color": (0.62, 0.40, 0.85), "pixels": [
        "....OOOOOOOO......", "...OOOOOOOOOO.....", "..OOEOOOOOOEOO....",
        "...OOOOOOOOOO.....", "..O.O.O.O.O.O.O...", "...O.O.O.O.O.O....",
    ]},
    "sparkle": {"color": (0.98, 0.78, 0.18), "pixels": [
        "........OO........", ".....OOOOOOOO.....", ".OOOOOOOOOOOOOOOO.",
        ".OOOOOOOOOOOOOOOO.", ".....OOOOOOOO.....", "........OO........",
    ]},
    "blob":    {"color": (0.35, 0.82, 0.45), "pixels": [
        "..................", "....OOOOOOOOOO....", "..OOOOOOOOOOOOOO..",
        "..OOOOOOOOOOOOOO..", "...OOOOOOOOOOOO...", "..................",
    ]},
    "pacman":  {"color": (0.98, 0.85, 0.10), "pixels": [
        ".....OOOOOOOOO....", "....OOOOOOOOOOO...", "...OOOOOOOO.......",
        "...OOOOOO.........", "...OOOOOOOO.......", "....OOOOOOOOOOO...",
    ]},
    "invader": {"color": (0.30, 0.90, 0.40), "pixels": [
        "....O......O......", ".....OOOOOOOO.....", "....OOOOOOOOOO....",
        "...OO.OOOO.OO.....", "...OOOOOOOOOO.....", "....O.OOOO.O......",
    ]},
    "crown":   {"color": (0.96, 0.80, 0.20), "pixels": [
        "..O..O..O..O..O...", "..O..O..O..O..O...", "..OOOOOOOOOOOOOO..",
        "..OOOOOOOOOOOOOO..", "..OOOOOOOOOOOOOO..", "..................",
    ]},
    "skull":   {"color": (0.92, 0.92, 0.95), "pixels": [
        ".....OOOOOOOO.....", "....OOOOOOOOOO....", "....OO.OOOO.OO....",
        ".....OOOOOOOO.....", "......OOOOOO......", "......O.O.O.O.....",
    ]},
}
MORPH_TARGETS = [k for k in FORMS if k != "clawd"]

for _form in FORMS.values():
    _form["bodyCells"] = []
    _form["footCells"] = []
    for _r in range(ROWS):
        for _c in range(COLS):
            ch = _form["pixels"][_r][_c]
            if ch == '.': continue
            (_form["bodyCells"] if _r < 4 else _form["footCells"]).append((_r, _c, ch))

# Same message pool as the lock-screen widget.
MESSAGES = [
    "You're absolutely right!",
    "Let me think about this more carefully...",
    "Actually, on reflection — yes, that.",
    "404: Motivation not found.",
    "It works on my machine ¯\\_(ツ)_/¯",
    "Just one more refactor, I promise.",
    "TODO: rename this variable later.",
    "git push --force or die trying.",
    "Have you tried turning it off and on again?",
    "Naming things is hard.",
    "Today's bug is tomorrow's feature.",
    "Make it work, make it right, make it fast.",
    "Why do programmers prefer dark mode? Bugs hate the light.",
    "There's no place like 127.0.0.1",
    "I'd tell you a UDP joke, but you might not get it.",
    "Take a deep breath. The compiler can wait.",
    "Did you remember to commit?",
    "Sip your coffee. The bug will still be there.",
]

# ──────────────── easing ────────────────
def _ease_out_quad(t): return 1 - (1 - t) ** 2
def _ease_in_quad(t): return t * t
def _ease_in_out_quad(t):
    return 2*t*t if t < 0.5 else 1 - ((-2*t+2) ** 2) / 2
def _ease_in_out_cubic(t):
    return 4*t*t*t if t < 0.5 else 1 - ((-2*t+2) ** 3) / 2
def _ease_out_bounce(t):
    n1, d1 = 7.5625, 2.75
    if t < 1/d1: return n1*t*t
    elif t < 2/d1: t -= 1.5/d1; return n1*t*t + 0.75
    elif t < 2.5/d1: t -= 2.25/d1; return n1*t*t + 0.9375
    else: t -= 2.625/d1; return n1*t*t + 0.984375
def _ease_out_back(t):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3*(t-1)**3 + c1*(t-1)**2

EASINGS = {
    "linear": lambda t: t,
    "ease_out_quad": _ease_out_quad,
    "ease_in_quad": _ease_in_quad,
    "ease_in_out_quad": _ease_in_out_quad,
    "ease_in_out_cubic": _ease_in_out_cubic,
    "ease_out_bounce": _ease_out_bounce,
    "ease_out_back": _ease_out_back,
}


class _Tween:
    def __init__(self, state, key, target, dur_ms, easing="linear", on_complete=None):
        self.state = state
        self.key = key
        self.start = state[key]
        self.target = target
        self.dur = max(1, dur_ms)
        self.elapsed = 0
        self.ease = EASINGS.get(easing, EASINGS["linear"])
        self.on_complete = on_complete
        self.done = False

    def step(self, dt):
        if self.done: return
        self.elapsed += dt
        t = min(1.0, self.elapsed / self.dur)
        self.state[self.key] = self.start + (self.target - self.start) * self.ease(t)
        if t >= 1.0:
            self.done = True
            if self.on_complete:
                try: self.on_complete()
                except Exception as e: print("tween callback:", e)


# ──────────────── usage fetcher ────────────────
def _find_fetch_script():
    candidates = [
        os.path.join(SCRIPT_DIR, "fetch-usage.sh"),
        os.path.join(SCRIPT_DIR, "..", "applet", "fetch-usage.sh"),
        os.path.expanduser("~/.local/share/cinnamon/applets/claude-usage@rowdy4e/fetch-usage.sh"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return os.path.abspath(p)
    return None


# ──────────────── main window ────────────────
class ClawdStandalone(Gtk.Window):
    def __init__(self, args, _quit_on_destroy=True):
        super().__init__(title="Clawd — Claude Usage")
        self.args = args
        self._quit_on_destroy = _quit_on_destroy
        self.set_default_size(480, 380)
        self.set_position(Gtk.WindowPosition.CENTER)
        if args.keep_above: self.set_keep_above(True)
        if args.sticky: self.stick()

        # Pixel size for the in-window Clawd. Compact since the window is small.
        self._pixel_x = 6
        self._pixel_y = 12
        self._canvas_w = COLS * self._pixel_x + 40
        self._canvas_h = ROWS * self._pixel_y + 30

        # State
        self._s = {
            "body_x": 0.0, "body_y": 0.0,
            "tilt": 0.0, "scale_x": 1.0, "scale_y": 1.0,
            "eye_open": 1.0, "eye_state": "normal",
            "mouth_visible": 0.0, "mouth_shape": 0,
            "_breath": 0.0, "_breath_start": None,
            "_blink_active": False, "_blink_phase": "closing", "_blink_t": 0.0,
            "morph_t": 0.0, "form_a": "clawd", "form_b": "clawd",
            "walking": 0.0, "walk_phase": 0.0, "excited": 0.0,
        }
        self._tweens = []
        self._anim_busy = False
        self._current_message = ""
        self._message_active = False
        self._mouth_anim_id = None

        # Usage state
        self._last_usage = None
        self._last_error = None
        self._last_updated = 0
        self._next_refresh_at = 0
        self._rate_limited_until = 0
        self._backoff_seconds = 0

        self._fetch_script = _find_fetch_script()

        # ── Layout ──
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        outer.set_margin_top(14)
        outer.set_margin_bottom(14)
        outer.set_margin_start(14)
        outer.set_margin_end(14)

        self.area = Gtk.DrawingArea()
        self.area.set_size_request(self._canvas_w, self._canvas_h)
        self.area.connect("draw", self._on_draw_clawd)
        # Centered Clawd in its own row
        clawd_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        clawd_box.set_halign(Gtk.Align.CENTER)
        clawd_box.pack_start(self.area, False, False, 0)
        outer.pack_start(clawd_box, False, False, 0)

        sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        outer.pack_start(sep, False, False, 0)

        # Usage grid
        self._usage_grid = Gtk.Grid()
        self._usage_grid.set_column_spacing(18)
        self._usage_grid.set_row_spacing(6)
        self._usage_grid.set_halign(Gtk.Align.CENTER)
        outer.pack_start(self._usage_grid, False, False, 0)

        # Status footer
        self._status_label = Gtk.Label()
        self._status_label.set_halign(Gtk.Align.CENTER)
        self._status_label.get_style_context().add_class("dim-label")
        outer.pack_start(self._status_label, False, False, 0)

        # Buttons row
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        btn_box.set_halign(Gtk.Align.END)
        self._refresh_btn = Gtk.Button.new_with_label("Refresh")
        self._refresh_btn.connect("clicked", lambda *_: self._refresh_usage())
        btn_box.pack_start(self._refresh_btn, False, False, 0)
        close_btn = Gtk.Button.new_with_label("Close")
        close_btn.connect("clicked", lambda *_: self.destroy())
        btn_box.pack_start(close_btn, False, False, 0)
        outer.pack_start(btn_box, False, False, 0)

        self.add(outer)

        # Initial usage display (loading)
        self._rebuild_usage_grid()
        self._update_status()

        # Animation tick
        self._tick_id = GLib.timeout_add(33, self._on_tick)
        # Blinks
        self._blink_id = GLib.timeout_add(random.randint(4000, 9000), self._begin_blink)
        # Idle animations
        self._idle_id = GLib.timeout_add(random.randint(15000, 25000), self._trigger_random)
        # Messages
        self._msg_id = GLib.timeout_add(random.randint(35000, 80000), self._show_random_message)
        # Initial fetch
        GLib.timeout_add(300, self._refresh_usage)
        # Auto-refresh + status tick
        self._auto_id = GLib.timeout_add_seconds(max(60, args.refresh), self._auto_refresh)
        self._status_id = GLib.timeout_add_seconds(1, self._update_status)

        self.connect("destroy", self._on_destroy)

    def _on_destroy(self, *_):
        for tid in (self._tick_id, self._blink_id, self._idle_id, self._msg_id,
                    self._mouth_anim_id, self._auto_id, self._status_id):
            if tid:
                try: GLib.source_remove(tid)
                except Exception: pass
        if self._quit_on_destroy:
            Gtk.main_quit()

    # ──────────────── usage fetching ────────────────
    def _auto_refresh(self):
        # Called by the timer; never blocks because subprocess is async-ish.
        self._refresh_usage()
        return True

    def _refresh_usage(self):
        if not self._fetch_script:
            self._last_error = "fetch-usage.sh not found"
            self._rebuild_usage_grid()
            return False
        now_ms = int(GLib.get_monotonic_time() / 1000)
        if now_ms < self._rate_limited_until:
            return False
        try:
            proc = Gio.Subprocess.new(
                [self._fetch_script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            )
            proc.communicate_utf8_async(None, None, self._on_fetch_done)
        except Exception as e:
            self._last_error = "spawn failed: %s" % e
            self._rebuild_usage_grid()
        return False

    def _on_fetch_done(self, source, result):
        try:
            ok, stdout, stderr = source.communicate_utf8_finish(result)
            if stdout:
                data = json.loads(stdout)
                if isinstance(data, dict) and data.get("rateLimited"):
                    self._backoff_seconds = min(3600,
                        max(120, (self._backoff_seconds or 60) * 2))
                    self._rate_limited_until = int(GLib.get_monotonic_time() / 1000) + self._backoff_seconds * 1000
                    self._last_error = "rate limited — backing off %d min" % (self._backoff_seconds // 60)
                elif isinstance(data, dict) and data.get("error"):
                    self._last_error = str(data["error"])
                else:
                    self._last_usage = data
                    self._last_error = None
                    self._last_updated = int(GLib.get_monotonic_time() / 1000)
                    self._backoff_seconds = 0
                    self._rate_limited_until = 0
                    self._next_refresh_at = self._last_updated + self.args.refresh * 1000
            else:
                self._last_error = (stderr or "no output").strip()
        except Exception as e:
            self._last_error = "parse error: %s" % e
        self._rebuild_usage_grid()
        self._update_status()

    def _rebuild_usage_grid(self):
        for child in list(self._usage_grid.get_children()):
            self._usage_grid.remove(child)
        if self._last_error:
            err = Gtk.Label(label="⚠ " + self._last_error)
            err.set_halign(Gtk.Align.CENTER)
            self._usage_grid.attach(err, 0, 0, 2, 1)
            err.show()
            return
        if not self._last_usage:
            lbl = Gtk.Label(label="Loading…")
            self._usage_grid.attach(lbl, 0, 0, 2, 1)
            lbl.show()
            return
        rows = []
        u = self._last_usage
        if u.get("five_hour"):
            rows.append(("Session", self._fmt_pct(u["five_hour"]) + "  ·  resets " + self._fmt_reset_rel(u["five_hour"].get("resets_at"))))
        if u.get("seven_day"):
            rows.append(("Week (all)", self._fmt_pct(u["seven_day"]) + "  ·  resets " + self._fmt_reset_rel(u["seven_day"].get("resets_at"))))
        if u.get("seven_day_sonnet"):
            rows.append(("Week (Sonnet)", self._fmt_pct(u["seven_day_sonnet"])))
        if u.get("seven_day_opus"):
            rows.append(("Week (Opus)", self._fmt_pct(u["seven_day_opus"])))
        ex = u.get("extra_usage")
        if ex and ex.get("is_enabled"):
            cur = ex.get("currency", "USD")
            sym = "€" if cur == "EUR" else "$" if cur == "USD" else cur + " "
            used = ex.get("used_credits", 0) / 100
            limit = ex.get("monthly_limit", 0) / 100
            rows.append(("Credits", self._fmt_pct(ex) + "  ·  %s%.2f / %s%.0f" % (sym, used, sym, limit)))
        for i, (k, v) in enumerate(rows):
            kl = Gtk.Label(label=k)
            kl.set_halign(Gtk.Align.START)
            kl.get_style_context().add_class("dim-label")
            vl = Gtk.Label(label=v)
            vl.set_halign(Gtk.Align.END)
            vl.set_selectable(True)
            self._usage_grid.attach(kl, 0, i, 1, 1)
            self._usage_grid.attach(vl, 1, i, 1, 1)
            kl.show(); vl.show()

    def _fmt_pct(self, sec):
        if sec is None: return "—"
        u = sec.get("utilization")
        if u is None: return "—"
        return "%.0f %%" % u

    def _fmt_reset_rel(self, iso):
        if not iso: return "—"
        try:
            d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            delta = (d - now).total_seconds()
            if delta <= 0: return "soon"
            if delta < 3600: return "in %d min" % (delta // 60)
            if delta < 86400:
                h = int(delta // 3600); m = int((delta % 3600) // 60)
                return "in %dh %02dm" % (h, m)
            return "in %dd" % (delta // 86400)
        except Exception:
            return "—"

    def _update_status(self, *_):
        parts = []
        if self._last_updated:
            now_s = int(GLib.get_monotonic_time() / 1000) // 1000
            age = max(0, now_s - self._last_updated // 1000)
            parts.append("Updated %ds ago" % age if age < 60 else "Updated %dm ago" % (age // 60))
        if self._rate_limited_until > int(GLib.get_monotonic_time() / 1000):
            wait_s = (self._rate_limited_until - int(GLib.get_monotonic_time() / 1000)) // 1000
            parts.append("retry in %d min" % max(1, wait_s // 60))
        self._status_label.set_text("  ·  ".join(parts) if parts else "")
        return True

    # ──────────────── animations & drawing ────────────────
    def _begin_blink(self):
        if not self._s["_blink_active"]:
            self._s["_blink_active"] = True
            self._s["_blink_phase"] = "closing"
            self._s["_blink_t"] = 0.0
        self._blink_id = GLib.timeout_add(random.randint(4000, 9000), self._begin_blink)
        return False

    def _trigger_random(self):
        if not self._anim_busy:
            try: self._play_animation(self._pick_animation())
            except Exception as e: self._anim_busy = False; print("anim error:", e)
        self._idle_id = GLib.timeout_add(random.randint(15000, 25000), self._trigger_random)
        return False

    def _pick_animation(self):
        return random.choice([
            "bounce", "wiggle", "squish", "shake", "tilt_pose",
            "walk", "wink", "yawn", "lookAround", "morph", "glitch",
        ])

    def _play_animation(self, name):
        self._reset_motion()
        m = getattr(self, "_anim_" + name, None)
        if not m: return
        self._anim_busy = True
        m()

    def _anim_done(self): self._anim_busy = False

    def _reset_motion(self):
        s = self._s
        self._tweens = [t for t in self._tweens if t.key not in (
            "body_x", "body_y", "tilt", "scale_x", "scale_y",
            "walking", "walk_phase", "excited", "morph_t", "mouth_visible"
        )]
        s["body_x"] = 0.0; s["body_y"] = 0.0
        s["tilt"] = 0.0; s["scale_x"] = 1.0; s["scale_y"] = 1.0
        s["walking"] = 0.0; s["walk_phase"] = 0.0
        s["excited"] = 0.0; s["morph_t"] = 0.0
        s["form_a"] = "clawd"; s["form_b"] = "clawd"
        s["mouth_visible"] = 0.0; s["mouth_shape"] = 0
        s["eye_state"] = "normal"

    def _add_tween(self, key, target, dur, easing="linear", on_complete=None):
        self._tweens = [t for t in self._tweens if t.key != key]
        self._tweens.append(_Tween(self._s, key, target, dur, easing, on_complete))

    def _anim_bounce(self):
        def back(): self._add_tween("body_y", 0, 400, "ease_out_bounce", on_complete=self._anim_done)
        self._add_tween("body_y", -8, 180, "ease_out_quad", on_complete=back)

    def _anim_wiggle(self):
        steps = [(-12, 100), (12, 120), (-7, 100), (0, 120)]
        def chain(i):
            if i >= len(steps): self._anim_done(); return
            tgt, dur = steps[i]
            self._add_tween("tilt", tgt, dur, "linear", on_complete=lambda: chain(i+1))
        chain(0)

    def _anim_squish(self):
        def s3():
            self._add_tween("scale_x", 1.0, 240, "ease_out_bounce")
            self._add_tween("scale_y", 1.0, 240, "ease_out_bounce", on_complete=self._anim_done)
        def s2():
            self._add_tween("scale_x", 0.90, 180, "ease_out_quad")
            self._add_tween("scale_y", 1.12, 180, "ease_out_quad", on_complete=s3)
        self._add_tween("scale_x", 1.15, 120, "ease_out_quad")
        self._add_tween("scale_y", 0.80, 120, "ease_out_quad", on_complete=s2)

    def _anim_shake(self):
        steps = [4, -4, 3, -3, 2, -2, 0]
        def chain(i):
            if i >= len(steps): self._anim_done(); return
            self._add_tween("body_x", steps[i], 60, "linear", on_complete=lambda: chain(i+1))
        chain(0)

    def _anim_tilt_pose(self):
        d = -16 if random.random() < 0.5 else 16
        def hold(): GLib.timeout_add(450, lambda: (self._add_tween("tilt", 0, 350, "ease_out_back", on_complete=self._anim_done), False)[1])
        self._add_tween("tilt", d, 250, "ease_out_quad", on_complete=hold)

    def _anim_walk(self):
        s = self._s
        s["walking"] = 1.0; s["walk_phase"] = 0.0
        state = {"i": 0}
        def toggle():
            if state["i"] >= 4:
                self._add_tween("body_y", 0, 150, "linear")
                s["walking"] = 0.0; s["walk_phase"] = 0.0; self._anim_done(); return
            nph = 0.99 if state["i"] % 2 == 0 else 0.0
            nby = -3 if state["i"] % 2 == 0 else 0
            self._add_tween("walk_phase", nph, 220, "ease_in_out_quad")
            self._add_tween("body_y", nby, 220, "ease_in_out_quad",
                            on_complete=lambda: (state.update(i=state["i"]+1), toggle())[1])
        toggle()

    def _anim_wink(self):
        s = self._s
        s["eye_state"] = "wink-l" if random.random() < 0.5 else "wink-r"
        def back(): s["eye_state"] = "normal"; self._anim_done()
        GLib.timeout_add(450, lambda: (back(), False)[1])

    def _anim_yawn(self):
        s = self._s
        s["eye_state"] = "sleepy"; s["mouth_shape"] = 1
        self._add_tween("mouth_visible", 1.0, 250, "ease_out_quad")
        def close():
            self._add_tween("mouth_visible", 0.0, 300, "ease_in_quad",
                            on_complete=lambda: (s.update(eye_state="normal", mouth_shape=0), self._anim_done())[1])
        GLib.timeout_add(900, lambda: (close(), False)[1])

    def _anim_lookAround(self):
        def s3(): self._add_tween("tilt", 0, 250, "ease_out_quad", on_complete=self._anim_done)
        def s2(): self._add_tween("tilt", 7, 350, "ease_in_out_quad",
                                  on_complete=lambda: GLib.timeout_add(220, lambda: (s3(), False)[1]))
        self._add_tween("tilt", -7, 250, "ease_out_quad",
                        on_complete=lambda: GLib.timeout_add(220, lambda: (s2(), False)[1]))

    def _anim_morph(self):
        s = self._s
        s["form_a"] = "clawd"; s["form_b"] = random.choice(MORPH_TARGETS); s["morph_t"] = 0.0
        def out():
            self._add_tween("morph_t", 0.0, 500, "ease_in_out_quad",
                            on_complete=lambda: (s.update(form_b="clawd"), self._anim_done())[1])
        self._add_tween("morph_t", 1.0, 600, "ease_in_out_quad",
                        on_complete=lambda: GLib.timeout_add(1400, lambda: (out(), False)[1]))

    def _anim_glitch(self):
        s = self._s; state = {"i": 0}
        def tick():
            if state["i"] >= 6:
                s["form_a"] = "clawd"; s["form_b"] = "clawd"; s["morph_t"] = 0.0; s["body_x"] = 0
                self._anim_done(); return False
            pick = random.choice(MORPH_TARGETS)
            s["form_a"] = pick; s["form_b"] = pick; s["morph_t"] = 0.0
            s["body_x"] = random.uniform(-3, 3)
            state["i"] += 1
            GLib.timeout_add(70, tick); return False
        tick()

    # ──────────────── messages ────────────────
    def _show_random_message(self):
        try:
            if not self._message_active:
                self._current_message = random.choice(MESSAGES)
                self._message_active = True
                self._start_mouth_talk()
                GLib.timeout_add(6500, self._hide_message)
                self.area.queue_draw()
        except Exception as e:
            print("msg error:", e)
        self._msg_id = GLib.timeout_add(random.randint(35000, 80000), self._show_random_message)
        return False

    def _hide_message(self):
        self._message_active = False
        self._current_message = ""
        self._stop_mouth_talk()
        self.area.queue_draw()
        return False

    def _start_mouth_talk(self):
        if self._mouth_anim_id: return
        start = GLib.get_monotonic_time()
        def tick():
            if not self._message_active or (GLib.get_monotonic_time() - start) > 2_000_000:
                self._s["mouth_visible"] = 0.0; self._s["mouth_shape"] = 0
                self._mouth_anim_id = None; return False
            open_now = self._s["mouth_visible"] < 0.5
            self._s["mouth_visible"] = 1.0 if open_now else 0.0
            if open_now:
                self._s["mouth_shape"] = 1 if random.random() < 0.3 else 0
            return True
        self._s["mouth_visible"] = 1.0; self._s["mouth_shape"] = 0
        self._mouth_anim_id = GLib.timeout_add(random.randint(110, 160), tick)

    def _stop_mouth_talk(self):
        if self._mouth_anim_id:
            try: GLib.source_remove(self._mouth_anim_id)
            except Exception: pass
            self._mouth_anim_id = None
        self._s["mouth_visible"] = 0.0; self._s["mouth_shape"] = 0

    # ──────────────── tick / drawing ────────────────
    def _on_tick(self):
        try:
            s = self._s
            now = GLib.get_monotonic_time() / 1000.0
            if s["_breath_start"] is None: s["_breath_start"] = now
            phase = ((now - s["_breath_start"]) % 4000.0) / 4000.0
            s["_breath"] = (1 - math.cos(phase * 2 * math.pi)) / 2
            if s["_blink_active"]:
                if s["_blink_phase"] == "closing":
                    s["_blink_t"] += 0.18
                    s["eye_open"] = max(0.0, 1.0 - s["_blink_t"])
                    if s["_blink_t"] >= 1: s["_blink_phase"] = "opening"; s["_blink_t"] = 0
                else:
                    s["_blink_t"] += 0.14
                    s["eye_open"] = min(1.0, s["_blink_t"])
                    if s["_blink_t"] >= 1: s["_blink_active"] = False; s["eye_open"] = 1.0
            for tw in self._tweens[:]: tw.step(33)
            self._tweens = [t for t in self._tweens if not t.done]
            self.area.queue_draw()
        except Exception as e:
            print("tick error:", e)
        return True

    def _on_draw_clawd(self, area, cr):
        try:
            w = area.get_allocated_width()
            h = area.get_allocated_height()
            self._paint(cr, w, h)
            self._draw_bubble(cr, w, h)
        except Exception as e:
            print("draw error:", e)
        return False

    def _paint(self, cr, w, h):
        s = self._s
        try: cr.set_antialias(cairo.ANTIALIAS_NONE)
        except Exception: pass

        PX, PY = self._pixel_x, self._pixel_y
        draw_w, draw_h = COLS * PX, ROWS * PY
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

        ra, ga, ba = form_a["color"]; rb, gb, bb = form_b["color"]
        r = ra*(1-t) + rb*t; g = ga*(1-t) + gb*t; b = ba*(1-t) + bb*t

        left_closed = right_closed = False
        if not morphing:
            es = s["eye_state"]
            if es == "sleepy": left_closed = right_closed = True
            elif es == "wink-l": left_closed = True
            elif es == "wink-r": right_closed = True
            elif s["eye_open"] < 0.5: left_closed = right_closed = True

        pair_a = {4, 13}; pair_b = {6, 11}

        def body_cell(entry):
            row, col, ch = entry
            if ch == 'E':
                is_l = (col == 5); is_r = (col == 12)
                if morphing or (is_l and left_closed) or (is_r and right_closed):
                    cr.rectangle(ox + col*PX, oy + row*PY, PX, PY)
                return
            cr.rectangle(ox + col*PX, oy + row*PY, PX, PY)

        def foot_cell(entry):
            row, col, ch = entry
            yo = 0
            if ch == 'F' and s["walking"] > 0 and not morphing:
                lift = PY
                if s["walk_phase"] < 0.5 and col in pair_a: yo = -lift
                elif s["walk_phase"] >= 0.5 and col in pair_b: yo = -lift
                yo = int(round(yo * s["walking"]))
            cr.rectangle(ox + col*PX, oy + row*PY + yo, PX, PY)

        breath_scale = 1.0 - s["_breath"] * 0.05
        pivot_y = oy + 4 * PY

        if not morphing:
            form = form_b if t >= 0.5 else form_a
            cr.save()
            cr.translate(0, pivot_y)
            cr.scale(1.0, breath_scale)
            cr.translate(0, -pivot_y)
            cr.set_source_rgb(r, g, b)
            for e in form["bodyCells"]: body_cell(e)
            cr.fill()
            if left_closed or right_closed:
                openness = (s["eye_open"] if (left_closed and right_closed and s["eye_state"] == "normal") else 0.0)
                alpha = 1.0 - openness
                if alpha > 0.05:
                    lid_h = max(2, int(PY * 0.35))
                    lid_y = oy + 1 * PY + (PY - lid_h) // 2
                    lid_w = 3 * PX
                    cr.set_source_rgba(r*0.25, g*0.18, b*0.15, alpha)
                    if left_closed: cr.rectangle(ox + 4*PX, lid_y, lid_w, lid_h)
                    if right_closed: cr.rectangle(ox + 11*PX, lid_y, lid_w, lid_h)
                    cr.fill()
            if s["mouth_visible"] > 0.05:
                if s["mouth_shape"] == 1:
                    cols = [6, 7, 8, 9, 10, 11]; mh = max(2, int(PY * 0.7))
                else:
                    cols = [7, 8, 9, 10]; mh = max(2, int(PY * 0.45))
                my = oy + 3*PY + (PY - mh) // 2
                cr.set_source_rgba(r*0.45, g*0.30, b*0.20, s["mouth_visible"])
                for mc in cols: cr.rectangle(ox + mc*PX, my, PX, mh)
                cr.fill()
            cr.restore()
            cr.set_source_rgb(r, g, b)
            for e in form["footCells"]: foot_cell(e)
            cr.fill()
        else:
            both, only_a, only_b = [], [], []
            for row in range(ROWS):
                for col in range(COLS):
                    ia = form_a["pixels"][row][col] in ('O','E','F')
                    ib = form_b["pixels"][row][col] in ('O','E','F')
                    if ia and ib: both.append((row, col))
                    elif ia: only_a.append((row, col))
                    elif ib: only_b.append((row, col))
            def filt(cells, lo, hi): return [c for c in cells if lo <= c[0] < hi]
            cr.save()
            cr.translate(0, pivot_y); cr.scale(1.0, breath_scale); cr.translate(0, -pivot_y)
            for cells, a in ((filt(both, 0, 4), 1.0), (filt(only_a, 0, 4), 1-t), (filt(only_b, 0, 4), t)):
                if not cells: continue
                cr.set_source_rgba(r, g, b, a)
                for (row, col) in cells: cr.rectangle(ox + col*PX, oy + row*PY, PX, PY)
                cr.fill()
            cr.restore()
            for cells, a in ((filt(both, 4, ROWS), 1.0), (filt(only_a, 4, ROWS), 1-t), (filt(only_b, 4, ROWS), t)):
                if not cells: continue
                cr.set_source_rgba(r, g, b, a)
                for (row, col) in cells: cr.rectangle(ox + col*PX, oy + row*PY, PX, PY)
                cr.fill()

        cr.restore()

    def _draw_bubble(self, cr, canvas_w, canvas_h):
        if not self._message_active or not self._current_message: return
        try:
            layout = PangoCairo.create_layout(cr)
            fd = Pango.FontDescription("Press Start 2P, VT323, PixelOperator, Monaco, DejaVu Sans Mono")
            fd.set_size(9 * Pango.SCALE)
            fd.set_weight(Pango.Weight.BOLD)
            layout.set_font_description(fd)
            layout.set_text(self._current_message, -1)
            layout.set_alignment(Pango.Alignment.LEFT)
            max_w = min(380, canvas_w - 40)
            layout.set_width(max_w * Pango.SCALE)
            layout.set_wrap(Pango.WrapMode.WORD)
            ink, logical = layout.get_pixel_extents()
            tw, th = max(ink.width, 1), max(logical.height, ink.height)
            pad_x, pad_y = 10, 6
            bw = tw + 2*pad_x; bh = th + 2*pad_y
            bx = (canvas_w - bw) // 2
            by = 4
            cr.set_source_rgba(0.078, 0.094, 0.125, 0.92)
            cr.rectangle(bx, by, bw, bh); cr.fill()
            cr.set_source_rgba(0.851, 0.467, 0.341, 1.0)
            cr.set_line_width(2)
            cr.rectangle(bx + 1, by + 1, bw - 2, bh - 2); cr.stroke()
            cr.set_source_rgba(0.961, 0.878, 0.784, 1.0)
            cr.move_to(bx + pad_x - ink.x, by + pad_y - ink.y)
            PangoCairo.show_layout(cr, layout)
        except Exception as e:
            print("bubble error:", e)


# ──────────────── Tray-icon renderer ────────────────
def render_clawd_icon(path, size=64):
    """Render a static Clawd PNG suitable for a panel tray icon."""
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    cr = cairo.Context(surface)
    try: cr.set_antialias(cairo.ANTIALIAS_NONE)
    except Exception: pass
    # Fit Clawd into the icon — bitmap is 18×6 logical pixels (3:1 ratio).
    px = max(1, (size - 4) // COLS)
    py = px  # square pixels in the icon (it's tiny, no aspect tricks)
    bitmap_w = COLS * px
    bitmap_h = ROWS * py
    ox = (size - bitmap_w) // 2
    oy = (size - bitmap_h) // 2
    form = FORMS["clawd"]
    cr.set_source_rgb(*form["color"])
    for r, c, ch in form["bodyCells"] + form["footCells"]:
        if ch == 'E':  # eyes stay as gaps
            continue
        cr.rectangle(ox + c * px, oy + r * py, px, py)
    cr.fill()
    surface.write_to_png(path)


def run_tray(args):
    """Run as a tray-icon-only process. Window is hidden but kept alive."""
    try:
        gi.require_version("AyatanaAppIndicator3", "0.1")
        from gi.repository import AyatanaAppIndicator3 as AI
    except Exception as e:
        sys.stderr.write(
            "Tray mode requires libayatana-appindicator. On Ubuntu/Debian:\n"
            "  sudo apt install gir1.2-ayatanaappindicator3-0.1\n"
            "On Fedora:\n"
            "  sudo dnf install libayatana-appindicator-gtk3\n"
            "\nFalling back to plain window mode.\n"
        )
        win = ClawdStandalone(args)
        win.show_all()
        Gtk.main()
        return

    # Render icon (cached in ~/.cache/clawd/)
    icon_dir = os.path.expanduser("~/.cache/clawd")
    os.makedirs(icon_dir, exist_ok=True)
    icon_path = os.path.join(icon_dir, "clawd-tray.png")
    render_clawd_icon(icon_path, size=64)

    # Create the window but keep it hidden — closing X hides it, doesn't quit.
    win = ClawdStandalone(args, _quit_on_destroy=False)
    win.connect("delete-event", lambda w, e: (w.hide(), True)[1])

    indicator = AI.Indicator.new(
        "clawd-claude-usage",
        icon_path,
        AI.IndicatorCategory.APPLICATION_STATUS
    )
    indicator.set_status(AI.IndicatorStatus.ACTIVE)
    indicator.set_icon_full(icon_path, "Clawd — Claude Code usage")
    indicator.set_title("Clawd")

    # Build the dropdown menu.
    menu = Gtk.Menu()

    open_item = Gtk.MenuItem(label="Open window")
    open_item.connect("activate", lambda *_: (win.show_all(), win.present()))
    menu.append(open_item)

    refresh_item = Gtk.MenuItem(label="Refresh now")
    refresh_item.connect("activate", lambda *_: win._refresh_usage())
    menu.append(refresh_item)

    menu.append(Gtk.SeparatorMenuItem())

    # Stats rows — disabled (info-only), updated by the periodic poller.
    session_item = Gtk.MenuItem(label="Session: —")
    session_item.set_sensitive(False)
    menu.append(session_item)
    week_item = Gtk.MenuItem(label="Week: —")
    week_item.set_sensitive(False)
    menu.append(week_item)
    credits_item = Gtk.MenuItem(label="Credits: —")
    credits_item.set_sensitive(False)
    menu.append(credits_item)

    menu.append(Gtk.SeparatorMenuItem())

    quit_item = Gtk.MenuItem(label="Quit")
    quit_item.connect("activate", lambda *_: Gtk.main_quit())
    menu.append(quit_item)

    menu.show_all()
    indicator.set_menu(menu)
    # Left-click on the icon (if supported) opens the window.
    try:
        indicator.set_secondary_activate_target(open_item)
    except Exception:
        pass

    def update_menu():
        u = win._last_usage
        if u:
            if u.get("five_hour"):
                session_item.set_label("Session: %.0f %%" % (u["five_hour"].get("utilization") or 0))
            if u.get("seven_day"):
                week_item.set_label("Week: %.0f %%" % (u["seven_day"].get("utilization") or 0))
            ex = u.get("extra_usage")
            if ex and ex.get("is_enabled"):
                credits_item.set_label("Credits: %.0f %%" % (ex.get("utilization") or 0))
            else:
                credits_item.set_label("Credits: —")
        return True
    GLib.timeout_add_seconds(2, update_menu)

    Gtk.main()


def main():
    p = argparse.ArgumentParser(description="Clawd — standalone Claude Code usage app.")
    p.add_argument("--tray", action="store_true",
                   help="Run as a panel tray icon instead of a window (requires libayatana-appindicator).")
    p.add_argument("--keep-above", action="store_true", help="Stay above other windows.")
    p.add_argument("--sticky", action="store_true", help="Show on every workspace.")
    p.add_argument("--refresh", type=int, default=300, help="Refresh interval in seconds (default 300, min 60).")
    args = p.parse_args()
    args.refresh = max(60, args.refresh)

    if args.tray:
        run_tray(args)
    else:
        win = ClawdStandalone(args)
        win.show_all()
        Gtk.main()


if __name__ == "__main__":
    main()
