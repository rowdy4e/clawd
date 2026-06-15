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

const APPLET_DIR = GLib.get_home_dir() + "/.local/share/cinnamon/applets/clawd@rowdy4e";
const LOCKSCREEN_CONFIG_DIR = GLib.get_home_dir() + "/.config/clawd-lockscreen";
const LOCKSCREEN_MESSAGES_FILE = LOCKSCREEN_CONFIG_DIR + "/messages";
const LOCKSCREEN_SIZE_FILE = LOCKSCREEN_CONFIG_DIR + "/size-percent";

// Default lock-screen messages — written to the messages file on first edit
// so the user has something to start from. The widget falls back to its own
// built-in defaults if the file is missing entirely.
const DEFAULT_LOCKSCREEN_MESSAGES = [
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
    "Step away for 5 minutes. Solutions appear in the shower."
];

// ─── Pixel-art forms loaded from cinnamon/shared/forms.json ───
// Single source of truth shared with the Python lock-screen widget.
// Glyphs: 'O' body, 'E' eye gap (drawn only when blinking), 'F' foot
// (walk-animated), '.' transparent.
function _loadJSON(path) {
    const [ok, raw] = GLib.file_get_contents(path);
    if (!ok) throw new Error("can't read " + path);
    const text = (typeof raw === 'string') ? raw : imports.byteArray.toString(raw);
    return JSON.parse(text);
}
const _SHARED_FORMS = _loadJSON(APPLET_DIR + "/forms.json");
const _SHARED_ANIMS = _loadJSON(APPLET_DIR + "/animations.json");
const COLS = _SHARED_FORMS.grid.cols;
const ROWS = _SHARED_FORMS.grid.rows;
const FORMS = _SHARED_FORMS.forms;
const FORM_KEYS = Object.keys(FORMS);
// Per-form `contexts` (optional) restricts which renderer can use this form.
// e.g. {"contexts": ["lockscreen"]} = lockscreen-only HD form, hidden on panel.
// Default: form is available in both contexts.
function _formAllowsContext(form, ctx) {
    if (!form.contexts) return true;
    return form.contexts.indexOf(ctx) >= 0;
}
const MORPH_TARGETS = FORM_KEYS.filter(k =>
    k !== "clawd" && _formAllowsContext(FORMS[k], "panel"));

// Pull in the shared animation interpreter (sibling file in the applet dir).
const AnimRunnerModule = imports.ui.appletManager.applets["clawd@rowdy4e"].anim_runner;
const AnimationRunner = AnimRunnerModule.AnimationRunner;

// Maps DSL snake_case keys to the camelCase keys used by our state object.
const DSL_TO_STATE = {
    body_x: "bodyX", body_y: "bodyY",
    scale_x: "scaleX", scale_y: "scaleY",
    tilt: "tilt",
    eye_open: "eyeOpen", eye_state: "eyeState",
    mouth_visible: "mouthVisible", mouth_shape: "mouthShape",
    walk_phase: "walkPhase", walking: "walking",
    form_a: "formA", form_b: "formB", morph_t: "morphT",
    excited: "excited", eye_shift: "eyeShift",
    rainbow_active: "rainbowActive", rainbow_phase: "rainbowPhase"
};

// DSL easing names -> Tweener transition names.
const DSL_TO_TWEENER = {
    "linear":           "linear",
    "ease_out_quad":    "easeOutQuad",
    "ease_in_quad":     "easeInQuad",
    "ease_in_out_quad": "easeInOutQuad",
    "ease_in_out_cubic":"easeInOutCubic",
    "ease_out_bounce":  "easeOutBounce",
    "ease_out_back":    "easeOutBack"
};

// Rainbow palette — driven by the rainbow animation; lives in shared/forms.json
// so the lock-screen widget can reuse the exact same colors.
const RAINBOW = _SHARED_FORMS.palettes.rainbow;

function isFilled(pixels, row, col) {
    let ch = pixels[row][col];
    return ch === 'O' || ch === 'E' || ch === 'F';
}

// Pre-compile each form's filled cells into split body/foot arrays so the draw
// path doesn't pay for string indexing on every frame. Each form has its own
// row count — clawd is chunky 6-row, newer forms use 12-row for finer detail.
// Positions (eye, mouth, pivot) are derived from the row count. Also stash
// the content bounding box so the renderer can vertically center asymmetric
// forms (e.g. clawd's empty bottom row).
(function _precomputeFormCells() {
    for (let key of FORM_KEYS) {
        let form = FORMS[key];
        let rows = form.rows || form.pixels.length;
        form.rows = rows;
        form.eye_row   = (form.eye_row   != null) ? form.eye_row   : Math.floor(rows / 4);
        form.mouth_row = (form.mouth_row != null) ? form.mouth_row : Math.round(rows * 0.58);
        form.pivot_row = (form.pivot_row != null) ? form.pivot_row : rows - 2;
        form.bodyCells = [];
        form.footCells = [];
        // Multi-color support: group body cells by glyph so each can be drawn
        // with its own palette color in one fill() pass.
        form.bodyByGlyph = {};
        form.hasPalette = !!form.palette;
        let contentTop = rows, contentBottom = 0;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < COLS; col++) {
                let ch = form.pixels[row][col];
                if (ch === '.') continue;
                // 'F' cells are feet (walk-animated, no breath); everything
                // else breathes with the body.
                if (ch === 'F') {
                    form.footCells.push([row, col, ch]);
                } else {
                    form.bodyCells.push([row, col, ch]);
                    if (!form.bodyByGlyph[ch]) form.bodyByGlyph[ch] = [];
                    form.bodyByGlyph[ch].push([row, col, ch]);
                }
                if (row < contentTop) contentTop = row;
                if (row + 1 > contentBottom) contentBottom = row + 1;
            }
        }
        form.content_top = (contentBottom > contentTop) ? contentTop : 0;
        form.content_bottom = (contentBottom > contentTop) ? contentBottom : rows;
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

        this.settings = new Settings.AppletSettings(this, "clawd@rowdy4e", instanceId);
        this.settings.bind("refreshSeconds", "refreshSeconds", this._reschedule.bind(this));
        this.settings.bind("barMode", "barMode", this._rebuildMenu.bind(this));
        this.settings.bind("animationStyle", "animationStyle", () => {});
        this.settings.bind("animationFpsMode", "animationFpsMode", () => {
            // Re-arm the breath tick at the new cadence.
            this._stopBreathing();
            this._startBreathing();
        });
        this.settings.bind("animateOnRefresh", "animateOnRefresh", () => {});
        this.settings.bind("idleAnimations", "idleAnimations", this._scheduleIdle.bind(this));
        this.settings.bind("idleMinSeconds", "idleMinSeconds", this._scheduleIdle.bind(this));
        this.settings.bind("idleMaxSeconds", "idleMaxSeconds", this._scheduleIdle.bind(this));
        this.settings.bind("devMode", "devMode", this._rebuildMenu.bind(this));
        this._lastLockscreenVal = null; // unknown on init — first call won't restart
        this._lastSizeVal = null;
        this.settings.bind("lockscreenEnabled", "lockscreenEnabled", this._onLockscreenToggle.bind(this));
        this.settings.bind("lockscreenSizePercent", "lockscreenSizePercent", this._onLockscreenSize.bind(this));
        this._onLockscreenToggle(); // initial sync, no restart
        this._onLockscreenSize();   // initial sync, no restart
        // Watch the messages file — when the user saves in their editor we
        // restart cinnamon-screensaver so edits take effect on next lock.
        this._setupMessagesFileMonitor();

        // Drawing canvas sized to panel. We want the overall icon to be the
        // same physical size regardless of ROWS — so xUnit is computed against
        // a "logical 6-row" yUnit (then xUnit:yUnit_logical = 1:2 like the CLI
        // proportions used to be). The actual per-cell yUnit scales with ROWS.
        let yUnitLogical6 = Math.max(2, Math.floor((panelHeight - 4) / 6));
        let yUnit = Math.max(2, Math.floor((panelHeight - 4) / ROWS));
        let xUnit = Math.max(2, Math.floor(yUnitLogical6 / 2));
        // Horizontal headroom — accommodates squish (~1.15×) and tilt. Tight at
        // 2 cols, so extreme animations (max squish, big tilt) may clip slightly.
        let padX = 2 * xUnit;
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

        // Animation interpreter — reads shared/animations.json, drives Tweener.
        // intensityY=0.6 keeps panel bounces snug (lockscreen uses 1.0).
        this._runner = new AnimationRunner({
            state: this._state,
            addTween: (key, target, ms, ease, onComplete) => {
                let opts = {time: ms / 1000.0,
                            transition: DSL_TO_TWEENER[ease] || "linear",
                            onUpdate: () => this._repaint()};
                opts[key] = target;
                if (onComplete) opts.onComplete = onComplete;
                Tweener.addTween(this._state, opts);
            },
            timeoutAdd: (ms, fn) => Mainloop.timeout_add(ms, fn),
            randomLists: {MORPH_TARGETS: MORPH_TARGETS},
            keyMap: DSL_TO_STATE,
            animationsJson: _SHARED_ANIMS,
            intensityY: 0.6
        });

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
        this._authStale = false;    // HTTP 401 → soft "sign in expired" state, not an error
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
        // yUnit is the GLOBAL row height (for ROWS=12). Per-form cellH is computed
        // below — a 6-row form will use 2× cellH so it stays chunky.
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
        let sameGrid = (formA.rows === formB.rows);

        // Per-form geometry — picks the dominant form's row count so 6-row
        // clawd renders chunky while 12-row forms render fine-grained.
        let dForm = (t >= 0.5) ? formB : formA;
        let formRows = dForm.rows;
        let cellH = Math.floor(drawH / formRows);
        let eyeRow = dForm.eye_row;
        let mouthRow = dForm.mouth_row;
        let pivotRow = dForm.pivot_row;
        // Shift originY so the form's filled bounding box is vertically
        // centered. Equal top/bottom gaps regardless of where empty rows live
        // in the form's data.
        let topEmpty = dForm.content_top;
        let bottomEmpty = formRows - dForm.content_bottom;
        originY += Math.round((bottomEmpty - topEmpty) * cellH / 2);

        // Body color: interpolate between formA.color and formB.color. Used as
        // the default (when no palette entry for a glyph) and for derived bits
        // like eyelids/mouth.
        let baseColor = [
            formA.color[0] * (1 - t) + formB.color[0] * t,
            formA.color[1] * (1 - t) + formB.color[1] * t,
            formA.color[2] * (1 - t) + formB.color[2] * t
        ];
        // Apply rainbow + excited tints to a [r,g,b] in place.
        let applyTints = (rgb) => {
            let r = rgb[0], g = rgb[1], b = rgb[2];
            if (s.rainbowActive > 0.01) {
                let rb = rainbowColor(s.rainbowPhase);
                let k = s.rainbowActive;
                r = r * (1 - k) + rb[0] * k;
                g = g * (1 - k) + rb[1] * k;
                b = b * (1 - k) + rb[2] * k;
            }
            let mix = Math.max(0, Math.min(1, s.excited));
            return [r * (1 - mix) + 0.95 * mix,
                    g * (1 - mix) + 0.35 * mix,
                    b * (1 - mix) + 0.20 * mix];
        };
        // Resolve color for a glyph in a form (palette > form.color).
        let glyphColor = (form, ch) => {
            if (form.palette && form.palette[ch]) return form.palette[ch];
            return form.color;
        };
        let tintedBase = applyTints(baseColor);
        let r = tintedBase[0], g = tintedBase[1], b = tintedBase[2];

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
                    cr.rectangle(originX + col * xUnit, originY + row * cellH, xUnit, cellH);
                }
                return;
            }
            let yOffset = 0;
            if (ch === 'F' && s.walking > 0 && !morphing) {
                let lift = cellH;
                if (s.walkPhase < 0.5 && pairA[col]) yOffset = -lift;
                if (s.walkPhase >= 0.5 && pairB[col]) yOffset = -lift;
                yOffset = Math.round(yOffset * s.walking);
            }
            cr.rectangle(originX + col * xUnit, originY + row * cellH + yOffset, xUnit, cellH);
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
            let lidH = Math.max(2, Math.floor(cellH * 0.35));
            let lidYOffset = Math.floor((cellH - lidH) / 2);
            let lidWidth = 3 * xUnit;
            // Dark color derived from body color but much darker
            cr.setSourceRGBA(r * 0.25, g * 0.18, b * 0.15, alpha);
            if (leftEyeClosed) {
                cr.rectangle(originX + 4 * xUnit, originY + eyeRow * cellH + lidYOffset, lidWidth, lidH);
            }
            if (rightEyeClosed) {
                cr.rectangle(originX + 11 * xUnit, originY + eyeRow * cellH + lidYOffset, lidWidth, lidH);
            }
            cr.fill();
        };
        // Make it accessible from the body draw block below
        this._lastDrawEyelids = drawEyelids;

        // Breath is now a GPU transform on the actor (see _startBreathing), so it
        // is NOT redrawn here — keep these neutral to avoid applying it twice.
        let breathScale = 1;
        let breathBob = 0;
        let pivotY = originY + pivotRow * cellH;
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
                cr.rectangle(originX + col * xUnit, originY + row * cellH, xUnit, cellH);
            }
        };

        if (!morphing) {
            let form = (t >= 0.5) ? formB : formA;

            // BODY — with breath transform. Iterate glyph groups so each can
            // be drawn with its own palette color (or fallback to body color).
            cr.save();
            applyBreath();
            for (let ch in form.bodyByGlyph) {
                let c = applyTints(glyphColor(form, ch));
                cr.setSourceRGB(c[0], c[1], c[2]);
                drawCells(form.bodyByGlyph[ch]);
                cr.fill();
            }
            // Eyelid line over closed eyes
            drawEyelids();
            // Mouth lives on the body
            if (s.mouthVisible > 0.05) {
                let mouthCols, mouthH;
                if (s.mouthShape === 1) {
                    mouthCols = [6, 7, 8, 9, 10, 11];
                    mouthH = Math.max(2, Math.floor(cellH * 0.7));
                } else {
                    mouthCols = [7, 8, 9, 10];
                    mouthH = Math.max(2, Math.floor(cellH * 0.45));
                }
                let mr = r * 0.45, mg = g * 0.30, mb = b * 0.20;
                cr.setSourceRGBA(mr, mg, mb, s.mouthVisible);
                let yTopOffset = Math.floor((cellH - mouthH) / 2);
                for (let mc of mouthCols) {
                    cr.rectangle(originX + mc * xUnit, originY + mouthRow * cellH + yTopOffset, xUnit, mouthH);
                }
                cr.fill();
            }
            cr.restore();

            // FEET (rows 4..end) — no breath. Single glyph (F), but resolve
            // via palette for completeness.
            let fc = applyTints(glyphColor(form, 'F'));
            cr.setSourceRGB(fc[0], fc[1], fc[2]);
            drawCells(form.footCells);
            cr.fill();
        } else if (sameGrid && !formA.hasPalette && !formB.hasPalette) {
            // Same-grid morph: smart cell matching for a smooth crossfade.
            let bothCells = [], onlyACells = [], onlyBCells = [];
            for (let row = 0; row < formRows; row++) {
                for (let col = 0; col < COLS; col++) {
                    let inA = isFilled(formA.pixels, row, col);
                    let inB = isFilled(formB.pixels, row, col);
                    if (inA && inB) bothCells.push([row, col]);
                    else if (inA) onlyACells.push([row, col]);
                    else if (inB) onlyBCells.push([row, col]);
                }
            }
            cr.save();
            applyBreath();
            cr.setSourceRGBA(r, g, b, 1);
            drawCellsFiltered(bothCells, 0, formRows); cr.fill();
            if (onlyACells.length) {
                cr.setSourceRGBA(r, g, b, 1 - t);
                drawCellsFiltered(onlyACells, 0, formRows); cr.fill();
            }
            if (onlyBCells.length) {
                cr.setSourceRGBA(r, g, b, t);
                drawCellsFiltered(onlyBCells, 0, formRows); cr.fill();
            }
            cr.restore();
        } else {
            // Cross-grid OR multi-color morph: alpha-blend each form drawn
            // with its own palette. (Per-cell glyph matching gets nonsensical
            // when forms use different color schemes.)
            let drawWholeForm = (form, alpha) => {
                let fH = Math.floor(drawH / form.rows);
                let cellsByGlyph = {};
                for (let row = 0; row < form.rows; row++) {
                    for (let col = 0; col < COLS; col++) {
                        let ch = form.pixels[row][col];
                        if (ch === '.' || ch === 'F') continue;
                        if (!cellsByGlyph[ch]) cellsByGlyph[ch] = [];
                        cellsByGlyph[ch].push([row, col]);
                    }
                }
                for (let ch in cellsByGlyph) {
                    let c = applyTints(glyphColor(form, ch));
                    cr.setSourceRGBA(c[0], c[1], c[2], alpha);
                    for (let cell of cellsByGlyph[ch]) {
                        cr.rectangle(originX + cell[1] * xUnit, originY + cell[0] * fH, xUnit, fH);
                    }
                    cr.fill();
                }
            };
            cr.save();
            applyBreath();
            drawWholeForm(formA, 1 - t);
            drawWholeForm(formB, t);
            cr.restore();
        }

        cr.restore();
        cr.$dispose();
    }

    _repaint() { this._clawd.queue_repaint(); }

    // ───────── Animations ─────────
    // Breathing — applied as a GPU transform on the actor (vertical scale + bob),
    // NOT a Cairo redraw. So even running continuously it costs ~0 (the compositor
    // just re-composites a cached texture). `actor.mapped` still zeroes work when
    // the panel is hidden (fullscreen apps / autohide / screen-off).
    _startBreathing() {
        if (this._breathTickId) return;
        const FPS_TICK = { saver: 400, balanced: 220, smooth: 120 };
        const TICK_MS = FPS_TICK[this.animationFpsMode] || FPS_TICK.balanced;
        const PERIOD_MS = 4000;    // full inhale+exhale
        let startTime = Date.now();
        this._breathTickId = Mainloop.timeout_add(TICK_MS, () => {
            if (this.actor && this.actor.mapped === false) return true;
            let phase = ((Date.now() - startTime) % PERIOD_MS) / PERIOD_MS;
            let bt = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
            this._state.breathT = bt;
            // GPU transform around the actor centre (pivot 0.5,0.5) — no repaint.
            this._clawd.scale_y = 1 - bt * 0.05;
            this._clawd.translation_y = bt * 0.5;
            return true;
        });
    }

    _stopBreathing() {
        if (this._breathTickId) {
            Mainloop.source_remove(this._breathTickId);
            this._breathTickId = null;
        }
        if (this._clawd) { this._clawd.scale_y = 1; this._clawd.translation_y = 0; }
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
        const all = this._runner.listAnimations();
        const tags = _SHARED_ANIMS.tags || {};
        const hasTag = (n, tag) => (tags[n] || []).indexOf(tag) >= 0;
        const eggs = all.filter(n => hasTag(n, "easter_egg"));
        const pool = all.filter(n => !hasTag(n, "easter_egg"));

        let style = this.animationStyle || "random";
        if (style !== "random") {
            return all.indexOf(style) >= 0 ? style : "bounce";
        }
        // ~4% chance to roll one of the easter eggs (if any are defined).
        if (eggs.length && Math.random() < 0.04) {
            return eggs[Math.floor(Math.random() * eggs.length)];
        }
        return pool[Math.floor(Math.random() * pool.length)];
    }

    _animate() {
        if (this.animateOnRefresh === false) return;
        this._playAnimation(this._pickAnimation());
    }

    _playAnimation(name) {
        this._resetMotion();
        this._runner.play(name);
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

    // Utilization of a section as a rounded integer string, or null when the
    // section is missing / has no utilization (API sometimes returns null even
    // when a section is "enabled" — guarding here avoids .toFixed() on null).
    _utilPct(sec) {
        return (sec && sec.utilization != null) ? sec.utilization.toFixed(0) : null;
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
        let headerText = this._authStale
            ? "Claude Code · sign in expired"
            : (this._lastError
                ? "Claude Code — error"
                : (usage
                    ? "Claude Code · " + pct + "% " + this._barModeLabel()
                    : "Claude Code · loading…"));
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
            let fmtPct = (sec) => { let v = this._utilPct(sec); return v != null ? v + " %" : "—"; };
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

            // Build a 2-column grid of clickable buttons inside the given submenu.
            const buildGrid = (parentMenu, items, onClick) => {
                const PER_ROW = 2;
                for (let i = 0; i < items.length; i += PER_ROW) {
                    let row = new PopupMenu.PopupBaseMenuItem({
                        reactive: false, activate: false, hover: false
                    });
                    let box = new St.BoxLayout({
                        vertical: false,
                        style_class: "claude-usage-playground-row"
                    });
                    box.set_x_expand(true);
                    for (let j = 0; j < PER_ROW; j++) {
                        if (i + j < items.length) {
                            let it = items[i + j];
                            let btn = new St.Button({
                                label: it.label,
                                can_focus: true,
                                style_class: "claude-usage-playground-btn"
                            });
                            btn.set_x_expand(true);
                            btn.set_x_align(Clutter.ActorAlign.FILL);
                            btn.connect("clicked", () => onClick(it.value));
                            box.add_actor(btn);
                        } else {
                            // Pad with an empty equal-width spacer so the last odd
                            // row doesn't have one full-width button.
                            box.add_actor(new St.Widget({ x_expand: true }));
                        }
                    }
                    row.addActor(box, { expand: true, span: -1 });
                    parentMenu.addMenuItem(row);
                }
            };

            // Animations — derived from animations.json so newly-added entries
            // appear automatically. Easter eggs (e.g. grow) included so you
            // can trigger them on demand here.
            const anims = this._runner.listAnimations()
                .map(n => ({label: "▶ " + n, value: n}));
            buildGrid(devItem.menu, anims, name => this._playAnimation(name));

            // Morph-to: one button per form (except clawd, which is the default).
            // Each button forces the morph animation to pick that form.
            devItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let header = new PopupMenu.PopupMenuItem("Morph to…", { reactive: false });
            header.label.set_style_class_name("popup-subtitle-menu-item");
            devItem.menu.addMenuItem(header);
            const forms = MORPH_TARGETS.map(n => ({label: "◆ " + n, value: n}));
            buildGrid(devItem.menu, forms, formName => {
                this._resetMotion();
                this._runner.play("morph", null,
                    {randomLists: {MORPH_TARGETS: [formName]}});
            });

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
        let path = APPLET_DIR + "/fetch-usage.sh";

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
                            if (data.httpCode === 401) {
                                this._authStale = true;
                                this._lastError = "Sign in expired — run `claude` in a terminal once. Usage will appear after that.";
                            } else {
                                this._authStale = false;
                                this._lastError = data.error;
                            }
                        } else {
                            this._lastUsage = data;
                            this._lastError = null;
                            this._authStale = false;
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
        if (this._authStale) {
            this.set_applet_tooltip("Claude usage · sign in expired — run `claude` once");
            return;
        }
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
        let push = (label, sec) => {
            let v = this._utilPct(sec);
            if (v != null) parts.push(label + " " + v + "%");
        };
        push("session", usage.five_hour);
        push("week", usage.seven_day);
        if (usage.extra_usage && usage.extra_usage.is_enabled) push("credits", usage.extra_usage);
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

    // Persist the lock-screen size percentage and restart the screensaver
    // so the widget picks up the new size on next lock.
    _onLockscreenSize() {
        const val = String(this.lockscreenSizePercent || 100);
        const isInitial = (this._lastSizeVal === null);
        if (val === this._lastSizeVal) return;
        this._lastSizeVal = val;
        try {
            GLib.mkdir_with_parents(LOCKSCREEN_CONFIG_DIR, parseInt("755", 8));
            GLib.file_set_contents(LOCKSCREEN_SIZE_FILE, val);
        } catch (e) {
            global.log && global.log("Clawd lockscreen size write failed: " + e.toString());
        }
        if (!isInitial) this._maybeRestartScreensaver();
    }

    // Settings button — opens the messages file in the user's default text
    // editor. If the file doesn't exist yet, seed it with the defaults so the
    // user has a starting point.
    openLockscreenMessages() {
        try {
            GLib.mkdir_with_parents(LOCKSCREEN_CONFIG_DIR, parseInt("755", 8));
            if (!GLib.file_test(LOCKSCREEN_MESSAGES_FILE, GLib.FileTest.EXISTS)) {
                GLib.file_set_contents(LOCKSCREEN_MESSAGES_FILE,
                    DEFAULT_LOCKSCREEN_MESSAGES.join("\n") + "\n");
            }
            Gio.Subprocess.new(["xdg-open", LOCKSCREEN_MESSAGES_FILE],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            global.log && global.log("Clawd: open messages editor failed: " + e.toString());
        }
    }

    // Settings button — confirm, then overwrite the messages file with
    // built-in defaults. File monitor catches the change and restarts the
    // screensaver.
    resetLockscreenMessages() {
        try {
            const ModalDialog = imports.ui.modalDialog;
            let dialog = new ModalDialog.ConfirmDialog(
                "Reset lock-screen messages to the bundled defaults?\n" +
                "All your custom edits will be lost.",
                () => this._writeDefaultMessages()
            );
            dialog.open();
        } catch (e) {
            // Confirm dialog unavailable (older Cinnamon?) — fall back to
            // direct reset rather than silently failing.
            global.log && global.log("Clawd: confirm dialog failed: " + e.toString());
            this._writeDefaultMessages();
        }
    }

    _writeDefaultMessages() {
        try {
            GLib.mkdir_with_parents(LOCKSCREEN_CONFIG_DIR, parseInt("755", 8));
            GLib.file_set_contents(LOCKSCREEN_MESSAGES_FILE,
                DEFAULT_LOCKSCREEN_MESSAGES.join("\n") + "\n");
        } catch (e) {
            global.log && global.log("Clawd: reset messages failed: " + e.toString());
        }
    }

    // Watch the messages file — when the user edits it externally and saves,
    // restart cinnamon-screensaver so the widget re-reads the file next lock.
    _setupMessagesFileMonitor() {
        try {
            let file = Gio.File.new_for_path(LOCKSCREEN_MESSAGES_FILE);
            this._messagesMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._messagesMonitor.connect("changed", (mon, f, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    eventType === Gio.FileMonitorEvent.CREATED) {
                    this._maybeRestartScreensaver();
                }
            });
        } catch (e) {
            global.log && global.log("Clawd: messages file monitor setup failed: " + e.toString());
        }
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
        if (this._messagesMonitor) { this._messagesMonitor.cancel(); this._messagesMonitor = null; }
        this._stopBreathing();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    let applet = new ClaudeUsageApplet(orientation, panelHeight, instanceId);
    applet._reschedule();
    applet._scheduleIdle();
    return applet;
}
