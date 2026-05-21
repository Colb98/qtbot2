const SYMBOLS = {
    M1: { weight: 2, pay3: 200, pay2: 10, emote: 'cao' },
    M2: { weight: 3, pay3: 67,  pay2: 3,  emote: 'thienthuong' },
    M3: { weight: 4, pay3: 55,  pay2: 2,  emote: 'ngoc' },
    M4: { weight: 5, pay3: 20,  pay2: 0,  emote: 'kythuong' },
    M5: { weight: 7, pay3: 8,   pay2: 0,  emote: 'dieu' },
    M6: { weight: 7, pay3: 8,   pay2: 0,  emote: 'nhuom' }
};
const REELS = 3;

const _icons = Object.keys(SYMBOLS);
const _weights = _icons.map(s => SYMBOLS[s].weight);
const _totalWeight = _weights.reduce((a, b) => a + b, 0);

function pickWeighted() {
    let r = Math.random() * _totalWeight;
    for (let i = 0; i < _icons.length; i++) {
        r -= _weights[i];
        if (r < 0) return _icons[i];
    }
    return _icons[_icons.length - 1];
}

function spin() {
    const result = [];
    for (let i = 0; i < REELS; i++) result.push(pickWeighted());
    const counts = {};
    for (const s of result) counts[s] = (counts[s] || 0) + 1;
    let mult = 0;
    for (const s of Object.keys(counts)) {
        const c = counts[s];
        if (c === 3) mult = Math.max(mult, SYMBOLS[s].pay3);
        else if (c === 2) mult = Math.max(mult, SYMBOLS[s].pay2);
    }
    return { result, mult };
}

module.exports = { SYMBOLS, REELS, spin };
