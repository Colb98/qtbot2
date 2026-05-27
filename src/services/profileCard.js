// Profile card renderer — Discord 8:3 (1600×600) layout adapted from
// the player-card design reference (discord-card.jsx).
//
// Layout: sect background (cover, focal at 30%) + per-sect theme tint,
// big class emblem floating behind the character pose (with glow halo),
// character art anchored bottom-right, left info panel containing:
//   eyebrow row → italic player name → guild line + prestige chip →
//   hairline → 3 item slots (feathered circular crop) → ngọc line →
//   hairline → "Thành Tựu" → 3 achievement chips.
//
// Assets reused (no new art files needed):
//   assets/profile_card/character_bg/{cl,hh,tm,tt,tv,ty,ln}_bg.png
//   assets/profile_card/character_images/{sect}_{m|f}.png
//   emotes/{CL,HH,TM,TT,TV,TY,LN}.png            (class emblems)
//   emotes/ingame/{cao,cao5,cao9,...,ngoc}.png   (item icons)
//
// Fonts (bundled, Vietnamese diacritics intact):
//   CormorantGaramond-MediumItalic — showpiece name
//   Cinzel-SemiBold                 — eyebrow / class label / rank caps
//   BeVietnamPro-{Regular,Medium,SemiBold} — body + guild line

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const log = require('../../logger');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSETS_BASE = path.join(ROOT, 'assets');
const CARD_ASSETS = path.join(ASSETS_BASE, 'profile_card');
const FONTS_DIR = path.join(CARD_ASSETS, 'fonts');
const CHARACTER_IMAGES = path.join(CARD_ASSETS, 'character_images');
const CHARACTER_BG = path.join(CARD_ASSETS, 'character_bg');
const BORDERS_DIR = path.join(CARD_ASSETS, 'borders');
const EMOTES_DIR = path.join(ROOT, 'emotes');
const EMOTES_INGAME = path.join(EMOTES_DIR, 'ingame');

// ── Font registration ─────────────────────────────────────────────────────
let _fontsRegistered = false;
function registerFonts() {
    if (_fontsRegistered) return;
    const fallback = path.join(ASSETS_BASE, 'NotoSans-Regular.ttf');
    const fallbackCJK = path.join(ASSETS_BASE, 'NotoSansSC-Regular.otf');
    if (fs.existsSync(fallback)) GlobalFonts.registerFromPath(fallback, 'NotoSans');
    if (fs.existsSync(fallbackCJK)) GlobalFonts.registerFromPath(fallbackCJK, 'NotoSansCJK');

    const reg = (file, family) => {
        const p = path.join(FONTS_DIR, file);
        if (!fs.existsSync(p)) { log.warn(`profileCard: missing font ${p}`); return; }
        try { GlobalFonts.registerFromPath(p, family); }
        catch (e) { log.warn(`profileCard: failed to register ${file}: ${e.message}`); }
    };
    reg('CormorantGaramond-MediumItalic.ttf', 'CormorantGaramond');
    reg('Cinzel-SemiBold.ttf',                'Cinzel');
    reg('BeVietnamPro-Regular.ttf',           'BeVietnamPro');
    reg('BeVietnamPro-Medium.ttf',            'BeVietnamPro');
    reg('BeVietnamPro-SemiBold.ttf',          'BeVietnamPro');
    _fontsRegistered = true;
}

const FONT_BODY = `BeVietnamPro, NotoSans, NotoSansCJK, sans-serif`;
const FONT_CALLI = `CormorantGaramond, NotoSans, serif`;
const FONT_CAPS = `Cinzel, BeVietnamPro, NotoSans, serif`;

// ── Per-sect theme ────────────────────────────────────────────────────────
// Accent / glow / deep / nameShadow are tuned per sect to match the bg art.
const SECT_TO_CODE = {
    'Cửu Linh': 'cl',
    'Huyết Hà': 'hh',
    'Toái Mộng': 'tm',
    'Thần Tương': 'tt',
    'Tố Vấn': 'tv',
    'Thiết Y': 'ty',
    'Long Ngâm': 'ln'
};

const SECT_DISPLAY = {
    cl: { vi: 'Cửu Linh',   words: ['CỬU', 'LINH'],   chinese: ['九', '靈'] },
    hh: { vi: 'Huyết Hà',   words: ['HUYẾT', 'HÀ'],   chinese: ['血', '河'] },
    tm: { vi: 'Toái Mộng',  words: ['TOÁI', 'MỘNG'],  chinese: ['碎', '夢'] },
    tt: { vi: 'Thần Tương', words: ['THẦN', 'TƯƠNG'], chinese: ['神', '相'] },
    tv: { vi: 'Tố Vấn',     words: ['TỐ', 'VẤN'],     chinese: ['素', '問'] },
    ty: { vi: 'Thiết Y',    words: ['THIẾT', 'Y'],    chinese: ['鐵', '醫'] },
    ln: { vi: 'Long Ngâm',  words: ['LONG', 'NGÂM'],  chinese: ['龍', '吟'] }
};

const THEMES = {
    cl: { accent: '#cbb3e8', glow: '#a98be0', deep: '#1f0e34',
          nameShadow: { color: 'rgba(60,20,100,0.55)', blur: 28, offset: 4 } },
    hh: { accent: '#e8b06a', glow: '#ff7a3d', deep: '#3a0d0a',
          nameShadow: { color: 'rgba(120,20,12,0.55)', blur: 24, offset: 4 } },
    tm: { accent: '#a8c4d9', glow: '#7aa6c8', deep: '#14223a',
          nameShadow: { color: 'rgba(30,60,100,0.55)', blur: 26, offset: 4 } },
    tt: { accent: '#6bb6e5', glow: '#3a99d8', deep: '#0a2540',
          nameShadow: { color: 'rgba(20,60,110,0.55)', blur: 28, offset: 4 } },
    tv: { accent: '#f4b5c7', glow: '#ea91a7', deep: '#3a1424',
          nameShadow: { color: 'rgba(120,40,70,0.55)', blur: 28, offset: 4 } },
    ty: { accent: '#ffc966', glow: '#fea81c', deep: '#3a2008',
          nameShadow: { color: 'rgba(140,90,10,0.55)', blur: 26, offset: 4 } },
    ln: { accent: '#7fe8c0', glow: '#3ee5b0', deep: '#082a20',
          nameShadow: { color: 'rgba(10,90,70,0.55)', blur: 28, offset: 4 } }
};

function alphaHex(hex, a) {
    // hex like #rrggbb → rgba(r,g,b,a)
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
}

// ── Image cache ───────────────────────────────────────────────────────────
const _imageCache = new Map();
async function loadCached(filePath) {
    if (_imageCache.has(filePath)) return _imageCache.get(filePath);
    if (!fs.existsSync(filePath)) { _imageCache.set(filePath, null); return null; }
    try {
        const img = await loadImage(filePath);
        _imageCache.set(filePath, img);
        return img;
    } catch (e) {
        log.warn(`profileCard: failed to load ${filePath}: ${e.message}`);
        _imageCache.set(filePath, null);
        return null;
    }
}

// ── Item labels & icons ───────────────────────────────────────────────────
const ITEM_LABELS = {
    nhuom: 'Nhuộm',
    dieu: 'Diều',
    cao: 'Cáo',
    cao5: 'Cáo 5 Đuôi',
    cao9: 'Cáo 9 Đuôi',
    kythuong: 'Kỳ Thưởng',
    thienthuong: 'Thiên Thưởng',
    phuonghoang1: 'Băng Phượng',
    phuonghoang2: 'Hoả Phượng',
    thantrang: 'Thần Trang'
};
function itemIconPath(key) { return path.join(EMOTES_INGAME, `${key}.png`); }
function classIconPath(sectCode) {
    const map = { cl: 'CL', hh: 'HH', tm: 'TM', tt: 'TT', tv: 'TV', ty: 'TY', ln: 'LN' };
    const f = map[sectCode];
    return f ? path.join(EMOTES_DIR, `${f}.png`) : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtNum(n) { return Number(n).toLocaleString('en-US'); }

// Letter-spaced text. Canvas supports ctx.letterSpacing but it requires CSS
// length string; we just pass `${px}px`.
function setSpacing(ctx, px) {
    try { ctx.letterSpacing = `${px}px`; } catch (e) { /* older builds */ }
}

function measure(ctx, text) {
    return ctx.measureText(text).width;
}

function fitFont(ctx, text, baseSize, maxWidth, fontTemplate) {
    let size = baseSize;
    while (size > 14) {
        ctx.font = fontTemplate(size);
        if (measure(ctx, text) <= maxWidth) return size;
        size -= 2;
    }
    return size;
}

function truncateToWidth(ctx, text, maxWidth) {
    if (measure(ctx, text) <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(ctx, text.slice(0, mid) + '…') <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
}

// Draw a hairline divider — gradient from transparent → soft accent → transparent.
function drawHairline(ctx, x, y, w, accent) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, 'rgba(244,237,226,0)');
    grad.addColorStop(0.2, alphaHex(accent, 0.4));
    grad.addColorStop(0.8, alphaHex(accent, 0.4));
    grad.addColorStop(1, 'rgba(244,237,226,0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, 1);
    ctx.restore();
}

// Cover-fit an image into rect (dx,dy,dw,dh) anchored at vertical focal yPct (0..1).
function drawCover(ctx, img, dx, dy, dw, dh, yPct = 0.5) {
    const scale = Math.max(dw / img.width, dh / img.height);
    const sw = img.width * scale, sh = img.height * scale;
    const sx = dx + (dw - sw) / 2;
    const sy = dy + (dh - sh) * yPct;
    ctx.drawImage(img, sx, sy, sw, sh);
}

// Contain-fit an image into rect, anchored at (xPct, yPct) within the rect.
function drawContain(ctx, img, dx, dy, dw, dh, xPct = 0.5, yPct = 0.5) {
    const scale = Math.min(dw / img.width, dh / img.height);
    const sw = img.width * scale, sh = img.height * scale;
    const sx = dx + (dw - sw) * xPct;
    const sy = dy + (dh - sh) * yPct;
    ctx.drawImage(img, sx, sy, sw, sh);
}

// Draw an image with feathered radial mask + outer blurred halo — used for
// item showcase "badges" so square/rect art crops to a soft circle.
async function drawBadgeIcon(ctx, img, cx, cy, size, accent) {
    if (!img) return;

    // Outer blurred halo (offscreen so we can apply blur + mask without
    // bleeding settings onto the main context).
    const haloPad = Math.round(size * 0.35);
    const haloSize = size + haloPad * 2;
    const halo = createCanvas(haloSize, haloSize);
    const hctx = halo.getContext('2d');
    hctx.filter = 'blur(14px) saturate(1.15)';
    // Cover the halo canvas with the image
    const iScale = Math.max(haloSize / img.width, haloSize / img.height);
    const iw = img.width * iScale, ih = img.height * iScale;
    hctx.drawImage(img, (haloSize - iw) / 2, (haloSize - ih) / 2, iw, ih);
    hctx.filter = 'none';
    // Soft radial fade — destination-in keeps only the area inside the mask
    hctx.globalCompositeOperation = 'destination-in';
    const hgrad = hctx.createRadialGradient(haloSize / 2, haloSize / 2, haloSize * 0.18,
                                            haloSize / 2, haloSize / 2, haloSize * 0.5);
    hgrad.addColorStop(0, 'rgba(0,0,0,0.85)');
    hgrad.addColorStop(1, 'rgba(0,0,0,0)');
    hctx.fillStyle = hgrad;
    hctx.fillRect(0, 0, haloSize, haloSize);

    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.drawImage(halo, cx - haloSize / 2, cy - haloSize / 2);
    ctx.restore();

    // Inner crisp(er) circle with feathered edge.
    const core = createCanvas(size, size);
    const cctx = core.getContext('2d');
    const cScale = Math.max(size / img.width, size / img.height);
    const cw = img.width * cScale, ch = img.height * cScale;
    cctx.drawImage(img, (size - cw) / 2, (size - ch) / 2, cw, ch);
    cctx.globalCompositeOperation = 'destination-in';
    const cgrad = cctx.createRadialGradient(size / 2, size / 2, size * 0.36,
                                            size / 2, size / 2, size * 0.5);
    cgrad.addColorStop(0, 'rgba(0,0,0,1)');
    cgrad.addColorStop(0.65, 'rgba(0,0,0,1)');
    cgrad.addColorStop(1, 'rgba(0,0,0,0)');
    cctx.fillStyle = cgrad;
    cctx.fillRect(0, 0, size, size);

    ctx.drawImage(core, cx - size / 2, cy - size / 2);

    // Faint accent ring just inside the soft edge
    ctx.save();
    ctx.strokeStyle = alphaHex(accent, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

// Subtle "Nhất Mộng Giang Hồ" watermark in the top-right corner. Uses
// `difference` blend mode so the text auto-contrasts against whatever is
// behind it: bright on dark backgrounds, dark on bright ones, without ever
// screaming for attention. A medium-gray fill (≠ pure white) keeps the
// inversion strength moderate.
function drawWatermark(ctx, theme) {
    const text = 'NHẤT MỘNG GIANG HỒ';
    ctx.save();
    ctx.font = `500 italic 18px ${FONT_CALLI}`;
    setSpacing(ctx, 4);
    const w = measure(ctx, text);
    const x = CARD_W - w - 28;
    const y = 18;

    // Auto-contrast text via 'difference' — result ≈ |bg - fg|.
    // fg=160 gray → ~160 on black, ~95 on white, ~32 on mid-gray.
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = 'rgb(160,160,160)';
    ctx.fillText(text, x, y);

    // Accent underline in normal blend so the brand colour still reads.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = alphaHex(theme.accent, 0.35);
    ctx.fillRect(x - 14, y + 14, w + 8, 1);

    setSpacing(ctx, 0);
    ctx.restore();
}

// Faded, enlarged silhouette of the character pose — drawn BEHIND the
// regular pose as a desaturated ~50% opacity backdrop. Position constants
// are kept inline so they're easy to tweak by hand.
function drawCharacterSilhouette(ctx, charImg) {
    if (!charImg) return;

    // ── Tweak these ──────────────────────────────────────────────────────
    const SIL_SCALE      = 3.0;   // multiplier vs. the pose-box contain-fit
    const SIL_OPACITY    = 0.5;
    const SIL_SATURATION = 0.2;   // 0 = grayscale, 1 = original
    // Anchored at the same bottom-right point as the character pose box.
    const POSE_BOX_X = CARD_W - 1100 + 80;   // = 580
    const POSE_BOX_Y = 0;
    const POSE_BOX_W = 1100;
    const POSE_BOX_H = CARD_H;
    // ─────────────────────────────────────────────────────────────────────

    const fitScale = Math.min(POSE_BOX_W / charImg.width, POSE_BOX_H / charImg.height);
    const w = charImg.width  * fitScale * SIL_SCALE;
    const h = charImg.height * fitScale * SIL_SCALE;
    const x = (POSE_BOX_X + POSE_BOX_W) - w + 0.5 * CARD_W;   // anchor right
    const y = (POSE_BOX_Y + POSE_BOX_H) - h + 0.6 * h;   // anchor bottom

    ctx.save();
    ctx.globalAlpha = SIL_OPACITY;
    ctx.filter = `saturate(${SIL_SATURATION})`;
    ctx.drawImage(charImg, x, y, w, h);
    ctx.filter = 'none';
    ctx.restore();
}

// Decorative class emblem floating behind character — frosted-glass icon
// with colored glow halo.
async function drawClassEmblem(ctx, sectCode, theme) {
    const iconPath = classIconPath(sectCode);
    if (!iconPath) return;
    const icon = await loadCached(iconPath);
    if (!icon) return;

    const cx = 1100, cy = 280;
    const size = 640;
    const haloSize = Math.round(size * 1.3);

    // Soft halo behind icon
    ctx.save();
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloSize / 2);
    halo.addColorStop(0, alphaHex(theme.glow, 0.32));
    halo.addColorStop(0.25, alphaHex(theme.glow, 0.15));
    halo.addColorStop(0.6, alphaHex(theme.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Icon — low opacity, blurred slightly, with the glow color cast onto it.
    const emblem = createCanvas(size, size);
    const ectx = emblem.getContext('2d');
    const eScale = Math.min(size / icon.width, size / icon.height);
    const ew = icon.width * eScale, eh = icon.height * eScale;
    ectx.drawImage(icon, (size - ew) / 2, (size - eh) / 2, ew, eh);

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.shadowColor = theme.glow;
    // ctx.shadowBlur = 60;
    ctx.drawImage(emblem, cx - size / 2, cy - size / 2);
    // ctx.shadowBlur = 16;
    ctx.drawImage(emblem, cx - size / 2, cy - size / 2);
    ctx.restore();
}

// Tiny SVG-equivalent ornament glyphs (crown / coin / diamond) drawn by hand.
function drawGlyph(ctx, kind, cx, cy, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    if (kind === 'crown') {
        const r = size / 2;
        const pts = [
            [0, -r], [r * 0.43, -r * 0.28], [r, -r * 0.28],
            [r * 0.5, r * 0.14], [r * 0.71, r * 0.71], [0, r * 0.36],
            [-r * 0.71, r * 0.71], [-r * 0.5, r * 0.14], [-r, -r * 0.28],
            [-r * 0.43, -r * 0.28]
        ];
        ctx.beginPath();
        ctx.moveTo(cx + pts[0][0], cy + pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(cx + pts[i][0], cy + pts[i][1]);
        ctx.closePath();
        ctx.fill();
    } else if (kind === 'coin') {
        const r = size / 2 * 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.36, 0, Math.PI * 2);
        ctx.fill();
    } else { // diamond
        const r = size / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.stroke();
        const r2 = r * 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r2);
        ctx.lineTo(cx + r2, cy);
        ctx.lineTo(cx, cy + r2);
        ctx.lineTo(cx - r2, cy);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

// Small ngọc octagon glyph (matches NgocGlyph in shared.jsx).
function drawNgocGlyph(ctx, cx, cy, size, theme) {
    const r = size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.78, cy - r * 0.34);
    ctx.lineTo(cx + r * 0.56, cy + r);
    ctx.lineTo(cx - r * 0.56, cy + r);
    ctx.lineTo(cx - r * 0.78, cy - r * 0.34);
    ctx.closePath();
    ctx.fillStyle = alphaHex(theme.accent, 0.2);
    ctx.fill();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.42, cy - r * 0.34);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - r * 0.42, cy - r * 0.34);
    ctx.closePath();
    ctx.fillStyle = alphaHex(theme.accent, 0.55);
    ctx.fill();
    ctx.restore();
}

// Border-with-glass-fill chip (used for prestige + achievement chips).
function drawChip(ctx, x, y, w, h, theme, { gradient = true } = {}) {
    ctx.save();
    if (gradient) {
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, alphaHex(theme.accent, 0.18));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
    } else {
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, 'rgba(0,0,0,0.32)');
        g.addColorStop(1, 'rgba(0,0,0,0.18)');
        ctx.fillStyle = g;
    }
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = alphaHex(theme.accent, 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
}

// ── Card dims ─────────────────────────────────────────────────────────────
const CARD_W = 1600;
const CARD_H = 600;

async function renderProfileCard(player /* avatarBuffer ignored — reference design has no avatar */ ) {
    registerFonts();

    const sectCode = SECT_TO_CODE[player.sect] || 'hh';
    const theme = THEMES[sectCode] || THEMES.hh;
    const display = SECT_DISPLAY[sectCode] || SECT_DISPLAY.hh;

    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';

    // 1. Background — cover with vertical focal at 30%
    const bgImg = await loadCached(path.join(CHARACTER_BG, `${sectCode}_bg.png`));
    if (bgImg) {
        drawCover(ctx, bgImg, 0, 0, CARD_W, CARD_H, 0.3);
    } else {
        ctx.fillStyle = '#0a0807';
        ctx.fillRect(0, 0, CARD_W, CARD_H);
    }

    // 2. Left dark gradient — fades to right
    {
        const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H * 0.18);
        // Approximation of `linear-gradient(100deg, ...)` — 100° points right-and-down slightly.
        // We use the same stops for the gradient line direction.
        const grad = ctx.createLinearGradient(0, CARD_H * 0.5, CARD_W * 0.62, CARD_H * 0.5 - CARD_W * 0.62 * Math.tan((10 / 180) * Math.PI));
        grad.addColorStop(0, 'rgba(8,5,4,0.86)');
        grad.addColorStop(0.26, 'rgba(8,5,4,0.62)');
        grad.addColorStop(0.46, 'rgba(8,5,4,0.22)');
        grad.addColorStop(0.62, 'rgba(8,5,4,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, CARD_W, CARD_H);
        // The unused g local is just to silence linters about double-gradient idea
        void g;
    }

    // 3. Bottom shade
    {
        const g = ctx.createLinearGradient(0, CARD_H * 0.6, 0, CARD_H);
        g.addColorStop(0, 'rgba(8,5,4,0)');
        g.addColorStop(1, 'rgba(8,5,4,0.45)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, CARD_W, CARD_H);
    }

    // 4. Class emblem — back layer behind character pose
    await drawClassEmblem(ctx, sectCode, theme);

    // 4b. Watermark — sits above class emblem layer in the top-right
    drawWatermark(ctx, theme);

    // 5. Character pose — right -80, top 0, bottom 0, width 1100,
    //    contain-fit anchored right bottom. A faded oversized silhouette of
    //    the same image is drawn first as a back-layer atmosphere.
    const gender = player.gender === 'f' ? 'f' : 'm';
    const charImg = await loadCached(path.join(CHARACTER_IMAGES, `${sectCode}_${gender}.png`));
    if (charImg) {
        // Silhouette back-layer — 3x size, desaturated, ~0.5 opacity.
        drawCharacterSilhouette(ctx, charImg);

        const boxX = CARD_W - 1100 + 80; // = 580
        const boxY = 0;
        const boxW = 1100;
        const boxH = CARD_H;
        // Drop shadow under the figure
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 10;
        drawContain(ctx, charImg, boxX, boxY, boxW, boxH, 1, 1);
        ctx.restore();
    }

    // 6. Info panel — left 50, top 44, width 720
    const PX = 50, PY = 44, PW = 720;
    let cursorY = PY;

    // 6a. Eyebrow row — hairline tick + "THẺ NHÂN VẬT" + diamond + class name
    {
        // hairline tick
        ctx.save();
        ctx.fillStyle = alphaHex(theme.accent, 0.7);
        ctx.fillRect(PX, cursorY + 8, 22, 1);
        ctx.restore();

        ctx.font = `600 12px ${FONT_CAPS}`;
        setSpacing(ctx, 4.5);
        ctx.fillStyle = theme.accent;
        ctx.fillText('THẺ NHÂN VẬT', PX + 32, cursorY + 3);

        const lblW = measure(ctx, 'THẺ NHÂN VẬT');
        setSpacing(ctx, 0);

        // diamond ornament
        const diamCx = PX + 32 + lblW + 16;
        const diamCy = cursorY + 8;
        ctx.save();
        ctx.translate(diamCx, diamCy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = alphaHex(theme.accent, 0.7);
        ctx.fillRect(-2.5, -2.5, 5, 5);
        ctx.restore();

        // class label (Vietnamese caps)
        const classLabel = display.vi.toUpperCase();
        ctx.font = `600 12px ${FONT_CAPS}`;
        setSpacing(ctx, 4.5);
        ctx.fillStyle = alphaHex('#f4ede2', 0.45);
        ctx.fillText(classLabel, diamCx + 16, cursorY + 3);
        setSpacing(ctx, 0);
    }
    cursorY += 22;

    // 6b. Player name — big italic Cormorant Garamond
    {
        const name = player.ingame || 'Vô Danh';
        const maxW = PW - 20;
        const size = fitFont(ctx, name, 88, maxW, (s) => `500 italic ${s}px ${FONT_CALLI}`);
        ctx.font = `500 italic ${size}px ${FONT_CALLI}`;
        ctx.save();
        ctx.shadowColor = theme.nameShadow.color;
        ctx.shadowBlur = theme.nameShadow.blur;
        ctx.shadowOffsetY = theme.nameShadow.offset;
        ctx.fillStyle = '#f4ede2';
        ctx.fillText(name, PX, cursorY);
        // a second pass without shadow for crispness on glyph centers
        ctx.shadowColor = 'transparent';
        ctx.fillText(name, PX, cursorY);
        ctx.restore();
        cursorY += size * 0.96 + 6;
    }

    // 6c. Guild + prestige chip — inline
    {
        const guildText = `《 ${display.vi} 》`;
        ctx.font = `500 22px ${FONT_CALLI}`;
        ctx.fillStyle = alphaHex('#f4ede2', 0.74);
        const gW = measure(ctx, guildText);
        ctx.fillText(guildText, PX, cursorY + 2);

        const prestige = (player.profile && player.profile.selectedTitle) || 'Nhất Mộng Giang Hồ';
        const chipPadX = 12, chipPadY = 6;
        const chipFontSize = 11;
        ctx.font = `600 ${chipFontSize}px ${FONT_CAPS}`;
        setSpacing(ctx, 3);
        const labelText = prestige.toUpperCase();
        const labelW = measure(ctx, labelText);
        const glyphSize = 12;
        const chipW = chipPadX * 2 + glyphSize + 10 + labelW;
        const chipH = chipPadY * 2 + chipFontSize + 4;
        const chipX = PX + gW + 14;
        const chipY = cursorY + 4;
        drawChip(ctx, chipX, chipY, chipW, chipH, theme);
        drawGlyph(ctx, 'crown', chipX + chipPadX + glyphSize / 2, chipY + chipH / 2, glyphSize, theme.accent);
        ctx.fillStyle = theme.accent;
        ctx.fillText(labelText, chipX + chipPadX + glyphSize + 10, chipY + chipPadY + 1);
        setSpacing(ctx, 0);

        cursorY += 32;
    }

    // 6d. Hairline
    cursorY += 12;
    drawHairline(ctx, PX, cursorY, 480, theme.accent);
    cursorY += 16;

    // 6e. Item showcase row — 3 compact slots: icon + ×qty only.
    {
        const slotKeys = [
            player.profile && player.profile.itemSlot1,
            player.profile && player.profile.itemSlot2,
            player.profile && player.profile.itemSlot3
        ];
        const badgeSize = 64;
        const slotW = 150;            // tighter — no name label, just qty
        for (let i = 0; i < 3; i++) {
            const key = slotKeys[i];
            const sx = PX + i * slotW;
            const sy = cursorY;
            const cx = sx + badgeSize / 2;
            const cy = sy + badgeSize / 2;

            if (!key) continue;
            const qty = (player.wallet && (
                (player.wallet.items && player.wallet.items[key] || 0) +
                (player.wallet.lockedItems && player.wallet.lockedItems[key] || 0)
            )) || 0;
            if (qty <= 0) continue;

            const iconImg = await loadCached(itemIconPath(key));
            await drawBadgeIcon(ctx, iconImg, cx, cy, badgeSize, theme.accent);

            // ×qty — vertically centered next to the badge
            ctx.font = `600 22px ${FONT_CAPS}`;
            setSpacing(ctx, 0.6);
            ctx.fillStyle = theme.accent;
            const qtyText = `×${fmtNum(qty)}`;
            const qtyW = measure(ctx, qtyText);
            ctx.fillText(qtyText, sx + badgeSize + 10, cy - 12);
            setSpacing(ctx, 0);
            void qtyW;
        }
        cursorY += badgeSize + 14;
    }

    // 6f. Ngọc line (optional)
    if (player.profile && player.profile.showNgoc) {
        const ngocTotal = (player.wallet && (player.wallet.ngoc || 0) + (player.wallet.lockedNgoc || 0)) || 0;
        const x = PX;
        const y = cursorY;

        // Ngọc icon — real PNG at assets/ngoc_hq.png, falls back to the
        // procedural octagon glyph if the file is missing.
        const ngocIcon = await loadCached(path.join(ASSETS_BASE, 'ngoc_hq.png'));
        const iconSize = 24;
        if (ngocIcon) {
            ctx.drawImage(ngocIcon, x, y - 2, iconSize, iconSize);
        } else {
            drawNgocGlyph(ctx, x + iconSize / 2, y + 9, 16, theme);
        }

        ctx.font = `400 11px ${FONT_CAPS}`;
        setSpacing(ctx, 3.5);
        ctx.fillStyle = alphaHex('#f4ede2', 0.45);
        ctx.fillText('NGỌC', x + iconSize + 8, y + 4);
        const lblW = measure(ctx, 'NGỌC');
        setSpacing(ctx, 0);

        ctx.font = `600 20px ${FONT_CAPS}`;
        setSpacing(ctx, 0.4);
        ctx.fillStyle = theme.accent;
        ctx.fillText(ngocTotal.toLocaleString('en-US'), x + iconSize + 8 + lblW + 14, y - 1);
        setSpacing(ctx, 0);
        cursorY += 28;
    }

    // 6g. Bottom block — achievements section anchored to panel bottom
    const PANEL_BOTTOM = CARD_H - 36;
    {
        const achLabelY = PANEL_BOTTOM - 78;

        // Hairline above
        drawHairline(ctx, PX, achLabelY - 12, 480, theme.accent);

        // "THÀNH TỰU"
        ctx.font = `600 11px ${FONT_CAPS}`;
        setSpacing(ctx, 4.5);
        ctx.fillStyle = alphaHex('#f4ede2', 0.45);
        ctx.fillText('THÀNH TỰU', PX, achLabelY);
        const lblW = measure(ctx, 'THÀNH TỰU');
        setSpacing(ctx, 0);
        // Trailing rule
        ctx.save();
        ctx.fillStyle = alphaHex(theme.accent, 0.22);
        ctx.fillRect(PX + lblW + 10, achLabelY + 6, 480 - lblW - 10, 1);
        ctx.restore();

        // Achievement chips
        const stats = player.stats || {};
        const chips = [];
        if (stats.wordchainRank) {
            chips.push({ glyph: 'crown', label: 'Top Nối Từ', rank: `#${stats.wordchainRank}` });
        } else {
            chips.push({ glyph: 'crown', label: 'Top Nối Từ', rank: '—' });
        }
        if (stats.vtvRank) {
            chips.push({ glyph: 'coin', label: 'Vua Tiếng Việt', rank: `#${stats.vtvRank}` });
        } else {
            chips.push({ glyph: 'coin', label: 'Vua Tiếng Việt', rank: '—' });
        }
        if (stats.biggestJackpot && stats.biggestJackpot.amount > 0) {
            chips.push({ glyph: 'diamond', label: 'Jackpot Lớn Nhất', rank: fmtNum(stats.biggestJackpot.amount) });
        } else {
            chips.push({ glyph: 'diamond', label: 'Jackpot Lớn Nhất', rank: '★' });
        }

        // 2-line chip: line 1 = title (small caps), line 2 = value (large).
        // Glyph on the left, vertical divider, then stacked text on the right.
        const chipH = 60;
        const chipBlockW = 540;                 // total horizontal real estate
        const chipGap = 12;
        const chipW = Math.floor((chipBlockW - chipGap * (chips.length - 1)) / chips.length);
        const chipY = PANEL_BOTTOM - chipH;
        let chipX = PX;

        for (const a of chips) {
            if (chipX + chipW > PX + PW) break; // don't overflow

            drawChip(ctx, chipX, chipY, chipW, chipH, theme, { gradient: false });

            // Glyph — left side
            const glyphSize = 18;
            drawGlyph(ctx, a.glyph, chipX + 22, chipY + chipH / 2, glyphSize, theme.accent);

            // Vertical divider after glyph
            ctx.save();
            ctx.strokeStyle = alphaHex(theme.accent, 0.4);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(chipX + 44, chipY + 10);
            ctx.lineTo(chipX + 44, chipY + chipH - 10);
            ctx.stroke();
            ctx.restore();

            const textX = chipX + 54;
            const textMaxW = chipW - 64;

            // Line 1 — title (uppercase, letter-spaced)
            ctx.font = `600 10px ${FONT_CAPS}`;
            setSpacing(ctx, 2);
            ctx.fillStyle = alphaHex('#f4ede2', 0.6);
            ctx.fillText(truncateToWidth(ctx, a.label.toUpperCase(), textMaxW), textX, chipY + 12);
            setSpacing(ctx, 0);

            // Line 2 — value (accent, larger)
            ctx.font = `600 20px ${FONT_CAPS}`;
            setSpacing(ctx, 0.5);
            ctx.fillStyle = theme.accent;
            ctx.fillText(truncateToWidth(ctx, a.rank, textMaxW), textX, chipY + 30);
            setSpacing(ctx, 0);

            chipX += chipW + chipGap;
        }
    }

    // 7. Reserved badge region hook (no-op for shop). Kept for the spec —
    // the renderer already does circular-crop + blurred edge via
    // drawBadgeIcon(), so wiring in player.profile.badgeSlots[] later is
    // a 5-line addition above the achievement row.
    // eslint-disable-next-line no-unused-vars
    const _badgeHook = null;

    // 8. Rounded corners on the final image — mask the whole canvas to a
    // rounded-rect via destination-in compositing.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    const r = 18;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(CARD_W - r, 0);
    ctx.quadraticCurveTo(CARD_W, 0, CARD_W, r);
    ctx.lineTo(CARD_W, CARD_H - r);
    ctx.quadraticCurveTo(CARD_W, CARD_H, CARD_W - r, CARD_H);
    ctx.lineTo(r, CARD_H);
    ctx.quadraticCurveTo(0, CARD_H, 0, CARD_H - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    return canvas.toBuffer('image/png');
}

// Stats computation — unchanged.
function computeStats(guildId, userId, profileData) {
    let wordchainRank = null, wordchainTotal = null, wordchainBest = null;
    let vtvRank = null, vtvTotal = null, vtvWords = null;
    try {
        const wce = require('./wordchainEng');
        const top = wce.getLifetimeTop(guildId, 9999);
        wordchainTotal = top.length;
        for (let i = 0; i < top.length; i++) {
            if (top[i][0] === userId) { wordchainRank = i + 1; wordchainBest = top[i][1]; break; }
        }
    } catch (e) { /* service not available */ }
    try {
        const vtv = require('./vuaTiengViet');
        const top = vtv.getLifetimeTop(guildId, 9999);
        vtvTotal = top.length;
        for (let i = 0; i < top.length; i++) {
            if (top[i][0] === userId) {
                vtvRank = i + 1;
                vtvWords = top[i][1] && top[i][1].words;
                break;
            }
        }
    } catch (e) { /* service not available */ }
    return {
        biggestJackpot: profileData && profileData.biggestJackpot,
        wordchainRank, wordchainTotal, wordchainBest,
        vtvRank, vtvTotal, vtvWords
    };
}

module.exports = {
    renderProfileCard,
    computeStats,
    registerFonts,
    SECT_TO_CODE,
    ITEM_LABELS,
    CARD_W,
    CARD_H
};
