// Animation interpreter for Clawd (Cinnamon applet side).
// Mirror of cinnamon/lockscreen/anim_runner.py — keep them in sync.
// Reads cinnamon/shared/animations.json (the shared DSL) and drives a
// host-supplied addTween(key, target, durMs, easing, onComplete).

function AnimationRunner(opts) {
    this._state = opts.state;
    this._addTween = opts.addTween;
    this._timeoutAdd = opts.timeoutAdd; // (ms, fn) -> id  (Mainloop.timeout_add)
    this._randomLists = opts.randomLists || {};
    this._intensityY = (opts.intensityY != null) ? opts.intensityY : 1.0;
    // keyMap maps DSL snake_case names to host state keys (e.g. body_y -> bodyY).
    // addTween is also called with the mapped key so Tweener targets the right
    // state property.
    this._keyMap = opts.keyMap || {};
    this._animations = (opts.animationsJson && opts.animationsJson.animations) || {};
    let keys = (opts.animationsJson && opts.animationsJson.intensity_y_keys) || ["body_y"];
    this._intensityKeys = {};
    for (let i = 0; i < keys.length; i++) this._intensityKeys[keys[i]] = true;
    this._iterStack = [];
}

AnimationRunner.prototype = {

    play: function(name, onComplete, opts) {
        let script = this._animations[name];
        let done = onComplete || function() {};
        // Optional per-call randomLists override — useful for "morph to a
        // specific form" by passing {MORPH_TARGETS: [chosenFormName]}.
        let saved = null;
        if (opts && opts.randomLists) {
            saved = this._randomLists;
            let merged = {};
            for (let k in saved) merged[k] = saved[k];
            for (let k in opts.randomLists) merged[k] = opts.randomLists[k];
            this._randomLists = merged;
        }
        let self = this;
        let wrappedDone = function() {
            if (saved) self._randomLists = saved;
            done();
        };
        if (script == null) { wrappedDone(); return; }
        this._run(this._normalize(script), wrappedDone);
    },

    listAnimations: function() {
        return Object.keys(this._animations);
    },

    _k: function(key) {
        return this._keyMap[key] || key;
    },

    _normalize: function(script) {
        return Array.isArray(script) ? script : [script];
    },

    _run: function(steps, then) {
        if (!steps || steps.length === 0) { then(); return; }
        let head = steps[0];
        let rest = steps.slice(1);
        let self = this;
        let nextStep = function() { self._run(rest, then); };
        this._execStep(head, nextStep);
    },

    _execStep: function(step, then) {
        let self = this;

        if (step.tween != null) {
            let key = step.tween;
            let target = this._scale(key, this._eval(step.to));
            this._addTween(this._k(key), target, step.ms, step.ease || "linear", then);
            return;
        }

        if (step.tween_many != null) {
            let entries = Object.keys(step.tween_many).map(function(k) {
                return [self._k(k), self._scale(k, self._eval(step.tween_many[k]))];
            });
            let ms = step.ms;
            let ease = step.ease || "linear";
            // Fire all tweens; last one carries the on_complete.
            for (let i = 0; i < entries.length - 1; i++) {
                this._addTween(entries[i][0], entries[i][1], ms, ease, null);
            }
            let last = entries[entries.length - 1];
            this._addTween(last[0], last[1], ms, ease, then);
            return;
        }

        if (step.delay != null) {
            this._timeoutAdd(step.delay, function() { then(); return false; });
            return;
        }

        if (step.set != null) {
            let assigns = step.set;
            // Two-pass: literals/random first so {ref:...} reads the new value.
            for (let k in assigns) {
                let v = assigns[k];
                if (v && typeof v === "object" && v.ref != null) continue;
                this._state[this._k(k)] = this._scale(k, this._eval(v));
            }
            for (let k in assigns) {
                let v = assigns[k];
                if (v && typeof v === "object" && v.ref != null) {
                    this._state[this._k(k)] = this._state[this._k(v.ref)];
                }
            }
            then();
            return;
        }

        if (step.repeat != null) {
            let n = step.repeat;
            let body = step.body;
            this._iterStack.push(0);
            let loop = function(i) {
                if (i >= n) {
                    self._iterStack.pop();
                    then();
                    return;
                }
                self._iterStack[self._iterStack.length - 1] = i;
                self._run(body.slice(), function() { loop(i + 1); });
            };
            loop(0);
            return;
        }

        if (step.sequence != null) {
            let seq = step.sequence;
            let key = seq.tween;
            let values = seq.values;
            let defaultMs = seq.ms;
            let defaultEase = seq.ease || "linear";
            let mappedKey = this._k(key);
            let chain = function(i) {
                if (i >= values.length) { then(); return; }
                let v = values[i];
                let target, ms, ease;
                if (v && typeof v === "object" && v.to != null) {
                    target = self._eval(v.to);
                    ms = (v.ms != null) ? v.ms : defaultMs;
                    ease = v.ease || defaultEase;
                } else {
                    target = self._eval(v);
                    ms = defaultMs;
                    ease = defaultEase;
                }
                self._addTween(mappedKey, self._scale(key, target), ms, ease,
                               function() { chain(i + 1); });
            };
            chain(0);
            return;
        }

        if (step.parallel != null) {
            let scripts = step.parallel;
            if (!scripts || scripts.length === 0) { then(); return; }
            let remaining = scripts.length;
            let eachDone = function() {
                remaining--;
                if (remaining === 0) then();
            };
            for (let i = 0; i < scripts.length; i++) {
                this._run(this._normalize(scripts[i]), eachDone);
            }
            return;
        }

        // Unknown — don't deadlock the chain.
        try { global.logError("Clawd anim_runner: unknown step " + JSON.stringify(step)); }
        catch (e) {}
        then();
    },

    _eval: function(v) {
        if (v == null || typeof v !== "object") return v;
        if (Array.isArray(v)) return v;
        if (v.random_pick != null) {
            let arr = v.random_pick;
            return arr[Math.floor(Math.random() * arr.length)];
        }
        if (v.random_from != null) {
            let arr = this._randomLists[v.random_from];
            return arr[Math.floor(Math.random() * arr.length)];
        }
        if (v.random_range != null) {
            let lo = v.random_range[0], hi = v.random_range[1];
            return lo + Math.random() * (hi - lo);
        }
        if (v.iter_pick != null) {
            if (this._iterStack.length === 0) return v.iter_pick[0];
            let idx = this._iterStack[this._iterStack.length - 1];
            return v.iter_pick[idx % v.iter_pick.length];
        }
        if (v.ref != null) return this._state[this._k(v.ref)];
        return v;
    },

    _scale: function(key, value) {
        if (this._intensityKeys[key] && typeof value === "number") {
            return value * this._intensityY;
        }
        return value;
    }
};
