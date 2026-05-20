const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Tweener = imports.ui.tweener;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cairo = imports.cairo;

const APPLET_DIR = GLib.get_home_dir() + "/.local/share/cinnamon/applets/claude-usage@rowdy4e";

// ─── Pixel-art forms — 18 cols × 6 rows each ───
// 'O' body, 'E' eye gap (drawn only when blinking), 'F' foot (walk-animated),
// '.' transparent. Each form has its own color.
const FORMS = {
    clawd: {
        color: [0.85, 0.47, 0.34],
        pixels: [
            "...OOOOOOOOOOOO...",
            "...OOEOOOOOOEOO...",
            ".OOOOOOOOOOOOOOOO.",
            "...OOOOOOOOOOOO...",
            "....F.F....F.F....",
            ".................."
        ]
    },
    heart: {
        color: [0.93, 0.27, 0.49],
        pixels: [
            "..................",
            "....OOO....OOO....",
            "...OOOOOOOOOOOO...",
            "....OOOOOOOOOO....",
            ".....OOOOOOOO.....",
            "......OOOOOO......"
        ]
    },
    ghost: {
        color: [0.88, 0.90, 0.96],
        pixels: [
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "...OOEOOOOOOEOO...",
            "...OOOOOOOOOOOO...",
            "...OOOOOOOOOOOO...",
            "...O.OO.OO.OO.O..."
        ]
    },
    octopus: {
        color: [0.62, 0.40, 0.85],
        pixels: [
            "....OOOOOOOO......",
            "...OOOOOOOOOO.....",
            "..OOEOOOOOOEOO....",
            "...OOOOOOOOOO.....",
            "..O.O.O.O.O.O.O...",
            "...O.O.O.O.O.O...."
        ]
    },
    sparkle: {
        color: [0.98, 0.78, 0.18],
        pixels: [
            "........OO........",
            ".....OOOOOOOO.....",
            ".OOOOOOOOOOOOOOOO.",
            ".OOOOOOOOOOOOOOOO.",
            ".....OOOOOOOO.....",
            "........OO........"
        ]
    },
    blob: {
        color: [0.35, 0.82, 0.45],
        pixels: [
            "..................",
            "....OOOOOOOOOO....",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            "...OOOOOOOOOOOO...",
            ".................."
        ]
    },
    pacman: {
        color: [0.98, 0.85, 0.10],
        pixels: [
            ".....OOOOOOOOO....",
            "....OOOOOOOOOOO...",
            "...OOOOOOOO.......",
            "...OOOOOO.........",
            "...OOOOOOOO.......",
            "....OOOOOOOOOOO..."
        ]
    },
    invader: {
        color: [0.30, 0.90, 0.40],
        pixels: [
            "....O......O......",
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "...OO.OOOO.OO.....",
            "...OOOOOOOOOO.....",
            "....O.OOOO.O......"
        ]
    },
    crown: {
        color: [0.96, 0.80, 0.20],
        pixels: [
            "..O..O..O..O..O...",
            "..O..O..O..O..O...",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            "..OOOOOOOOOOOOOO..",
            ".................."
        ]
    },
    skull: {
        color: [0.92, 0.92, 0.95],
        pixels: [
            ".....OOOOOOOO.....",
            "....OOOOOOOOOO....",
            "....OO.OOOO.OO....",
            ".....OOOOOOOO.....",
            "......OOOOOO......",
            "......O.O.O.O....."
        ]
    }
};
const FORM_KEYS = Object.keys(FORMS);
const MORPH_TARGETS = FORM_KEYS.filter(k => k !== "clawd");
const COLS = 18;
const ROWS = 6;

// Rainbow palette — Tweened through during the rainbow animation.
const RAINBOW = [
    [0.95, 0.20, 0.20], // red
    [0.95, 0.55, 0.10], // orange
    [0.95, 0.85, 0.10], // yellow
    [0.30, 0.85, 0.30], // green
    [0.20, 0.55, 0.95], // blue
    [0.55, 0.30, 0.85], // indigo
    [0.85, 0.30, 0.85]  // violet
];

function isFilled(pixels, row, col) {
    let ch = pixels[row][col];
    return ch === 'O' || ch === 'E' || ch === 'F';
}

// Pre-compile each form's filled cells into split body/foot arrays so the draw
// path doesn't pay for string indexing on every frame.
(function _precomputeFormCells() {
    for (let key of FORM_KEYS) {
        let form = FORMS[key];
        form.bodyCells = [];
        form.footCells = [];
        for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
                let ch = form.pixels[row][col];
                if (ch === '.') continue;
                let target = (row < 4) ? form.bodyCells : form.footCells;
                target.push([row, col, ch]);
            }
        }
    }
})();

function rainbowColor(t) {
    let n = RAINBOW.length;
    let pos = (t % 1) * (n - 1);
    let i = Math.floor(pos);
    let f = pos - i;
    let a = RAINBOW[i];
    let b = RAINBOW[Math.min(i + 1, n - 1)];
    return [
        a[0] * (1 - f) + b[0] * f,
        a[1] * (1 - f) + b[1] * f,
        a[2] * (1 - f) + b[2] * f
    ];
}

// Colors
const ORANGE_NORMAL  = [0.85, 0.47, 0.34];
const ORANGE_EXCITED = [0.95, 0.35, 0.20];
const EYE_BLACK = [0.08, 0.08, 0.08];

// Bar colors (in popup menu)
const COLOR_OK   = [0.388, 0.400, 0.945];
const COLOR_WARN = [0.961, 0.620, 0.043];
const COLOR_CRIT = [0.937, 0.267, 0.267];
const COLOR_TRACK = [1.0, 1.0, 1.0, 0.18];

class ClaudeUsageApplet extends Applet.Applet {
    constructor(orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.set_applet_tooltip("Claude usage");
        this.setAllowedLayout(Applet.AllowedLayout.HORIZONTAL);

        this.settings = new Settings.AppletSettings(this, "claude-usage@rowdy4e", instanceId);
        this.settings.bind("refreshSeconds", "refreshSeconds", this._reschedule.bind(this));
        this.settings.bind("barMode", "barMode", this._rebuildMenu.bind(this));
        this.settings.bind("animationStyle", "animationStyle", () => {});
        this.settings.bind("animateOnRefresh", "animateOnRefresh", () => {});
        this.settings.bind("idleAnimations", "idleAnimations", this._scheduleIdle.bind(this));
        this.settings.bind("idleMinSeconds", "idleMinSeconds", this._scheduleIdle.bind(this));
        this.settings.bind("idleMaxSeconds", "idleMaxSeconds", this._scheduleIdle.bind(this));
        this.settings.bind("usageScriptPath", "usageScriptPath", this._refresh.bind(this));
        this.settings.bind("devMode", "devMode", this._rebuildMenu.bind(this));
        this._lastLockscreenVal = null; // unknown on init — first call won't restart
        this.settings.bind("lockscreenEnabled", "lockscreenEnabled", this._onLockscreenToggle.bind(this));
        this._onLockscreenToggle(); // initial sync, no restart

        // Drawing canvas sized to panel. Each terminal cell is ~2:1 (tall:wide),
        // so to match the CLI proportions we draw "tall pixels": yUnit = 2 × xUnit.
        let yUnit = Math.max(2, Math.floor((panelHeight - 4) / ROWS));
        let xUnit = Math.max(1, Math.floor(yUnit / 2));
        // Horizontal headroom — accommodates squish (~1.15×) and wider morph forms.
        // 4 cols of padding each side = enough breathing room.
        let padX = 4 * xUnit;
        let padY = 0;
        let canvasH = yUnit * ROWS + 2 * padY;
        let canvasW = xUnit * COLS + 2 * padX;

        // Remember unit sizes so the draw handler stays in sync.
        this._xUnit = xUnit;
        this._yUnit = yUnit;

        this._clawd = new St.DrawingArea({
            width: canvasW,
            height: canvasH,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._clawd.set_pivot_point(0.5, 0.5);
        this._clawd.connect("repaint", this._drawClawd.bind(this));
        this.actor.add_actor(this._clawd);

        // Animated state — Tweener animates these properties; onUpdate calls repaint.
        this._state = {
            bodyY: 0,
            bodyX: 0,
            scaleX: 1,
            scaleY: 1,
            tilt: 0,
            eyeOpen: 1,        // 0 = closed (eyes filled with body color), 1 = open (gap)
            walkPhase: 0,      // 0..1, alternates which foot pair is lifted
            walking: 0,        // 0 = standing, 1 = walking
            excited: 0,        // 0 = normal color, 1 = excited
            formA: "clawd",    // current form
            formB: "clawd",    // target form
            morphT: 0,         // 0 = pure formA, 1 = pure formB
            rainbowActive: 0,  // 0 = use form color, 1 = use rainbow color
            rainbowPhase: 0,   // 0..1 position in rainbow palette
            mouthVisible: 0,   // 0 = no mouth, 1 = mouth shown
            mouthShape: 0,     // 0 = line, 1 = "O" (open)
            eyeState: "normal",// normal | wink-l | wink-r | sleepy
            eyeShift: 0,       // -1..1, horizontal eye position shift (px in xUnit)
            breathT: 0         // breathing phase, 0..1 — owned ONLY by _startBreathing
        };

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._pendingRebuild = false;
        this._timeLabels = [];   // [{ label, updater }] for live-updating time strings
        this._menuTickId = null;
        this.menu.connect("open-state-changed", (m, open) => {
            if (open) {
                this._updateTimeLabels();
                if (!this._menuTickId) {
                    this._menuTickId = Mainloop.timeout_add_seconds(1, () => {
                        this._updateTimeLabels();
                        return true;
                    });
                }
            } else {
                if (this._menuTickId) {
                    Mainloop.source_remove(this._menuTickId);
                    this._menuTickId = null;
                }
                if (this._pendingRebuild) {
                    this._pendingRebuild = false;
                    this._rebuildMenu();
                }
            }
        });

        this._timeout = null;
        this._idleTimeout = null;
        this._blinkTimeout = null;
        this._lastUsage = null;     // parsed /api/oauth/usage response
        this._lastError = null;
        this._lastUpdated = 0;      // ms of last successful fetch
        this._nextRefreshAt = 0;    // ms when next auto-refresh will fire
        this._rateLimitedUntil = 0; // ms; if Date.now() < this, skip fetches
        this._backoffSeconds = 0;   // current backoff override; resets on success
        this._barArea = null;

        this._rebuildMenu();
        this._refresh();
        this._startBreathing();
        this._scheduleBlink();
    }

    // ───────── Cairo drawing ─────────
    _drawClawd(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let s = this._state;

        try { cr.setAntialias(Cairo.Antialias.NONE); } catch (e) {}

        // Use the unit sizes computed at construction so transforms have headroom.
        let yUnit = this._yUnit || 4;
        let xUnit = this._xUnit || 2;
        let drawW = xUnit * COLS;
        let drawH = yUnit * ROWS;
        let originX = Math.floor((w - drawW) / 2);
        let originY = Math.floor((h - drawH) / 2);

        // Transform around canvas center
        cr.save();
        cr.translate(w / 2 + s.bodyX, h / 2 + s.bodyY);
        cr.rotate(s.tilt * Math.PI / 180);
        cr.scale(s.scaleX, s.scaleY);
        cr.translate(-w / 2, -h / 2);

        let formA = FORMS[s.formA] || FORMS.clawd;
        let formB = FORMS[s.formB] || formA;
        let t = Math.max(0, Math.min(1, s.morphT));
        let morphing = (s.formA !== s.formB) && (t > 0.001 && t < 0.999);

        // Body color: interpolate between formA.color and formB.color according to morph progress.
        let baseColor = [
            formA.color[0] * (1 - t) + formB.color[0] * t,
            formA.color[1] * (1 - t) + formB.color[1] * t,
            formA.color[2] * (1 - t) + formB.color[2] * t
        ];
        // Rainbow override
        if (s.rainbowActive > 0.01) {
            let rb = rainbowColor(s.rainbowPhase);
            let k = s.rainbowActive;
            baseColor = [
                baseColor[0] * (1 - k) + rb[0] * k,
                baseColor[1] * (1 - k) + rb[1] * k,
                baseColor[2] * (1 - k) + rb[2] * k
            ];
        }
        // Excited adds a flash of red
        let mix = Math.max(0, Math.min(1, s.excited));
        let r = baseColor[0] * (1 - mix) + 0.95 * mix;
        let g = baseColor[1] * (1 - mix) + 0.35 * mix;
        let b = baseColor[2] * (1 - mix) + 0.20 * mix;

        // Walk pairs
        let pairA = { 4: true, 13: true };
        let pairB = { 6: true, 11: true };

        // Track which eyes are "closed" so we can draw a proper eyelid line
        // on top of the body afterwards (rather than just filling the gap).
        let leftEyeClosed = false, rightEyeClosed = false;
        if (!morphing) {
            if (s.eyeState === "sleepy") {
                leftEyeClosed = true; rightEyeClosed = true;
            } else if (s.eyeState === "wink-l") {
                leftEyeClosed = true;
            } else if (s.eyeState === "wink-r") {
                rightEyeClosed = true;
            } else if (s.eyeOpen < 0.5) {
                leftEyeClosed = true; rightEyeClosed = true;
            }
        }

        // Helper to push a rectangle from pre-compiled cells.
        let pushCellByEntry = (entry) => {
            let row = entry[0], col = entry[1], ch = entry[2];
            if (ch === 'E') {
                // Fill the eye gap with body color when:
                //  - morphing (clean crossfade)
                //  - that eye is closed (body shows under the eyelid)
                let isLeft = (col === 5);
                let isRight = (col === 12);
                let closed = morphing
                    || (isLeft && leftEyeClosed)
                    || (isRight && rightEyeClosed);
                if (closed) {
                    cr.rectangle(originX + col * xUnit, originY + row * yUnit, xUnit, yUnit);
                }
                return;
            }
            let yOffset = 0;
            if (ch === 'F' && s.walking > 0 && !morphing) {
                let lift = yUnit;
                if (s.walkPhase < 0.5 && pairA[col]) yOffset = -lift;
                if (s.walkPhase >= 0.5 && pairB[col]) yOffset = -lift;
                yOffset = Math.round(yOffset * s.walking);
            }
            cr.rectangle(originX + col * xUnit, originY + row * yUnit + yOffset, xUnit, yUnit);
        };

        // Stash a closure to draw eyelids after the body. Called inside the breath
        // transform block so eyelids move with the body.
        let drawEyelids = () => {
            if (morphing) return;
            // For partial blink (eyeOpen between 0 and 1) interpolate width/opacity
            let openness = 1;
            if (leftEyeClosed || rightEyeClosed) {
                // If we're mid-blink, both eyes share the same eyeOpen value.
                openness = (leftEyeClosed && rightEyeClosed && s.eyeState === "normal") ? s.eyeOpen : 0;
            }
            // 0 = fully closed, 1 = fully open
            // Eyelid drawn as a thin dark horizontal line across the eye area.
            // Width slightly wider than the gap (3 pixels = cols around the eye).
            let alpha = 1 - openness;
            if (alpha < 0.05) return;
            let lidH = Math.max(2, Math.floor(yUnit * 0.35));
            let lidYOffset = Math.floor((yUnit - lidH) / 2);
            let lidWidth = 3 * xUnit;
            // Dark color derived from body color but much darker
            cr.setSourceRGBA(r * 0.25, g * 0.18, b * 0.15, alpha);
            if (leftEyeClosed) {
                cr.rectangle(originX + 4 * xUnit, originY + 1 * yUnit + lidYOffset, lidWidth, lidH);
            }
            if (rightEyeClosed) {
                cr.rectangle(originX + 11 * xUnit, originY + 1 * yUnit + lidYOffset, lidWidth, lidH);
            }
            cr.fill();
        };
        // Make it accessible from the body draw block below
        this._lastDrawEyelids = drawEyelids;

        // Breath transform — applies only to body rows (0..3). Pivot at the
        // bottom of body so feet stay anchored ("ground" them).
        let breathScale = 1 - s.breathT * 0.05;
        let breathBob = s.breathT * 0.5;
        let pivotY = originY + 4 * yUnit;
        let applyBreath = () => {
            cr.translate(0, breathBob);
            cr.translate(0, pivotY);
            cr.scale(1, breathScale);
            cr.translate(0, -pivotY);
        };

        let drawCells = (cells) => {
            for (let i = 0; i < cells.length; i++) pushCellByEntry(cells[i]);
        };

        let drawCellsFiltered = (cells, rowStart, rowEnd) => {
            for (let i = 0; i < cells.length; i++) {
                let row = cells[i][0];
                if (row < rowStart || row >= rowEnd) continue;
                let col = cells[i][1];
                cr.rectangle(originX + col * xUnit, originY + row * yUnit, xUnit, yUnit);
            }
        };

        if (!morphing) {
            let form = (t >= 0.5) ? formB : formA;

            // BODY (rows 0..3) — with breath transform
            cr.save();
            applyBreath();
            cr.setSourceRGB(r, g, b);
            drawCells(form.bodyCells);
            cr.fill();
            // Eyelid line over closed eyes
            drawEyelids();
            // Mouth lives on the body
            if (s.mouthVisible > 0.05) {
                let mouthRow = 3;
                let mouthCols, mouthH;
                if (s.mouthShape === 1) {
                    mouthCols = [6, 7, 8, 9, 10, 11];
                    mouthH = Math.max(2, Math.floor(yUnit * 0.7));
                } else {
                    mouthCols = [7, 8, 9, 10];
                    mouthH = Math.max(2, Math.floor(yUnit * 0.45));
                }
                let mr = r * 0.45, mg = g * 0.30, mb = b * 0.20;
                cr.setSourceRGBA(mr, mg, mb, s.mouthVisible);
                let yTopOffset = Math.floor((yUnit - mouthH) / 2);
                for (let mc of mouthCols) {
                    cr.rectangle(originX + mc * xUnit, originY + mouthRow * yUnit + yTopOffset, xUnit, mouthH);
                }
                cr.fill();
            }
            cr.restore();

            // FEET (rows 4..end) — no breath
            cr.setSourceRGB(r, g, b);
            drawCells(form.footCells);
            cr.fill();
        } else {
            // Crossfade. Split each cell list by row range too.
            let bothCells = [], onlyACells = [], onlyBCells = [];
            for (let row = 0; row < ROWS; row++) {
                for (let col = 0; col < COLS; col++) {
                    let inA = isFilled(formA.pixels, row, col);
                    let inB = isFilled(formB.pixels, row, col);
                    if (inA && inB) bothCells.push([row, col]);
                    else if (inA) onlyACells.push([row, col]);
                    else if (inB) onlyBCells.push([row, col]);
                }
            }

            // BODY rows (0..3) — with breath
            cr.save();
            applyBreath();
            cr.setSourceRGBA(r, g, b, 1);
            drawCellsFiltered(bothCells, 0, 4); cr.fill();
            if (onlyACells.length) {
                cr.setSourceRGBA(r, g, b, 1 - t);
                drawCellsFiltered(onlyACells, 0, 4); cr.fill();
            }
            if (onlyBCells.length) {
                cr.setSourceRGBA(r, g, b, t);
                drawCellsFiltered(onlyBCells, 0, 4); cr.fill();
            }
            cr.restore();

            // FEET rows (4..end) — no breath
            cr.setSourceRGBA(r, g, b, 1);
            drawCellsFiltered(bothCells, 4, ROWS); cr.fill();
            if (onlyACells.length) {
                cr.setSourceRGBA(r, g, b, 1 - t);
                drawCellsFiltered(onlyACells, 4, ROWS); cr.fill();
            }
            if (onlyBCells.length) {
                cr.setSourceRGBA(r, g, b, t);
                drawCellsFiltered(onlyBCells, 4, ROWS); cr.fill();
            }
        }

        cr.restore();
        cr.$dispose();
    }

    _repaint() { this._clawd.queue_repaint(); }

    // ───────── Animations ─────────
    // Breathing — smooth (12 fps) when on-screen, zero work when off-screen.
    // The `actor.mapped` check is the killer optimization: Cinnamon hides the
    // panel during fullscreen apps / autohide / screen-off and we do nothing.
    _startBreathing() {
        if (this._breathTickId) return;
        const TICK_MS = 80;        // ~12 fps — smooth slow motion
        const PERIOD_MS = 4000;    // full inhale+exhale
        let startTime = Date.now();
        this._breathTickId = Mainloop.timeout_add(TICK_MS, () => {
            if (this.actor && this.actor.mapped === false) return true;
            let phase = ((Date.now() - startTime) % PERIOD_MS) / PERIOD_MS;
            this._state.breathT = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
            this._repaint();
            return true;
        });
    }

    _stopBreathing() {
        if (this._breathTickId) {
            Mainloop.source_remove(this._breathTickId);
            this._breathTickId = null;
        }
    }

    _scheduleBlink() {
        if (this._blinkTimeout) Mainloop.source_remove(this._blinkTimeout);
        // Blink every 4–9s when visible. Skipped silently when off-screen.
        let delay = 4 + Math.floor(Math.random() * 6);
        this._blinkTimeout = Mainloop.timeout_add_seconds(delay, () => {
            if (!this.actor || this.actor.mapped !== false) this._blink();
            this._scheduleBlink();
            return false;
        });
    }

    _blink() {
        let s = this._state;
        Tweener.removeTweens(s, "eyeOpen");
        Tweener.addTween(s, {
            eyeOpen: 0,
            time: 0.08,
            onUpdate: () => this._repaint(),
            onComplete: () => {
                // sometimes double-blink
                let dbl = Math.random() < 0.2;
                Tweener.addTween(s, {
                    eyeOpen: 1,
                    time: 0.12,
                    onUpdate: () => this._repaint(),
                    onComplete: dbl ? () => {
                        Mainloop.timeout_add(120, () => { this._blink(); return false; });
                    } : null
                });
            }
        });
    }

    _resetMotion() {
        let s = this._state;
        // Note: never touch breathT — that's owned by the breathing loop.
        Tweener.removeTweens(s, "bodyX", "bodyY", "tilt", "scaleX", "scaleY",
                                "walking", "walkPhase",
                                "excited", "morphT", "rainbowActive", "rainbowPhase",
                                "mouthVisible", "eyeShift");
        s.bodyX = 0;
        s.bodyY = 0;
        s.tilt = 0;
        s.scaleX = 1;
        s.scaleY = 1;
        s.walking = 0;
        s.walkPhase = 0;
        s.excited = 0;
        s.morphT = 0;
        s.formA = "clawd";
        s.formB = "clawd";
        s.rainbowActive = 0;
        s.rainbowPhase = 0;
        s.mouthVisible = 0;
        s.mouthShape = 0;
        s.eyeState = "normal";
        s.eyeShift = 0;
    }

    _pickAnimation() {
        const random = ["bounce", "wiggle", "squish", "shake", "tilt",
                        "walk", "excited", "morph", "glitch",
                        "wink", "yawn", "lookAround"];
        const all = random.concat(["spin", "rainbow"]);
        let style = this.animationStyle || "random";
        if (style === "random") return random[Math.floor(Math.random() * random.length)];
        return all.indexOf(style) >= 0 ? style : "bounce";
    }

    _animate() {
        if (this.animateOnRefresh === false) return;
        this._playAnimation(this._pickAnimation());
    }

    _playAnimation(name) {
        this._resetMotion();
        let fn = this["_anim_" + name];
        if (typeof fn === "function") fn.call(this, this._state);
    }

    _anim_bounce(s) {
        Tweener.addTween(s, {
            bodyY: -6,
            time: 0.18,
            transition: "easeOutQuad",
            onUpdate: () => this._repaint(),
            onComplete: () => {
                Tweener.addTween(s, {
                    bodyY: 0,
                    time: 0.4,
                    transition: "easeOutBounce",
                    onUpdate: () => this._repaint()
                });
            }
        });
    }

    _anim_wiggle(s) {
        let step = (target, time, next) => {
            Tweener.addTween(s, {
                tilt: target, time: time,
                onUpdate: () => this._repaint(),
                onComplete: next || null
            });
        };
        step(-14, 0.1, () => step(14, 0.12, () => step(-8, 0.1, () => step(0, 0.12))));
    }

    _anim_squish(s) {
        Tweener.addTween(s, {
            scaleX: 1.15, scaleY: 0.80,
            time: 0.12, transition: "easeOutQuad",
            onUpdate: () => this._repaint(),
            onComplete: () => {
                Tweener.addTween(s, {
                    scaleX: 0.90, scaleY: 1.12,
                    time: 0.18, transition: "easeOutQuad",
                    onUpdate: () => this._repaint(),
                    onComplete: () => {
                        Tweener.addTween(s, {
                            scaleX: 1, scaleY: 1,
                            time: 0.24, transition: "easeOutBounce",
                            onUpdate: () => this._repaint()
                        });
                    }
                });
            }
        });
    }

    _anim_spin(s) {
        Tweener.addTween(s, {
            tilt: 360, time: 0.7, transition: "easeInOutCubic",
            onUpdate: () => this._repaint(),
            onComplete: () => { s.tilt = 0; this._repaint(); }
        });
    }

    _anim_shake(s) {
        let steps = [5, -5, 4, -4, 2, -2, 0];
        let i = 0;
        let step = () => {
            if (i >= steps.length) return;
            Tweener.addTween(s, {
                bodyX: steps[i], time: 0.06,
                onUpdate: () => this._repaint(),
                onComplete: () => { i++; step(); }
            });
        };
        step();
    }

    _anim_tilt(s) {
        let dir = Math.random() < 0.5 ? -1 : 1;
        Tweener.addTween(s, {
            tilt: dir * 18, time: 0.25, transition: "easeOutQuad",
            onUpdate: () => this._repaint(),
            onComplete: () => {
                Mainloop.timeout_add(450, () => {
                    Tweener.addTween(s, {
                        tilt: 0, time: 0.35, transition: "easeOutBack",
                        onUpdate: () => this._repaint()
                    });
                    return false;
                });
            }
        });
    }

    // 'Walk' = alternate foot pairs lifting + tiny body bob
    _anim_walk(s) {
        s.walking = 1;
        s.walkPhase = 0;
        let steps = 0;
        let max = 4;
        let toggle = () => {
            if (steps >= max) {
                Tweener.addTween(s, {
                    walking: 0, bodyY: 0, time: 0.15,
                    onUpdate: () => this._repaint(),
                    onComplete: () => { s.walkPhase = 0; }
                });
                return;
            }
            let nextPhase = (steps % 2 === 0) ? 0.99 : 0;
            let nextBob   = (steps % 2 === 0) ? -2 : 0;
            Tweener.addTween(s, {
                walkPhase: nextPhase, bodyY: nextBob, time: 0.22,
                transition: "easeInOutQuad",
                onUpdate: () => this._repaint(),
                onComplete: () => { steps++; toggle(); }
            });
        };
        toggle();
    }

    // 'Wink' = close one eye briefly
    _anim_wink(s) {
        s.eyeState = Math.random() < 0.5 ? "wink-l" : "wink-r";
        this._repaint();
        Mainloop.timeout_add(450, () => {
            s.eyeState = "normal";
            this._repaint();
            return false;
        });
    }

    // 'Yawn' = sleepy eyes + open mouth, slight bob, then back
    _anim_yawn(s) {
        s.eyeState = "sleepy";
        s.mouthShape = 1; // "O"
        Tweener.addTween(s, {
            mouthVisible: 1, time: 0.25, transition: "easeOutQuad",
            onUpdate: () => this._repaint()
        });
        Mainloop.timeout_add(900, () => {
            Tweener.addTween(s, {
                mouthVisible: 0, time: 0.3, transition: "easeInQuad",
                onUpdate: () => this._repaint(),
                onComplete: () => {
                    s.eyeState = "normal";
                    s.mouthShape = 0;
                    this._repaint();
                }
            });
            return false;
        });
    }

    // 'LookAround' = eyes drift left then right then center
    _anim_lookAround(s) {
        Tweener.addTween(s, {
            eyeShift: 1, time: 0.25, transition: "easeOutQuad",
            onUpdate: () => this._repaint(),
            onComplete: () => {
                Mainloop.timeout_add(220, () => {
                    Tweener.addTween(s, {
                        eyeShift: -1, time: 0.35, transition: "easeInOutQuad",
                        onUpdate: () => this._repaint(),
                        onComplete: () => {
                            Mainloop.timeout_add(220, () => {
                                Tweener.addTween(s, {
                                    eyeShift: 0, time: 0.25, transition: "easeOutQuad",
                                    onUpdate: () => this._repaint()
                                });
                                return false;
                            });
                        }
                    });
                    return false;
                });
            }
        });
    }

    // 'Morph' = transform into another form, hold briefly, return to clawd
    _anim_morph(s) {
        let target = MORPH_TARGETS[Math.floor(Math.random() * MORPH_TARGETS.length)];
        s.formA = "clawd";
        s.formB = target;
        s.morphT = 0;
        Tweener.addTween(s, {
            morphT: 1, time: 0.6,
            transition: "easeInOutQuad",
            onUpdate: () => this._repaint(),
            onComplete: () => {
                Mainloop.timeout_add(1400, () => {
                    Tweener.addTween(s, {
                        morphT: 0, time: 0.5,
                        transition: "easeInOutQuad",
                        onUpdate: () => this._repaint(),
                        onComplete: () => {
                            s.formB = "clawd";
                            this._repaint();
                        }
                    });
                    return false;
                });
            }
        });
    }

    // 'Rainbow' = sweep through the rainbow palette for ~2 cycles
    _anim_rainbow(s) {
        s.rainbowActive = 1;
        s.rainbowPhase = 0;
        let cycles = 2;
        let run = () => {
            if (cycles <= 0) {
                Tweener.addTween(s, {
                    rainbowActive: 0, time: 0.3,
                    onUpdate: () => this._repaint()
                });
                return;
            }
            s.rainbowPhase = 0;
            Tweener.addTween(s, {
                rainbowPhase: 1, time: 1.2, transition: "linear",
                onUpdate: () => this._repaint(),
                onComplete: () => { cycles--; run(); }
            });
        };
        run();
    }

    // 'Glitch' = rapid random form swaps with brief shake, like he's bugging out
    _anim_glitch(s) {
        let steps = 6;
        let i = 0;
        let tick = () => {
            if (i >= steps) {
                s.formA = "clawd"; s.formB = "clawd"; s.morphT = 0;
                Tweener.addTween(s, {
                    bodyX: 0, time: 0.08,
                    onUpdate: () => this._repaint()
                });
                return;
            }
            let pick = MORPH_TARGETS[Math.floor(Math.random() * MORPH_TARGETS.length)];
            s.formA = pick;
            s.formB = pick;
            s.morphT = 0;
            s.bodyX = (Math.random() * 6 - 3);
            this._repaint();
            i++;
            Mainloop.timeout_add(70, () => { tick(); return false; });
        };
        tick();
    }

    // 'Excited' = flash to brighter orange + rapid shake
    _anim_excited(s) {
        Tweener.addTween(s, {
            excited: 1, time: 0.1,
            onUpdate: () => this._repaint()
        });
        let steps = [3, -3, 3, -3, 2, -2, 0];
        let i = 0;
        let step = () => {
            if (i >= steps.length) {
                Tweener.addTween(s, {
                    excited: 0, time: 0.3,
                    onUpdate: () => this._repaint()
                });
                return;
            }
            Tweener.addTween(s, {
                bodyX: steps[i], time: 0.05,
                onUpdate: () => this._repaint(),
                onComplete: () => { i++; step(); }
            });
        };
        step();
    }

    _scheduleIdle() {
        if (this._idleTimeout) {
            Mainloop.source_remove(this._idleTimeout);
            this._idleTimeout = null;
        }
        if (this.idleAnimations === false) return;
        let min = Math.max(3, parseInt(this.idleMinSeconds) || 12);
        let max = Math.max(min + 1, parseInt(this.idleMaxSeconds) || 22);
        let delay = min + Math.floor(Math.random() * (max - min + 1));
        this._idleTimeout = Mainloop.timeout_add_seconds(delay, () => {
            if (!this.actor || this.actor.mapped !== false) {
                this._playAnimation(this._pickAnimation());
            }
            this._scheduleIdle();
            return false;
        });
    }

    // ───────── formatting & data ─────────
    _formatCost(n) {
        if (n == null || isNaN(n)) return "$?";
        return "$" + n.toFixed(2);
    }
    _formatTokens(n) {
        if (n == null || isNaN(n)) return "?";
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
        return n.toString();
    }
    _formatDuration(minutes) {
        if (minutes == null || isNaN(minutes) || minutes < 0) return "—";
        let m = Math.floor(minutes);
        let h = Math.floor(m / 60);
        let mm = m % 60;
        if (h > 0) return h + "h " + (mm < 10 ? "0" : "") + mm + "m";
        return mm + "m";
    }
    _formatLocalTime(iso) {
        try {
            let d = new Date(iso);
            let pad = (n) => n.toString().padStart(2, "0");
            return pad(d.getHours()) + ":" + pad(d.getMinutes());
        } catch (e) { return "—"; }
    }
    _shortModel(name) { return name.replace(/^claude-/, ""); }

    _utilSection(usage) {
        if (!usage) return null;
        let mode = this.barMode || "session";
        if (mode === "session") return usage.five_hour;
        if (mode === "week") return usage.seven_day;
        if (mode === "week-sonnet") return usage.seven_day_sonnet;
        if (mode === "credits") return usage.extra_usage;
        return usage.five_hour;
    }

    _computePercent(usage) {
        let sec = this._utilSection(usage);
        if (!sec || sec.utilization == null) return 0;
        return Math.max(0, Math.min(1, sec.utilization / 100));
    }

    _barModeLabel() {
        switch (this.barMode) {
            case "week": return "week";
            case "week-sonnet": return "week (Sonnet)";
            case "credits": return "credits";
            default: return "session";
        }
    }

    // Returns minutes until reset, or null if not applicable.
    _minutesUntil(iso) {
        if (!iso) return null;
        try {
            let target = new Date(iso).getTime();
            let now = Date.now();
            if (target <= now) return 0;
            return Math.floor((target - now) / 60000);
        } catch (e) { return null; }
    }

    _formatResetIn(iso) {
        let m = this._minutesUntil(iso);
        if (m == null) return "—";
        if (m < 60) return "in " + m + " min";
        let h = Math.floor(m / 60);
        let mm = m % 60;
        if (h < 24) return "in " + h + "h " + (mm < 10 ? "0" : "") + mm + "m";
        let d = Math.floor(h / 24);
        let hh = h % 24;
        return "in " + d + "d " + hh + "h";
    }

    _formatResetAt(iso) {
        try {
            let d = new Date(iso);
            let pad = (n) => n.toString().padStart(2, "0");
            let now = new Date();
            let sameDay = d.toDateString() === now.toDateString();
            let time = pad(d.getHours()) + ":" + pad(d.getMinutes());
            if (sameDay) return "today " + time;
            let days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
            return days[d.getDay()] + " " + time;
        } catch (e) { return "—"; }
    }

    // ───────── progress bar in popup ─────────
    _roundedRect(cr, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
    }
    _drawBar(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        let radius = h / 2;

        this._roundedRect(cr, 0, 0, w, h, radius);
        cr.setSourceRGBA.apply(cr, COLOR_TRACK);
        cr.fill();

        let pct = this._computePercent(this._lastUsage);
        if (pct > 0 && !this._lastError) {
            let fillW = Math.max(h, Math.round(w * pct));
            this._roundedRect(cr, 0, 0, fillW, h, radius);
            let c = COLOR_OK;
            if (pct >= 0.85) c = COLOR_CRIT;
            else if (pct >= 0.65) c = COLOR_WARN;
            cr.setSourceRGB(c[0], c[1], c[2]);
            cr.fill();
        }
        cr.$dispose();
    }

    // ───────── menu ─────────
    _makeRow(label, value) {
        let row = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        let box = new St.BoxLayout({ vertical: false, style_class: "claude-usage-popup-row" });
        let l = new St.Label({ text: label, style_class: "claude-usage-popup-row-label" });
        let v = new St.Label({ text: value, style_class: "claude-usage-popup-row-value" });
        v.set_x_expand(true);
        v.set_x_align(Clutter.ActorAlign.END);
        box.add_actor(l);
        box.add_actor(v);
        row.addActor(box, { expand: true, span: -1 });
        return { item: row, valueLabel: v };
    }

    _updateTimeLabels() {
        for (let entry of this._timeLabels) {
            try {
                let txt = entry.updater();
                if (entry.label) entry.label.set_text(txt);
            } catch (e) { /* ignore */ }
        }
    }

    _footerText() {
        let parts = [];
        if (this._lastUpdated) {
            let ageSec = Math.floor((Date.now() - this._lastUpdated) / 1000);
            let ageStr = ageSec < 60
                ? ageSec + " s ago"
                : Math.floor(ageSec / 60) + " min ago";
            parts.push("Updated " + ageStr);
        }
        if (this._rateLimitedUntil > Date.now()) {
            let wait = this._rateLimitedUntil - Date.now();
            let str = wait < 60000
                ? Math.ceil(wait / 1000) + " s"
                : Math.ceil(wait / 60000) + " min";
            parts.push("rate-limited (retry in " + str + ")");
        } else if (this._nextRefreshAt && this._nextRefreshAt > Date.now()) {
            let until = this._nextRefreshAt - Date.now();
            let str = until < 60000
                ? Math.ceil(until / 1000) + " s"
                : Math.ceil(until / 60000) + " min";
            parts.push("next in " + str);
        }
        return parts.length ? parts.join("  ·  ") : "—";
    }

    _rebuildMenu() {
        this.menu.removeAll();
        let usage = this._lastUsage;
        let pct = Math.round(this._computePercent(usage) * 100);

        let headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        let headerText = this._lastError
            ? "Claude Code — error"
            : (usage
                ? "Claude Code · " + pct + "% " + this._barModeLabel()
                : "Claude Code · loading…");
        let header = new St.Label({ text: headerText, style_class: "claude-usage-popup-header" });
        headerItem.addActor(header, { expand: true, span: -1 });
        this.menu.addMenuItem(headerItem);

        let barItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        let barBox = new St.BoxLayout({ vertical: false, style_class: "claude-usage-popup-bar-container" });
        this._barArea = new St.DrawingArea({ width: 260, height: 10, y_align: Clutter.ActorAlign.CENTER });
        this._barArea.connect("repaint", (area) => this._drawBar(area));
        barBox.add_actor(this._barArea);
        barBox.set_x_expand(true);
        barItem.addActor(barBox, { expand: true, span: -1 });
        this.menu.addMenuItem(barItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._lastError) {
            let errItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
            let errLabel = new St.Label({ text: this._lastError });
            errItem.addActor(errLabel, { expand: true, span: -1 });
            this.menu.addMenuItem(errItem);
        } else if (!usage) {
            let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
            let lbl = new St.Label({ text: "Loading usage…" });
            item.addActor(lbl, { expand: true, span: -1 });
            this.menu.addMenuItem(item);
        } else {
            let fmtPct = (sec) => sec && sec.utilization != null ? sec.utilization.toFixed(0) + " %" : "—";
            this._timeLabels = [];

            let addDynamic = (label, fn) => {
                let row = this._makeRow(label, fn());
                this.menu.addMenuItem(row.item);
                this._timeLabels.push({ label: row.valueLabel, updater: fn });
            };

            // Session (5h) — "resets in X" is relative, update every tick
            if (usage.five_hour) {
                addDynamic("Session",
                    () => fmtPct(usage.five_hour) + "  ·  resets " + this._formatResetIn(usage.five_hour.resets_at));
            }
            // Week (all models)
            if (usage.seven_day) {
                addDynamic("Week (all)",
                    () => fmtPct(usage.seven_day) + "  ·  resets " + this._formatResetIn(usage.seven_day.resets_at));
            }
            // Week (Sonnet) — only if present
            if (usage.seven_day_sonnet) {
                addDynamic("Week (Sonnet)",
                    () => fmtPct(usage.seven_day_sonnet) + "  ·  resets " + this._formatResetIn(usage.seven_day_sonnet.resets_at));
            }
            // Week (Opus) — only if present
            if (usage.seven_day_opus) {
                addDynamic("Week (Opus)",
                    () => fmtPct(usage.seven_day_opus) + "  ·  resets " + this._formatResetIn(usage.seven_day_opus.resets_at));
            }
            // Extra credits — no time component, but use addDynamic for consistency
            let ex = usage.extra_usage;
            if (ex && ex.is_enabled) {
                let cur = ex.currency || "USD";
                let symbol = cur === "EUR" ? "€" : cur === "USD" ? "$" : (cur + " ");
                let used = (ex.used_credits / 100).toFixed(2);
                let limit = (ex.monthly_limit / 100).toFixed(0);
                this.menu.addMenuItem(this._makeRow("Credits",
                    fmtPct(ex) + "  ·  " + symbol + used + " / " + symbol + limit).item);
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Status footer: last updated + rate-limit info (updates every tick)
        let footerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        let footerLabel = new St.Label({ text: this._footerText(), style_class: "claude-usage-popup-row-label" });
        footerItem.addActor(footerLabel, { expand: true, span: -1 });
        this.menu.addMenuItem(footerItem);
        this._timeLabels.push({ label: footerLabel, updater: () => this._footerText() });

        // Force refresh — only show if cache is stale and we're not rate-limited.
        let stale = !this._lastUpdated ||
            (Date.now() - this._lastUpdated) > (4 * 60 * 1000);
        if (stale && this._rateLimitedUntil < Date.now()) {
            let refreshItem = new PopupMenu.PopupMenuItem("Refresh now");
            refreshItem.connect("activate", () => {
                this._refresh();
                this._animate();
            });
            this.menu.addMenuItem(refreshItem);
        }

        // Animation playground — clickable buttons that don't dismiss the menu.
        if (this.devMode) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let devItem = new PopupMenu.PopupSubMenuMenuItem("Animation playground");
            const anims = [
                "bounce", "wiggle", "squish", "spin", "shake", "tilt",
                "walk", "wink", "yawn", "lookAround",
                "morph", "glitch", "rainbow", "excited"
            ];
            // Grid of buttons — 2 per row, equal width via x_expand + x_align FILL.
            const PER_ROW = 2;
            for (let i = 0; i < anims.length; i += PER_ROW) {
                let row = new PopupMenu.PopupBaseMenuItem({
                    reactive: false, activate: false, hover: false
                });
                let box = new St.BoxLayout({
                    vertical: false,
                    style_class: "claude-usage-playground-row"
                });
                box.set_x_expand(true);
                for (let j = 0; j < PER_ROW; j++) {
                    if (i + j < anims.length) {
                        let name = anims[i + j];
                        let btn = new St.Button({
                            label: "▶ " + name,
                            can_focus: true,
                            style_class: "claude-usage-playground-btn"
                        });
                        btn.set_x_expand(true);
                        btn.set_x_align(Clutter.ActorAlign.FILL);
                        btn.connect("clicked", () => {
                            this._playAnimation(name);
                        });
                        box.add_actor(btn);
                    } else {
                        // Pad with an empty equal-width spacer so the last odd row
                        // doesn't have a full-width button.
                        let spacer = new St.Widget({ x_expand: true });
                        box.add_actor(spacer);
                    }
                }
                row.addActor(box, { expand: true, span: -1 });
                devItem.menu.addMenuItem(row);
            }
            this.menu.addMenuItem(devItem);
        }

        if (this._barArea) this._barArea.queue_repaint();
    }

    // ───────── /api/oauth/usage call via wrapper script ─────────
    _refresh() {
        // Skip the network call entirely while we're rate-limited.
        if (Date.now() < this._rateLimitedUntil) {
            return;
        }
        let path = this.usageScriptPath && this.usageScriptPath.length > 0
            ? this.usageScriptPath
            : APPLET_DIR + "/fetch-usage.sh";

        try {
            let proc = Gio.Subprocess.new(
                [path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (source, result) => {
                try {
                    let [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (stdout && stdout.length > 0) {
                        let data = JSON.parse(stdout.toString());
                        if (data && data.rateLimited) {
                            // 429 — back off. Double the wait each time, up to 1 hour.
                            this._backoffSeconds = Math.min(3600,
                                Math.max(120, (this._backoffSeconds || 60) * 2));
                            this._rateLimitedUntil = Date.now() + this._backoffSeconds * 1000;
                            this._lastError = "rate limited — backing off " +
                                Math.round(this._backoffSeconds / 60) + " min";
                        } else if (data && data.error) {
                            this._lastError = data.error;
                        } else {
                            this._lastUsage = data;
                            this._lastError = null;
                            this._lastUpdated = Date.now();
                            this._backoffSeconds = 0;
                            this._rateLimitedUntil = 0;
                        }
                    } else {
                        this._lastError = (stderr || "no output").toString().trim();
                    }
                } catch (e) {
                    this._lastError = "parse error: " + e.message;
                }
                this._refreshMenu();
                this._animate();
                this._updateTooltip();
            });
        } catch (e) {
            this._lastError = "spawn failed: " + e.message;
            this._refreshMenu();
            this._updateTooltip();
        }
    }

    // Called after data updates. If menu is open we don't tear it down —
    // we just queue a repaint of the bar and defer the rebuild until close.
    _refreshMenu() {
        if (this.menu && this.menu.isOpen) {
            this._pendingRebuild = true;
            if (this._barArea) this._barArea.queue_repaint();
            return;
        }
        this._rebuildMenu();
    }

    _updateTooltip() {
        if (this._lastError) {
            this.set_applet_tooltip("Claude usage — error: " + this._lastError);
            return;
        }
        let usage = this._lastUsage;
        if (!usage) {
            this.set_applet_tooltip("Claude usage · loading…");
            return;
        }
        let parts = [];
        if (usage.five_hour) parts.push("session " + usage.five_hour.utilization.toFixed(0) + "%");
        if (usage.seven_day) parts.push("week " + usage.seven_day.utilization.toFixed(0) + "%");
        if (usage.extra_usage && usage.extra_usage.is_enabled)
            parts.push("credits " + usage.extra_usage.utilization.toFixed(0) + "%");
        this.set_applet_tooltip("Claude · " + parts.join(" · "));
    }

    _reschedule() {
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
            this._timeout = null;
        }
        let interval = Math.max(60, parseInt(this.refreshSeconds) || 300);
        this._nextRefreshAt = Date.now() + interval * 1000;
        this._timeout = Mainloop.timeout_add_seconds(interval, () => {
            this._refresh();
            this._nextRefreshAt = Date.now() + interval * 1000;
            return true;
        });
    }

    // Persist the lock-screen toggle to ~/.config/clawd-lockscreen/enabled
    // and (if not currently locked) restart cinnamon-screensaver so the
    // widget re-reads the config on next launch.
    _onLockscreenToggle() {
        let val = (this.lockscreenEnabled === false) ? "0" : "1";
        let isInitial = (this._lastLockscreenVal === null);
        if (val === this._lastLockscreenVal) return;
        this._lastLockscreenVal = val;
        try {
            let dir = GLib.get_home_dir() + "/.config/clawd-lockscreen";
            let file = dir + "/enabled";
            GLib.mkdir_with_parents(dir, parseInt("755", 8));
            GLib.file_set_contents(file, val);
        } catch (e) {
            global.log && global.log("Clawd lockscreen config write failed: " + e.toString());
        }
        if (!isInitial) this._maybeRestartScreensaver();
    }

    // Restart cinnamon-screensaver — but only if it's not currently locked.
    // ALL subprocess calls are async so the Cinnamon main thread never blocks.
    _maybeRestartScreensaver() {
        try {
            let proc = Gio.Subprocess.new(
                ["cinnamon-screensaver-command", "-q"],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, null, (source, result) => {
                let isActive = false;
                try {
                    let [, stdout] = source.communicate_utf8_finish(result);
                    let txt = stdout ? stdout.toString() : "";
                    isActive = /is active/i.test(txt) && !/is inactive/i.test(txt);
                } catch (e) { /* assume not active on error */ }
                if (isActive) return; // user is currently locked — skip
                try {
                    // Match the specific main.py path so we don't hit other shells/processes.
                    Gio.Subprocess.new(
                        ["pkill", "-f", "/usr/share/cinnamon-screensaver/cinnamon-screensaver-main"],
                        Gio.SubprocessFlags.STDERR_SILENCE
                    );
                } catch (e) { /* ignore */ }
            });
        } catch (e) {
            global.log && global.log("Clawd screensaver restart failed: " + e.toString());
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this._timeout) { Mainloop.source_remove(this._timeout); this._timeout = null; }
        if (this._idleTimeout) { Mainloop.source_remove(this._idleTimeout); this._idleTimeout = null; }
        if (this._blinkTimeout) { Mainloop.source_remove(this._blinkTimeout); this._blinkTimeout = null; }
        this._stopBreathing();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    let applet = new ClaudeUsageApplet(orientation, panelHeight, instanceId);
    applet._reschedule();
    applet._scheduleIdle();
    return applet;
}
