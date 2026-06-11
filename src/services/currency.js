const { data, saveData } = require('../state');
const economy = require('../config/economy');
const seasonCfg = require('../config/season');

const INGAME_EMOTE_NAMES = ['nhuom', 'nganphieu', 'ngoc', 'cao', 'cao5', 'cao9', 'dieu', 'kythuong', 'thienthuong', 'phuonghoang1', 'phuonghoang2', 'thantrang', 'shake_tt', 'slotanim', 'dice1', 'dice2', 'dice3', 'dice4', 'dice5', 'dice6', 's2_pet1', 's2_pet2', 's2_thanthu', 's2_thanthuplus', 's2_thantrang'];
const ANIMATED_EMOTES = new Set(['shake_tt', 'slotanim']);
// Season-2 premium keys (s2_*). Emote PNGs live in emotes/ingame/<key>.png; run
// !upload_ingame_emotes to register them as chat emotes. The profile card reads
// the PNGs directly, so showcase icons work even before the upload.
const SEASON2_ITEM_KEYS = ['s2_pet1', 's2_pet2', 's2_thanthu', 's2_thanthuplus', 's2_thantrang'];
const ITEM_KEYS = ['nhuom', 'dieu', 'cao', 'cao5', 'cao9', 'kythuong', 'thienthuong', 'phuonghoang1', 'phuonghoang2', 'thantrang', ...SEASON2_ITEM_KEYS];
const ITEM_LABELS = {
    nhuom: 'Nhuộm',
    dieu: 'Diều',
    cao: 'Cáo',
    cao5: 'Cáo 5 đuôi',
    cao9: 'Cáo 9 đuôi',
    kythuong: 'Kỳ Thưởng',
    thienthuong: 'Thiên Thưởng',
    phuonghoang1: 'Phượng Băng',
    phuonghoang2: 'Phượng Hoả',
    thantrang: 'Thần Trang',
    s2_pet1: 'Sói',
    s2_pet2: 'Sói Tinh Hà',
    s2_thanthu: 'Rồng',
    s2_thanthuplus: 'Rồng Pro Max',
    s2_thantrang: 'Thần Trang S2'
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
            lockedNgoc: 0,
            items: { nhuom: 0, dieu: 0, cao: 0, cao5: 0, cao9: 0, kythuong: 0, thienthuong: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
            lockedItems: { nhuom: 0, dieu: 0, cao: 0, cao5: 0, cao9: 0, kythuong: 0, thienthuong: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
            pity: { kt: 0, tt: 0 }
        };
    }
    const w = data.wallet[guildId][userId];
    if (!w.items) w.items = { nhuom: 0, dieu: 0, cao: 0, cao5: 0, cao9: 0, kythuong: 0, thienthuong: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 };
    if (!w.lockedItems) w.lockedItems = { nhuom: 0, dieu: 0, cao: 0, cao5: 0, cao9: 0, kythuong: 0, thienthuong: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 };
    for (const k of ITEM_KEYS) if (typeof w.items[k] !== 'number') w.items[k] = 0;
    for (const k of ITEM_KEYS) if (typeof w.lockedItems[k] !== 'number') w.lockedItems[k] = 0;
    if (typeof w.nganphieu !== 'number') w.nganphieu = 0;
    if (typeof w.ngoc !== 'number') w.ngoc = 0;
    if (typeof w.lockedNgoc !== 'number') w.lockedNgoc = 0;
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

function addLockedNgoc(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    w.lockedNgoc += amount;
    saveData();
    return w.lockedNgoc;
}

function addLockedItem(guildId, userId, key, amount) {
    if (!ITEM_KEYS.includes(key)) throw new Error(`Unknown item key: ${key}`);
    const w = getWallet(guildId, userId);
    w.lockedItems[key] += amount;
    saveData();
    return w.lockedItems[key];
}

// Deducts ngọc for games: locked first, then non-locked. Saves data.
function spendNgocForGame(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    const lockedUsed = Math.min(amount, w.lockedNgoc);
    w.lockedNgoc -= lockedUsed;
    w.ngoc -= (amount - lockedUsed);
    saveData();
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

// Drop yesterday's per-user entries from the date-keyed daily maps so they
// don't accumulate forever and bloat every state serialize. Safe because both
// maps reset on date change at read time anyway. Returns entries removed.
function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    const ce = data.chatEarn || {};
    for (const guildId of Object.keys(ce)) {
        const g = ce[guildId];
        for (const uid of Object.keys(g)) {
            if (!g[uid] || g[uid].date !== today) { delete g[uid]; removed++; }
        }
        if (Object.keys(g).length === 0) delete ce[guildId];
    }
    const dc = data.dailyClaim || {};
    for (const guildId of Object.keys(dc)) {
        const g = dc[guildId];
        for (const uid of Object.keys(g)) {
            if (g[uid] !== today) { delete g[uid]; removed++; }
        }
        if (Object.keys(g).length === 0) delete dc[guildId];
    }
    if (removed) saveData();
    return removed;
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

// ── !khodo embed ─────────────────────────────────────────────────────────────
// Columns (inline embed fields): currency + thiên thưởng · common items · one
// column per season's premium items (new seasons appear automatically from
// config/season.js). Unless showAll, zero-quantity item lines are hidden and
// fully-empty columns dropped; the currency column always shows in full.
// Returns a plain embed object so this file stays free of discord.js.
const KHODO_COLOR = 0xF1C40F;

function buildKhodoView(guildId, userId, displayName, showAll) {
    const w = getWallet(guildId, userId);
    const total = k => (w.items[k] || 0) + (w.lockedItems[k] || 0);
    const itemLine = k => `${renderEmote(k)} ${ITEM_LABELS[k]}: **${fmt(total(k))}**`;

    let hiddenCount = 0;
    const itemField = (name, keys) => {
        const shown = showAll ? keys : keys.filter(k => total(k) > 0);
        hiddenCount += keys.length - shown.length;
        if (shown.length === 0) return null;
        return { name, value: shown.map(itemLine).join('\n'), inline: true };
    };

    const premiumKeys = seasonCfg.allPremiumKeys();
    const commonKeys = ITEM_KEYS.filter(k => k !== 'thienthuong' && !premiumKeys.has(k));

    const fields = [{
        name: 'Tiền tệ',
        value: [
            itemLine('thienthuong'),
            `${renderEmote('ngoc')} Ngọc: **${fmt(w.ngoc + w.lockedNgoc)}**`,
            `${renderEmote('nganphieu')} Ngân phiếu: **${fmt(w.nganphieu)}**`
        ].join('\n'),
        inline: true
    }];
    fields.push(itemField('Vật phẩm thường', commonKeys));
    for (const id of seasonCfg.SEASON_IDS) {
        const s = seasonCfg.SEASONS[id];
        const keys = seasonCfg.seasonTiers(id).map(t => s.items[t]);
        const name = s.name === `Mùa ${id}` ? s.name : `Mùa ${id} — ${s.name}`;
        fields.push(itemField(name, keys));
    }

    return {
        embed: { color: KHODO_COLOR, title: `Kho đồ của ${displayName}`, fields: fields.filter(Boolean) },
        hiddenCount
    };
}

module.exports = {
    INGAME_EMOTE_NAMES,
    ITEM_KEYS,
    ITEM_LABELS,
    getWallet,
    addNganphieu,
    addNgoc,
    addItem,
    addLockedNgoc,
    addLockedItem,
    spendNgocForGame,
    tryEarnFromChat,
    tryClaimDaily,
    pruneDaily,
    renderEmote,
    buildKhodoView,
    todayStr,
    fmt
};
