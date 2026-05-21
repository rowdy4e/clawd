// Shared building blocks for the GNOME extension panel indicator.
// Mirror of the Cinnamon refactor — loads forms + animations from JSON,
// supports per-form palettes, row counts, and content centering. Keeps
// FORMS/Tween/drawClawd/easings exported for compatibility with extension.js.

import Gio from 'gi://Gio';

// ─── JSON loading ────────────────────────────────────────────────────────
function _loadJSON(filename) {
    // import.meta.url is file:///…/clawd-core.js — derive the directory and
    // read the sibling file via Gio (TextDecoder turns bytes into a string).
    const modURL = import.meta.url;
    const modPath = modURL.replace(/^file:\/\//, '');
    const dir = modPath.substring(0, modPath.lastIndexOf('/'));
    const file = Gio.File.new_for_path(`${dir}/${filename}`);
    const [, contents] = file.load_contents(null);
    return JSON.parse(new TextDecoder('utf-8').decode(contents));
}

const _SHARED_FORMS = _loadJSON('forms.json');
const _SHARED_ANIMS = _loadJSON('animations.json');

export const COLS = _SHARED_FORMS.grid.cols;
export const ROWS = _SHARED_FORMS.grid.rows;
export const FORMS = _SHARED_FORMS.forms;
export const FORM_KEYS = Object.keys(FORMS);
export const RAINBOW = (_SHARED_FORMS.palettes && _SHARED_FORMS.palettes.rainbow) || [];
export const ANIMATIONS_JSON = _SHARED_ANIMS;
const _TAGS = _SHARED_ANIMS.tags || {};

function _formAllowsContext(form, ctx) {
    if (!form.contexts) return true;
    return form.contexts.indexOf(ctx) >= 0;
}
export const MORPH_TARGETS = FORM_KEYS.filter(k =>
    k !== 'clawd' && _formAllowsContext(FORMS[k], 'panel'));
export const EASTER_EGGS = FORM_KEYS.filter(k => false);  // unused — animations.json tags drive easter-egg roll instead

// Per-form precompute. Each form gets:
//   rows, eye_row, mouth_row, pivot_row  (derived or explicit in JSON)
//   bodyCells / footCells (split by F glyph)
//   bodyByGlyph (group body cells by glyph, for multi-color render)
//   content_top / content_bottom (bounding box of filled rows for centering)
//   hasPalette
for (const key of FORM_KEYS) {
    const f = FORMS[key];
    const rows = f.rows || f.pixels.length;
    f.rows = rows;
    f.eye_row   = (f.eye_row   != null) ? f.eye_row   : Math.floor(rows / 4);
    f.mouth_row = (f.mouth_row != null) ? f.mouth_row : Math.round(rows * 0.58);
    f.pivot_row = (f.pivot_row != null) ? f.pivot_row : rows - 2;
    f.bodyCells = [];
    f.footCells = [];
    f.bodyByGlyph = {};
    f.hasPalette = !!f.palette;
    let contentTop = rows, contentBottom = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < COLS; col++) {
            const ch = f.pixels[row][col];
            if (ch === '.') continue;
            if (ch === 'F') {
                f.footCells.push([row, col, ch]);
            } else {
                f.bodyCells.push([row, col, ch]);
                if (!f.bodyByGlyph[ch]) f.bodyByGlyph[ch] = [];
                f.bodyByGlyph[ch].push([row, col, ch]);
            }
            if (row < contentTop) contentTop = row;
            if (row + 1 > contentBottom) contentBottom = row + 1;
        }
    }
    f.content_top = (contentBottom > contentTop) ? contentTop : 0;
    f.content_bottom = (contentBottom > contentTop) ? contentBottom : rows;
}

// ─── Tween ───────────────────────────────────────────────────────────────
export class Tween {
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

// ─── Rainbow color helper ────────────────────────────────────────────────
export function rainbowColor(t) {
    if (!RAINBOW.length) return [1, 1, 1];
    const n = RAINBOW.length;
    const pos = (t % 1) * (n - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = RAINBOW[i];
    const b = RAINBOW[Math.min(i + 1, n - 1)];
    return [
        a[0] * (1 - f) + b[0] * f,
        a[1] * (1 - f) + b[1] * f,
        a[2] * (1 - f) + b[2] * f,
    ];
}

// ─── Pure renderer ───────────────────────────────────────────────────────
// State fields used: bodyX, bodyY, scaleX, scaleY, tilt, eyeOpen, eyeState,
// mouthVisible, mouthShape, walkPhase, walking, excited, formA, formB, morphT,
// rainbowActive, rainbowPhase, breathT.
export function drawClawd(Cairo, cr, w, h, s, xUnit, yUnit) {
    try { cr.setAntialias(Cairo.Antialias.NONE); } catch (e) {}

    const drawW = xUnit * COLS;
    const drawH = yUnit * ROWS;
    const baseOriginX = Math.floor((w - drawW) / 2);
    let originX = baseOriginX;
    let originY = Math.floor((h - drawH) / 2);

    cr.save();
    cr.translate(w/2 + s.bodyX, h/2 + s.bodyY);
    cr.rotate(s.tilt * Math.PI / 180);
    cr.scale(s.scaleX, s.scaleY);
    cr.translate(-w/2, -h/2);

    const formA = FORMS[s.formA] || FORMS.clawd;
    const formB = FORMS[s.formB] || formA;
    const t = Math.max(0, Math.min(1, s.morphT));
    const morphing = (s.formA !== s.formB) && (t > 0.001 && t < 0.999);
    const sameGrid = (formA.rows === formB.rows);

    // Per-form geometry (picks dominant form's row count).
    const dForm = (t >= 0.5) ? formB : formA;
    const formRows = dForm.rows;
    const cellH = Math.floor(drawH / formRows);
    const eyeRow = dForm.eye_row;
    const mouthRow = dForm.mouth_row;
    const pivotRow = dForm.pivot_row;
    // Center bounding box vertically (equal top/bottom gaps).
    const topEmpty = dForm.content_top;
    const bottomEmpty = formRows - dForm.content_bottom;
    originY += Math.round((bottomEmpty - topEmpty) * cellH / 2);

    // Base color: interpolate single-color form colors; tints applied per-glyph.
    const baseColor = [
        formA.color[0] * (1 - t) + formB.color[0] * t,
        formA.color[1] * (1 - t) + formB.color[1] * t,
        formA.color[2] * (1 - t) + formB.color[2] * t,
    ];
    const applyTints = (rgb) => {
        let r = rgb[0], g = rgb[1], b = rgb[2];
        if ((s.rainbowActive || 0) > 0.01) {
            const rb = rainbowColor(s.rainbowPhase || 0);
            const k = s.rainbowActive;
            r = r * (1 - k) + rb[0] * k;
            g = g * (1 - k) + rb[1] * k;
            b = b * (1 - k) + rb[2] * k;
        }
        const mix = Math.max(0, Math.min(1, s.excited || 0));
        return [
            r * (1 - mix) + 0.95 * mix,
            g * (1 - mix) + 0.35 * mix,
            b * (1 - mix) + 0.20 * mix,
        ];
    };
    const glyphColor = (form, ch) => {
        if (form.palette && form.palette[ch]) return form.palette[ch];
        return form.color;
    };
    const [r, g, b] = applyTints(baseColor);

    // Eye state — tracks which eyes are currently closed (for eyelid line).
    let lc = false, rc = false;
    if (!morphing) {
        if (s.eyeState === 'sleepy') { lc = true; rc = true; }
        else if (s.eyeState === 'wink-l') lc = true;
        else if (s.eyeState === 'wink-r') rc = true;
        else if ((s.eyeOpen ?? 1) < 0.5) { lc = true; rc = true; }
    }

    const pairA = {4: true, 13: true};
    const pairB = {6: true, 11: true};

    const breathScale = 1 - (s.breathT || 0) * 0.05;
    const pivotY = originY + pivotRow * cellH;

    const pushCell = (entry) => {
        const row = entry[0], col = entry[1], ch = entry[2];
        if (ch === 'E') {
            const isLeft = (col === 5), isRight = (col === 12);
            if (morphing || (isLeft && lc) || (isRight && rc)) {
                cr.rectangle(originX + col*xUnit, originY + row*cellH, xUnit, cellH);
            }
            return;
        }
        let yOff = 0;
        if (ch === 'F' && (s.walking || 0) > 0 && !morphing) {
            const lift = cellH;
            if (s.walkPhase < 0.5 && pairA[col]) yOff = -lift;
            if (s.walkPhase >= 0.5 && pairB[col]) yOff = -lift;
            yOff = Math.round(yOff * s.walking);
        }
        cr.rectangle(originX + col*xUnit, originY + row*cellH + yOff, xUnit, cellH);
    };

    if (!morphing) {
        const form = (t >= 0.5) ? formB : formA;

        // BODY — iterate glyph groups for multi-color support
        cr.save();
        cr.translate(0, pivotY);
        cr.scale(1, breathScale);
        cr.translate(0, -pivotY);
        for (const ch in form.bodyByGlyph) {
            const c = applyTints(glyphColor(form, ch));
            cr.setSourceRGB(c[0], c[1], c[2]);
            for (const e of form.bodyByGlyph[ch]) pushCell(e);
            cr.fill();
        }
        // Eyelids on top
        if (lc || rc) {
            const open = (lc && rc && s.eyeState === 'normal') ? (s.eyeOpen ?? 1) : 0;
            const alpha = 1 - open;
            if (alpha > 0.05) {
                const lidH = Math.max(2, Math.floor(cellH * 0.35));
                const lidY = originY + eyeRow * cellH + Math.floor((cellH - lidH) / 2);
                const lidW = 3 * xUnit;
                cr.setSourceRGBA(r*0.25, g*0.18, b*0.15, alpha);
                if (lc) cr.rectangle(originX + 4*xUnit, lidY, lidW, lidH);
                if (rc) cr.rectangle(originX + 11*xUnit, lidY, lidW, lidH);
                cr.fill();
            }
        }
        // Mouth overlay
        const mv = s.mouthVisible || 0;
        if (mv > 0.05) {
            const cols = (s.mouthShape === 1) ? [6,7,8,9,10,11] : [7,8,9,10];
            const mh = Math.max(2, Math.floor(cellH * (s.mouthShape === 1 ? 0.7 : 0.45)));
            const my = originY + mouthRow*cellH + Math.floor((cellH - mh) / 2);
            cr.setSourceRGBA(r*0.45, g*0.30, b*0.20, mv);
            for (const mc of cols) cr.rectangle(originX + mc*xUnit, my, xUnit, mh);
            cr.fill();
        }
        cr.restore();
        // FEET — palette-aware
        const fc = applyTints(glyphColor(form, 'F'));
        cr.setSourceRGB(fc[0], fc[1], fc[2]);
        for (const e of form.footCells) pushCell(e);
        cr.fill();
    } else if (sameGrid && !formA.hasPalette && !formB.hasPalette) {
        // Same-grid single-color morph — smart cell matching crossfade.
        const both = [], onlyA = [], onlyB = [];
        for (let row = 0; row < formRows; row++) {
            for (let col = 0; col < COLS; col++) {
                const a = ['O','E','F'].includes(formA.pixels[row][col]);
                const bb = ['O','E','F'].includes(formB.pixels[row][col]);
                if (a && bb) both.push([row, col]);
                else if (a) onlyA.push([row, col]);
                else if (bb) onlyB.push([row, col]);
            }
        }
        const draw = (cells) => {
            for (const [row, col] of cells)
                cr.rectangle(originX + col*xUnit, originY + row*cellH, xUnit, cellH);
        };
        cr.save();
        cr.translate(0, pivotY); cr.scale(1, breathScale); cr.translate(0, -pivotY);
        cr.setSourceRGBA(r, g, b, 1);     draw(both);   cr.fill();
        cr.setSourceRGBA(r, g, b, 1 - t); draw(onlyA);  cr.fill();
        cr.setSourceRGBA(r, g, b, t);     draw(onlyB);  cr.fill();
        cr.restore();
    } else {
        // Cross-grid or multi-color morph — alpha-blend each form at its own
        // scale and palette.
        const drawWholeForm = (form, alpha) => {
            const fH = Math.floor(drawH / form.rows);
            const cellsByGlyph = {};
            for (let row = 0; row < form.rows; row++) {
                for (let col = 0; col < COLS; col++) {
                    const ch = form.pixels[row][col];
                    if (ch === '.' || ch === 'F') continue;
                    if (!cellsByGlyph[ch]) cellsByGlyph[ch] = [];
                    cellsByGlyph[ch].push([row, col]);
                }
            }
            for (const ch in cellsByGlyph) {
                const c = applyTints(glyphColor(form, ch));
                cr.setSourceRGBA(c[0], c[1], c[2], alpha);
                for (const [row, col] of cellsByGlyph[ch]) {
                    cr.rectangle(originX + col*xUnit, originY + row*fH, xUnit, fH);
                }
                cr.fill();
            }
        };
        cr.save();
        cr.translate(0, pivotY); cr.scale(1, breathScale); cr.translate(0, -pivotY);
        drawWholeForm(formA, 1 - t);
        drawWholeForm(formB, t);
        cr.restore();
    }

    cr.restore();
}

// ─── Easing functions ────────────────────────────────────────────────────
export const easeOutQuad   = t => 1 - (1 - t) ** 2;
export const easeInQuad    = t => t * t;
export const easeInOutQuad = t => t < 0.5 ? 2*t*t : 1 - ((-2*t+2) ** 2) / 2;
export const easeInOutCubic = t => t < 0.5 ? 4*t*t*t : 1 - ((-2*t+2) ** 3) / 2;
export const easeOutBack   = t => 1 + 2.70158 * (t-1)**3 + 1.70158 * (t-1)**2;
export const easeOutBounce = t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1/d1) return n1*t*t;
    if (t < 2/d1) { t -= 1.5/d1; return n1*t*t + 0.75; }
    if (t < 2.5/d1) { t -= 2.25/d1; return n1*t*t + 0.9375; }
    t -= 2.625/d1; return n1*t*t + 0.984375;
};
// Maps DSL easing names to easing functions.
export const EASING_BY_NAME = {
    'linear':           t => t,
    'ease_out_quad':    easeOutQuad,
    'ease_in_quad':     easeInQuad,
    'ease_in_out_quad': easeInOutQuad,
    'ease_in_out_cubic': easeInOutCubic,
    'ease_out_back':    easeOutBack,
    'ease_out_bounce':  easeOutBounce,
};
