const { data, saveData } = require('../state');
const economy = require('../config/economy');

const INGAME_EMOTE_NAMES = ['nhuom', 'nganphieu', 'ngoc', 'cao', 'dieu', 'kythuong', 'thienthuong', 'shake_tt', 'slotanim', 'dice1', 'dice2', 'dice3', 'dice4', 'dice5', 'dice6'];
const ANIMATED_EMOTES = new Set(['shake_tt', 'slotanim']);
const ITEM_KEYS = ['nhuom', 'dieu', 'cao', 'kythuong', 'thienthuong'];
const ITEM_LABELS = {
    nhuom: 'Nhuộm',
    dieu: 'Diều',
    cao: 'Cáo',
    kythuong: 'Kỳ Thưởng',
    thienthuong: 'Thiên Thưởng'
};

const DAILY_RESET_OFFSET_HOURS = 7;

function todayStr() {
    const shifted = new Date(Date.now() + DAILY_RESET_OFFSET_HOURS * 3600 * 1000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getWallet(guildId, userId) {
    data.wallet = data.wallet || {};
    data.wallet[guildId] = data.wallet[guildId] || {};
    if (!data.wallet[guildId][userId]) {
        data.wallet[guildId][userId] = {
            nganphieu: 0,
            ngoc: 0,
            items: { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 },
            pity: { kt: 0, tt: 0 }
        };
    }
    const w = data.wallet[guildId][userId];
    if (!w.items) w.items = { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 };
    for (const k of ITEM_KEYS) if (typeof w.items[k] !== 'number') w.items[k] = 0;
    if (typeof w.nganphieu !== 'number') w.nganphieu = 0;
    if (typeof w.ngoc !== 'number') w.ngoc = 0;
    if (!w.pity) w.pity = { kt: 0, tt: 0 };
    if (typeof w.pity.kt !== 'number') w.pity.kt = 0;
    if (typeof w.pity.tt !== 'number') w.pity.tt = 0;
    if (typeof w.slotPity !== 'number') w.slotPity = 0;
    if (typeof w.slotStreakMaxBet !== 'number') w.slotStreakMaxBet = 0;
    return w;
}

function addNganphieu(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    w.nganphieu += amount;
    saveData();
    return w.nganphieu;
}

function addNgoc(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    w.ngoc += amount;
    saveData();
    return w.ngoc;
}

function addItem(guildId, userId, key, amount) {
    if (!ITEM_KEYS.includes(key)) throw new Error(`Unknown item key: ${key}`);
    const w = getWallet(guildId, userId);
    w.items[key] += amount;
    saveData();
    return w.items[key];
}

function tryEarnFromChat(guildId, userId) {
    data.chatEarn = data.chatEarn || {};
    data.chatEarn[guildId] = data.chatEarn[guildId] || {};
    const today = todayStr();
    const entry = data.chatEarn[guildId][userId];
    if (!entry || entry.date !== today) {
        data.chatEarn[guildId][userId] = { date: today, count: 0 };
    }
    const e = data.chatEarn[guildId][userId];
    if (e.count >= economy.CHAT_DAILY_CAP) {
        return false;
    }
    e.count += 1;
    const w = getWallet(guildId, userId);
    w.nganphieu += economy.CHAT_REWARD;
    saveData();
    return true;
}

function tryClaimDaily(guildId, userId) {
    data.dailyClaim = data.dailyClaim || {};
    data.dailyClaim[guildId] = data.dailyClaim[guildId] || {};
    const today = todayStr();
    if (data.dailyClaim[guildId][userId] === today) {
        return { claimed: false, reward: null };
    }
    data.dailyClaim[guildId][userId] = today;
    const { nganphieuMin, nganphieuMax } = economy.DAILY_REWARD;
    const nganphieu = Math.floor(nganphieuMin + Math.random() * (nganphieuMax - nganphieuMin + 1));
    const w = getWallet(guildId, userId);
    w.nganphieu += nganphieu;
    saveData();
    return { claimed: true, reward: { nganphieu } };
}

function fmt(n) {
    return Number(n).toLocaleString('en-US');
}

function renderEmote(key) {
    const id = data.ingameEmoteIds && data.ingameEmoteIds[key];
    if (!id) return `:${key}:`;
    const prefix = ANIMATED_EMOTES.has(key) ? 'a' : '';
    return `<${prefix}:ig_${key}:${id}>`;
}

module.exports = {
    INGAME_EMOTE_NAMES,
    ITEM_KEYS,
    ITEM_LABELS,
    getWallet,
    addNganphieu,
    addNgoc,
    addItem,
    tryEarnFromChat,
    tryClaimDaily,
    renderEmote,
    todayStr,
    fmt
};
