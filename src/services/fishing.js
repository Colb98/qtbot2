const path = require('path');
const { data, saveData } = require('../state');
const economy = require('../config/economy');
const { todayStr, addNgoc, addItem } = require('./currency');

// Câu cá (!cauca / !fishing) — daily faucet with pre-rendered GIF endings.
// The GIFs live in assets/fishing/gif/ (gitignored while the art is under
// review — regenerate with scripts/gen_fishing_gifs.py, ship alongside code).
// Odds/rewards are economy.FISHING (live-tunable); daily count is stored in
// data.fishing[guildId][userId] = { date, count } and swept by pruneDaily.

const GIF_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fishing', 'gif');

// Flavor text per ending, posted after the GIF reveals it.
const OUTCOME_TEXT = {
    small:    { emoji: '🐟', label: 'Cá nhỏ', line: 'Một chú cá nhỏ cắn câu!' },
    tuna:     { emoji: '🐟', label: 'Cá ngừ', line: 'Cá ngừ to đùng, kéo mỏi cả tay!' },
    catfish:  { emoji: '😾', label: 'Cá trê', line: 'Cá trê quái quỷ quẫy tung làm hỏng đồ câu của bạn!' },
    puffle:   { emoji: '🐡', label: 'Cá nóc', line: 'Cá nóc phồng gai đâm rách lưới của bạn!' },
    treasure: { emoji: '💰', label: 'Rương báu', line: 'Bạn kéo lên cả một RƯƠNG BÁU VẬT dưới đáy hồ!' },
    kelp:     { emoji: '🌿', label: 'Rong biển', line: 'Chỉ là một nhúm rong biển… ướt nhẹp.' },
    nothing:  { emoji: '🌙', label: 'Không có gì', line: 'Bạn câu cá đến khuya nhưng chẳng câu được gì.' }
};

function gifPath(outcome) {
    return path.join(GIF_DIR, `${outcome}.gif`);
}

function getEntry(guildId, userId) {
    data.fishing = data.fishing || {};
    data.fishing[guildId] = data.fishing[guildId] || {};
    const today = todayStr();
    const e = data.fishing[guildId][userId];
    if (!e || e.date !== today) {
        data.fishing[guildId][userId] = { date: today, count: 0 };
    }
    return data.fishing[guildId][userId];
}

// Consume one cast. Returns { ok, remaining, limit }.
function tryUseCast(guildId, userId) {
    const limit = economy.FISHING.DAILY_LIMIT;
    const e = getEntry(guildId, userId);
    if (e.count >= limit) return { ok: false, remaining: 0, limit };
    e.count += 1;
    saveData();
    return { ok: true, remaining: limit - e.count, limit };
}

function rollOutcome() {
    const outcomes = economy.FISHING.OUTCOMES;
    const keys = Object.keys(outcomes);
    const total = keys.reduce((s, k) => s + (outcomes[k].weight || 0), 0);
    let r = Math.random() * total;
    for (const k of keys) {
        r -= (outcomes[k].weight || 0);
        if (r < 0) return k;
    }
    return keys[keys.length - 1];
}

// Apply the ending's reward. Negative ngọc is deducted straight from the free
// wallet and MAY push it below 0 — that debt is the price of the catfish.
// Returns { ngocDelta, thienthuong }.
function settle(guildId, userId, outcome) {
    const o = economy.FISHING.OUTCOMES[outcome] || {};
    const ngocDelta = o.ngoc || 0;
    const tt = o.thienthuong || 0;
    if (ngocDelta !== 0) addNgoc(guildId, userId, ngocDelta);
    if (tt > 0) addItem(guildId, userId, 'thienthuong', tt);
    return { ngocDelta, thienthuong: tt };
}

function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    const f = data.fishing || {};
    for (const guildId of Object.keys(f)) {
        const g = f[guildId];
        for (const uid of Object.keys(g)) {
            if (!g[uid] || g[uid].date !== today) { delete g[uid]; removed++; }
        }
        if (Object.keys(g).length === 0) delete f[guildId];
    }
    if (removed) saveData();
    return removed;
}

module.exports = {
    OUTCOME_TEXT,
    gifPath,
    tryUseCast,
    rollOutcome,
    settle,
    pruneDaily
};
