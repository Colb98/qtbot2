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

const DEFAULT_TITLE = 'Nhất Mộng Giang Hồ';
const DEFAULT_BORDER = null;          // null → draw procedural ink-wash ring
const GENDERS = ['m', 'f'];

const VALID_ITEM_KEYS = new Set(['nhuom', 'dieu', 'cao', 'cao5', 'cao9', 'kythuong', 'thienthuong', 'phuonghoang1', 'phuonghoang2', 'thantrang']);

function ensureRoot() {
    if (!data.profile) data.profile = {};
    return data.profile;
}

function defaults() {
    return {
        gender: 'm',
        itemSlot1: null,
        itemSlot2: null,
        itemSlot3: null,
        showNgoc: false,
        biggestJackpot: null,
        selectedTitle: null,
        selectedBorder: null,
        badgeSlots: [null, null, null]
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
    return p;
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
    recordWin,
    getBiggestJackpot
};
