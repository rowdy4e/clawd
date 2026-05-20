// Shared building blocks for the panel indicator and the lock-screen widget.
// Keeping FORMS, easing functions, and Tween in one module prevents visual
// drift between the two Clawds.

export const COLS = 18;
export const ROWS = 6;

export const FORMS = {
    clawd:   { color: [0.85, 0.47, 0.34], pixels: [
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
        "..OOOOOOOOOOOOOO..","...OOOOOOOOOOOO...",".................."
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
        "..OOOOOOOOOOOOOO..","..OOOOOOOOOOOOOO..",".................."
    ]},
    skull:   { color: [0.92, 0.92, 0.95], pixels: [
        ".....OOOOOOOO.....","....OOOOOOOOOO....","....OO.OOOO.OO....",
        ".....OOOOOOOO.....","......OOOOOO......","......O.O.O.O....."
    ]},
};

export const FORM_KEYS = Object.keys(FORMS);
export const MORPH_TARGETS = FORM_KEYS.filter(k => k !== "clawd");

// Pre-compile body/foot cell lookups so the renderer doesn't re-scan strings.
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

// ─── Tween ───
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

// ─── Pure renderer (shared between panel + lock screen) ───
// Caller supplies cairo context, canvas size, animation state object,
// and pixel size (xUnit, yUnit). State fields used: bodyX, bodyY, scaleX,
// scaleY, tilt, eyeOpen, eyeState, mouthVisible, mouthShape, walkPhase,
// walking, excited, formA, formB, morphT, breathT.
export function drawClawd(Cairo, cr, w, h, s, xUnit, yUnit) {
    try { cr.setAntialias(Cairo.Antialias.NONE); } catch (e) {}

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
    const ex = Math.max(0, Math.min(1, s.excited || 0));
    if (ex > 0) {
        r = r * (1-ex) + 0.95 * ex;
        g = g * (1-ex) + 0.35 * ex;
        b = b * (1-ex) + 0.20 * ex;
    }

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
        if (ch === 'F' && (s.walking || 0) > 0 && !morphing) {
            const lift = yUnit;
            if (s.walkPhase < 0.5 && pairA[col]) yOff = -lift;
            if (s.walkPhase >= 0.5 && pairB[col]) yOff = -lift;
            yOff = Math.round(yOff * s.walking);
        }
        cr.rectangle(originX + col*xUnit, originY + row*yUnit + yOff, xUnit, yUnit);
    };

    if (!morphing) {
        const form = (t >= 0.5) ? formB : formA;

        cr.save();
        cr.translate(0, pivotY);
        cr.scale(1, breathScale);
        cr.translate(0, -pivotY);
        cr.setSourceRGB(r, g, b);
        for (const e of form.bodyCells) pushCell(e);
        cr.fill();
        if (lc || rc) {
            const open = (lc && rc && s.eyeState === 'normal') ? (s.eyeOpen ?? 1) : 0;
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
        const mv = s.mouthVisible || 0;
        if (mv > 0.05) {
            const cols = (s.mouthShape === 1) ? [6,7,8,9,10,11] : [7,8,9,10];
            const mh = Math.max(2, Math.floor(yUnit * (s.mouthShape === 1 ? 0.7 : 0.45)));
            const my = originY + 3*yUnit + Math.floor((yUnit - mh) / 2);
            cr.setSourceRGBA(r*0.45, g*0.30, b*0.20, mv);
            for (const mc of cols) cr.rectangle(originX + mc*xUnit, my, xUnit, mh);
            cr.fill();
        }
        cr.restore();
        cr.setSourceRGB(r, g, b);
        for (const e of form.footCells) pushCell(e);
        cr.fill();
    } else {
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
        cr.save();
        cr.translate(0, pivotY); cr.scale(1, breathScale); cr.translate(0, -pivotY);
        cr.setSourceRGBA(r, g, b, 1); draw(both, 0, 4); cr.fill();
        cr.setSourceRGBA(r, g, b, 1-t); draw(onlyA, 0, 4); cr.fill();
        cr.setSourceRGBA(r, g, b, t); draw(onlyB, 0, 4); cr.fill();
        cr.restore();
        cr.setSourceRGBA(r, g, b, 1); draw(both, 4, ROWS); cr.fill();
        cr.setSourceRGBA(r, g, b, 1-t); draw(onlyA, 4, ROWS); cr.fill();
        cr.setSourceRGBA(r, g, b, t); draw(onlyB, 4, ROWS); cr.fill();
    }

    cr.restore();
}

// ─── Easing functions ───
export const easeOutQuad   = t => 1 - (1 - t) ** 2;
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
