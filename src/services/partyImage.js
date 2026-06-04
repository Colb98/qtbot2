const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const log = require('../../logger');

const ROOT = path.resolve(__dirname, '..', '..');
const FONT_PATH = path.join(ROOT, 'assets', 'NotoSans-Regular.ttf');
const FONT_CJK_PATH = path.join(ROOT, 'assets', 'NotoSansSC-Regular.otf');
const EMOTES_DIR = path.join(ROOT, 'emotes');
const FONT_STACK = 'NotoSans, NotoSansCJK';

if (!fs.existsSync(FONT_PATH)) {
    throw new Error(`Cần file font ${FONT_PATH}`);
}
GlobalFonts.registerFromPath(FONT_PATH, 'NotoSans');
if (fs.existsSync(FONT_CJK_PATH)) {
    GlobalFonts.registerFromPath(FONT_CJK_PATH, 'NotoSansCJK');
} else {
    log.warn(`Không tìm thấy ${FONT_CJK_PATH}, tên có ký tự CJK sẽ render tofu.`);
}

const CLASS_TO_FILE = {
    'Cửu Linh': 'CL.png',
    'Huyết Hà': 'HH.png',
    'Toái Mộng': 'TM.png',
    'Thần Tương': 'TT.png',
    'Tố Vấn': 'TV.png',
    'Thiết Y': 'TY.png',
    'Long Ngâm': 'LN.png'
};

const emoteCache = new Map();
async function getEmote(faction) {
    if (emoteCache.has(faction)) return emoteCache.get(faction);
    const file = CLASS_TO_FILE[faction];
    if (!file) { emoteCache.set(faction, null); return null; }
    const fp = path.join(EMOTES_DIR, file);
    try {
        const img = await loadImage(fp);
        emoteCache.set(faction, img);
        return img;
    } catch (e) {
        log.warn(`Không load được emote ${faction}: ${e.message}`);
        emoteCache.set(faction, null);
        return null;
    }
}

const BG = '#2b2d31';
const HEADER_BG = '#5865f2';
const HEADER_PUSH = '#f97316';
const SUB_HEADER_BG = '#404249';
const CELL_BG = '#313338';
const CELL_BG_ALT = '#383a40';
const BORDER = '#1e1f22';
const TEXT = '#ffffff';
const TEXT_DIM = '#b5bac1';

const CELL_W = 200;
const CELL_H = 36;
const ICON = 24;
const ICON_PAD = 8;
const PARTY_HEADER_H = 40;
const SUB_HEADER_H = 30;
const PARTY_GAP = 18;
const OUTER_PAD = 18;
const MAX_ROWS_PER_PARTY = 6;

function partyDimensions(party, subs) {
    const cols = subs.length;
    let maxRows = 0;
    for (const s of subs) if (s.length > maxRows) maxRows = s.length;
    if (maxRows < 1) maxRows = 1;
    const width = cols * CELL_W;
    const height = PARTY_HEADER_H + SUB_HEADER_H + maxRows * CELL_H;
    return { width, height, cols, rows: maxRows };
}

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

// `names` is a pre-resolved { userId: displayName } map built by the caller —
// the renderer has no Discord context (it may run in a worker thread).
async function renderArrangement(result, mode, names) {
    names = names || {};
    const subsArr = mode === 'sa' ? result.saSubs : result.greedySubs;
    const dims = result.parties.map((p, i) => partyDimensions(p, subsArr[i]));

    const contentW = Math.max(...dims.map(d => d.width));
    const totalH = OUTER_PAD * 2 + dims.reduce((s, d) => s + d.height, 0) + PARTY_GAP * (dims.length - 1);
    const canvasW = OUTER_PAD * 2 + contentW;

    const canvas = createCanvas(canvasW, totalH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvasW, totalH);

    // Preload all emotes needed
    const factionsUsed = new Set();
    for (const p of result.parties) for (const m of p.members) factionsUsed.add(m.faction);
    for (const f of factionsUsed) await getEmote(f);

    let y = OUTER_PAD;
    for (let pi = 0; pi < result.parties.length; pi++) {
        const party = result.parties[pi];
        const subs = subsArr[pi];
        const d = dims[pi];
        const x0 = OUTER_PAD + Math.floor((contentW - d.width) / 2);

        // Party header
        ctx.fillStyle = party.isDayTru ? HEADER_PUSH : HEADER_BG;
        ctx.fillRect(x0, y, d.width, PARTY_HEADER_H);
        ctx.fillStyle = TEXT;
        ctx.font = `bold 18px ${FONT_STACK}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        const title = party.isDayTru
            ? `Nhóm ${pi + 1} — Đẩy trụ (${party.members.length})`
            : `Nhóm ${pi + 1} (${party.members.length})`;
        ctx.fillText(title, x0 + d.width / 2, y + PARTY_HEADER_H / 2);

        // Sub headers
        const subY = y + PARTY_HEADER_H;
        ctx.font = `bold 14px ${FONT_STACK}`;
        for (let si = 0; si < d.cols; si++) {
            const cx = x0 + si * CELL_W;
            ctx.fillStyle = SUB_HEADER_BG;
            ctx.fillRect(cx, subY, CELL_W, SUB_HEADER_H);
            ctx.strokeStyle = BORDER;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx + 0.5, subY + 0.5, CELL_W - 1, SUB_HEADER_H - 1);
            ctx.fillStyle = TEXT;
            ctx.textAlign = 'center';
            ctx.fillText(`Đội ${si + 1}`, cx + CELL_W / 2, subY + SUB_HEADER_H / 2);
        }

        // Cells
        const cellY0 = subY + SUB_HEADER_H;
        ctx.font = `14px ${FONT_STACK}`;
        for (let si = 0; si < d.cols; si++) {
            const cx = x0 + si * CELL_W;
            const sub = subs[si] || [];
            for (let ri = 0; ri < d.rows; ri++) {
                const cy = cellY0 + ri * CELL_H;
                ctx.fillStyle = ri % 2 === 0 ? CELL_BG : CELL_BG_ALT;
                ctx.fillRect(cx, cy, CELL_W, CELL_H);
                ctx.strokeStyle = BORDER;
                ctx.strokeRect(cx + 0.5, cy + 0.5, CELL_W - 1, CELL_H - 1);

                if (ri < sub.length) {
                    const m = sub[ri];
                    const emote = await getEmote(m.faction);
                    const iconX = cx + ICON_PAD;
                    const iconY = cy + (CELL_H - ICON) / 2;
                    if (emote) {
                        ctx.drawImage(emote, iconX, iconY, ICON, ICON);
                    } else {
                        ctx.fillStyle = TEXT_DIM;
                        ctx.fillRect(iconX, iconY, ICON, ICON);
                    }
                    const textX = iconX + ICON + 8;
                    const maxTextW = CELL_W - (textX - cx) - 6;
                    const name = names[m.id] || m.id;
                    ctx.fillStyle = TEXT;
                    ctx.textAlign = 'left';
                    ctx.fillText(truncate(ctx, name, maxTextW), textX, cy + CELL_H / 2);
                }
            }
        }

        y += d.height + PARTY_GAP;
    }

    return canvas.toBuffer('image/png');
}

module.exports = { renderArrangement };
