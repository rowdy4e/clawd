// Animation interpreter for Clawd (GNOME Shell 42–44 legacy side).
// Mirror of gnome/extension/anim_runner.js — identical logic; only the
// module boilerplate differs (var instead of ESM export) so GJS's legacy
// `imports` system exposes it as Me.imports.anim_runner.AnimationRunner.
// Reads animations.json (the shared DSL) and drives a host-supplied
// addTween(key, target, durMs, easing, onComplete).

var AnimationRunner = class AnimationRunner {
    constructor(opts) {
        this._state = opts.state;
        this._addTween = opts.addTween;
        this._timeoutAdd = opts.timeoutAdd; // (ms, fn) -> id  (GLib.timeout_add)
        this._randomLists = opts.randomLists || {};
        this._intensityY = (opts.intensityY != null) ? opts.intensityY : 1.0;
        // keyMap maps DSL snake_case names to host state keys.
        this._keyMap = opts.keyMap || {};
        this._animations = (opts.animationsJson && opts.animationsJson.animations) || {};
        let keys = (opts.animationsJson && opts.animationsJson.intensity_y_keys) || ["body_y"];
        this._intensityKeys = {};
        for (let i = 0; i < keys.length; i++) this._intensityKeys[keys[i]] = true;
        this._iterStack = [];
    }

    play(name, onComplete, opts) {
        let script = this._animations[name];
        let done = onComplete || (() => {});
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
        let wrappedDone = () => {
            if (saved) this._randomLists = saved;
            done();
        };
        if (script == null) { wrappedDone(); return; }
        this._run(this._normalize(script), wrappedDone);
    }

    listAnimations() {
        return Object.keys(this._animations);
    }

    _k(key) {
        return this._keyMap[key] || key;
    }

    _normalize(script) {
        return Array.isArray(script) ? script : [script];
    }

    _run(steps, then) {
        if (!steps || steps.length === 0) { then(); return; }
        let head = steps[0];
        let rest = steps.slice(1);
        this._execStep(head, () => this._run(rest, then));
    }

    _execStep(step, then) {
        if (step.tween != null) {
            let key = step.tween;
            let target = this._scale(key, this._eval(step.to));
            this._addTween(this._k(key), target, step.ms, step.ease || "linear", then);
            return;
        }

        if (step.tween_many != null) {
            let entries = Object.keys(step.tween_many).map(k =>
                [this._k(k), this._scale(k, this._eval(step.tween_many[k]))]);
            let ms = step.ms;
            let ease = step.ease || "linear";
            for (let i = 0; i < entries.length - 1; i++) {
                this._addTween(entries[i][0], entries[i][1], ms, ease, null);
            }
            let last = entries[entries.length - 1];
            this._addTween(last[0], last[1], ms, ease, then);
            return;
        }

        if (step.delay != null) {
            this._timeoutAdd(step.delay, () => { then(); return false; });
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
            let loop = (i) => {
                if (i >= n) {
                    this._iterStack.pop();
                    then();
                    return;
                }
                this._iterStack[this._iterStack.length - 1] = i;
                this._run(body.slice(), () => loop(i + 1));
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
            let chain = (i) => {
                if (i >= values.length) { then(); return; }
                let v = values[i];
                let target, ms, ease;
                if (v && typeof v === "object" && v.to != null) {
                    target = this._eval(v.to);
                    ms = (v.ms != null) ? v.ms : defaultMs;
                    ease = v.ease || defaultEase;
                } else {
                    target = this._eval(v);
                    ms = defaultMs;
                    ease = defaultEase;
                }
                this._addTween(mappedKey, this._scale(key, target), ms, ease,
                               () => chain(i + 1));
            };
            chain(0);
            return;
        }

        if (step.parallel != null) {
            let scripts = step.parallel;
            if (!scripts || scripts.length === 0) { then(); return; }
            let remaining = scripts.length;
            let eachDone = () => {
                remaining--;
                if (remaining === 0) then();
            };
            for (let i = 0; i < scripts.length; i++) {
                this._run(this._normalize(scripts[i]), eachDone);
            }
            return;
        }

        // Unknown — don't deadlock the chain.
        try { logError(new Error("Clawd anim_runner: unknown step " + JSON.stringify(step))); }
        catch (e) {}
        then();
    }

    _eval(v) {
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
    }

    _scale(key, value) {
        if (this._intensityKeys[key] && typeof value === "number") {
            return value * this._intensityY;
        }
        return value;
    }
};
