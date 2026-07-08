// Auto-play "📊 Tổng kết" summary card renderer. Given a finished session's
// summary object (plain data — safe to pass into a render worker), produces a
// PNG stats table: win/loss counters, total won (green) / total lost (red) →
// net, biggest win, and any fortune (rút quẻ) procs.
//
// Modeled on partyImage.js. No emoji is drawn as text (canvas would render
// tofu) — the ngọc value gets a small gold coin icon (emotes/ingame/ngoc.png,
// cached) and specials use small colored square markers instead.
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const log = require('../../logger');
const { registerFonts, FONT_BODY, FONT_CAPS } = require('./profileCard');

const ROOT = path.resolve(__dirname, '..', '..');
const NGOC_ICON_PATH = path.join(ROOT, 'emotes', 'ingame', 'ngoc.png');

// ── Palette ─────────────────────────────────────────────────────────────────
const BG = '#1e1f22';
const PANEL = '#2b2d31';
const PANEL_ALT = '#313338';
const GREEN = '#2ECC71';
const RED = '#E74C3C';
const GOLD = '#F1C40F';
const PURPLE = '#a98be0';
const TEXT = '#ffffff';
const DIM = '#b5bac1';

const W = 900;
const PAD = 32;
const GAP = 16;

// #RRGGBB + alpha → rgba() so we can tint panel fills without a second palette.
function alphaHex(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function fmt(n) {
    return Number(n).toLocaleString('en-US');
}

function signed(n) {
    return `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Binary-search truncation with an ellipsis (partyImage precedent).
function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
}

let _ngocIcon;
let _ngocIconTried = false;
async function ngocIcon() {
    if (_ngocIconTried) return _ngocIcon;
    _ngocIconTried = true;
    try { _ngocIcon = await loadImage(NGOC_ICON_PATH); }
    catch (e) { log.warn(`summaryCard: ngoc icon load failed (${e.message})`); _ngocIcon = null; }
    return _ngocIcon;
}

// Section geometry (heights). Total canvas height is the sum plus paddings.
const HEADER_H = 96;
const COUNTER_H = 96;
const MONEY_ROW_H = 46;
const NET_H = 68;
const SPECIAL_HEADER_H = 34;
const SPECIAL_ROW_H = 32;

async function renderSummaryCard(summary) {
    registerFonts();
    const s = summary.stats || {};
    const net = (s.totalWin || 0) - (s.totalLoss || 0);

    const specials = [];
    if (s.reverseCount > 0) {
        specials.push({ color: PURPLE, label: `Nghịch Thiên Cải Mệnh ×${s.reverseCount}`, value: `+${fmt(s.reverseTotal || 0)}` });
    }
    if (s.jackpotCount > 0) {
        specials.push({ color: GOLD, label: `Jackpot quẻ ×${s.jackpotCount}`, value: `+${fmt(s.jackpotTotal || 0)}` });
    }
    if (s.pityCount > 0) {
        specials.push({ color: DIM, label: `Pity kích hoạt ×${s.pityCount}`, value: '' });
    }

    const moneyRows = 3;
    let height = PAD + HEADER_H + GAP + COUNTER_H + GAP + moneyRows * MONEY_ROW_H + GAP + NET_H + PAD;
    if (specials.length) {
        height += GAP + SPECIAL_HEADER_H + specials.length * SPECIAL_ROW_H;
    }

    const canvas = createCanvas(W, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, height);

    const icon = await ngocIcon();
    // Draw a small ngọc coin (or a gold dot fallback) at (x,y) sized `sz`,
    // returns the right edge so callers can lay text after it.
    const drawNgoc = (x, y, sz) => {
        if (icon) { ctx.drawImage(icon, x, y, sz, sz); }
        else { ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(x + sz / 2, y + sz / 2, sz / 2, 0, Math.PI * 2); ctx.fill(); }
        return x + sz;
    };

    const contentW = W - PAD * 2;
    let y = PAD;

    // ── Header band ──────────────────────────────────────────────────────────
    ctx.fillStyle = PANEL;
    roundRect(ctx, PAD, y, contentW, HEADER_H, 14);
    ctx.fill();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.font = `600 30px ${FONT_CAPS}`;
    ctx.fillText(truncate(ctx, `AUTO ${(summary.gameLabel || '').toUpperCase()} — TỔNG KẾT PHIÊN`, contentW - 40), PAD + 20, y + 40);

    ctx.fillStyle = DIM;
    ctx.font = `400 16px ${FONT_BODY}`;
    const sub = `Cược ${summary.betLabel} · ${summary.rounds} ${summary.unit} · ${summary.reasonText}`;
    ctx.fillText(truncate(ctx, sub, contentW - 40), PAD + 20, y + 68);

    // Gold rule at the band's foot.
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD + 20, y + HEADER_H - 14);
    ctx.lineTo(PAD + contentW - 20, y + HEADER_H - 14);
    ctx.stroke();

    y += HEADER_H + GAP;

    // ── Win / loss counters (two half panels) ────────────────────────────────
    const halfW = (contentW - GAP) / 2;
    const counter = (x, tint, accent, label, count) => {
        ctx.fillStyle = alphaHex(tint, 0.16);
        roundRect(ctx, x, y, halfW, COUNTER_H, 12);
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = accent;
        ctx.font = `700 46px ${FONT_CAPS}`;
        ctx.fillText(fmt(count), x + halfW / 2, y + 52);
        ctx.fillStyle = DIM;
        ctx.font = `600 16px ${FONT_CAPS}`;
        ctx.fillText(label, x + halfW / 2, y + 80);
    };
    counter(PAD, GREEN, GREEN, `THẮNG (${summary.unit})`, s.wins || 0);
    counter(PAD + halfW + GAP, RED, RED, `THUA (${summary.unit})`, s.losses || 0);

    y += COUNTER_H + GAP;

    // ── Money rows ───────────────────────────────────────────────────────────
    // Label left, value right (with a trailing ngọc coin). Rows alternate fills.
    const moneyRow = (i, accent, label, valueText) => {
        const ry = y + i * MONEY_ROW_H;
        ctx.fillStyle = i % 2 === 0 ? PANEL : PANEL_ALT;
        roundRect(ctx, PAD, ry, contentW, MONEY_ROW_H, 8);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = DIM;
        ctx.font = `500 18px ${FONT_BODY}`;
        ctx.fillText(label, PAD + 20, ry + MONEY_ROW_H / 2 + 6);

        const iconSz = 22;
        const iconX = PAD + contentW - 20 - iconSz;
        drawNgoc(iconX, ry + (MONEY_ROW_H - iconSz) / 2, iconSz);
        ctx.textAlign = 'right';
        ctx.fillStyle = accent;
        ctx.font = `700 20px ${FONT_CAPS}`;
        ctx.fillText(valueText, iconX - 10, ry + MONEY_ROW_H / 2 + 7);
    };
    moneyRow(0, GREEN, 'Tổng thắng', `+${fmt(s.totalWin || 0)}`);
    moneyRow(1, RED, 'Tổng thua', `−${fmt(s.totalLoss || 0)}`);
    moneyRow(2, GOLD, 'Thắng lớn nhất', `+${fmt(s.biggestPayout || 0)}`);

    y += moneyRows * MONEY_ROW_H + GAP;

    // ── Net band ─────────────────────────────────────────────────────────────
    const netAccent = net >= 0 ? GREEN : RED;
    ctx.fillStyle = alphaHex(netAccent, 0.12);
    roundRect(ctx, PAD, y, contentW, NET_H, 12);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.font = `700 24px ${FONT_CAPS}`;
    ctx.fillText('LÃI / LỖ RÒNG', PAD + 20, y + NET_H / 2 + 8);

    const netIconSz = 30;
    const netIconX = PAD + contentW - 20 - netIconSz;
    drawNgoc(netIconX, y + (NET_H - netIconSz) / 2, netIconSz);
    ctx.textAlign = 'right';
    ctx.fillStyle = netAccent;
    ctx.font = `700 40px ${FONT_CAPS}`;
    ctx.fillText(signed(net), netIconX - 12, y + NET_H / 2 + 14);

    y += NET_H;

    // ── Specials panel (only when something procced) ─────────────────────────
    if (specials.length) {
        y += GAP;
        ctx.textAlign = 'left';
        ctx.fillStyle = DIM;
        ctx.font = `600 15px ${FONT_CAPS}`;
        ctx.fillText('VẬN QUẺ ỨNG NGHIỆM', PAD + 4, y + 20);
        y += SPECIAL_HEADER_H;

        for (let i = 0; i < specials.length; i++) {
            const sp = specials[i];
            const ry = y + i * SPECIAL_ROW_H;
            ctx.fillStyle = i % 2 === 0 ? PANEL : PANEL_ALT;
            roundRect(ctx, PAD, ry, contentW, SPECIAL_ROW_H - 4, 6);
            ctx.fill();
            // Colored square marker.
            ctx.fillStyle = sp.color;
            roundRect(ctx, PAD + 14, ry + (SPECIAL_ROW_H - 4) / 2 - 6, 12, 12, 3);
            ctx.fill();
            ctx.textAlign = 'left';
            ctx.fillStyle = TEXT;
            ctx.font = `500 16px ${FONT_BODY}`;
            ctx.fillText(sp.label, PAD + 38, ry + (SPECIAL_ROW_H - 4) / 2 + 5);
            if (sp.value) {
                ctx.textAlign = 'right';
                ctx.fillStyle = sp.color;
                ctx.font = `700 16px ${FONT_CAPS}`;
                ctx.fillText(sp.value, PAD + contentW - 20, ry + (SPECIAL_ROW_H - 4) / 2 + 5);
            }
        }
    }

    return canvas.toBuffer('image/png');
}

module.exports = { renderSummaryCard };
