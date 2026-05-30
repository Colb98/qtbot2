const { renderEmote, ITEM_LABELS, fmt } = require('./currency');
const economy = require('../config/economy');

const GACHA = economy.GACHA;

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function computeRates(pity) {
    const base = GACHA.BASE_RATES;
    const pkt = GACHA.PITY_KT_RATES;
    const ptt = GACHA.PITY_TT_END_RATES;

    if (pity.tt >= GACHA.PITY_TT_END) {
        return { cao: ptt.cao, thienthuong: ptt.thienthuong, kythuong: ptt.kythuong };
    }
    if (pity.tt >= GACHA.PITY_TT_START) {
        const t = (pity.tt - GACHA.PITY_TT_START) / (GACHA.PITY_TT_END - GACHA.PITY_TT_START);
        const start = pity.kt >= GACHA.PITY_KT_THRESHOLD ? pkt : base;
        return {
            cao: lerp(start.cao, ptt.cao, t),
            thienthuong: lerp(start.thienthuong, ptt.thienthuong, t),
            kythuong: lerp(start.kythuong, ptt.kythuong, t)
        };
    }
    if (pity.kt >= GACHA.PITY_KT_THRESHOLD) {
        return { cao: pkt.cao, thienthuong: pkt.thienthuong, kythuong: pkt.kythuong };
    }
    return { cao: base.cao, thienthuong: base.thienthuong, kythuong: base.kythuong };
}

function rollOne(pity) {
    pity.kt += 1;
    pity.tt += 1;

    const rates = computeRates(pity);
    const r = Math.random();
    let result;
    if (r < rates.cao) result = 'cao';
    else if (r < rates.cao + rates.thienthuong) result = 'thienthuong';
    else if (r < rates.cao + rates.thienthuong + rates.kythuong) result = 'kythuong';
    else result = Math.random() < 0.5 ? 'dieu' : 'nhuom';

    if (result === 'cao' || result === 'thienthuong' || result === 'kythuong') {
        pity.kt = 0;
    }
    if (result === 'thienthuong') {
        pity.tt = 0;
    }
    return result;
}

function rollMany(n, pity, meta = null) {
    const counts = { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 };
    for (let i = 0; i < n; i++) {
        const wasKtPity = pity.kt >= GACHA.PITY_KT_THRESHOLD;
        const wasTtPity = pity.tt >= GACHA.PITY_TT_START;
        if (meta) {
            if (wasKtPity) meta.ktPityRolls = (meta.ktPityRolls || 0) + 1;
            if (wasTtPity) meta.ttPityRolls = (meta.ttPityRolls || 0) + 1;
        }
        const result = rollOne(pity);
        counts[result] += 1;
        if (meta && (result === 'cao' || result === 'thienthuong' || result === 'kythuong')) {
            if (wasKtPity) meta.hitsAtPityKt = (meta.hitsAtPityKt || 0) + 1;
            if (wasTtPity) meta.hitsAtPityTt = (meta.hitsAtPityTt || 0) + 1;
        }
    }
    return counts;
}

function formatRollResult(counts) {
    const order = ['cao', 'thienthuong', 'kythuong', 'dieu', 'nhuom'];
    const parts = [];
    for (const k of order) {
        if (counts[k] > 0) parts.push(`${renderEmote(k)} ${ITEM_LABELS[k]} x${fmt(counts[k])}`);
    }
    return parts.join(', ');
}

function getPityStatus(pity) {
    const ttLeft = GACHA.PITY_TT_END - pity.tt;
    const ktLeft = Math.max(0, GACHA.PITY_KT_THRESHOLD - pity.kt);
    return { ttLeft, ktLeft };
}

module.exports = {
    // Live getters so runtime economy overrides are reflected without a restart.
    get ROLL_COST() { return GACHA.ROLL_COST; },
    get SUPPORTED_COUNTS() { return GACHA.SUPPORTED_COUNTS; },
    rollOne,
    rollMany,
    formatRollResult,
    computeRates,
    getPityStatus
};
