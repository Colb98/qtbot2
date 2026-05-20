const { data, saveData } = require('../state');

const INGAME_EMOTE_NAMES = ['nhuom', 'nganphieu', 'ngoc', 'cao', 'dieu', 'kythuong', 'thienthuong', 'shake_tt'];
const ITEM_KEYS = ['nhuom', 'dieu', 'cao', 'kythuong', 'thienthuong'];
const ITEM_LABELS = {
    nhuom: 'Nhuộm',
    dieu: 'Diều',
    cao: 'Cáo',
    kythuong: 'Kỳ Thưởng',
    thienthuong: 'Thiên Thưởng'
};
const CHAT_REWARD = 1000;
const CHAT_DAILY_CAP = 1000;

function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getWallet(guildId, userId) {
    data.wallet = data.wallet || {};
    data.wallet[guildId] = data.wallet[guildId] || {};
    if (!data.wallet[guildId][userId]) {
        data.wallet[guildId][userId] = {
            nganphieu: 0,
            ngoc: 0,
            items: { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 }
        };
    }
    const w = data.wallet[guildId][userId];
    if (!w.items) w.items = { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 };
    for (const k of ITEM_KEYS) if (typeof w.items[k] !== 'number') w.items[k] = 0;
    if (typeof w.nganphieu !== 'number') w.nganphieu = 0;
    if (typeof w.ngoc !== 'number') w.ngoc = 0;
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
    if (e.count >= CHAT_DAILY_CAP) {
        return false;
    }
    e.count += 1;
    const w = getWallet(guildId, userId);
    w.nganphieu += CHAT_REWARD;
    saveData();
    return true;
}

function renderEmote(key) {
    const id = data.ingameEmoteIds && data.ingameEmoteIds[key];
    if (!id) return `:${key}:`;
    const ext = key === 'shake_tt' ? 'a' : '';
    return `<${ext}:ig_${key}:${id}>`;
}

module.exports = {
    INGAME_EMOTE_NAMES,
    ITEM_KEYS,
    ITEM_LABELS,
    CHAT_REWARD,
    CHAT_DAILY_CAP,
    getWallet,
    addNganphieu,
    addNgoc,
    addItem,
    tryEarnFromChat,
    renderEmote
};
