const { data, saveData } = require('../state');
const economy = require('../config/economy');

function pairKey(a, b) {
    return [String(a), String(b)].sort().join('_');
}

function ensureRoot(guildId) {
    data.bond = data.bond || {};
    data.bond[guildId] = data.bond[guildId] || {};
}

function getBond(guildId, a, b) {
    ensureRoot(guildId);
    return data.bond[guildId][pairKey(a, b)] || 0;
}

function addBond(guildId, a, b, amount) {
    if (!amount || amount <= 0) return getBond(guildId, a, b);
    if (String(a) === String(b)) return 0;
    ensureRoot(guildId);
    const key = pairKey(a, b);
    const cur = data.bond[guildId][key] || 0;
    data.bond[guildId][key] = cur + amount;
    saveData();
    return data.bond[guildId][key];
}

function emojiFor(score) {
    const { THRESHOLDS, EMOJIS } = economy.BOND;
    let idx = 0;
    for (let i = 0; i < THRESHOLDS.length; i++) {
        if (score >= THRESHOLDS[i]) idx = i;
    }
    return EMOJIS[idx];
}

function listBondsFor(guildId, userId, limit = 10) {
    ensureRoot(guildId);
    const me = String(userId);
    const rows = [];
    for (const [k, score] of Object.entries(data.bond[guildId])) {
        const [a, b] = k.split('_');
        if (a !== me && b !== me) continue;
        const other = a === me ? b : a;
        rows.push({ otherId: other, score });
    }
    rows.sort((x, y) => y.score - x.score);
    return rows.slice(0, limit);
}

module.exports = {
    getBond,
    addBond,
    emojiFor,
    listBondsFor
};
