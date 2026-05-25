const fs = require('fs');
const path = require('path');
const log = require('../../logger');
const { fmt } = require('./currency');
const { data, saveData } = require('../state');

const METRICS_DIR = path.resolve(__dirname, '..', '..', 'metrics');
const FLUSH_INTERVAL_MS = 30_000;

// ---- bucket helpers --------------------------------------------------------

function currentBucket() {
    const shifted = new Date(Date.now() + 7 * 3600 * 1000);
    return shifted.toISOString().slice(0, 10);
}

function bucketPath(bucket) {
    return path.join(METRICS_DIR, `${bucket}.json`);
}

function ensureDir() {
    if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
}

// Store shape (current): { [guildId]: { slot: {...}, coinflip: {...}, ... } }
// Legacy buckets are flat `{ slot: {...}, ... }` — migrated on read by wrapping
// the whole thing under a synthetic `_legacy` guild key.
const LEGACY_GUILD_KEY = '_legacy';

function migrateBucket(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const gameKeys = new Set(Object.keys(GAME_DEFAULTS));
    const topKeys = Object.keys(raw);
    if (topKeys.length === 0) return {};
    const looksLegacy = topKeys.some(k => gameKeys.has(k));
    if (looksLegacy) return { [LEGACY_GUILD_KEY]: raw };
    return raw;
}

function loadBucket(bucket) {
    const p = bucketPath(bucket);
    try {
        if (fs.existsSync(p)) return migrateBucket(JSON.parse(fs.readFileSync(p, 'utf8')));
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
    },
    daily: {
        claims: 0,
        nganphieuMinted: 0,
        playerIds: {}
    },
    gangoc: {
        giveaways: 0,
        ngocPerClaimTotal: 0,
        claims: 0,
        ngocMinted: 0,
        playerIds: {}
    }
};

// ---- exclude list ----------------------------------------------------------
// Users on the exclude list have ALL of their plays skipped at record* time:
// nothing they do is wagered, paid out, claimed, or counted as a unique player.
// Used to keep super-admin test plays out of game-balance metrics.

function _excludeSet() {
    if (!Array.isArray(data.metricsExcludeUsers)) data.metricsExcludeUsers = [];
    return new Set(data.metricsExcludeUsers);
}

function isExcluded(userId) {
    if (!userId) return false;
    return _excludeSet().has(String(userId));
}

function listExcluded() {
    return Array.from(_excludeSet());
}

function addExcluded(userId) {
    if (!userId) return false;
    const id = String(userId);
    if (!Array.isArray(data.metricsExcludeUsers)) data.metricsExcludeUsers = [];
    if (data.metricsExcludeUsers.includes(id)) return false;
    data.metricsExcludeUsers.push(id);
    saveData();
    return true;
}

function removeExcluded(userId) {
    if (!userId || !Array.isArray(data.metricsExcludeUsers)) return false;
    const id = String(userId);
    const i = data.metricsExcludeUsers.indexOf(id);
    if (i < 0) return false;
    data.metricsExcludeUsers.splice(i, 1);
    saveData();
    return true;
}

// Strip a user's ID from every playerIds map across the live store + all
// historical bucket files. Returns count of buckets modified.
function purgeUserFromPlayerIds(userId) {
    if (!userId) return 0;
    const uid = String(userId);
    let modified = 0;

    // Live store
    let liveDirty = false;
    for (const guildStore of Object.values(_store)) {
        for (const gameStore of Object.values(guildStore)) {
            if (gameStore && gameStore.playerIds && gameStore.playerIds[uid] !== undefined) {
                delete gameStore.playerIds[uid];
                liveDirty = true;
            }
        }
    }
    if (liveDirty) { _dirty = true; flush(); modified++; }

    // Historical buckets
    for (const b of listBuckets()) {
        if (b === _bucket) continue;
        const raw = loadBucket(b);
        let touched = false;
        for (const guildStore of Object.values(raw)) {
            for (const gameStore of Object.values(guildStore)) {
                if (gameStore && gameStore.playerIds && gameStore.playerIds[uid] !== undefined) {
                    delete gameStore.playerIds[uid];
                    touched = true;
                }
            }
        }
        if (touched) {
            try { fs.writeFileSync(bucketPath(b), JSON.stringify(raw, null, 0)); modified++; }
            catch (e) { log.error(`metrics: purgeUser failed for ${b}`, e); }
        }
    }
    return modified;
}

// Apply numeric deltas to a specific guild/game in a specific bucket.
// deltas: { 'field': number, 'nested.path': number, ... }
// Returns { applied: {field: delta}, skipped: {field: reason} }.
function adjustBucket(bucket, guildId, game, deltas) {
    if (!GAME_DEFAULTS[game]) throw new Error(`unknown game: ${game}`);
    const isLive = bucket === _bucket;
    if (isLive) flush();

    const raw = loadBucket(bucket);
    if (!raw[guildId]) raw[guildId] = {};
    if (!raw[guildId][game]) raw[guildId][game] = JSON.parse(JSON.stringify(GAME_DEFAULTS[game]));
    const target = raw[guildId][game];

    const applied = {};
    const skipped = {};
    for (const [path, delta] of Object.entries(deltas)) {
        if (typeof delta !== 'number' || !Number.isFinite(delta)) {
            skipped[path] = 'not a finite number';
            continue;
        }
        const parts = path.split('.');
        let node = target;
        for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i];
            if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
            node = node[k];
        }
        const leaf = parts[parts.length - 1];
        const cur = Number(node[leaf]) || 0;
        node[leaf] = cur + delta;
        applied[path] = delta;
    }

    try { fs.writeFileSync(bucketPath(bucket), JSON.stringify(raw, null, 0)); }
    catch (e) { log.error(`metrics: adjustBucket write failed for ${bucket}`, e); throw e; }

    if (isLive) {
        // Reload live store from disk so subsequent record* calls see the adjustment.
        _store = loadBucket(_bucket);
        _dirty = false;
    }
    return { applied, skipped };
}

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

function _get(guildId, game) {
    const gid = guildId || LEGACY_GUILD_KEY;
    if (!_store[gid]) _store[gid] = {};
    const guildStore = _store[gid];
    if (!guildStore[game]) guildStore[game] = JSON.parse(JSON.stringify(GAME_DEFAULTS[game]));
    const m = guildStore[game];
    const def = GAME_DEFAULTS[game];
    for (const k of Object.keys(def)) {
        if (m[k] === undefined) m[k] = typeof def[k] === 'object' ? JSON.parse(JSON.stringify(def[k])) : def[k];
    }
    return m;
}

// Merge multiple per-guild snapshots of a single game into one flat metric.
// Numbers sum; biggestWin/biggestWinBet kept as a pair; biggestRound/maxBet → max.
// Object fields (playerIds, outcomes, betBuckets, etc.) merge by summing values.
const MAX_FIELDS = new Set(['biggestRound', 'maxBet']);
function mergeForGame(game, instances) {
    const def = GAME_DEFAULTS[game];
    const out = JSON.parse(JSON.stringify(def));
    if (def.biggestWin !== undefined) {
        let best = 0, bestBet = 0;
        for (const m of instances) {
            const w = m.biggestWin || 0;
            if (w > best) { best = w; bestBet = m.biggestWinBet || 0; }
        }
        out.biggestWin = best;
        out.biggestWinBet = bestBet;
    }
    for (const key of Object.keys(def)) {
        if (key === 'biggestWin' || key === 'biggestWinBet') continue;
        if (MAX_FIELDS.has(key)) {
            let v = 0;
            for (const m of instances) {
                const x = m[key] || 0;
                if (x > v) v = x;
            }
            out[key] = v;
        } else if (typeof def[key] === 'number') {
            let v = 0;
            for (const m of instances) v += (m[key] || 0);
            out[key] = v;
        } else if (typeof def[key] === 'object' && def[key] !== null) {
            const merged = {};
            for (const k of Object.keys(def[key])) merged[k] = 0;
            for (const m of instances) {
                const sub = m[key] || {};
                for (const k of Object.keys(sub)) {
                    merged[k] = (merged[k] || 0) + (Number(sub[k]) || 0);
                }
            }
            out[key] = merged;
        }
    }
    return out;
}

// Collapse per-guild store into single flat { game: metric } using filter.
// guildFilter: undefined / 'all' → merge all guilds; otherwise pick that guild only.
function flattenStore(perGuildStore, guildFilter) {
    const out = {};
    const games = Object.keys(GAME_DEFAULTS);
    const isSingle = guildFilter && guildFilter !== 'all';
    for (const game of games) {
        const instances = [];
        if (isSingle) {
            const g = perGuildStore[guildFilter];
            if (g && g[game]) instances.push(g[game]);
        } else {
            for (const gid of Object.keys(perGuildStore)) {
                const g = perGuildStore[gid];
                if (g && g[game]) instances.push(g[game]);
            }
        }
        if (instances.length > 0) out[game] = mergeForGame(game, instances);
    }
    return out;
}

function listGuildsInStore(perGuildStore) {
    return Object.keys(perGuildStore || {});
}

function listAllGuilds() {
    const set = new Set();
    for (const b of listBuckets()) {
        const s = (b === _bucket) ? _store : loadBucket(b);
        for (const gid of Object.keys(s)) set.add(gid);
    }
    return Array.from(set);
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

function recordSlot({ guildId, amount, payout, outcomeName, pityTriggered, pityCapApplied, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'slot');
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

function recordCoinflip({ guildId, amount, won, side, viaButton = false, wasAllIn = false, bigWin = false, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'coinflip');
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

function recordTong({ guildId, amount, won, mult, guess, viaButton = false, wasAllIn = false, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'tong');
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

function recordMat({ guildId, amount, won, mult, face, matches, viaButton = false, wasAllIn = false, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'mat');
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

function recordGacha({ guildId, rolls, cost, counts, userId, ktPityRolls = 0, ttPityRolls = 0, hitsAtPityKt = 0, hitsAtPityTt = 0 }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'gacha');
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

function recordWordchainEng({ guildId, totalWords, participants, ngocAwarded, endReason, durationMs = 0, aboveThreshold = false, userIds = [] }) {
    // Drop excluded users from participant list before counting.
    const filteredIds = (userIds || []).filter(uid => !isExcluded(uid));
    _checkRollover();
    const m = _get(guildId, 'wordchain_eng');
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
    for (const uid of filteredIds) {
        m.playerIds[uid] = (m.playerIds[uid] || 0) + 1;
    }
    _dirty = true;
}

function recordDaily({ guildId, nganphieu, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'daily');
    m.claims++;
    m.nganphieuMinted += nganphieu;
    if (userId) m.playerIds[userId] = (m.playerIds[userId] || 0) + 1;
    _dirty = true;
}

function recordGangocCreated({ guildId, amount }) {
    _checkRollover();
    const m = _get(guildId, 'gangoc');
    m.giveaways++;
    m.ngocPerClaimTotal += amount;
    _dirty = true;
}

function recordGangocClaim({ guildId, amount, userId }) {
    if (isExcluded(userId)) return;
    _checkRollover();
    const m = _get(guildId, 'gangoc');
    m.claims++;
    m.ngocMinted += amount;
    if (userId) m.playerIds[userId] = (m.playerIds[userId] || 0) + 1;
    _dirty = true;
}

function recordWordchainReject({ guildId } = {}) {
    _checkRollover();
    const m = _get(guildId, 'wordchain_eng');
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

function _emptyGameMetric(game) {
    return JSON.parse(JSON.stringify(GAME_DEFAULTS[game]));
}

// Pull a flat metric for a single game from a per-guild store, applying guildFilter.
function _flatGame(perGuildStore, guildFilter, game) {
    const flat = flattenStore(perGuildStore, guildFilter);
    return flat[game] || _emptyGameMetric(game);
}

function _formatGame(game, perGuildStore, guildFilter) {
    perGuildStore = perGuildStore || _store;
    if (game === 'slot') {
        const m = _flatGame(perGuildStore, guildFilter, 'slot');
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
        const m = _flatGame(perGuildStore, guildFilter, 'coinflip');
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
        const m = _flatGame(perGuildStore, guildFilter, 'tong');
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
        const m = _flatGame(perGuildStore, guildFilter, 'mat');
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
        const m = _flatGame(perGuildStore, guildFilter, 'gacha');
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
    if (game === 'daily') {
        const m = _flatGame(perGuildStore, guildFilter, 'daily');
        const uniq = uniqueCount(m.playerIds);
        const ngocEq = m.nganphieuMinted / 100;
        return [
            `🎁 DAILY (faucet) — ${fmt(m.claims)} lượt nhận | Unique: ${fmt(uniq)}`,
            `**Minted**: ${fmt(m.nganphieuMinted)} ngân phiếu (≈ ${fmt(Math.round(ngocEq))} ngọc-eq)`
        ].join('\n');
    }
    if (game === 'gangoc') {
        const m = _flatGame(perGuildStore, guildFilter, 'gangoc');
        const uniq = uniqueCount(m.playerIds);
        const avgPerGa = m.giveaways ? Math.round(m.ngocPerClaimTotal / m.giveaways) : 0;
        return [
            `🎉 GANGOC (faucet) — ${fmt(m.giveaways)} GAs | ${fmt(m.claims)} claims | Unique: ${fmt(uniq)}`,
            `**Minted**: ${fmt(m.ngocMinted)} ngọc | Avg ngọc/GA (per claim): ${fmt(avgPerGa)}`
        ].join('\n');
    }
    if (game === 'wordchain_eng' || game === 'wordchain') {
        const m = _flatGame(perGuildStore, guildFilter, 'wordchain_eng');
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

function formatGame(game, guildFilter) { return _formatGame(game, _store, guildFilter); }

// Compute net economy contributions from a per-guild bucket store, filtered.
// Returns { netGame, minted, burned, netEconomy, ...breakdown }.
function netFromStore(perGuildStore, guildFilter) {
    const flat = flattenStore(perGuildStore, guildFilter);
    let netGame = 0;
    for (const g of ['slot', 'coinflip', 'tong', 'mat']) {
        const m = flat[g];
        if (!m) continue;
        netGame += ((m.payout || 0) - (m.wagered || 0));
    }
    const mintedWordchain = (flat.wordchain_eng && flat.wordchain_eng.ngocAwarded) || 0;
    const mintedGangoc = (flat.gangoc && flat.gangoc.ngocMinted) || 0;
    const mintedDailyNganphieu = (flat.daily && flat.daily.nganphieuMinted) || 0;
    const mintedDailyNgocEq = mintedDailyNganphieu / 100;
    const minted = mintedWordchain + mintedGangoc + mintedDailyNgocEq;
    const burned = (flat.gacha && flat.gacha.burned) || 0;
    return {
        netGame, minted, burned,
        mintedWordchain, mintedGangoc, mintedDailyNganphieu,
        netEconomy: netGame + minted - burned
    };
}

function rollingNet(days = 7, guildFilter) {
    const buckets = listBuckets();
    if (buckets.length === 0) return { days: 0, total: 0, avg: 0, samples: [] };
    const todayInclusive = buckets.slice(0, days);
    let total = 0;
    const samples = [];
    for (const b of todayInclusive) {
        const store = (b === _bucket) ? _store : loadBucket(b);
        const { netEconomy } = netFromStore(store, guildFilter);
        total += netEconomy;
        samples.push({ bucket: b, netEconomy });
    }
    return { days: todayInclusive.length, total, avg: todayInclusive.length ? total / todayInclusive.length : 0, samples };
}

function formatSummary(store, label, guildFilter) {
    const { netGame, minted, burned, netEconomy } = netFromStore(store, guildFilter);
    const r = rollingNet(7, guildFilter);
    const sign = (n) => n >= 0 ? `+${fmt(n)}` : `${fmt(n)}`;
    const scope = (!guildFilter || guildFilter === 'all') ? ' (all guilds)' : ` (guild ${guildFilter})`;
    return [
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💹 NET KINH TẾ${label}${scope} = ${sign(netEconomy)} ngọc`,
        `  = net game (${sign(netGame)}) + faucet (${sign(minted)}) − gacha burned (${fmt(burned)})`,
        `📈 7-day rolling avg net economy: ${sign(Math.round(r.avg))} ngọc/ngày (${r.days} ngày)`
    ].join('\n');
}

function formatAllSections(bucket, guildFilter) {
    const label = bucket ? ` [${bucket}]` : ` [${_bucket}]`;
    const store = bucket ? loadBucket(bucket) : _store;
    const sections = ['slot', 'coinflip', 'tong', 'mat', 'gacha', 'wordchain_eng', 'daily', 'gangoc']
        .map(g => _formatGame(g, store, guildFilter))
        .filter(Boolean);
    sections.push(`${formatSummary(store, label, guildFilter)}\n📅 Ngày${label}`);
    return sections;
}

// Backwards-compatible single-string formatter (joins sections with blank lines).
function formatAll(bucket, guildFilter) {
    return formatAllSections(bucket, guildFilter).join('\n\n');
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
const formatSlot = (guildFilter) => _formatGame('slot', _store, guildFilter);
const formatCoinflip = (guildFilter) => _formatGame('coinflip', _store, guildFilter);
const formatTong = (guildFilter) => _formatGame('tong', _store, guildFilter);
const formatMat = (guildFilter) => _formatGame('mat', _store, guildFilter);

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
    recordDaily, recordGangocCreated, recordGangocClaim,
    formatSlot, formatCoinflip, formatTong, formatMat,
    formatAll, formatAllSections, formatGame, packSections, listBuckets,
    rollingNet, netFromStore, loadBucket,
    flattenStore, listGuildsInStore, listAllGuilds,
    isExcluded, listExcluded, addExcluded, removeExcluded, purgeUserFromPlayerIds,
    adjustBucket,
    LEGACY_GUILD_KEY,
    currentBucket: () => _bucket,
    flush
};
