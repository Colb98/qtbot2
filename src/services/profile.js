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
    getBiggestJackpot,
    getCardRenderStatus,
    consumeCardRender,
    DAILY_CARD_RENDER_LIMIT
};
