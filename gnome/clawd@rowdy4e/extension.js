// Clawd — Claude Code usage. GNOME Shell extension port of the Cinnamon
// applet. Targets GNOME 45+ (ESM imports, Extension base class).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ─── Pixel art forms ───
const FORMS = {
    clawd: { color: [0.85, 0.47, 0.34], pixels: [
        "...OOOOOOOOOOOO...",
        "...OOEOOOOOOEOO...",
        ".OOOOOOOOOOOOOOOO.",
        "...OOOOOOOOOOOO...",
        "....F.F....F.F....",
        ".................."
    ]},
    heart:   { color: [0.93, 0.27, 0.49], pixels: [
        "..................","....OOO....OOO....","...OOOOOOOOOOOO...",
        "....OOOOOOOOOO....",".....OOOOOOOO.....","......OOOOOO......"
    ]},
    ghost:   { color: [0.88, 0.90, 0.96], pixels: [
        ".....OOOOOOOO.....","....OOOOOOOOOO....","...OOEOOOOOOEOO...",
        "...OOOOOOOOOOOO...","...OOOOOOOOOOOO...","...O.OO.OO.OO.O..."
    ]},
    octopus: { color: [0.62, 0.40, 0.85], pixels: [
        "....OOOOOOOO......","...OOOOOOOOOO.....","..OOEOOOOOOEOO....",
        "...OOOOOOOOOO.....","..O.O.O.O.O.O.O...","...O.O.O.O.O.O...."
    ]},
    sparkle: { color: [0.98, 0.78, 0.18], pixels: [
        "........OO........",".....OOOOOOOO.....",".OOOOOOOOOOOOOOOO.",
        ".OOOOOOOOOOOOOOOO.",".....OOOOOOOO.....","........OO........"
    ]},
    blob:    { color: [0.35, 0.82, 0.45], pixels: [
        "..................","....OOOOOOOOOO....","..OOOOOOOOOOOOOO..",
        "..OOOOOOOOOOOOOO..","...OOOOOOOOOOOO...","..................",
    ]},
    pacman:  { color: [0.98, 0.85, 0.10], pixels: [
        ".....OOOOOOOOO....","....OOOOOOOOOOO...","...OOOOOOOO.......",
        "...OOOOOO.........","...OOOOOOOO.......","....OOOOOOOOOOO..."
    ]},
    invader: { color: [0.30, 0.90, 0.40], pixels: [
        "....O......O......",".....OOOOOOOO.....","....OOOOOOOOOO....",
        "...OO.OOOO.OO.....","...OOOOOOOOOO.....","....O.OOOO.O......"
    ]},
    crown:   { color: [0.96, 0.80, 0.20], pixels: [
        "..O..O..O..O..O...","..O..O..O..O..O...","..OOOOOOOOOOOOOO..",
        "..OOOOOOOOOOOOOO..","..OOOOOOOOOOOOOO..","..................",
    ]},
    skull:   { color: [0.92, 0.92, 0.95], pixels: [
        ".....OOOOOOOO.....","....OOOOOOOOOO....","....OO.OOOO.OO....",
        ".....OOOOOOOO.....","......OOOOOO......","......O.O.O.O....."
    ]},
};
const FORM_KEYS = Object.keys(FORMS);
const MORPH_TARGETS = FORM_KEYS.filter(k => k !== "clawd");

// Pre-compile cells
for (const key of FORM_KEYS) {
    const f = FORMS[key];
    f.bodyCells = [];
    f.footCells = [];
    for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 18; col++) {
            const ch = f.pixels[row][col];
            if (ch === '.') continue;
            (row < 4 ? f.bodyCells : f.footCells).push([row, col, ch]);
        }
    }
}

const COLS = 18;
const ROWS = 6;

const COLOR_OK   = [0.388, 0.400, 0.945];
const COLOR_WARN = [0.961, 0.620, 0.043];
const COLOR_CRIT = [0.937, 0.267, 0.267];
const COLOR_TRACK = [1.0, 1.0, 1.0, 0.18];

// ─── Simple tween system (no Tweener dep) ───
class Tween {
    constructor(obj, key, target, duration_ms, easing, onComplete) {
        this.obj = obj;
        this.key = key;
        this.start = obj[key];
        this.target = target;
        this.duration = Math.max(1, duration_ms);
        this.elapsed = 0;
        this.easing = easing || (t => t);
        this.onComplete = onComplete;
        this.done = false;
    }
    step(dt) {
        if (this.done) return;
        this.elapsed += dt;
        const t = Math.min(1.0, this.elapsed / this.duration);
        this.obj[this.key] = this.start + (this.target - this.start) * this.easing(t);
        if (t >= 1.0) {
            this.done = true;
            if (this.onComplete) try { this.onComplete(); } catch (e) { logError(e); }
        }
    }
}

const easeOutQuad = t => 1 - (1 - t) ** 2;
const easeInOutQuad = t => t < 0.5 ? 2*t*t : 1 - ((-2*t+2) ** 2) / 2;
const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - ((-2*t+2) ** 3) / 2;
const easeOutBack = t => 1 + 2.70158 * (t-1)**3 + 1.70158 * (t-1)**2;
const easeOutBounce = t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1/d1) return n1*t*t;
    if (t < 2/d1) { t -= 1.5/d1; return n1*t*t + 0.75; }
    if (t < 2.5/d1) { t -= 2.25/d1; return n1*t*t + 0.9375; }
    t -= 2.625/d1; return n1*t*t + 0.984375;
};

// ─── ClawdIndicator (panel button) ───
const ClawdIndicator = GObject.registerClass(
class ClawdIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Clawd');
        this._extension = extension;
        this._panelHeight = Main.panel.height || 28;

        // Pixel grid sized to panel
        const yUnit = Math.max(2, Math.floor((this._panelHeight - 4) / ROWS));
        const xUnit = Math.max(1, Math.floor(yUnit / 2));
        const padX = 4 * xUnit;
        const canvasH = yUnit * ROWS;
        const canvasW = xUnit * COLS + 2 * padX;
        this._xUnit = xUnit;
        this._yUnit = yUnit;

        this._clawd = new St.DrawingArea({
            width: canvasW,
            height: canvasH,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clawd.connect('repaint', this._drawClawd.bind(this));
        this.add_child(this._clawd);

        // Animation state
        this._s = {
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

        this._tweens = [];
        this._animBusy = false;
        this._tickId = null;
        this._idleId = null;
        this._blinkId = null;
        this._refreshId = null;
        this._breathStart = null;

        // Usage state
        this._lastUsage = null;
        this._lastError = null;
        this._lastUpdated = 0;
        this._rateLimitedUntil = 0;
        this._backoffSeconds = 0;

        // Path to fetch script (uses extension dir)
        const dir = extension.path;
        this._fetchScript = `${dir}/fetch-usage.sh`;

        // Animation loop: 33 ms tick advances tweens + breath
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });

        // Periodic schedules
        this._scheduleBlink();
        this._scheduleIdle();
        this._scheduleRefresh();

        // Build popup menu
        this._buildMenu();

        // Initial fetch
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─── Animation tick ───
    _onTick() {
        try {
            const s = this._s;
            const now = GLib.get_monotonic_time() / 1000;
            if (this._breathStart == null) this._breathStart = now;
            const phase = ((now - this._breathStart) % 4000) / 4000;
            s.breathT = (1 - Math.cos(phase * 2 * Math.PI)) / 2;

            // Advance tweens
            for (const tw of [...this._tweens]) tw.step(33);
            this._tweens = this._tweens.filter(tw => !tw.done);

            this._clawd.queue_repaint();
        } catch (e) {
            logError(e, 'Clawd tick');
        }
    }

    _addTween(key, target, dur, easing, onComplete) {
        this._tweens = this._tweens.filter(t => t.key !== key);
        this._tweens.push(new Tween(this._s, key, target, dur, easing, onComplete));
    }

    _resetMotion() {
        const s = this._s;
        this._tweens = this._tweens.filter(t =>
            !['bodyX','bodyY','tilt','scaleX','scaleY','walking','walkPhase',
              'excited','morphT','mouthVisible'].includes(t.key));
        s.bodyX = 0; s.bodyY = 0; s.tilt = 0;
        s.scaleX = 1; s.scaleY = 1;
        s.walking = 0; s.walkPhase = 0;
        s.excited = 0; s.morphT = 0;
        s.formA = 'clawd'; s.formB = 'clawd';
        s.mouthVisible = 0; s.mouthShape = 0;
        s.eyeState = 'normal';
    }

    _animDone() { this._animBusy = false; }

    _pickAnimation() {
        const list = ['bounce','wiggle','squish','shake','tilt','walk',
                      'excited','morph','glitch','wink','yawn','lookAround'];
        return list[Math.floor(Math.random() * list.length)];
    }

    _playAnimation(name) {
        this._resetMotion();
        const fn = this[`_anim_${name}`];
        if (typeof fn === 'function') {
            this._animBusy = true;
            fn.call(this);
        }
    }

    _scheduleBlink() {
        const delay = 4 + Math.floor(Math.random() * 6);
        this._blinkId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._blink();
            this._scheduleBlink();
            return GLib.SOURCE_REMOVE;
        });
    }

    _blink() {
        const s = this._s;
        this._addTween('eyeOpen', 0, 80, easeOutQuad, () => {
            this._addTween('eyeOpen', 1, 120, easeOutQuad);
        });
    }

    _scheduleIdle() {
        const delay = 12 + Math.floor(Math.random() * 10);
        this._idleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            if (!this._animBusy) this._playAnimation(this._pickAnimation());
            this._scheduleIdle();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─── Animations ───
    _anim_bounce() {
        this._addTween('bodyY', -6, 180, easeOutQuad, () => {
            this._addTween('bodyY', 0, 400, easeOutBounce, () => this._animDone());
        });
    }

    _anim_wiggle() {
        const steps = [[-14, 100], [14, 120], [-8, 100], [0, 120]];
        const chain = (i) => {
            if (i >= steps.length) { this._animDone(); return; }
            this._addTween('tilt', steps[i][0], steps[i][1], null, () => chain(i+1));
        };
        chain(0);
    }

    _anim_squish() {
        this._addTween('scaleX', 1.15, 120, easeOutQuad);
        this._addTween('scaleY', 0.80, 120, easeOutQuad, () => {
            this._addTween('scaleX', 0.90, 180, easeOutQuad);
            this._addTween('scaleY', 1.12, 180, easeOutQuad, () => {
                this._addTween('scaleX', 1, 240, easeOutBounce);
                this._addTween('scaleY', 1, 240, easeOutBounce, () => this._animDone());
            });
        });
    }

    _anim_shake() {
        const steps = [5,-5,4,-4,2,-2,0];
        const chain = (i) => {
            if (i >= steps.length) { this._animDone(); return; }
            this._addTween('bodyX', steps[i], 60, null, () => chain(i+1));
        };
        chain(0);
    }

    _anim_tilt() {
        const d = Math.random() < 0.5 ? -18 : 18;
        this._addTween('tilt', d, 250, easeOutQuad, () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
                this._addTween('tilt', 0, 350, easeOutBack, () => this._animDone());
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _anim_walk() {
        const s = this._s;
        s.walking = 1; s.walkPhase = 0;
        let steps = 0, max = 4;
        const cycle = () => {
            if (steps >= max) {
                this._addTween('bodyY', 0, 150);
                s.walking = 0; s.walkPhase = 0;
                this._animDone(); return;
            }
            const nextPhase = (steps % 2 === 0) ? 0.99 : 0;
            const nextBob = (steps % 2 === 0) ? -2 : 0;
            this._addTween('walkPhase', nextPhase, 220, easeInOutQuad);
            this._addTween('bodyY', nextBob, 220, easeInOutQuad, () => { steps++; cycle(); });
        };
        cycle();
    }

    _anim_excited() {
        this._addTween('excited', 1, 100);
        const steps = [3,-3,3,-3,2,-2,0];
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

    // ─── Drawing ───
    _drawClawd(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const s = this._s;

        try { cr.setAntialias(Cairo.Antialias.NONE); } catch (e) {}

        const xUnit = this._xUnit;
        const yUnit = this._yUnit;
        const drawW = xUnit * COLS;
        const drawH = yUnit * ROWS;
        const originX = Math.floor((w - drawW) / 2);
        const originY = Math.floor((h - drawH) / 2);

        cr.save();
        cr.translate(w/2 + s.bodyX, h/2 + s.bodyY);
        cr.rotate(s.tilt * Math.PI / 180);
        cr.scale(s.scaleX, s.scaleY);
        cr.translate(-w/2, -h/2);

        const formA = FORMS[s.formA] || FORMS.clawd;
        const formB = FORMS[s.formB] || formA;
        const t = Math.max(0, Math.min(1, s.morphT));
        const morphing = (s.formA !== s.formB) && (t > 0.001 && t < 0.999);

        let r = formA.color[0] * (1-t) + formB.color[0] * t;
        let g = formA.color[1] * (1-t) + formB.color[1] * t;
        let b = formA.color[2] * (1-t) + formB.color[2] * t;
        const ex = Math.max(0, Math.min(1, s.excited));
        if (ex > 0) {
            r = r * (1-ex) + 0.95 * ex;
            g = g * (1-ex) + 0.35 * ex;
            b = b * (1-ex) + 0.20 * ex;
        }

        // Eye state
        let lc = false, rc = false;
        if (!morphing) {
            if (s.eyeState === 'sleepy') { lc = true; rc = true; }
            else if (s.eyeState === 'wink-l') lc = true;
            else if (s.eyeState === 'wink-r') rc = true;
            else if (s.eyeOpen < 0.5) { lc = true; rc = true; }
        }

        const pairA = {4: true, 13: true};
        const pairB = {6: true, 11: true};

        const breathScale = 1 - s.breathT * 0.05;
        const pivotY = originY + 4 * yUnit;

        const pushCell = (entry) => {
            const row = entry[0], col = entry[1], ch = entry[2];
            if (ch === 'E') {
                const isLeft = (col === 5), isRight = (col === 12);
                if (morphing || (isLeft && lc) || (isRight && rc)) {
                    cr.rectangle(originX + col*xUnit, originY + row*yUnit, xUnit, yUnit);
                }
                return;
            }
            let yOff = 0;
            if (ch === 'F' && s.walking > 0 && !morphing) {
                const lift = yUnit;
                if (s.walkPhase < 0.5 && pairA[col]) yOff = -lift;
                if (s.walkPhase >= 0.5 && pairB[col]) yOff = -lift;
                yOff = Math.round(yOff * s.walking);
            }
            cr.rectangle(originX + col*xUnit, originY + row*yUnit + yOff, xUnit, yUnit);
        };

        if (!morphing) {
            const form = (t >= 0.5) ? formB : formA;

            // Body (with breath)
            cr.save();
            cr.translate(0, pivotY);
            cr.scale(1, breathScale);
            cr.translate(0, -pivotY);
            cr.setSourceRGB(r, g, b);
            for (const e of form.bodyCells) pushCell(e);
            cr.fill();
            // Eyelids
            if (lc || rc) {
                const open = (lc && rc && s.eyeState === 'normal') ? s.eyeOpen : 0;
                const alpha = 1 - open;
                if (alpha > 0.05) {
                    const lidH = Math.max(2, Math.floor(yUnit * 0.35));
                    const lidY = originY + 1 * yUnit + Math.floor((yUnit - lidH) / 2);
                    const lidW = 3 * xUnit;
                    cr.setSourceRGBA(r*0.25, g*0.18, b*0.15, alpha);
                    if (lc) cr.rectangle(originX + 4*xUnit, lidY, lidW, lidH);
                    if (rc) cr.rectangle(originX + 11*xUnit, lidY, lidW, lidH);
                    cr.fill();
                }
            }
            // Mouth
            if (s.mouthVisible > 0.05) {
                const cols = (s.mouthShape === 1) ? [6,7,8,9,10,11] : [7,8,9,10];
                const mh = Math.max(2, Math.floor(yUnit * (s.mouthShape === 1 ? 0.7 : 0.45)));
                const my = originY + 3*yUnit + Math.floor((yUnit - mh) / 2);
                cr.setSourceRGBA(r*0.45, g*0.30, b*0.20, s.mouthVisible);
                for (const mc of cols) cr.rectangle(originX + mc*xUnit, my, xUnit, mh);
                cr.fill();
            }
            cr.restore();
            // Feet (no breath)
            cr.setSourceRGB(r, g, b);
            for (const e of form.footCells) pushCell(e);
            cr.fill();
        } else {
            // Crossfade — collect cells
            const both = [], onlyA = [], onlyB = [];
            for (let row = 0; row < ROWS; row++) {
                for (let col = 0; col < COLS; col++) {
                    const a = ['O','E','F'].includes(formA.pixels[row][col]);
                    const bb = ['O','E','F'].includes(formB.pixels[row][col]);
                    if (a && bb) both.push([row, col]);
                    else if (a) onlyA.push([row, col]);
                    else if (bb) onlyB.push([row, col]);
                }
            }
            const draw = (cells, lo, hi) => {
                for (const [row, col] of cells)
                    if (row >= lo && row < hi)
                        cr.rectangle(originX + col*xUnit, originY + row*yUnit, xUnit, yUnit);
            };
            // Body (rows 0-3) with breath
            cr.save();
            cr.translate(0, pivotY); cr.scale(1, breathScale); cr.translate(0, -pivotY);
            cr.setSourceRGBA(r, g, b, 1); draw(both, 0, 4); cr.fill();
            cr.setSourceRGBA(r, g, b, 1-t); draw(onlyA, 0, 4); cr.fill();
            cr.setSourceRGBA(r, g, b, t); draw(onlyB, 0, 4); cr.fill();
            cr.restore();
            // Feet
            cr.setSourceRGBA(r, g, b, 1); draw(both, 4, ROWS); cr.fill();
            cr.setSourceRGBA(r, g, b, 1-t); draw(onlyA, 4, ROWS); cr.fill();
            cr.setSourceRGBA(r, g, b, t); draw(onlyB, 4, ROWS); cr.fill();
        }

        cr.restore();
        cr.$dispose();
    }

    // ─── Usage fetching ───
    _scheduleRefresh() {
        if (this._refreshId) GLib.source_remove(this._refreshId);
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        if (Date.now() < this._rateLimitedUntil) return;
        try {
            const proc = Gio.Subprocess.new(
                [this._fetchScript],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (source, result) => {
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (stdout && stdout.length > 0) {
                        const data = JSON.parse(stdout);
                        if (data.rateLimited) {
                            this._backoffSeconds = Math.min(3600,
                                Math.max(120, (this._backoffSeconds || 60) * 2));
                            this._rateLimitedUntil = Date.now() + this._backoffSeconds * 1000;
                            this._lastError = "rate limited";
                        } else if (data.error) {
                            this._lastError = data.error;
                        } else {
                            this._lastUsage = data;
                            this._lastError = null;
                            this._lastUpdated = Date.now();
                            this._backoffSeconds = 0;
                            this._rateLimitedUntil = 0;
                        }
                    } else {
                        this._lastError = (stderr || "no output").trim();
                    }
                } catch (e) {
                    this._lastError = "parse error: " + e.message;
                }
                this._rebuildMenu();
            });
        } catch (e) {
            this._lastError = "spawn failed: " + e.message;
            this._rebuildMenu();
        }
    }

    // ─── Menu ───
    _buildMenu() {
        this._headerItem = new PopupMenu.PopupMenuItem('Claude Code · loading…', { reactive: false });
        this._headerItem.label.set_style_class_name('clawd-popup-header');
        this.menu.addMenuItem(this._headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._dataItems = {};
        for (const k of ['session', 'week', 'sonnet', 'opus', 'credits']) {
            const item = new PopupMenu.PopupMenuItem('', { reactive: false });
            this.menu.addMenuItem(item);
            this._dataItems[k] = item;
            item.visible = false;
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshAction = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshAction.connect('activate', () => this._refresh());
        this.menu.addMenuItem(this._refreshAction);
    }

    _rebuildMenu() {
        if (this._lastError) {
            this._headerItem.label.text = 'Claude Code — error: ' + this._lastError;
            for (const k in this._dataItems) this._dataItems[k].visible = false;
            return;
        }
        const u = this._lastUsage;
        if (!u) {
            this._headerItem.label.text = 'Claude Code · loading…';
            return;
        }
        const pct = u.five_hour ? Math.round(u.five_hour.utilization) : 0;
        this._headerItem.label.text = `Claude Code · ${pct}% session`;

        const fmtPct = (sec) => sec && sec.utilization != null
            ? sec.utilization.toFixed(0) + ' %' : '—';
        const fmtResetIn = (iso) => {
            if (!iso) return '—';
            try {
                const target = new Date(iso).getTime();
                const now = Date.now();
                if (target <= now) return 'soon';
                const mins = Math.floor((target - now) / 60000);
                if (mins < 60) return `in ${mins} min`;
                const h = Math.floor(mins / 60), m = mins % 60;
                if (h < 24) return `in ${h}h ${m}m`;
                return `in ${Math.floor(h / 24)}d`;
            } catch (e) { return '—'; }
        };

        const setRow = (key, label, value, show) => {
            const it = this._dataItems[key];
            if (!show) { it.visible = false; return; }
            it.label.text = `${label}    ${value}`;
            it.visible = true;
        };

        setRow('session', 'Session',
            `${fmtPct(u.five_hour)}  ·  resets ${fmtResetIn(u.five_hour?.resets_at)}`,
            !!u.five_hour);
        setRow('week', 'Week (all)',
            `${fmtPct(u.seven_day)}  ·  resets ${fmtResetIn(u.seven_day?.resets_at)}`,
            !!u.seven_day);
        setRow('sonnet', 'Week (Sonnet)', fmtPct(u.seven_day_sonnet),
            !!u.seven_day_sonnet);
        setRow('opus', 'Week (Opus)', fmtPct(u.seven_day_opus),
            !!u.seven_day_opus);

        const e = u.extra_usage;
        if (e && e.is_enabled) {
            const sym = e.currency === 'EUR' ? '€' : e.currency === 'USD' ? '$' : (e.currency + ' ');
            setRow('credits', 'Credits',
                `${fmtPct(e)}  ·  ${sym}${(e.used_credits/100).toFixed(2)} / ${sym}${(e.monthly_limit/100).toFixed(0)}`,
                true);
        } else {
            setRow('credits', '', '', false);
        }
    }

    destroy() {
        for (const tid of [this._tickId, this._idleId, this._blinkId, this._refreshId]) {
            if (tid) try { GLib.source_remove(tid); } catch (e) {}
        }
        this._tickId = this._idleId = this._blinkId = this._refreshId = null;
        super.destroy();
    }
});

// ─── Extension entry ───
export default class ClawdExtension extends Extension {
    enable() {
        this._indicator = new ClawdIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
