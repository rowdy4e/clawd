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

import {
    FORMS, FORM_KEYS, MORPH_TARGETS, COLS, ROWS,
    Tween, drawClawd, ANIMATIONS_JSON, EASING_BY_NAME,
    easeOutQuad, easeInOutQuad, easeInOutCubic, easeOutBack, easeOutBounce,
} from './clawd-core.js';
import {AnimationRunner} from './anim_runner.js';

// LockClawdManager intentionally not imported — lock-screen mascot is not
// renderable from extensions on GNOME 50+ Wayland (compositor lock-surface
// bypasses extension actors). File kept in repo for reference.
// import {LockClawdManager} from './lockscreen.js';

// Random one-liners Clawd throws at you on the lock screen.
// Ported from the Cinnamon python widget for feature parity.
const LOCK_MESSAGES = [
    "You're absolutely right!",
    "Let me think about this more carefully...",
    "Actually, on reflection — yes, that.",
    "Hmm, you raise a good point.",
    "404: Motivation not found.",
    "It works on my machine ¯\\_(ツ)_/¯",
    "Just one more refactor, I promise.",
    "TODO: rename this variable later.",
    "git push --force or die trying.",
    "Have you tried turning it off and on again?",
    "Stack Overflow is your spirit animal.",
    "Naming things is hard.",
    "There are 2 hard problems: cache invalidation, naming things, off-by-one errors.",
    "Today's bug is tomorrow's feature.",
    "Code never lies. Comments sometimes do.",
    "Make it work, make it right, make it fast.",
    "Premature optimization is the root of all evil.",
    "Why do programmers prefer dark mode? Bugs hate the light.",
    "There's no place like 127.0.0.1",
    "I'd tell you a UDP joke, but you might not get it.",
    "A SQL query walks into a bar — sees two tables — asks: mind if I join you?",
    "Take a deep breath. The compiler can wait.",
    "Did you remember to commit?",
    "Sip your coffee. The bug will still be there.",
    "Step away for 5 minutes. Solutions appear in the shower.",
];
const LOCK_MESSAGE_DURATION_MS = 6500;
const LOCK_MESSAGE_INTERVAL_MIN_MS = 35000;
const LOCK_MESSAGE_INTERVAL_MAX_MS = 80000;

// File-based debug log: works even after lock cycle clears journal cache.
function _clawdDebug(msg) {
    try {
        const ts = new Date().toISOString();
        const line = `${ts} ${msg}\n`;
        const f = Gio.File.new_for_path('/tmp/clawd-debug.log');
        const stream = f.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_bytes(new GLib.Bytes(line), null);
        stream.close(null);
    } catch (e) { log(`[clawd] debug write failed: ${e}`); }
}

// ─── ClawdIndicator (panel button) ───
const ClawdIndicator = GObject.registerClass(
class ClawdIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Clawd');
        this._extension = extension;
        this._panelHeight = Main.panel.height || 28;

        // Pixel grid sized to panel. xUnit is computed against a "logical
        // 6-row yUnit" so the icon stays the same physical size regardless
        // of how many rows we have in the (now 12-row) shared grid.
        const yUnitLogical6 = Math.max(2, Math.floor((this._panelHeight - 4) / 6));
        const yUnit = Math.max(2, Math.floor((this._panelHeight - 4) / ROWS));
        const xUnit = Math.max(2, Math.floor(yUnitLogical6 / 2));
        const padX = 2 * xUnit;
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
            rainbowActive: 0, rainbowPhase: 0,
        };

        this._tweens = [];
        this._animBusy = false;
        this._tickId = null;
        this._idleId = null;
        this._blinkId = null;
        this._refreshId = null;
        this._breathStart = null;

        // Animation interpreter — drives every animation through animations.json
        // instead of the old hand-coded _anim_* methods. DSL uses snake_case
        // keys; state object uses camelCase — keyMap bridges them.
        const easingFor = (name) => EASING_BY_NAME[name] || (t => t);
        const DSL_TO_STATE = {
            body_x: 'bodyX', body_y: 'bodyY',
            scale_x: 'scaleX', scale_y: 'scaleY',
            tilt: 'tilt',
            eye_open: 'eyeOpen', eye_state: 'eyeState',
            mouth_visible: 'mouthVisible', mouth_shape: 'mouthShape',
            walk_phase: 'walkPhase', walking: 'walking',
            form_a: 'formA', form_b: 'formB', morph_t: 'morphT',
            excited: 'excited',
            rainbow_active: 'rainbowActive', rainbow_phase: 'rainbowPhase',
        };
        this._runner = new AnimationRunner({
            state: this._s,
            addTween: (key, target, ms, ease, onComplete) => {
                // Replace any in-flight tween on the same key so they don't fight.
                this._tweens = this._tweens.filter(t => t.key !== key);
                this._tweens.push(new Tween(this._s, key, target, ms, easingFor(ease), onComplete));
            },
            timeoutAdd: (ms, fn) =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                    fn();
                    return GLib.SOURCE_REMOVE;
                }),
            randomLists: {MORPH_TARGETS: MORPH_TARGETS},
            keyMap: DSL_TO_STATE,
            animationsJson: ANIMATIONS_JSON,
            intensityY: 0.6,
        });

        // Usage state
        this._lastUsage = null;
        this._lastError = null;
        this._lastUpdated = 0;
        this._rateLimitedUntil = 0;
        this._backoffSeconds = 0;

        // Path to fetch script (uses extension dir)
        const dir = extension.path;
        this._fetchScript = `${dir}/fetch-usage.sh`;

        // Settings
        this._settings = extension.getSettings('org.gnome.shell.extensions.clawd');
        this._settingsHandlers = [];
        this._settingsHandlers.push(this._settings.connect('changed::refresh-seconds',
            () => this._scheduleRefresh()));
        for (const key of ['idle-animations', 'idle-min-seconds', 'idle-max-seconds']) {
            this._settingsHandlers.push(this._settings.connect(`changed::${key}`,
                () => this._scheduleIdle()));
        }
        this._settingsHandlers.push(this._settings.connect('changed::dev-mode',
            () => this._rebuildPlaygroundMenu()));
        this._settingsHandlers.push(this._settings.connect('changed::bar-mode',
            () => this._rebuildMenu()));

        // Animation loop: 80 ms tick (~12 FPS) — matches the Cinnamon applet.
        // Pixel art doesn't need 30 FPS; 12 FPS keeps the breath smooth and
        // is gentle on CPU.
        this._tickIntervalMs = 80;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._tickIntervalMs, () => {
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
            const newBreath = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
            const breathDelta = Math.abs(newBreath - (s.breathT ?? 0));
            s.breathT = newBreath;

            const hasTweens = this._tweens.length > 0;
            if (hasTweens) {
                for (const tw of [...this._tweens]) tw.step(this._tickIntervalMs);
                this._tweens = this._tweens.filter(tw => !tw.done);
            }

            // Skip when breath barely moved AND nothing else animating.
            const noVisibleChange = !hasTweens
                && s.mouthVisible === 0 && s.walking === 0
                && breathDelta < 0.003;
            if (noVisibleChange) return;

            if (this._clawd.mapped) this._clawd.queue_repaint();
            if (this._coupledAreas) {
                for (const a of this._coupledAreas) {
                    if (a.mapped) try { a.queue_repaint(); } catch (e) {}
                }
            }
        } catch (e) {
            logError(e, 'Clawd tick');
        }
    }

    addCoupledArea(area) {
        if (!this._coupledAreas) this._coupledAreas = [];
        this._coupledAreas.push(area);
        // If the actor is destroyed (e.g. via disable() destroying lockBin),
        // remove it from the list synchronously so the next tick doesn't
        // touch a disposed object.
        area.connect('destroy', () => {
            if (!this._coupledAreas) return;
            const i = this._coupledAreas.indexOf(area);
            if (i >= 0) this._coupledAreas.splice(i, 1);
        });
    }

    stopTick() {
        if (this._tickId) {
            try { GLib.source_remove(this._tickId); } catch (e) {}
            this._tickId = null;
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
        const choice = this._settings
            ? this._settings.get_string('animation-style')
            : 'random';
        if (choice && choice !== 'random') return choice;
        // Pool = everything except easter-egg-tagged animations (rolled below
        // at low probability).
        const all = this._runner.listAnimations();
        const tags = (ANIMATIONS_JSON.tags || {});
        const eggs = all.filter(n => (tags[n] || []).indexOf('easter_egg') >= 0);
        const pool = all.filter(n => (tags[n] || []).indexOf('easter_egg') < 0);
        if (eggs.length && Math.random() < 0.04) {
            return eggs[Math.floor(Math.random() * eggs.length)];
        }
        return pool[Math.floor(Math.random() * pool.length)];
    }

    _playAnimation(name) {
        this._resetMotion();
        this._animBusy = true;
        this._runner.play(name, () => this._animDone());
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
        if (this._idleId) {
            try { GLib.source_remove(this._idleId); } catch (e) {}
            this._idleId = null;
        }
        if (this._settings && !this._settings.get_boolean('idle-animations')) return;
        const min = this._settings ? this._settings.get_int('idle-min-seconds') : 12;
        const max = this._settings ? this._settings.get_int('idle-max-seconds') : 22;
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        const delay = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
        this._idleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            if (!this._animBusy) this._playAnimation(this._pickAnimation());
            this._idleId = null;
            this._scheduleIdle();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─── Animations come from shared/animations.json via AnimationRunner ──

    _drawClawd(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        drawClawd(Cairo, cr, w, h, this._s, this._xUnit, this._yUnit);
        cr.$dispose();
    }


    // ─── Usage fetching ───
    _scheduleRefresh() {
        if (this._refreshId) {
            try { GLib.source_remove(this._refreshId); } catch (e) {}
            this._refreshId = null;
        }
        const sec = this._settings ? this._settings.get_int('refresh-seconds') : 300;
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
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
                            if (this._settings && this._settings.get_boolean('animate-on-refresh')
                                && !this._animBusy) {
                                this._playAnimation(this._pickAnimation());
                            }
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

        this._playgroundItem = null;
        this._rebuildPlaygroundMenu();
    }

    _rebuildPlaygroundMenu() {
        if (this._playgroundItem) {
            this._playgroundItem.destroy();
            this._playgroundItem = null;
        }
        if (!this._settings || !this._settings.get_boolean('dev-mode')) return;

        const sub = new PopupMenu.PopupSubMenuMenuItem('Animation playground');
        // Derive animations from animations.json so newly-added entries appear
        // automatically. Easter eggs (e.g. grow) included so you can trigger
        // them on demand here.
        const anims = this._runner.listAnimations();
        for (const name of anims) {
            const it = new PopupMenu.PopupMenuItem(name);
            it.connect('activate', () => {
                this._animBusy = false;
                this._playAnimation(name);
            });
            sub.menu.addMenuItem(it);
        }
        // Morph to: one entry per panel-allowed form. Each forces the runner's
        // morph animation to target that form via randomLists override.
        const formSub = new PopupMenu.PopupSubMenuMenuItem('Morph to…');
        for (const k of MORPH_TARGETS) {
            const it = new PopupMenu.PopupMenuItem(k);
            it.connect('activate', () => {
                this._resetMotion();
                this._animBusy = true;
                this._runner.play('morph', () => this._animDone(),
                    {randomLists: {MORPH_TARGETS: [k]}});
            });
            formSub.menu.addMenuItem(it);
        }
        sub.menu.addMenuItem(formSub);
        this.menu.addMenuItem(sub);
        this._playgroundItem = sub;
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
        const barMode = this._settings ? this._settings.get_string('bar-mode') : 'session';
        const headerSrc = {
            'session':     {sec: u.five_hour,         label: 'session'},
            'week':        {sec: u.seven_day,         label: 'week'},
            'week-sonnet': {sec: u.seven_day_sonnet,  label: 'week (Sonnet)'},
            'credits':     {sec: u.extra_usage && u.extra_usage.is_enabled ? u.extra_usage : null,
                            label: 'credits'},
        }[barMode] || {sec: u.five_hour, label: 'session'};
        const pct = headerSrc.sec && headerSrc.sec.utilization != null
            ? Math.round(headerSrc.sec.utilization) : 0;
        this._headerItem.label.text = `Claude Code · ${pct}% ${headerSrc.label}`;

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
        if (this._settings && this._settingsHandlers) {
            for (const h of this._settingsHandlers) {
                try { this._settings.disconnect(h); } catch (e) {}
            }
        }
        this._settingsHandlers = null;
        this._settings = null;
        super.destroy();
    }
});

// ─── Extension entry ───
export default class ClawdExtension extends Extension {
    enable() {
        _clawdDebug(`enable() — sessionMode=${Main.sessionMode.currentMode}`);
        this._indicator = new ClawdIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settings = this.getSettings('org.gnome.shell.extensions.clawd');

        this._buildLockOverlay();

        // Rebuild the lock overlay when the user switches top/bottom.
        this._posSettingHandler = this._settings.connect(
            'changed::lockscreen-position-bottom',
            () => this._rebuildLockChrome());

        if (Main.screenShield) {
            _clawdDebug(`screenShield active=${Main.screenShield.active} locked=${Main.screenShield.locked}`);
            const syncLock = (src) => {
                const sh = Main.screenShield;
                const want = !!(sh && (sh.active || sh.locked));
                _clawdDebug(`${src} → lockMode(${want})`);
                this._setLockOverlay(want);
            };
            this._lockHandler = Main.screenShield.connect('active-changed', () => syncLock('active'));
            this._lockedHandler = Main.screenShield.connect('locked-changed', () => syncLock('locked'));
            if (Main.screenShield.active || Main.screenShield.locked)
                this._setLockOverlay(true);
        }
    }

    _buildLockOverlay() {
        const LOCK_YUNIT = 10, LOCK_XUNIT = 5;
        const padX = 4 * LOCK_XUNIT;
        const cw = LOCK_XUNIT * COLS + 2 * padX;
        const ch = LOCK_YUNIT * ROWS;

        this._lockClawd = new St.DrawingArea({width: cw, height: ch});
        this._lockClawd.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            drawClawd(Cairo, cr, w, h, this._indicator._s, LOCK_XUNIT, LOCK_YUNIT);
            cr.$dispose();
        });

        this._lockBubble = new St.Label({
            style_class: 'clawd-lock-bubble',
            visible: false,
        });
        this._lockBubble.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: 2,
            ellipsize: 0,
        });

        // FixedLayout = like CSS position: absolute; children placed via
        // set_x/set_y. Horizontal centering via Clutter.AlignConstraint
        // auto-updates on every layout pass.
        const CLAWD_OFFSET = 80;
        this._lockBin = new St.Widget({
            name: 'clawdLockBin',
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            visible: false,
            style: `min-height: ${CLAWD_OFFSET + ch + 16}px;`,
        });

        const clawdWrap = new St.Bin({child: this._lockClawd});
        this._lockBin.add_child(clawdWrap);
        this._lockBin.add_child(this._lockBubble);
        clawdWrap.add_constraint(new Clutter.AlignConstraint({
            source: this._lockBin,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        this._lockBubble.add_constraint(new Clutter.AlignConstraint({
            source: this._lockBin,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        clawdWrap.set_y(CLAWD_OFFSET);
        this._lockBubble.set_y(12);

        this._indicator.addCoupledArea(this._lockClawd);

        // Mount in either panelBox (top) or a new bottom-anchored chrome.
        const bottom = this._settings.get_boolean('lockscreen-position-bottom');
        if (bottom) {
            this._bottomChrome = new St.BoxLayout({
                name: 'clawdBottomChrome',
                orientation: Clutter.Orientation.VERTICAL,
            });
            this._bottomChrome.add_child(this._lockBin);
            Main.layoutManager.addChrome(this._bottomChrome, {
                affectsStruts: true,
                trackFullscreen: true,
            });
            this._positionBottomChrome();
            this._monitorsChangedId = Main.layoutManager.connect(
                'monitors-changed', () => this._positionBottomChrome());
            this._bottomChrome.connect('notify::height',
                () => this._positionBottomChrome());
        } else {
            Main.layoutManager.panelBox.add_child(this._lockBin);
        }
    }

    _positionBottomChrome() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._bottomChrome) return;
        this._bottomChrome.set_width(m.width);
        const [, h] = this._bottomChrome.get_preferred_height(-1);
        this._bottomChrome.set_position(m.x, m.y + m.height - h);
    }

    _teardownLockOverlay() {
        this._stopAllMessages();
        if (this._monitorsChangedId) {
            try { Main.layoutManager.disconnect(this._monitorsChangedId); } catch (e) {}
            this._monitorsChangedId = null;
        }
        if (this._bottomChrome) {
            try { Main.layoutManager.removeChrome(this._bottomChrome); } catch (e) {}
            try { this._bottomChrome.destroy(); } catch (e) {}
            this._bottomChrome = null;
            this._lockBin = null; // destroyed together with its parent
        } else if (this._lockBin) {
            try { this._lockBin.destroy(); } catch (e) {}
            this._lockBin = null;
        }
        this._lockClawd = null;
        this._lockBubble = null;
    }

    _rebuildLockChrome() {
        const wasLocked = !!(Main.screenShield?.active || Main.screenShield?.locked);
        this._teardownLockOverlay();
        this._buildLockOverlay();
        if (wasLocked) this._setLockOverlay(true);
    }

    _setLockOverlay(on) {
        if (!this._lockBin) return;
        this._lockBin.visible = on;
        // Hide the small panel clawd while the big lock overlay is shown.
        if (this._indicator?.container)
            this._indicator.container.visible = !on;
        if (on)
            this._scheduleNextMessage(true);
        else
            this._stopAllMessages();
    }

    _scheduleNextMessage(initial) {
        this._stopMessageTimer();
        // First message comes a bit faster after lock; subsequent ones random.
        const min = initial ? 8000 : LOCK_MESSAGE_INTERVAL_MIN_MS;
        const max = initial ? 18000 : LOCK_MESSAGE_INTERVAL_MAX_MS;
        const delay = min + Math.floor(Math.random() * (max - min));
        this._msgTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._msgTimerId = null;
            this._showRandomMessage();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showRandomMessage() {
        if (!this._lockBin?.visible || !this._lockBubble) return;
        const text = LOCK_MESSAGES[Math.floor(Math.random() * LOCK_MESSAGES.length)];
        this._lockBubble.set_text(text);
        this._lockBubble.visible = true;
        this._startMouthTalk();
        this._msgHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOCK_MESSAGE_DURATION_MS, () => {
            this._msgHideId = null;
            this._hideMessage();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideMessage() {
        if (this._lockBubble) this._lockBubble.visible = false;
        this._stopMouthTalk();
        if (this._lockBin?.visible) this._scheduleNextMessage(false);
    }

    _startMouthTalk() {
        if (this._mouthTimerId || !this._indicator) return;
        const s = this._indicator._s;
        const startUs = GLib.get_monotonic_time();
        const TALK_LIMIT_US = 2_000_000;
        s.mouthVisible = 1;
        s.mouthShape = 0;
        const tick = () => {
            if (!this._lockBin?.visible || (GLib.get_monotonic_time() - startUs) > TALK_LIMIT_US) {
                s.mouthVisible = 0;
                s.mouthShape = 0;
                this._mouthTimerId = null;
                return GLib.SOURCE_REMOVE;
            }
            const openNow = s.mouthVisible < 0.5;
            s.mouthVisible = openNow ? 1 : 0;
            if (openNow) s.mouthShape = Math.random() < 0.3 ? 1 : 0;
            return GLib.SOURCE_CONTINUE;
        };
        this._mouthTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 110 + Math.floor(Math.random() * 50), tick);
    }

    _stopMouthTalk() {
        if (this._mouthTimerId) {
            try { GLib.source_remove(this._mouthTimerId); } catch (e) {}
            this._mouthTimerId = null;
        }
        if (this._indicator?._s) {
            this._indicator._s.mouthVisible = 0;
            this._indicator._s.mouthShape = 0;
        }
    }

    _stopMessageTimer() {
        if (this._msgTimerId) {
            try { GLib.source_remove(this._msgTimerId); } catch (e) {}
            this._msgTimerId = null;
        }
    }

    _stopAllMessages() {
        this._stopMessageTimer();
        if (this._msgHideId) {
            try { GLib.source_remove(this._msgHideId); } catch (e) {}
            this._msgHideId = null;
        }
        this._stopMouthTalk();
        if (this._lockBubble) this._lockBubble.visible = false;
    }

    disable() {
        _clawdDebug('disable()');
        if (Main.screenShield) {
            if (this._lockHandler) try { Main.screenShield.disconnect(this._lockHandler); } catch (e) {}
            if (this._lockedHandler) try { Main.screenShield.disconnect(this._lockedHandler); } catch (e) {}
        }
        this._lockHandler = null;
        this._lockedHandler = null;
        if (this._posSettingHandler && this._settings) {
            try { this._settings.disconnect(this._posSettingHandler); } catch (e) {}
            this._posSettingHandler = null;
        }
        // Stop the tick BEFORE destroying the lock actors so it can't land
        // on a disposed widget mid-destroy and segfault gnome-shell.
        this._indicator?.stopTick();
        this._teardownLockOverlay();
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
