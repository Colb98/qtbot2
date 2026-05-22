const fs = require('fs');
const path = require('path');
const log = require('../../logger');
const { fmt } = require('./currency');

const METRICS_DIR = path.resolve(__dirname, '..', '..', 'metrics');
const FLUSH_INTERVAL_MS = 30_000;

// ---- bucket helpers --------------------------------------------------------

function currentBucket() {
    // UTC date string, e.g. '2026-05-22'
    return new Date().toISOString().slice(0, 10);
}

function bucketPath(bucket) {
    return path.join(METRICS_DIR, `${bucket}.json`);
}

function ensureDir() {
    if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function loadBucket(bucket) {
    const p = bucketPath(bucket);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        log.error(`metrics: failed to load ${bucket}.json, starting fresh`, e);
    }
    return {};
}

// ---- game defaults ---------------------------------------------------------

const GAME_DEFAULTS = {
    slot: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        pityTriggers: 0, pityCapApplied: 0,
        outcomes: {}
    },
    coinflip: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        sideGuess: { sap: 0, ngua: 0, none: 0 }
    },
    tong: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        sumCounts: {}
    },
    mat: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        faceCounts: {}, matchCounts: {}
    }
};

// ---- state -----------------------------------------------------------------

ensureDir();
let _bucket = currentBucket();
let _store = loadBucket(_bucket);
let _dirty = false;

function _get(game) {
    if (!_store[game]) _store[game] = JSON.parse(JSON.stringify(GAME_DEFAULTS[game]));
    const m = _store[game];
    const def = GAME_DEFAULTS[game];
    for (const k of Object.keys(def)) {
        if (m[k] === undefined) m[k] = typeof def[k] === 'object' ? JSON.parse(JSON.stringify(def[k])) : def[k];
    }
    return m;
}

// Roll over to a new daily file if the UTC date changed since last access.
function _checkRollover() {
    const b = currentBucket();
    if (b === _bucket) return;
    flush(); // finalize old day
    _bucket = b;
    _store = loadBucket(_bucket); // usually empty; safe if file already exists
    _dirty = false;
}

// ---- flush -----------------------------------------------------------------

function flush() {
    if (!_dirty) return;
    try {
        fs.writeFileSync(bucketPath(_bucket), JSON.stringify(_store, null, 0));
        _dirty = false;
    } catch (e) {
        log.error('metrics: flush failed', e);
    }
}

const _timer = setInterval(flush, FLUSH_INTERVAL_MS);
if (_timer.unref) _timer.unref();

// ---- record functions ------------------------------------------------------

function recordSlot({ amount, payout, outcomeName, pityTriggered, pityCapApplied }) {
    _checkRollover();
    const m = _get('slot');
    m.spins++;
    m.wagered += amount;
    m.payout += payout;
    if (payout > 0) {
        m.wins++;
        if (payout > m.biggestWin) { m.biggestWin = payout; m.biggestWinBet = amount; }
    }
    m.outcomes[outcomeName] = (m.outcomes[outcomeName] || 0) + 1;
    if (pityTriggered) m.pityTriggers++;
    if (pityCapApplied) m.pityCapApplied++;
    _dirty = true;
}

function recordCoinflip({ amount, won, side, viaButton = false, wasAllIn = false, bigWin = false }) {
    _checkRollover();
    const m = _get('coinflip');
    m.spins++;
    m.wagered += amount;
    const payout = won ? amount * 2 : 0;
    m.payout += payout;
    if (won) {
        m.wins++;
        if (payout > m.biggestWin) { m.biggestWin = payout; m.biggestWinBet = amount; }
        if (bigWin) m.bigWinCount++;
    }
    if (viaButton) m.viaButton++;
    if (wasAllIn) m.allInCount++;
    if (!m.sideGuess) m.sideGuess = { sap: 0, ngua: 0, none: 0 };
    m.sideGuess[side || 'none'] = (m.sideGuess[side || 'none'] || 0) + 1;
    _dirty = true;
}

function recordTong({ amount, won, mult, guess, viaButton = false, wasAllIn = false }) {
    _checkRollover();
    const m = _get('tong');
    m.spins++;
    m.wagered += amount;
    const payout = won ? amount * mult : 0;
    m.payout += payout;
    if (won) {
        m.wins++;
        if (payout > m.biggestWin) { m.biggestWin = payout; m.biggestWinBet = amount; }
        if (mult >= 10) m.bigWinCount++;
    }
    if (viaButton) m.viaButton++;
    if (wasAllIn) m.allInCount++;
    m.sumCounts[String(guess)] = (m.sumCounts[String(guess)] || 0) + 1;
    _dirty = true;
}

function recordMat({ amount, won, mult, face, matches, viaButton = false, wasAllIn = false }) {
    _checkRollover();
    const m = _get('mat');
    m.spins++;
    m.wagered += amount;
    const payout = won ? amount * mult : 0;
    m.payout += payout;
    if (won) {
        m.wins++;
        if (payout > m.biggestWin) { m.biggestWin = payout; m.biggestWinBet = amount; }
        if (mult >= 4) m.bigWinCount++;
    }
    if (viaButton) m.viaButton++;
    if (wasAllIn) m.allInCount++;
    m.faceCounts[String(face)] = (m.faceCounts[String(face)] || 0) + 1;
    m.matchCounts[String(matches)] = (m.matchCounts[String(matches)] || 0) + 1;
    _dirty = true;
}

// ---- formatters ------------------------------------------------------------

function pct(a, b) {
    if (!b) return '—';
    return (a / b * 100).toFixed(1) + '%';
}

function topEntries(obj, n = 5) {
    return Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `${k}:${v}`)
        .join(' | ') || '(trống)';
}

function _formatGame(game) {
    if (game === 'slot') {
        const m = _get('slot');
        const edge = m.wagered - m.payout;
        return [
            `🎰 SLOT — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Edge: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            `Pity triggers: ${m.pityTriggers} | Pity cap applied: ${m.pityCapApplied}`,
            `Outcomes: ${topEntries(m.outcomes, 6)}`
        ].join('\n');
    }
    if (game === 'coinflip') {
        const m = _get('coinflip');
        const edge = m.wagered - m.payout;
        const sg = m.sideGuess || {};
        return [
            `🪙 COINFLIP — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Edge: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins: ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            `Via button: ${m.viaButton} (${pct(m.viaButton, m.spins)}) | All-in: ${m.allInCount}`,
            `Side — Sấp: ${sg.sap || 0} | Ngửa: ${sg.ngua || 0} | Tự do: ${sg.none || 0}`
        ].join('\n');
    }
    if (game === 'tong') {
        const m = _get('tong');
        const edge = m.wagered - m.payout;
        return [
            `🎲 TONG — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Edge: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins (x≥10): ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            `Via button: ${m.viaButton} (${pct(m.viaButton, m.spins)}) | All-in: ${m.allInCount}`,
            `Top sums: ${topEntries(m.sumCounts, 6)}`
        ].join('\n');
    }
    if (game === 'mat') {
        const m = _get('mat');
        const edge = m.wagered - m.payout;
        const mc = m.matchCounts || {};
        return [
            `🎲 MAT — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Edge: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins (x≥4): ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            `Via button: ${m.viaButton} (${pct(m.viaButton, m.spins)}) | All-in: ${m.allInCount}`,
            `Faces: ${topEntries(m.faceCounts, 6)} | Matches — 0:${mc['0']||0} 1:${mc['1']||0} 2:${mc['2']||0} 3:${mc['3']||0}`
        ].join('\n');
    }
    return '';
}

function formatGame(game) { return _formatGame(game); }
function formatAll(bucket) {
    const label = bucket ? ` [${bucket}]` : ` [${_bucket}]`;
    const store = bucket ? loadBucket(bucket) : null;
    const orig = store ? _store : null;
    if (store) {
        // temporarily swap store for formatting
        Object.assign(_store, {});
        Object.keys(store).forEach(k => (_store[k] = store[k]));
    }
    const out = ['slot', 'coinflip', 'tong', 'mat']
        .map(g => _formatGame(g))
        .join('\n\n') + `\n\n📅 Ngày${label}`;
    if (orig) Object.assign(_store, orig);
    return out;
}

// Public named exports kept consistent with callers
const formatSlot = () => _formatGame('slot');
const formatCoinflip = () => _formatGame('coinflip');
const formatTong = () => _formatGame('tong');
const formatMat = () => _formatGame('mat');

function listBuckets() {
    try {
        return fs.readdirSync(METRICS_DIR)
            .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
            .map(f => f.replace('.json', ''))
            .sort()
            .reverse();
    } catch { return []; }
}

module.exports = {
    recordSlot, recordCoinflip, recordTong, recordMat,
    formatSlot, formatCoinflip, formatTong, formatMat,
    formatAll, formatGame, listBuckets,
    currentBucket: () => _bucket,
    flush
};
