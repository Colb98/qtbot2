const { renderEmote, ITEM_LABELS } = require('./currency');

const ROLL_COST = 100;
const SUPPORTED_COUNTS = [1, 10, 50];

const P_CAO = 0.0004;
const P_THIENTHUONG = 0.0036;
const P_KYTHUONG = 0.04;

function roll() {
    const r = Math.random();
    if (r < P_CAO) return 'cao';
    if (r < P_CAO + P_THIENTHUONG) return 'thienthuong';
    if (r < P_CAO + P_THIENTHUONG + P_KYTHUONG) return 'kythuong';
    return Math.random() < 0.5 ? 'dieu' : 'nhuom';
}

function rollMany(n) {
    const counts = { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 };
    for (let i = 0; i < n; i++) {
        counts[roll()] += 1;
    }
    return counts;
}

function formatRollResult(counts) {
    const order = ['cao', 'thienthuong', 'kythuong', 'dieu', 'nhuom'];
    const parts = [];
    for (const k of order) {
        if (counts[k] > 0) parts.push(`${renderEmote(k)} ${ITEM_LABELS[k]} x${counts[k]}`);
    }
    return parts.join(', ');
}

module.exports = {
    ROLL_COST,
    SUPPORTED_COUNTS,
    roll,
    rollMany,
    formatRollResult
};
