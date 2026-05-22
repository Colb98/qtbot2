const SYMBOLS = {
    M1: { emote: 'cao' },
    M2: { emote: 'thienthuong' },
    M3: { emote: 'ngoc' },
    M4: { emote: 'kythuong' },
    M5: { emote: 'dieu' },
    M6: { emote: 'nhuom' }
};
const REELS = 3;
const ALL_SYMBOLS = Object.keys(SYMBOLS);

// kind:
//   '3x'   — 3 reels giống nhau (symbol từ `symbol` hoặc random từ `symbols`)
//   '2x'   — 2 reels giống nhau, reel 3 khác (random từ phần còn lại)
//   'thua' — 3 reels khác nhau hoàn toàn
const POOL = [
    { name: 'MEGA Jackpot',         mult: 150,  weight: 1,    kind: '3x', symbol: 'M1' },
    { name: 'Jackpot Thiên Thưởng', mult: 40,   weight: 4,    kind: '3x', symbol: 'M2' },
    { name: 'Jackpot Ngọc',         mult: 18,   weight: 9,    kind: '3x', symbol: 'M3' },
    { name: 'Mini Jackpot',         mult: 10,   weight: 62,   kind: '2x', symbol: 'M1' },
    { name: '2x Cáo',               mult: 6,    weight: 70,   kind: '2x', symbol: 'M2' },
    { name: '2x Vua',               mult: 3,    weight: 130,  kind: '2x', symbol: 'M3' },
    { name: 'An Ủi To',             mult: 2,    weight: 200,  kind: '3x', symbol: 'M4' },
    { name: 'Hoàn Vốn',             mult: 1,    weight: 700,  kind: '3x', symbols: ['M5', 'M6'] },
    { name: 'Nhỏ x0.5',             mult: 0.5,  weight: 600,  kind: '2x', symbol: 'M4' },
    { name: 'Nhỏ x0.25',            mult: 0.25, weight: 350,  kind: '2x', symbols: ['M5', 'M6'] },
    { name: 'Thua',                 mult: 0,    weight: 1197, kind: 'thua' }
];

const _totalWeight = POOL.reduce((a, p) => a + p.weight, 0);

function pickOutcome() {
    let r = Math.random() * _totalWeight;
    for (const p of POOL) {
        r -= p.weight;
        if (r < 0) return p;
    }
    return POOL[POOL.length - 1];
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildReels(outcome) {
    if (outcome.kind === '3x') {
        const sym = outcome.symbol || pickRandom(outcome.symbols);
        return [sym, sym, sym];
    }
    if (outcome.kind === '2x') {
        const sym = outcome.symbol || pickRandom(outcome.symbols);
        const others = ALL_SYMBOLS.filter(s => s !== sym);
        const filler = pickRandom(others);
        return shuffle([sym, sym, filler]);
    }
    // thua: pick 3 phần tử khác nhau hoàn toàn từ 6 symbols, random thứ tự
    const pool = shuffle(ALL_SYMBOLS.slice()).slice(0, REELS);
    return pool;
}

const PITY_THRESHOLD = 10;

function pickFromPool(pool) {
    const totalW = pool.reduce((a, p) => a + p.weight, 0);
    let r = Math.random() * totalW;
    for (const p of pool) {
        r -= p.weight;
        if (r < 0) return p;
    }
    return pool[pool.length - 1];
}

function spin(pityCount = 0) {
    let outcome;
    let pityTriggered = false;
    if (pityCount >= PITY_THRESHOLD) {
        outcome = pickFromPool(POOL.filter(p => p.mult >= 3));
        pityTriggered = true;
    } else {
        outcome = pickOutcome();
    }
    const result = buildReels(outcome);
    return { result, mult: outcome.mult, name: outcome.name, pityTriggered };
}

module.exports = { SYMBOLS, REELS, POOL, spin, PITY_THRESHOLD };
