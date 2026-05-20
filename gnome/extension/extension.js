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
    Tween, drawClawd,
    easeOutQuad, easeInOutQuad, easeInOutCubic, easeOutBack, easeOutBounce,
} from './clawd-core.js';

import {LockClawdManager} from './lockscreen.js';

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
        const choice = this._settings
            ? this._settings.get_string('animation-style')
            : 'random';
        if (choice && choice !== 'random') return choice;
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
        const anims = ['bounce','wiggle','squish','spin','shake','tilt','walk',
                       'excited','morph','glitch','wink','yawn','lookAround'];
        for (const name of anims) {
            const it = new PopupMenu.PopupMenuItem(name);
            it.connect('activate', () => {
                this._animBusy = false;
                this._playAnimation(name);
            });
            sub.menu.addMenuItem(it);
        }
        const formKeys = Object.keys(FORMS).filter(k => k !== 'clawd');
        const formSub = new PopupMenu.PopupSubMenuMenuItem('Morph to…');
        for (const k of formKeys) {
            const it = new PopupMenu.PopupMenuItem(k);
            it.connect('activate', () => {
                this._animBusy = false;
                this._s.formB = k;
                this._addTween('morphT', 1, 320, easeOutQuad, () => {
                    this._s.formA = k; this._s.morphT = 0;
                });
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
        this._indicator = new ClawdIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._lockManager = new LockClawdManager(
            this.getSettings('org.gnome.shell.extensions.clawd')
        );
        this._lockManager.enable();
    }
    disable() {
        this._lockManager?.disable();
        this._lockManager = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
