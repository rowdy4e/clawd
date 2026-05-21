"""Animation interpreter for Clawd.

Reads animations.json (the shared DSL) and drives the host's `_add_tween`
function. Mirror implementation of anim-runner.js — keep them in sync.

The host provides:
  * state           — mutable dict of animation keys (body_x, body_y, ...)
  * add_tween(key, target, dur_ms, easing, on_complete)
  * GLib            — gi.repository.GLib for timeout_add (delays)
  * random_lists    — dict mapping name -> list, used by {random_from: NAME}
  * intensity_y     — multiplier applied to body_y targets (panel < 1, lock 1)
"""

import random


class AnimationRunner:
    def __init__(self, state, animations_json, add_tween, glib,
                 random_lists=None, intensity_y=1.0):
        self._state = state
        self._add_tween = add_tween
        self._GLib = glib
        self._random_lists = random_lists or {}
        self._intensity_y = float(intensity_y)
        self._animations = animations_json.get("animations", {})
        self._intensity_keys = set(animations_json.get("intensity_y_keys", ["body_y"]))
        self._iter_stack = []  # current iteration index inside `repeat`

    # ─── Public entry point ──────────────────────────────────────────────
    def play(self, name, on_complete=None, random_lists=None):
        script = self._animations.get(name)
        done = on_complete or (lambda: None)
        # Optional per-call random_lists override — useful for "morph to a
        # specific form" by passing {"MORPH_TARGETS": [chosen_form_name]}.
        saved = None
        if random_lists:
            saved = self._random_lists
            merged = dict(saved)
            merged.update(random_lists)
            self._random_lists = merged

        def wrapped_done():
            if saved is not None:
                self._random_lists = saved
            done()

        if script is None:
            wrapped_done()
            return
        self._run(self._normalize(script), wrapped_done)

    def list_animations(self):
        return list(self._animations.keys())

    # ─── Core loop ───────────────────────────────────────────────────────
    @staticmethod
    def _normalize(script):
        return script if isinstance(script, list) else [script]

    def _run(self, steps, then):
        if not steps:
            then()
            return
        head, rest = steps[0], steps[1:]
        next_step = lambda: self._run(rest, then)
        self._exec_step(head, next_step)

    def _exec_step(self, step, then):
        if "tween" in step:
            target = self._scale(step["tween"], self._eval(step["to"]))
            self._add_tween(step["tween"], target, step["ms"],
                            step.get("ease", "linear"), on_complete=then)

        elif "tween_many" in step:
            items = list(step["tween_many"].items())
            ms = step["ms"]
            ease = step.get("ease", "linear")
            # Fire all tweens; the last one carries the on_complete.
            for k, v in items[:-1]:
                self._add_tween(k, self._scale(k, self._eval(v)), ms, ease)
            last_k, last_v = items[-1]
            self._add_tween(last_k, self._scale(last_k, self._eval(last_v)),
                            ms, ease, on_complete=then)

        elif "delay" in step:
            ms = int(step["delay"])
            self._GLib.timeout_add(ms, lambda: (then(), False)[1])

        elif "set" in step:
            assignments = step["set"]
            # Two-pass: literals/random first so {ref:...} can read the new value.
            for k, v in assignments.items():
                if isinstance(v, dict) and "ref" in v:
                    continue
                self._state[k] = self._scale(k, self._eval(v))
            for k, v in assignments.items():
                if isinstance(v, dict) and "ref" in v:
                    self._state[k] = self._state[v["ref"]]
            then()

        elif "repeat" in step:
            n = int(step["repeat"])
            body = step["body"]
            def loop(i):
                if i >= n:
                    self._iter_stack.pop()
                    then()
                    return
                self._iter_stack[-1] = i
                self._run(list(body), lambda: loop(i + 1))
            self._iter_stack.append(0)
            loop(0)

        elif "sequence" in step:
            seq = step["sequence"]
            key = seq["tween"]
            values = seq["values"]
            default_ms = seq["ms"]
            default_ease = seq.get("ease", "linear")
            def chain(i):
                if i >= len(values):
                    then()
                    return
                v = values[i]
                if isinstance(v, dict) and "to" in v:
                    target = self._eval(v["to"])
                    ms = v.get("ms", default_ms)
                    ease = v.get("ease", default_ease)
                else:
                    target = self._eval(v)
                    ms, ease = default_ms, default_ease
                self._add_tween(key, self._scale(key, target), ms, ease,
                                on_complete=lambda: chain(i + 1))
            chain(0)

        elif "parallel" in step:
            scripts = step["parallel"]
            if not scripts:
                then()
                return
            remaining = [len(scripts)]
            def each_done():
                remaining[0] -= 1
                if remaining[0] == 0:
                    then()
            for s in scripts:
                self._run(self._normalize(s), each_done)

        else:
            # Unknown step — log and continue so we don't deadlock the chain.
            try:
                import sys
                sys.stderr.write("Clawd anim_runner: unknown step %r\n" % step)
            except Exception:
                pass
            then()

    # ─── Value evaluation ────────────────────────────────────────────────
    def _eval(self, v):
        if not isinstance(v, dict):
            return v
        if "random_pick" in v:
            return random.choice(v["random_pick"])
        if "random_from" in v:
            return random.choice(self._random_lists[v["random_from"]])
        if "random_range" in v:
            lo, hi = v["random_range"]
            return random.uniform(lo, hi)
        if "iter_pick" in v:
            if not self._iter_stack:
                return v["iter_pick"][0]
            idx = self._iter_stack[-1]
            return v["iter_pick"][idx % len(v["iter_pick"])]
        if "ref" in v:
            return self._state[v["ref"]]
        return v

    def _scale(self, key, value):
        if key in self._intensity_keys and isinstance(value, (int, float)):
            return value * self._intensity_y
        return value
