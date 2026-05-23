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

const BET_BUCKET_EDGES = [100, 500, 1000, 5000, 10000, 25000, 50000];
const BET_BUCKET_LABELS = ['<100', '100-499', '500-999', '1k-4k', '5k-9k', '10k-24k', '25k-49k', '50k+'];

function betBucket(amount) {
    for (let i = 0; i < BET_BUCKET_EDGES.length; i++) {
        if (amount < BET_BUCKET_EDGES[i]) return BET_BUCKET_LABELS[i];
    }
    return BET_BUCKET_LABELS[BET_BUCKET_LABELS.length - 1];
}

function approxMedianFromBuckets(buckets, total) {
    if (!total) return null;
    const target = total / 2;
    let cum = 0;
    for (const label of BET_BUCKET_LABELS) {
        cum += buckets[label] || 0;
        if (cum >= target) return label;
    }
    return BET_BUCKET_LABELS[BET_BUCKET_LABELS.length - 1];
}

const GAME_DEFAULTS = {
    slot: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        pityTriggers: 0, pityCapApplied: 0,
        outcomes: {},
        playerIds: {}, betBuckets: {}, maxBet: 0
    },
    coinflip: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        sideGuess: { sap: 0, ngua: 0, none: 0 },
        playerIds: {}, betBuckets: {}, maxBet: 0
    },
    tong: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        sumCounts: {},
        playerIds: {}, betBuckets: {}, maxBet: 0
    },
    mat: {
        spins: 0, wagered: 0, payout: 0, wins: 0,
        biggestWin: 0, biggestWinBet: 0,
        viaButton: 0, allInCount: 0, bigWinCount: 0,
        faceCounts: {}, matchCounts: {},
        playerIds: {}, betBuckets: {}, maxBet: 0
    },
    gacha: {
        rolls: 0,
        burned: 0,
        hits: 0,
        ktPityRolls: 0,
        ttPityRolls: 0,
        hitsAtPityKt: 0,
        hitsAtPityTt: 0,
        itemCounts: { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 },
        playerIds: {}
    },
    wordchain_eng: {
        rounds: 0,
        totalWords: 0,
        biggestRound: 0,
        ngocAwarded: 0,
        participantsTotal: 0,
        multiplayerRounds: 0,
        emptyRounds: 0,
        endReasons: { timeout: 0, dead_end: 0, surrender: 0 },
        playerIds: {},
        wordHistogram: { '0': 0, '1-5': 0, '6-10': 0, '11-20': 0, '21-30': 0, '31-50': 0, '51+': 0 },
        roundDurationMs: 0,
        rejectedWords: 0,
        roundsAboveThreshold: 0
    }
};

function recordPlayerAndBet(m, userId, amount) {
    if (userId) m.playerIds[userId] = (m.playerIds[userId] || 0) + 1;
    if (Number.isFinite(amount) && amount > 0) {
        const label = betBucket(amount);
        m.betBuckets[label] = (m.betBuckets[label] || 0) + 1;
        if (amount > m.maxBet) m.maxBet = amount;
    }
}

function uniqueCount(map) {
    return map ? Object.keys(map).length : 0;
}

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

function recordSlot({ amount, payout, outcomeName, pityTriggered, pityCapApplied, userId }) {
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
    recordPlayerAndBet(m, userId, amount);
    _dirty = true;
}

function recordCoinflip({ amount, won, side, viaButton = false, wasAllIn = false, bigWin = false, userId }) {
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
    recordPlayerAndBet(m, userId, amount);
    _dirty = true;
}

function recordTong({ amount, won, mult, guess, viaButton = false, wasAllIn = false, userId }) {
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
    recordPlayerAndBet(m, userId, amount);
    _dirty = true;
}

function recordMat({ amount, won, mult, face, matches, viaButton = false, wasAllIn = false, userId }) {
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
    recordPlayerAndBet(m, userId, amount);
    _dirty = true;
}

function recordGacha({ rolls, cost, counts, userId, ktPityRolls = 0, ttPityRolls = 0, hitsAtPityKt = 0, hitsAtPityTt = 0 }) {
    _checkRollover();
    const m = _get('gacha');
    m.rolls += rolls;
    m.burned += cost;
    let hits = 0;
    for (const k of ['nhuom', 'dieu', 'cao', 'kythuong', 'thienthuong']) {
        const c = counts[k] || 0;
        if (!m.itemCounts) m.itemCounts = { nhuom: 0, dieu: 0, cao: 0, kythuong: 0, thienthuong: 0 };
        m.itemCounts[k] = (m.itemCounts[k] || 0) + c;
        if (k === 'cao' || k === 'thienthuong' || k === 'kythuong') hits += c;
    }
    m.hits += hits;
    m.ktPityRolls += ktPityRolls;
    m.ttPityRolls += ttPityRolls;
    m.hitsAtPityKt += hitsAtPityKt;
    m.hitsAtPityTt += hitsAtPityTt;
    if (userId) m.playerIds[userId] = (m.playerIds[userId] || 0) + rolls;
    _dirty = true;
}

function wordHistogramBucket(totalWords) {
    if (totalWords === 0) return '0';
    if (totalWords <= 5) return '1-5';
    if (totalWords <= 10) return '6-10';
    if (totalWords <= 20) return '11-20';
    if (totalWords <= 30) return '21-30';
    if (totalWords <= 50) return '31-50';
    return '51+';
}

function recordWordchainEng({ totalWords, participants, ngocAwarded, endReason, durationMs = 0, aboveThreshold = false, userIds = [] }) {
    _checkRollover();
    const m = _get('wordchain_eng');
    m.rounds++;
    m.totalWords += totalWords;
    if (totalWords > m.biggestRound) m.biggestRound = totalWords;
    m.ngocAwarded += ngocAwarded;
    m.participantsTotal += participants;
    if (participants >= 2) m.multiplayerRounds++;
    if (participants === 0) m.emptyRounds++;
    if (!m.endReasons) m.endReasons = { timeout: 0, dead_end: 0, surrender: 0 };
    if (endReason && m.endReasons[endReason] !== undefined) {
        m.endReasons[endReason]++;
    }
    if (!m.wordHistogram) m.wordHistogram = { '0': 0, '1-5': 0, '6-10': 0, '11-20': 0, '21-30': 0, '31-50': 0, '51+': 0 };
    const bucket = wordHistogramBucket(totalWords);
    m.wordHistogram[bucket] = (m.wordHistogram[bucket] || 0) + 1;
    m.roundDurationMs += Math.max(0, durationMs);
    if (aboveThreshold) m.roundsAboveThreshold++;
    if (!m.playerIds) m.playerIds = {};
    for (const uid of userIds) {
        m.playerIds[uid] = (m.playerIds[uid] || 0) + 1;
    }
    _dirty = true;
}

function recordWordchainReject() {
    _checkRollover();
    const m = _get('wordchain_eng');
    m.rejectedWords = (m.rejectedWords || 0) + 1;
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

function formatBetStats(m) {
    const uniq = uniqueCount(m.playerIds);
    const median = approxMedianFromBuckets(m.betBuckets || {}, m.spins);
    return `Unique players: ${fmt(uniq)} | Median bet bucket: ${median || '—'} | Max bet: ${fmt(m.maxBet || 0)}`;
}

function _formatGame(game) {
    if (game === 'slot') {
        const m = _get('slot');
        const edge = m.wagered - m.payout;
        return [
            `🎰 SLOT — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Net (cho người chơi): ${fmt(-edge || 0)} | Edge nhà: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            formatBetStats(m),
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
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Net (cho người chơi): ${fmt(-edge || 0)} | Edge nhà: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins: ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            formatBetStats(m),
            `Via button: ${m.viaButton} (${pct(m.viaButton, m.spins)}) | All-in: ${m.allInCount}`,
            `Side — Sấp: ${sg.sap || 0} | Ngửa: ${sg.ngua || 0} | Tự do: ${sg.none || 0}`
        ].join('\n');
    }
    if (game === 'tong') {
        const m = _get('tong');
        const edge = m.wagered - m.payout;
        return [
            `🎲 TONG — ${fmt(m.spins)} lượt`,
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Net (cho người chơi): ${fmt(-edge || 0)} | Edge nhà: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins (x≥10): ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            formatBetStats(m),
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
            `Wagered: ${fmt(m.wagered)} | Payout: ${fmt(m.payout)} | Net (cho người chơi): ${fmt(-edge || 0)} | Edge nhà: ${fmt(edge)} (${pct(edge, m.wagered)})`,
            `Wins: ${fmt(m.wins)} (${pct(m.wins, m.spins)}) | Big wins (x≥4): ${m.bigWinCount} | Biggest: ${fmt(m.biggestWin)} (bet ${fmt(m.biggestWinBet)})`,
            formatBetStats(m),
            `Via button: ${m.viaButton} (${pct(m.viaButton, m.spins)}) | All-in: ${m.allInCount}`,
            `Faces: ${topEntries(m.faceCounts, 6)} | Matches — 0:${mc['0']||0} 1:${mc['1']||0} 2:${mc['2']||0} 3:${mc['3']||0}`
        ].join('\n');
    }
    if (game === 'gacha') {
        const m = _get('gacha');
        const ic = m.itemCounts || {};
        const econ = require('../config/economy');
        const baseRates = econ.GACHA.BASE_RATES;
        const theoreticalHit = (baseRates.cao + baseRates.thienthuong + baseRates.kythuong);
        const actualHit = m.rolls ? (m.hits / m.rolls) : 0;
        const uniq = uniqueCount(m.playerIds);
        return [
            `🎁 GACHA (sink) — ${fmt(m.rolls)} lượt quay`,
            `**Burned**: ${fmt(m.burned)} ngọc | Unique rollers: ${fmt(uniq)} | Avg rolls/người: ${uniq ? (m.rolls / uniq).toFixed(1) : '—'}`,
            `Hits: ${fmt(m.hits)} (${pct(m.hits, m.rolls)} thực vs ${(theoreticalHit * 100).toFixed(2)}% lý thuyết)`,
            `Pity — KT rolls trong pity: ${m.ktPityRolls} (hits: ${m.hitsAtPityKt}) | TT rolls trong pity: ${m.ttPityRolls} (hits: ${m.hitsAtPityTt})`,
            `Items — Cao: ${fmt(ic.cao||0)} | TT: ${fmt(ic.thienthuong||0)} | KT: ${fmt(ic.kythuong||0)} | Diều: ${fmt(ic.dieu||0)} | Nhuộm: ${fmt(ic.nhuom||0)}`
        ].join('\n');
    }
    if (game === 'wordchain_eng' || game === 'wordchain') {
        const m = _get('wordchain_eng');
        const er = m.endReasons || { timeout: 0, dead_end: 0, surrender: 0 };
        const avgWords = m.rounds ? (m.totalWords / m.rounds).toFixed(1) : '—';
        const avgPart = m.rounds ? (m.participantsTotal / m.rounds).toFixed(2) : '—';
        const uniq = uniqueCount(m.playerIds);
        const durationMin = m.roundDurationMs ? m.roundDurationMs / 60000 : 0;
        const ngocPerMin = durationMin ? (m.ngocAwarded / durationMin).toFixed(1) : '—';
        const rewardPerRound = m.rounds ? (m.ngocAwarded / m.rounds).toFixed(0) : '—';
        const hist = m.wordHistogram || {};
        const histStr = ['0', '1-5', '6-10', '11-20', '21-30', '31-50', '51+']
            .map(k => `${k}:${hist[k] || 0}`).join(' | ');
        return [
            `📝 WORDCHAIN_ENG (faucet) — ${fmt(m.rounds)} ván | Unique players: ${fmt(uniq)}`,
            `**Minted**: ${fmt(m.ngocAwarded)} ngọc | Reward/ván: ${rewardPerRound} | Ngọc/phút (chơi): ${ngocPerMin}`,
            `Total words: ${fmt(m.totalWords)} | Avg/round: ${avgWords} | Biggest round: ${fmt(m.biggestRound)} | Participants avg: ${avgPart}`,
            `Histogram số từ: ${histStr}`,
            `Vượt mốc bão hòa (≥${econThreshold()}): ${m.roundsAboveThreshold || 0} (${pct(m.roundsAboveThreshold, m.rounds)}) | Multiplayer (≥2 ng): ${m.multiplayerRounds} (${pct(m.multiplayerRounds, m.rounds)}) | Empty: ${m.emptyRounds}`,
            `Từ bị từ chối: ${fmt(m.rejectedWords || 0)} | End reasons — timeout: ${er.timeout} | dead_end: ${er.dead_end} | surrender: ${er.surrender}`
        ].join('\n');
    }
    return '';
}

function econThreshold() {
    try { return require('../config/economy').WORDCHAIN_ENG.WORD_THRESHOLD; } catch (e) { return 25; }
}

function formatGame(game) { return _formatGame(game); }

// Compute net economy contributions from a bucket store object.
// Returns { netGame, minted, burned, netEconomy }.
function netFromStore(store) {
    let netGame = 0;
    for (const g of ['slot', 'coinflip', 'tong', 'mat']) {
        const m = store[g];
        if (!m) continue;
        const wagered = m.wagered || 0;
        const payout = m.payout || 0;
        netGame += (payout - wagered);
    }
    const minted = (store.wordchain_eng && store.wordchain_eng.ngocAwarded) || 0;
    const burned = (store.gacha && store.gacha.burned) || 0;
    return { netGame, minted, burned, netEconomy: netGame + minted - burned };
}

function rollingNet(days = 7) {
    const buckets = listBuckets();
    if (buckets.length === 0) return { days: 0, total: 0, avg: 0, samples: [] };
    const todayInclusive = buckets.slice(0, days);
    let total = 0;
    const samples = [];
    for (const b of todayInclusive) {
        const store = (b === _bucket) ? _store : loadBucket(b);
        const { netEconomy } = netFromStore(store);
        total += netEconomy;
        samples.push({ bucket: b, netEconomy });
    }
    return { days: todayInclusive.length, total, avg: todayInclusive.length ? total / todayInclusive.length : 0, samples };
}

function formatSummary(store, label) {
    const { netGame, minted, burned, netEconomy } = netFromStore(store);
    const r = rollingNet(7);
    const sign = (n) => n >= 0 ? `+${fmt(n)}` : `${fmt(n)}`;
    return [
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💹 NET KINH TẾ${label} = ${sign(netEconomy)} ngọc`,
        `  = net game (${sign(netGame)}) + faucet wordchain (${sign(minted)}) − gacha burned (${fmt(burned)})`,
        `📈 7-day rolling avg net economy: ${sign(Math.round(r.avg))} ngọc/ngày (${r.days} ngày)`
    ].join('\n');
}

function formatAllSections(bucket) {
    const label = bucket ? ` [${bucket}]` : ` [${_bucket}]`;
    const store = bucket ? loadBucket(bucket) : null;
    const orig = store ? _store : null;
    if (store) {
        // temporarily swap store for formatting
        Object.assign(_store, {});
        Object.keys(store).forEach(k => (_store[k] = store[k]));
    }
    const liveStore = bucket ? store : _store;
    const sections = ['slot', 'coinflip', 'tong', 'mat', 'gacha', 'wordchain_eng']
        .map(g => _formatGame(g))
        .filter(Boolean);
    sections.push(`${formatSummary(liveStore, label)}\n📅 Ngày${label}`);
    if (orig) Object.assign(_store, orig);
    return sections;
}

// Backwards-compatible single-string formatter (joins sections with blank lines).
function formatAll(bucket) {
    return formatAllSections(bucket).join('\n\n');
}

// Pack sections into Discord-sized chunks (≤ budget chars per chunk),
// preserving section boundaries — never splits inside a section.
function packSections(sections, budget = 1900) {
    const out = [];
    let current = '';
    for (const s of sections) {
        if (!s) continue;
        const sep = current ? '\n\n' : '';
        if (current && current.length + sep.length + s.length > budget) {
            out.push(current);
            current = s;
        } else {
            current += sep + s;
        }
    }
    if (current) out.push(current);
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
    recordSlot, recordCoinflip, recordTong, recordMat, recordWordchainEng,
    recordGacha, recordWordchainReject,
    formatSlot, formatCoinflip, formatTong, formatMat,
    formatAll, formatAllSections, formatGame, packSections, listBuckets,
    rollingNet, netFromStore,
    currentBucket: () => _bucket,
    flush
};
