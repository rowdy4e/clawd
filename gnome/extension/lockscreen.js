// Lock-screen Clawd: a self-contained mirror of the panel widget that
// attaches to Main.screenShield when the session locks and detaches on
// unlock. Adds two lock-screen-only flourishes:
//   • speech bubble with random short messages (mouth animates while text holds)
//   • rare "grow" easter egg — Clawd briefly fills the screen
// The visual data (FORMS / Tween / drawClawd) lives in clawd-core.js so
// the panel + lock screen never drift apart.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    FORMS, FORM_KEYS, MORPH_TARGETS, COLS, ROWS,
    Tween, drawClawd,
    easeOutQuad, easeInOutQuad, easeInOutCubic, easeOutBack, easeOutBounce,
} from './clawd-core.js';

const MESSAGES = [
    "git push --force?  yikes",
    "have you tried turning it off and on again?",
    "today: production. tomorrow: regret.",
    "cache invalidation, naming things, off-by-one",
    "rm -rf ~/regrets",
    "deploys at 4:55 pm hit different",
    "the bug is in the last place you'll look",
    "TODO: write more TODOs",
    "works on my machine 🤷",
    "premature optimization is the root of all caffeine",
    "i love deadlines. i love the whooshing sound they make",
    "wake me when the build is green",
    "trust me, i'm an engineer",
    "404: motivation not found",
    "if it compiles, ship it",
    "first try!  (just kidding, 47th try)",
    "the linter is always right (mostly)",
    "code is poetry. mine is haiku — short and confusing",
    "rebase early, rebase often",
    "AI didn't take my job, it gave me a co-author",
];

function pickMessage() {
    return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

// State factory — same shape as the panel widget's _s
function makeState() {
    return {
        bodyX: 0, bodyY: 0,
        scaleX: 1, scaleY: 1,
        tilt: 0,
        eyeOpen: 1,
        eyeState: 'normal',
        mouthVisible: 0,
        mouthShape: 0,
        walkPhase: 0, walking: 0,
        excited: 0,
        formA: 'clawd', formB: 'clawd',
        morphT: 0,
        breathT: 0,
    };
}

// ─── LockClawd ───
export const LockClawd = GObject.registerClass(
class LockClawd extends St.DrawingArea {
    _init(monitor) {
        // Sized to fit inside the clock BoxLayout below the date.
        // Square cells: with the shared grid now at ROWS=12 (was 6), this
        // keeps the icon at the same physical size as the original.
        const targetBodyW = Math.floor(monitor.width * 0.12);
        const xUnit = Math.max(6, Math.floor(targetBodyW / COLS));
        const yUnit = xUnit;
        const padX = 2 * xUnit;
        const padY = 2 * yUnit;
        const bodyW = xUnit * COLS;
        const bodyH = yUnit * ROWS;
        const canvasW = bodyW + 2 * padX;
        const canvasH = bodyH + 2 * padY;

        // Inside a BoxLayout these (x,y) are ignored; included for safety
        const cx = 0, cy = 0;

        super._init({
            width: canvasW,
            height: canvasH,
            x: cx,
            y: cy,
            reactive: false,
            can_focus: false,
            track_hover: false,
            opacity: 255,
        });
        log(`[clawd] LockClawd._init w=${canvasW} h=${canvasH} x=${cx} y=${cy} (monitor ${monitor.width}x${monitor.height} @ ${monitor.x},${monitor.y})`);

        this._xUnit = xUnit;
        this._yUnit = yUnit;
        this._canvasW = canvasW;
        this._canvasH = canvasH;
        this._fixedX = cx;
        this._fixedY = cy;
        this.connect('repaint', this._draw.bind(this));

        // State
        this._s = makeState();
        this._tweens = [];
        this._animBusy = false;
        this._breathStart = null;

        // Speech bubble state
        this._bubbleText = pickMessage();
        this._bubbleAlpha = 0;
        this._bubbleStart = GLib.get_monotonic_time() / 1000;
        this._talkingUntil = 0; // ms timestamp; mouth animates while > now

        // Animation loop
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        // Periodic schedules
        this._blinkId = null;
        this._idleId = null;
        this._scheduleBlink();
        this._scheduleIdle();
    }

    destroy() {
        for (const id of [this._tickId, this._blinkId, this._idleId]) {
            if (id) try { GLib.source_remove(id); } catch (e) {}
        }
        this._tickId = this._blinkId = this._idleId = null;
        super.destroy();
    }

    // Force preferred size so layout-managed parents (e.g. modalDialogGroup)
    // can't crush us. Both min and natural return canvas dims.
    vfunc_get_preferred_width(_forHeight) {
        return [this._canvasW, this._canvasW];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [this._canvasH, this._canvasH];
    }

    // ─── Tick: tweens, breath, bubble cycle ───
    _tick() {
        const s = this._s;
        const now = GLib.get_monotonic_time() / 1000;

        if (this._breathStart == null) this._breathStart = now;
        const phase = ((now - this._breathStart) % 4000) / 4000;
        s.breathT = (1 - Math.cos(phase * 2 * Math.PI)) / 2;

        for (const tw of [...this._tweens]) tw.step(33);
        this._tweens = this._tweens.filter(tw => !tw.done);

        // Bubble cycle: 4000 ms period
        //   0–500    fade in
        //   500–3000 hold (mouth animates first 2 s)
        //   3000–3500 fade out
        //   3500–4000 swap text
        const bp = (now - this._bubbleStart) % 4000;
        if (bp < 500)        this._bubbleAlpha = bp / 500;
        else if (bp < 3000)  this._bubbleAlpha = 1;
        else if (bp < 3500)  this._bubbleAlpha = 1 - (bp - 3000) / 500;
        else                 this._bubbleAlpha = 0;
        if (bp >= 3500 && !this._swapped) {
            this._bubbleText = pickMessage();
            this._swapped = true;
        } else if (bp < 3500) {
            this._swapped = false;
        }

        // Talking mouth: open/close while bubble first 2 s
        if (bp < 2000) {
            const open = (Math.floor(now / 120) % 2 === 0) ? 1 : 0.3;
            s.mouthVisible = open * this._bubbleAlpha;
            s.mouthShape = 0;
        } else if (!this._animBusy) {
            s.mouthVisible *= 0.85;
        }

        this.queue_repaint();
    }

    _addTween(key, target, dur, easing, onComplete) {
        const t = new Tween(this._s, key, target, dur, easing, onComplete);
        this._tweens.push(t);
        return t;
    }

    // ─── Draw: Clawd + bubble ───
    _draw(area) {
        const cr = (area || this).get_context();
        const [w, h] = (area || this).get_surface_size();

        // DIAG: log first few paints so we know _draw fires when locked
        this._paintCount = (this._paintCount || 0) + 1;
        if (this._paintCount <= 3 || this._paintCount % 60 === 0) {
            log(`[clawd] _draw #${this._paintCount} surface=${w}x${h} mapped=${this.mapped} visible=${this.visible} opacity=${this.opacity}`);
        }

        // DIAG NUCLEAR: solid OPAQUE red full-screen — covers everything
        cr.setSourceRGBA(1, 0, 0, 1);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // DIAG: bright neon green border around full screen edges
        cr.setSourceRGBA(0, 1, 0, 1);
        cr.setLineWidth(20);
        cr.rectangle(10, 10, w - 20, h - 20);
        cr.stroke();

        // DIAG: huge "X" diagonal lines in bright yellow to confirm canvas size
        cr.setSourceRGBA(1, 1, 0, 1);
        cr.setLineWidth(15);
        cr.moveTo(0, 0);     cr.lineTo(w, h); cr.stroke();
        cr.moveTo(w, 0);     cr.lineTo(0, h); cr.stroke();

        if (this._bubbleAlpha > 0.02) {
            this._drawBubble(cr, w);
        }

        drawClawd(Cairo, cr, w, h, this._s, this._xUnit, this._yUnit);
        cr.$dispose();
    }

    _drawBubble(cr, canvasW) {
        const text = this._bubbleText;
        const layout = PangoCairo.create_layout(cr);
        const fontSize = Math.max(11, Math.floor(this._yUnit * 0.5));
        const fd = Pango.FontDescription.from_string(`Sans ${fontSize}`);
        layout.set_font_description(fd);
        layout.set_alignment(Pango.Alignment.LEFT);
        layout.set_text(text, -1);
        const [ink, _logical] = layout.get_pixel_extents();
        const tw = ink.width;
        const th = ink.height;

        const padX = Math.floor(fontSize * 0.8);
        const padY = Math.floor(fontSize * 0.5);
        const bubW = tw + 2 * padX;
        const bubH = th + 2 * padY;
        const radius = Math.min(14, Math.floor(bubH / 2));

        // Position above Clawd, centered horizontally over canvas
        const bx = Math.floor((canvasW - bubW) / 2);
        const by = Math.floor(this._canvasH * 0.2);

        const a = this._bubbleAlpha;

        // Shadow
        cr.setSourceRGBA(0, 0, 0, 0.35 * a);
        this._roundRect(cr, bx + 2, by + 3, bubW, bubH, radius);
        cr.fill();

        // Bubble bg
        cr.setSourceRGBA(0.98, 0.98, 0.99, 0.95 * a);
        this._roundRect(cr, bx, by, bubW, bubH, radius);
        cr.fill();

        // Tail (triangle pointing down toward Clawd)
        const tipX = bx + Math.floor(bubW / 2);
        const tipY = by + bubH;
        const tailW = Math.floor(bubH * 0.35);
        const tailH = Math.floor(bubH * 0.35);
        cr.setSourceRGBA(0.98, 0.98, 0.99, 0.95 * a);
        cr.moveTo(tipX - tailW, tipY - 1);
        cr.lineTo(tipX, tipY + tailH);
        cr.lineTo(tipX + tailW, tipY - 1);
        cr.closePath();
        cr.fill();

        // Border
        cr.setSourceRGBA(0.20, 0.22, 0.30, 0.85 * a);
        cr.setLineWidth(1.5);
        this._roundRect(cr, bx + 0.5, by + 0.5, bubW - 1, bubH - 1, radius);
        cr.stroke();

        // Text
        cr.setSourceRGBA(0.10, 0.10, 0.14, a);
        cr.moveTo(bx + padX - ink.x, by + padY - ink.y);
        PangoCairo.show_layout(cr, layout);
    }

    _roundRect(cr, x, y, w, h, r) {
        const PI = Math.PI;
        cr.newSubPath();
        cr.arc(x + w - r, y + r,           r, -0.5 * PI, 0);
        cr.arc(x + w - r, y + h - r,       r, 0, 0.5 * PI);
        cr.arc(x + r,     y + h - r,       r, 0.5 * PI, PI);
        cr.arc(x + r,     y + r,           r, PI, 1.5 * PI);
        cr.closePath();
    }

    // ─── Blink / idle / grow ───
    _scheduleBlink() {
        const delay = 4 + Math.floor(Math.random() * 6);
        this._blinkId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._addTween('eyeOpen', 0, 80, easeOutQuad, () => {
                this._addTween('eyeOpen', 1, 120, easeOutQuad);
            });
            this._blinkId = null;
            this._scheduleBlink();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleIdle() {
        const delay = 6 + Math.floor(Math.random() * 8);
        this._idleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            if (!this._animBusy) {
                // 4% chance of "grow" easter egg
                if (Math.random() < 0.04) this._anim_grow();
                else this._playRandom();
            }
            this._idleId = null;
            this._scheduleIdle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _animDone() { this._animBusy = false; }

    _playRandom() {
        const list = ['bounce','wiggle','squish','shake','tilt','walk',
                      'excited','morph','glitch','wink','yawn','lookAround'];
        const name = list[Math.floor(Math.random() * list.length)];
        const fn = this[`_anim_${name}`];
        if (typeof fn === 'function') {
            this._animBusy = true;
            fn.call(this);
        }
    }

    _anim_grow() {
        this._animBusy = true;
        // Scale to 3x with a back-out easing, hold, then bounce back
        this._addTween('scaleX', 3, 600, easeOutBack);
        this._addTween('scaleY', 3, 600, easeOutBack, () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2200, () => {
                this._addTween('scaleX', 1, 700, easeOutBounce);
                this._addTween('scaleY', 1, 700, easeOutBounce, () => this._animDone());
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _anim_bounce() {
        this._addTween('bodyY', -12, 220, easeOutQuad, () => {
            this._addTween('bodyY', 0, 400, easeOutBounce, () => this._animDone());
        });
    }
    _anim_wiggle() {
        const seq = [12, -12, 8, -8, 0];
        const chain = (i) => {
            if (i >= seq.length) { this._animDone(); return; }
            this._addTween('tilt', seq[i], 110, easeInOutQuad, () => chain(i+1));
        };
        chain(0);
    }
    _anim_squish() {
        this._addTween('scaleY', 0.55, 140, easeOutQuad);
        this._addTween('scaleX', 1.4, 140, easeOutQuad, () => {
            this._addTween('scaleY', 1, 320, easeOutBounce);
            this._addTween('scaleX', 1, 320, easeOutBounce, () => this._animDone());
        });
    }
    _anim_shake() {
        const seq = [6,-6,5,-5,3,-3,0];
        const chain = (i) => {
            if (i >= seq.length) { this._animDone(); return; }
            this._addTween('bodyX', seq[i], 55, null, () => chain(i+1));
        };
        chain(0);
    }
    _anim_tilt() {
        this._addTween('tilt', 14, 220, easeOutQuad, () => {
            this._addTween('tilt', 0, 400, easeOutBounce, () => this._animDone());
        });
    }
    _anim_walk() {
        const s = this._s;
        s.walking = 1; s.walkPhase = 0;
        const steps = 6;
        const stepDur = 220;
        let i = 0;
        const tick = () => {
            if (i >= steps) {
                s.walking = 0;
                this._addTween('bodyX', 0, 280, easeInOutQuad, () => this._animDone());
                return GLib.SOURCE_REMOVE;
            }
            s.walkPhase = (i % 2) ? 0.75 : 0.25;
            this._addTween('bodyX', (i+1) * 4 - 12, stepDur, easeInOutQuad);
            i++;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, stepDur, tick);
            return GLib.SOURCE_REMOVE;
        };
        tick();
    }
    _anim_excited() {
        this._addTween('excited', 1, 200, easeOutQuad);
        const steps = [-4, 4, -3, 3, -2, 2, 0];
        const chain = (i) => {
            if (i >= steps.length) {
                this._addTween('excited', 0, 300);
                this._animDone(); return;
            }
            this._addTween('bodyX', steps[i], 50, null, () => chain(i+1));
        };
        chain(0);
    }
    _anim_morph() {
        const s = this._s;
        s.formA = 'clawd';
        s.formB = MORPH_TARGETS[Math.floor(Math.random() * MORPH_TARGETS.length)];
        s.morphT = 0;
        this._addTween('morphT', 1, 600, easeInOutQuad, () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
                this._addTween('morphT', 0, 500, easeInOutQuad, () => {
                    s.formB = 'clawd';
                    this._animDone();
                });
                return GLib.SOURCE_REMOVE;
            });
        });
    }
    _anim_glitch() {
        const s = this._s;
        let i = 0;
        const tick = () => {
            if (i >= 6) {
                s.formA = 'clawd'; s.formB = 'clawd'; s.morphT = 0; s.bodyX = 0;
                this._animDone();
                return GLib.SOURCE_REMOVE;
            }
            const pick = MORPH_TARGETS[Math.floor(Math.random() * MORPH_TARGETS.length)];
            s.formA = pick; s.formB = pick; s.morphT = 0;
            s.bodyX = (Math.random() * 6 - 3);
            i++;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, tick);
            return GLib.SOURCE_REMOVE;
        };
        tick();
    }
    _anim_wink() {
        this._s.eyeState = Math.random() < 0.5 ? 'wink-l' : 'wink-r';
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._s.eyeState = 'normal';
            this._animDone();
            return GLib.SOURCE_REMOVE;
        });
    }
    _anim_yawn() {
        const s = this._s;
        s.eyeState = 'sleepy';
        s.mouthShape = 1;
        this._addTween('mouthVisible', 1, 250, easeOutQuad);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            this._addTween('mouthVisible', 0, 300, easeOutQuad, () => {
                s.eyeState = 'normal'; s.mouthShape = 0;
                this._animDone();
            });
            return GLib.SOURCE_REMOVE;
        });
    }
    _anim_lookAround() {
        const dir = Math.random() < 0.5 ? -1 : 1;
        this._addTween('tilt', dir * 8, 250, easeOutQuad, () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._addTween('tilt', -dir * 8, 350, easeInOutQuad, () => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                        this._addTween('tilt', 0, 250, easeOutQuad, () => this._animDone());
                        return GLib.SOURCE_REMOVE;
                    });
                });
                return GLib.SOURCE_REMOVE;
            });
        });
    }
});

// ─── Manager — owns the lifecycle ───
// Strategy: parent the widget under Main.layoutManager.uiGroup once at enable
// time, then toggle visibility based on Main.screenShield.active. This is
// more reliable than parenting under screenShieldGroup, whose visibility
// rules have shifted across GNOME versions.
export class LockClawdManager {
    constructor(settings) {
        this._settings = settings;
        this._widget = null;
        this._handlerIds = [];
        this._enabled = false;
    }

    enable() {
        if (this._enabled) return;
        this._enabled = true;
        const shield = Main.screenShield;
        log(`[clawd] LockClawdManager.enable; screenShield=${!!shield} active=${shield ? shield.active : '?'}`);
        if (!shield) return;

        // Belt + suspenders: subscribe to every signal that could indicate a
        // shield state change. GNOME 50 doesn't emit notify::active reliably
        // around unlock; unlock-complete is the canonical "fully unlocked".
        for (const sig of [
            'notify::active',
            'notify::locked',
            'active-changed',
            'lock-status-changed',
            'unlock-complete',
            'lock-screen-shown',
            'wake-up-screen',
        ]) {
            try {
                const id = shield.connect(sig, () => this._sync());
                this._handlerIds.push([shield, id]);
            } catch (e) {}
        }
        // Safety net: poll every 500ms — cheap, ensures we hide if every
        // signal somehow misses.
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
        try {
            const id = this._settings.connect('changed::lockscreen-enabled', () => this._sync());
            this._handlerIds.push([this._settings, id]);
        } catch (e) {}

        // Create widget once, keep it parked invisible until lock.
        this._createWidget();
        this._sync();
    }

    disable() {
        if (!this._enabled) return;
        this._enabled = false;
        if (this._pollId) {
            try { GLib.source_remove(this._pollId); } catch (e) {}
            this._pollId = null;
        }
        for (const [obj, id] of this._handlerIds) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._handlerIds = [];
        this._destroyWidget();
    }

    // GNOME 50 trick: lockscreen renders via a compositor path that bypasses
    // most Clutter actors — even uiGroup top chrome is invisible. The ONLY
    // way found to be visible is to inject INSIDE the live unlock dialog's
    // own visible widgets. _dialog._clock is the BoxLayout (vertical) that
    // contains the time/date/hint labels — adding our widget as a child
    // appends us below those, perfectly visible on the lockscreen.
    _candidates() {
        const shield = Main.screenShield;
        const dialog = shield && shield._dialog;
        const clock  = dialog && dialog._clock;
        const stack  = dialog && dialog._stack;
        return [
            ['shield._dialog._clock',           clock],
            ['shield._dialog._stack',           stack],
            ['shield._dialog',                  dialog],
            ['shield._lockDialogGroup',         shield && shield._lockDialogGroup],
            ['shield._lockScreenGroup',         shield && shield._lockScreenGroup],
            ['layoutManager.screenShieldGroup', Main.layoutManager.screenShieldGroup],
            ['global.stage',                    global.stage],
        ];
    }

    _logCandidates(tag) {
        for (const [name, obj] of this._candidates()) {
            if (!obj) { log(`[clawd] ${tag} ${name}: MISSING`); continue; }
            const m = obj.mapped, v = obj.visible, op = obj.opacity;
            const can = typeof obj.add_child === 'function';
            log(`[clawd] ${tag} ${name}: addChild=${can} mapped=${m} visible=${v} opacity=${op}`);
        }
    }

    _pickMappedParent() {
        for (const [name, obj] of this._candidates()) {
            if (obj && typeof obj.add_child === 'function' && obj.mapped && obj.visible) {
                return [name, obj];
            }
        }
        return [null, null];
    }

    _pickAnyParent() {
        for (const [name, obj] of this._candidates()) {
            if (obj && typeof obj.add_child === 'function') return [name, obj];
        }
        return [null, null];
    }

    _createWidget() {
        try {
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor) { log('[clawd] no primary monitor'); return; }
            this._widget = new LockClawd(monitor);
            this._widget.visible = false;
            // Initial: park under any available container. We'll reparent at
            // lock time to the live UnlockDialog clock BoxLayout.
            const [name, parent] = this._pickAnyParent();
            if (!parent) { log('[clawd] no usable parent at create time'); return; }
            parent.add_child(this._widget);
            this._parent = parent;
            log(`[clawd] LockClawd parked under ${name}`);
        } catch (e) {
            logError(e, 'LockClawdManager._createWidget');
        }
    }

    _destroyWidget() {
        if (!this._widget) return;
        try { this._widget.destroy(); } catch (e) {}
        this._widget = null;
        this._parent = null;
    }

    _reparentIfNeeded() {
        const w = this._widget;
        if (!w) return;
        const [name, parent] = this._pickMappedParent();
        if (!parent) {
            log('[clawd] _reparent: no mapped parent currently');
            return;
        }
        if (parent === this._parent) {
            log(`[clawd] _reparent: keep ${name} (already mapped)`);
            return;
        }
        try {
            const cur = w.get_parent();
            if (cur && typeof cur.remove_child === 'function') {
                cur.remove_child(w);
            }
            parent.add_child(w);
            this._parent = parent;
            log(`[clawd] _reparent -> ${name} mapped=${parent.mapped} visible=${parent.visible}`);
        } catch (e) {
            logError(e, 'LockClawdManager._reparentIfNeeded');
        }
    }

    _sync() {
        const shield = Main.screenShield;
        if (!shield || !this._widget) return;
        const enabled = this._settings.get_boolean('lockscreen-enabled');
        // GNOME 50: 'active' flickers off ~100 ms into lock when unlock prompt
        // takes over. 'locked' stays true for the whole lock cycle until the
        // user enters their password. Trigger on locked so the widget is
        // visible through both phases.
        const want = enabled && (shield.locked || shield.active);
        // Throttle logs once we've seen state stable
        if (this._lastWant !== want || (this._syncLogCount = (this._syncLogCount || 0) + 1) <= 4) {
            log(`[clawd] _sync: enabled=${enabled} active=${shield.active} locked=${shield.locked} want=${want}`);
            this._lastWant = want;
        }
        if (!want) {
            if (this._wasWant) {
                log('[clawd] _sync: hiding widget (want -> false)');
                this._wasWant = false;
            }
            this._widget.hide();
            return;
        }
        const wasWant = this._wasWant;
        this._wasWant = true;
        if (!wasWant) this._logCandidates('cand');
        this._reparentIfNeeded();
        this._widget.show();
        this._widget.opacity = 255;
        // Force position every sync — defensive against layout managers that
        // might reposition children. set_position works on St.Widget directly.
        try {
            if (typeof this._widget.set_position === 'function') {
                this._widget.set_position(this._widget._fixedX, this._widget._fixedY);
            }
            if (typeof this._widget.set_size === 'function') {
                this._widget.set_size(this._widget._canvasW, this._widget._canvasH);
            }
        } catch (e) {}
        try {
            if (this._parent && typeof this._parent.set_child_above_sibling === 'function') {
                this._parent.set_child_above_sibling(this._widget, null);
            }
        } catch (e) {}
        // Belt + suspenders for z-order: set 3D z_position high enough to be
        // drawn above siblings regardless of paint order. Clutter respects
        // z_position during paint depth-sorting.
        try {
            this._widget.z_position = 9999;
            if (typeof this._widget.set_pivot_point === 'function') {
                this._widget.set_pivot_point(0.5, 0.5);
            }
        } catch (e) {}
        // Diagnostic: log child indices to verify our paint position.
        if (!wasWant) {
            try {
                const stage = global.stage;
                const sChildren = stage.get_children();
                const wIdx = sChildren.indexOf(this._widget);
                let shieldIdx = -1;
                if (Main.layoutManager.screenShieldGroup) {
                    shieldIdx = sChildren.indexOf(Main.layoutManager.screenShieldGroup);
                }
                log(`[clawd] stage: ${sChildren.length} children, widget@${wIdx}, shieldGroup@${shieldIdx}, z_position=${this._widget.z_position}`);
                // Dump last few siblings (the high z-order range)
                const tail = sChildren.slice(Math.max(0, sChildren.length - 5));
                tail.forEach((ch, i) => {
                    const idx = sChildren.length - tail.length + i;
                    const cls = ch.constructor && ch.constructor.$gtype ? ch.constructor.$gtype.name : 'unknown';
                    log(`[clawd] stage[${idx}]: ${cls} mapped=${ch.mapped} visible=${ch.visible} opacity=${ch.opacity}`);
                });
                // Also dump uiGroup children — find our index + what's above us
                const ug = Main.layoutManager.uiGroup;
                if (ug) {
                    const uChildren = ug.get_children();
                    const uwIdx = uChildren.indexOf(this._widget);
                    log(`[clawd] uiGroup: ${uChildren.length} children, widget@${uwIdx}`);
                    // Anything ABOVE us (drawn on top) is concerning
                    const above = uChildren.slice(uwIdx + 1);
                    if (above.length > 0) {
                        log(`[clawd] ${above.length} child(ren) ABOVE widget in uiGroup:`);
                        above.forEach((ch, i) => {
                            const idx = uwIdx + 1 + i;
                            const cls = ch.constructor && ch.constructor.$gtype ? ch.constructor.$gtype.name : 'unknown';
                            log(`[clawd] uiGroup[${idx}]: ${cls} name=${ch.name || '?'} mapped=${ch.mapped} visible=${ch.visible} opacity=${ch.opacity}`);
                        });
                    } else {
                        log('[clawd] widget is LAST child of uiGroup (top z-order)');
                    }
                }
            } catch (e) { logError(e, '_sync stage diag'); }
        }
        if (!wasWant) {
            try {
                const p = this._parent;
                const w = this._widget;
                const box = w.get_allocation_box ? w.get_allocation_box() : null;
                log(`[clawd] _sync post-show: widget mapped=${w.mapped} visible=${w.visible} opacity=${w.opacity} alloc=${box ? `${box.x1.toFixed(0)},${box.y1.toFixed(0)}->${box.x2.toFixed(0)},${box.y2.toFixed(0)}` : 'n/a'}`);
                if (p) {
                    log(`[clawd] _sync parent: ${p.constructor && p.constructor.$gtype ? p.constructor.$gtype.name : 'unknown'} mapped=${p.mapped} visible=${p.visible} opacity=${p.opacity}`);
                }
            } catch (e) { logError(e, '_sync diag'); }
        }
        this._widget.queue_redraw && this._widget.queue_redraw();
        this._widget.queue_repaint && this._widget.queue_repaint();
    }
}
