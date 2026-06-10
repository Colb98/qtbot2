// Renders the visuals for `!nextseason`:
//   • an "item strip" PNG introducing a season's premium items (icons + names),
//   • a "badge strip" PNG showing a season's Top 1-3 badges (both leaderboards),
//   • a demo profile card flexing a Top title + badge showcase slots.
// All are static, so they're cached in-process after the first render.
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const log = require('../../logger');
const cfg = require('../config/season');
const profileCard = require('./profileCard');
const renderPool = require('./renderPool');
const { ITEM_LABELS } = require('./currency');

const EMOTES_INGAME = path.resolve(__dirname, '..', '..', 'emotes', 'ingame');
const BADGES_DIR = path.resolve(__dirname, '..', '..', 'assets', 'profile_card', 'badges');
const FONT = 'BeVietnamPro, NotoSans, NotoSansCJK, sans-serif';

const stripCache = {};   // seasonId -> Buffer
const badgeStripCache = {};   // seasonId -> Buffer
let demoCache = null;

// Shared dark-gold panel background + title used by both strips.
function paintStripFrame(ctx, W, H, TITLE_H, title) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#241a12');
    bg.addColorStop(1, '#15100b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(246,211,107,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f6d36b';
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillText(title, W / 2, TITLE_H / 2 + 6);
}

// Horizontal strip of a season's premium item icons with labels underneath.
async function renderItemsStrip(seasonId) {
    if (stripCache[seasonId]) return stripCache[seasonId];
    const s = cfg.getSeason(seasonId);
    if (!s) return null;
    profileCard.registerFonts();

    const tiers = cfg.seasonTiers(seasonId);
    const n = tiers.length;
    const ICON = 150, PAD = 36, GAP = 28, LABEL_H = 54, TITLE_H = 60;
    const W = PAD * 2 + n * ICON + (n - 1) * GAP;
    const H = TITLE_H + PAD + ICON + LABEL_H + PAD;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const nameUpper = String(s.name).toUpperCase();
    const stripTitle = nameUpper === `MÙA ${s.id}` ? `VẬT PHẨM MÙA ${s.id}` : `VẬT PHẨM MÙA ${s.id} — ${nameUpper}`;
    paintStripFrame(ctx, W, H, TITLE_H, stripTitle);

    const top = TITLE_H + PAD;
    for (let i = 0; i < n; i++) {
        const key = s.items[tiers[i]];
        const x = PAD + i * (ICON + GAP);
        try {
            const img = await loadImage(path.join(EMOTES_INGAME, `${key}.png`));
            ctx.drawImage(img, x, top, ICON, ICON);
        } catch (e) {
            ctx.strokeStyle = '#5a4a36';
            ctx.strokeRect(x, top, ICON, ICON);
        }
        ctx.fillStyle = '#f4ede2';
        ctx.font = `600 22px ${FONT}`;
        ctx.fillText(ITEM_LABELS[key] || key, x + ICON / 2, top + ICON + LABEL_H / 2 + 4);
    }
    const buf = canvas.toBuffer('image/png');
    stripCache[seasonId] = buf;
    return buf;
}

// Horizontal strip of a season's 6 Top 1-3 badges (Thiên Thưởng + Ngọc boards)
// with "Top N — <board>" labels. The badge art is gold-on-opaque-black, so it's
// composited with 'screen' to drop the black fill against the dark panel
// (same treatment as the profile-card showcase slots).
async function renderBadgeStrip(seasonId) {
    if (badgeStripCache[seasonId]) return badgeStripCache[seasonId];
    const badges = cfg.allBadgeDefs().filter(b => b.seasonId === seasonId);
    if (badges.length === 0) return null;
    // tt 1-3 first, then ngọc 1-3.
    badges.sort((a, b) => (a.board === b.board ? a.rank - b.rank : (a.board === 'tt' ? -1 : 1)));
    profileCard.registerFonts();

    const n = badges.length;
    const ICON = 170, PAD = 36, GAP = 28, LABEL_H = 70, TITLE_H = 60;
    const W = PAD * 2 + n * ICON + (n - 1) * GAP;
    const H = TITLE_H + PAD + ICON + LABEL_H + PAD;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    paintStripFrame(ctx, W, H, TITLE_H, `HUY HIỆU TOP 1-3 — MÙA ${seasonId}`);

    const top = TITLE_H + PAD;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
        const b = badges[i];
        const x = PAD + i * (ICON + GAP);
        try {
            const img = await loadImage(path.join(BADGES_DIR, `${b.id}.png`));
            ctx.save();
            ctx.globalCompositeOperation = 'lighten'; // drop the art's black fill
            ctx.drawImage(img, x, top, ICON, ICON);
            ctx.restore();
            drawn++;
        } catch (e) {
            ctx.strokeStyle = '#5a4a36';
            ctx.strokeRect(x, top, ICON, ICON);
        }
        ctx.fillStyle = '#f6d36b';
        ctx.font = `600 22px ${FONT}`;
        ctx.fillText(`Top ${b.rank}`, x + ICON / 2, top + ICON + 22);
        ctx.fillStyle = '#f4ede2';
        ctx.font = `400 18px ${FONT}`;
        ctx.fillText(`BXH ${cfg.BADGE_BOARD_LABELS[b.board]}`, x + ICON / 2, top + ICON + 50);
    }
    if (drawn === 0) return null; // no art on disk yet — skip the attachment
    const buf = canvas.toBuffer('image/png');
    badgeStripCache[seasonId] = buf;
    return buf;
}

// A demo profile card flexing a Top-1 title + badge showcase slots
// (1 item + 2 badges — shows the mix-and-match).
async function renderDemoCard() {
    if (demoCache) return demoCache;
    const player = {
        userId: 'demo', ingame: 'Đại Hiệp Vô Danh', sect: 'Huyết Hà', gender: 'm',
        wallet: {
            ngoc: 888000, lockedNgoc: 0,
            items: { cao: 6, cao5: 3, cao9: 2, thienthuong: 120, kythuong: 2, dieu: 4, nhuom: 1, phuonghoang1: 1, phuonghoang2: 1, thantrang: 1 },
            lockedItems: {}
        },
        profile: {
            gender: 'm', itemSlot1: 'cao9', itemSlot2: 's1_top_tt_1', itemSlot3: 's1_top_ngoc_1',
            showNgoc: true,
            biggestJackpot: { amount: 5000000, game: 'Slot — MEGA Jackpot', ts: Date.now() },
            selectedTitle: 's1_top1',       // Độc Bá Thương Khung
            achievementSlots: [null, null, null],
            unlockedTitles: ['s1_top1', 's1_ngoc1'],
            unlockedBadges: ['s1_top_tt_1', 's1_top_ngoc_1'],
            seasonAchievements: ['s1_own_pet3', 's1_own_thanthuplus'],
            seasonTitleSlots: ['s1_own_pet3', 's1_own_thanthuplus', null]
        },
        stats: { biggestJackpot: { amount: 5000000, game: 'Slot — MEGA Jackpot' }, wordchainRank: 1, vtvRank: 1, gameStats: {}, gachaStats: {} }
    };
    try {
        demoCache = await renderPool.renderProfileCard(player);
    } catch (e) {
        log.error('seasonTeaser: demo card render failed', e);
        return null;
    }
    return demoCache;
}

module.exports = { renderItemsStrip, renderBadgeStrip, renderDemoCard };
