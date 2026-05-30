// Profile data layer: stores per-user customization for the profile card
// (gender, item showcase slots, ngoc toggle, future title/border/badges)
// and the player's biggest jackpot.
//
// Storage: data.profile[guildId][userId] = {
//   gender: 'm' | 'f',
//   itemSlot1: itemKey | null,
//   itemSlot2: itemKey | null,
//   itemSlot3: itemKey | null,
//   showNgoc: boolean,
//   biggestJackpot: { amount, game, ts } | null,
//   // Reserved for future shop / title system (not yet used by UI):
//   selectedTitle: string | null,
//   selectedBorder: string | null,   // path to a border asset relative to assets/profile_card/borders/
//   badgeSlots: [badgeId|null, badgeId|null, badgeId|null]
// }

const { data, saveData } = require('../state');
const { todayStr } = require('./currency');

const DEFAULT_TITLE = 'Nhất Mộng Giang Hồ';
const DEFAULT_BORDER = null;          // null → draw procedural ink-wash ring
const GENDERS = ['m', 'f'];
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 32;
const DISPLAY_NAME_RE = /^[\p{L}\p{N} _-]+$/u;
const DAILY_CARD_RENDER_LIMIT = 5;     // non-super-admin cap, resets 00:00 GMT+7

const VALID_ITEM_KEYS = new Set(['nhuom', 'dieu', 'cao', 'cao5', 'cao9', 'kythuong', 'thienthuong', 'phuonghoang1', 'phuonghoang2', 'thantrang']);

function ensureRoot() {
    if (!data.profile) data.profile = {};
    return data.profile;
}

function defaults() {
    return {
        gender: 'm',
        displayName: null,            // overrides registrations[].ingame on card if set
        itemSlot1: null,
        itemSlot2: null,
        itemSlot3: null,
        showNgoc: false,
        biggestJackpot: null,
        selectedTitle: null,
        selectedBorder: null,
        badgeSlots: [null, null, null],
        // Up to 3 achievement ids (from ACHIEVEMENTS catalog) shown on the card.
        // Empty/all-null → card falls back to DEFAULT_ACHIEVEMENTS.
        achievementSlots: [null, null, null],
        // Daily card-render cap (non-super-admin only). Resets at 00:00 GMT+7.
        cardRenderCap: { date: null, count: 0 }
    };
}

function getProfile(guildId, userId) {
    const root = ensureRoot();
    if (!root[guildId]) root[guildId] = {};
    if (!root[guildId][userId]) root[guildId][userId] = defaults();
    const p = root[guildId][userId];
    const d = defaults();
    for (const k of Object.keys(d)) if (p[k] === undefined) p[k] = d[k];
    if (!Array.isArray(p.badgeSlots) || p.badgeSlots.length !== 3) p.badgeSlots = [null, null, null];
    if (!Array.isArray(p.achievementSlots) || p.achievementSlots.length !== 3) p.achievementSlots = [null, null, null];
    if (!p.cardRenderCap || typeof p.cardRenderCap !== 'object') p.cardRenderCap = { date: null, count: 0 };
    return p;
}

// Returns the current daily card-render usage for `userId`, rolling over the
// counter when the GMT+7 date has changed. Does not mutate the count.
function getCardRenderStatus(guildId, userId) {
    const p = getProfile(guildId, userId);
    const today = todayStr();
    const count = (p.cardRenderCap && p.cardRenderCap.date === today) ? (p.cardRenderCap.count || 0) : 0;
    return { date: today, used: count, limit: DAILY_CARD_RENDER_LIMIT, remaining: Math.max(0, DAILY_CARD_RENDER_LIMIT - count) };
}

// Atomically check-and-increment the daily card-render counter. Returns
// `{ ok, used, limit, remaining }`. When `ok === false`, the counter was not
// incremented and the caller should refuse the render. Callers that want to
// bypass the cap (super-admin) should simply not call this function.
function consumeCardRender(guildId, userId) {
    const p = getProfile(guildId, userId);
    const today = todayStr();
    if (!p.cardRenderCap || p.cardRenderCap.date !== today) {
        p.cardRenderCap = { date: today, count: 0 };
    }
    if (p.cardRenderCap.count >= DAILY_CARD_RENDER_LIMIT) {
        return { ok: false, used: p.cardRenderCap.count, limit: DAILY_CARD_RENDER_LIMIT, remaining: 0 };
    }
    p.cardRenderCap.count += 1;
    saveData();
    return {
        ok: true,
        used: p.cardRenderCap.count,
        limit: DAILY_CARD_RENDER_LIMIT,
        remaining: DAILY_CARD_RENDER_LIMIT - p.cardRenderCap.count
    };
}

function setGender(guildId, userId, gender) {
    if (!GENDERS.includes(gender)) throw new Error(`invalid gender: ${gender}`);
    const p = getProfile(guildId, userId);
    p.gender = gender;
    saveData();
    return p;
}

function setItemSlot(guildId, userId, slotNum, itemKey) {
    if (![1, 2, 3].includes(slotNum)) throw new Error(`invalid slot: ${slotNum}`);
    if (itemKey !== null && !VALID_ITEM_KEYS.has(itemKey)) throw new Error(`invalid item key: ${itemKey}`);
    const p = getProfile(guildId, userId);
    p[`itemSlot${slotNum}`] = itemKey;
    saveData();
    return p;
}

function setShowNgoc(guildId, userId, show) {
    const p = getProfile(guildId, userId);
    p.showNgoc = !!show;
    saveData();
    return p;
}

function setDisplayName(guildId, userId, name) {
    const p = getProfile(guildId, userId);
    if (name === null || name === undefined || name === '') {
        p.displayName = null;
        saveData();
        return p;
    }
    const cleaned = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (cleaned.length < DISPLAY_NAME_MIN || cleaned.length > DISPLAY_NAME_MAX) {
        throw new Error(`Tên phải dài từ ${DISPLAY_NAME_MIN} đến ${DISPLAY_NAME_MAX} ký tự.`);
    }
    if (!DISPLAY_NAME_RE.test(cleaned)) {
        throw new Error('Tên chỉ được dùng chữ cái, số, dấu cách, gạch dưới hoặc gạch ngang.');
    }
    p.displayName = cleaned;
    saveData();
    return p;
}

// Update if `amount` exceeds the existing biggest jackpot. Called on any
// game payout (slot/coinflip/dice/gacha-pity etc.). Returns true if updated.
function recordWin(guildId, userId, amount, game) {
    if (!guildId || !userId) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const p = getProfile(guildId, userId);
    const cur = p.biggestJackpot;
    if (!cur || amount > cur.amount) {
        p.biggestJackpot = { amount, game: String(game || 'game'), ts: Date.now() };
        saveData();
        return true;
    }
    return false;
}

function getBiggestJackpot(guildId, userId) {
    const p = getProfile(guildId, userId);
    return p.biggestJackpot;
}

const GAME_KEYS = ['slot', 'coinflip', 'tong', 'mat'];
const GAME_LABELS = {
    slot: 'Slot',
    coinflip: 'Coinflip',
    tong: 'Tổng',
    mat: 'Mặt'
};

function ensureGameStats(p) {
    if (!p.gameStats || typeof p.gameStats !== 'object') p.gameStats = {};
    for (const k of GAME_KEYS) {
        if (!p.gameStats[k] || typeof p.gameStats[k] !== 'object') {
            p.gameStats[k] = { plays: 0, totalBet: 0, totalPayout: 0, totalWon: 0, totalLost: 0 };
        }
        const g = p.gameStats[k];
        if (typeof g.plays !== 'number') g.plays = 0;
        if (typeof g.totalBet !== 'number') g.totalBet = 0;
        if (typeof g.totalPayout !== 'number') g.totalPayout = 0;
        // totalWon = sum of net profit on winning plays, totalLost = sum of net
        // loss on losing plays. Added later; historical plays leave these at 0.
        if (typeof g.totalWon !== 'number') g.totalWon = 0;
        if (typeof g.totalLost !== 'number') g.totalLost = 0;
    }
    return p.gameStats;
}

// Record one game play. `bet` is what the player wagered, `payout` is what
// they got back (0 on a loss; bet*mult on a win — for coinflip pass the full
// returned amount, i.e. 2*bet on win, 0 on loss).
function recordGame(guildId, userId, game, bet, payout) {
    if (!guildId || !userId) return;
    if (!GAME_KEYS.includes(game)) return;
    if (!Number.isFinite(bet) || bet < 0) bet = 0;
    if (!Number.isFinite(payout) || payout < 0) payout = 0;
    const p = getProfile(guildId, userId);
    const stats = ensureGameStats(p);
    const g = stats[game];
    g.plays += 1;
    g.totalBet += bet;
    g.totalPayout += payout;
    const net = payout - bet;
    if (net > 0) g.totalWon += net;
    else if (net < 0) g.totalLost += -net;
    saveData();
}

function getGameStats(guildId, userId) {
    const p = getProfile(guildId, userId);
    return ensureGameStats(p);
}

// ── Gacha stats ─────────────────────────────────────────────────────────────
// Lifetime totals: number of rolls + how many rare drops (cáo / thiên thưởng /
// kỳ thưởng) came out of the gacha.
function ensureGachaStats(p) {
    if (!p.gachaStats || typeof p.gachaStats !== 'object') p.gachaStats = {};
    const g = p.gachaStats;
    for (const k of ['rolls', 'cao', 'thienthuong', 'kythuong']) {
        if (typeof g[k] !== 'number') g[k] = 0;
    }
    return g;
}

// Record a gacha pull batch. `rolls` is the number of rolls, `counts` is the
// per-item result map from gacha.rollMany (e.g. { cao, thienthuong, kythuong }).
function recordGacha(guildId, userId, rolls, counts) {
    if (!guildId || !userId) return;
    if (!Number.isFinite(rolls) || rolls <= 0) return;
    const p = getProfile(guildId, userId);
    const g = ensureGachaStats(p);
    g.rolls += rolls;
    if (counts) {
        g.cao += counts.cao || 0;
        g.thienthuong += counts.thienthuong || 0;
        g.kythuong += counts.kythuong || 0;
    }
    saveData();
}

function getGachaStats(guildId, userId) {
    const p = getProfile(guildId, userId);
    return ensureGachaStats(p);
}

// ── Achievement catalog ─────────────────────────────────────────────────────
// Each entry derives a display value from a `ctx` of the player's tracked
// stats: { gameStats, gachaStats, jackpot, wordchainRank, vtvRank }. `kind`
// tells the renderer how to format the raw value:
//   'num'    → compact number (1.2M)
//   'signed' → +/− compact number (net profit, can be negative)
//   'rank'   → #N, or '—' when unranked (compute returns null)
const ACH_GAME_LABEL = { slot: 'Slot', coinflip: 'Coin', tong: 'Tổng', mat: 'Mặt' };
const _g = (ctx, k) => (ctx.gameStats && ctx.gameStats[k]) || { plays: 0, totalBet: 0, totalPayout: 0, totalWon: 0, totalLost: 0 };

const ACHIEVEMENTS = [
    // Tổng tiền đã cược — mỗi mode 1 danh hiệu
    ...GAME_KEYS.map(k => ({ id: `bet_${k}`, label: `Tổng Cược ${ACH_GAME_LABEL[k]}`, glyph: 'coin', kind: 'num',
        compute: (ctx) => _g(ctx, k).totalBet })),
    // Tổng tiền đã thắng (lãi) — mỗi mode 1 danh hiệu, thua = 0
    ...GAME_KEYS.map(k => ({ id: `won_${k}`, label: `Tổng Thắng ${ACH_GAME_LABEL[k]}`, glyph: 'crown', kind: 'num',
        compute: (ctx) => _g(ctx, k).totalWon })),
    // Tổng tiền thua — mỗi mode 1 danh hiệu, thắng = 0
    ...GAME_KEYS.map(k => ({ id: `lost_${k}`, label: `Tổng Thua ${ACH_GAME_LABEL[k]}`, glyph: 'diamond', kind: 'num',
        compute: (ctx) => _g(ctx, k).totalLost })),
    // Số lượt chơi — mỗi mode 1 danh hiệu
    ...GAME_KEYS.map(k => ({ id: `plays_${k}`, label: `Lượt Chơi ${ACH_GAME_LABEL[k]}`, glyph: 'coin', kind: 'num',
        compute: (ctx) => _g(ctx, k).plays })),
    // Gacha
    { id: 'gacha_rolls', label: 'Số Lượt Gacha', glyph: 'diamond', kind: 'num',
        compute: (ctx) => (ctx.gachaStats && ctx.gachaStats.rolls) || 0 },
    { id: 'gacha_cao', label: 'Cáo Từ Gacha', glyph: 'crown', kind: 'num',
        compute: (ctx) => (ctx.gachaStats && ctx.gachaStats.cao) || 0 },
    { id: 'gacha_thienthuong', label: 'Thiên Thưởng Gacha', glyph: 'diamond', kind: 'num',
        compute: (ctx) => (ctx.gachaStats && ctx.gachaStats.thienthuong) || 0 },
    // ── Gợi ý thêm ──
    { id: 'gacha_kythuong', label: 'Kỳ Thưởng Gacha', glyph: 'diamond', kind: 'num',
        compute: (ctx) => (ctx.gachaStats && ctx.gachaStats.kythuong) || 0 },
    { id: 'total_bet', label: 'Tổng Cược Tất Cả', glyph: 'coin', kind: 'num',
        compute: (ctx) => GAME_KEYS.reduce((s, k) => s + _g(ctx, k).totalBet, 0) },
    { id: 'total_plays', label: 'Tổng Lượt Chơi', glyph: 'coin', kind: 'num',
        compute: (ctx) => GAME_KEYS.reduce((s, k) => s + _g(ctx, k).plays, 0) },
    { id: 'net_profit', label: 'Lãi Ròng', glyph: 'crown', kind: 'signed',
        compute: (ctx) => GAME_KEYS.reduce((s, k) => s + (_g(ctx, k).totalPayout - _g(ctx, k).totalBet), 0) },
    { id: 'jackpot', label: 'Jackpot Lớn Nhất', glyph: 'diamond', kind: 'num',
        compute: (ctx) => (ctx.jackpot && ctx.jackpot.amount) || 0 },
    { id: 'wordchain', label: 'Top Nối Từ', glyph: 'crown', kind: 'rank',
        compute: (ctx) => ctx.wordchainRank || null },
    { id: 'vtv', label: 'Vua Tiếng Việt', glyph: 'coin', kind: 'rank',
        compute: (ctx) => ctx.vtvRank || null }
];
const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map(a => a.id));
// Shown when the player hasn't picked any (preserves the legacy card layout).
const DEFAULT_ACHIEVEMENTS = ['wordchain', 'vtv', 'jackpot'];

// Persist the player's chosen achievement ids (max 3, de-duped, validated).
// Stored as a length-3 array padded with null.
function setAchievementSlots(guildId, userId, ids) {
    const p = getProfile(guildId, userId);
    const cleaned = [];
    for (const id of (Array.isArray(ids) ? ids : [])) {
        if (ACHIEVEMENT_IDS.has(id) && !cleaned.includes(id)) cleaned.push(id);
        if (cleaned.length >= 3) break;
    }
    p.achievementSlots = [cleaned[0] || null, cleaned[1] || null, cleaned[2] || null];
    saveData();
    return p;
}

module.exports = {
    DEFAULT_TITLE,
    DEFAULT_BORDER,
    GENDERS,
    VALID_ITEM_KEYS,
    getProfile,
    setGender,
    setItemSlot,
    setShowNgoc,
    setDisplayName,
    recordWin,
    recordGame,
    getGameStats,
    recordGacha,
    getGachaStats,
    setAchievementSlots,
    ACHIEVEMENTS,
    ACHIEVEMENTS_BY_ID,
    DEFAULT_ACHIEVEMENTS,
    GAME_KEYS,
    GAME_LABELS,
    getBiggestJackpot,
    getCardRenderStatus,
    consumeCardRender,
    DAILY_CARD_RENDER_LIMIT
};
