const fs = require('fs');
const path = require('path');
const log = require('../../logger');
const economy = require('../config/economy');

// Review queue for the !noitu (Nối Từ Co-op) dictionary. The dataset is small,
// so legit words get ❌-ed in game; every declined 2-syllable play is recorded
// here as a candidate. Two filter layers decide a candidate's fate:
//
//   1. PLAYERS vote ✅/❌ via !duyettu. A word that gets APPROVE_THRESHOLD ✅
//      "graduates" to the admin queue. A word that gets REJECT_THRESHOLD ❌ is
//      auto-rejected — unless it's contested (already has ≥1 ✅), in which case it
//      graduates to the admin queue too, so every harsh penalty has an admin
//      verdict behind it.
//   2. ADMIN reviews graduated words on the dashboard (/words): ✅ stages a word,
//      ❌ rejects it. One Write commits the staged batch into
//      word_dict/tu2amtiet.json via wordchainViet.addWordsToDict.
//
// Payouts (services/currency) resolve when a word reaches a verdict: each voter
// is rewarded/penalised by comparing their vote to the "truth" (admin verdict on
// the accept branch, crowd consensus on clean auto-rejects) and whether they were
// with or against the crowd. See resolveWord + economy.WORD_REVIEW.
//
// wordchainViet is required lazily inside functions: it requires this module at
// load time (to record declines), so a top-level require would be circular.
// currency is also required lazily (it pulls in state.js).

const STORE_PATH = path.resolve(__dirname, '../../word_dict/noitu_review.json');
const TMP_PATH = STORE_PATH + '.tmp';
const SAVE_DEBOUNCE_MS = 1000;
const MAX_PENDING = 2000;
// Rejected entries are kept (not deleted) so a junk word won't resurface in the
// queue when it's replayed. Bulk-reject can dump a lot in at once, so cap the
// rejected backlog too; oldest rejects are evicted (they may resurface, fine).
const MAX_REJECTED = 3000;
const DAILY_RESET_OFFSET_HOURS = 7; // matches currency.js daily rollover (GMT+7)

// declined: { [word]: { count, lastAt, chained,
//                       status: 'pending'|'graduated'|'staged'|'rejected',
//                       votes?: { [userId]: { v: 1|-1, at, g: guildId } },
//                       contested?, graduatedAt?, resolved?, resolvedAt?, resolvedTruth? } }
// manualStaged: words typed by the admin (never seen in game), staged directly.
// voteCount: { [userId]: { date, n } } — per-day distinct-vote counter (anti-farm).
function loadStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return {
            declined: raw.declined && typeof raw.declined === 'object' ? raw.declined : {},
            manualStaged: Array.isArray(raw.manualStaged) ? raw.manualStaged : [],
            voteCount: raw.voteCount && typeof raw.voteCount === 'object' ? raw.voteCount : {}
        };
    } catch (e) {
        return { declined: {}, manualStaged: [], voteCount: {} };
    }
}

const store = loadStore();

let saveTimer = null;
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            await fs.promises.writeFile(TMP_PATH, JSON.stringify(store));
            await fs.promises.rename(TMP_PATH, STORE_PATH);
        } catch (e) {
            log.error('wordReview: save failed', e);
        }
    }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
}

function todayStr() {
    return new Date(Date.now() + DAILY_RESET_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

function normalizeWord(text) {
    const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    // Fold old/new diacritic spellings (lũy=luỹ…) to the same canonical form the
    // game matches on, so the review queue dedups variants and never queues a
    // word that's already playable under its other spelling. Lazy-required to
    // avoid the wordchainViet ↔ wordReview load cycle.
    try { return require('./wordchainViet').canonicalize(s); }
    catch (e) { return s; }
}

// Same shape the game accepts: exactly 2 syllables, letters only.
const TOKEN_RE = /^\p{L}+$/u;
function isValidShape(word) {
    const tokens = word.split(' ');
    return tokens.length === 2 && tokens.every(t => TOKEN_RE.test(t));
}

function tallyOf(e) {
    let yes = 0, no = 0;
    if (e.votes) for (const r of Object.values(e.votes)) { if (r.v === 1) yes += 1; else no += 1; }
    return { yes, no };
}

// Pending sort order: real chain attempts first, then by play count and recency.
function pendingCmp(a, b) {
    return (b.chained - a.chained) || (b.count - a.count) || (b.lastAt - a.lastAt);
}

// Spam guard: the queue is fed by arbitrary thread messages, so cap the
// pending backlog by evicting the least-played, oldest entry.
function evictIfNeeded() {
    const pending = Object.entries(store.declined).filter(([, e]) => e.status === 'pending');
    if (pending.length < MAX_PENDING) return;
    pending.sort((a, b) => (a[1].count - b[1].count) || (a[1].lastAt - b[1].lastAt));
    delete store.declined[pending[0][0]];
}

function evictRejectedIfNeeded() {
    const rejected = Object.entries(store.declined).filter(([, e]) => e.status === 'rejected');
    if (rejected.length <= MAX_REJECTED) return;
    rejected.sort((a, b) => a[1].lastAt - b[1].lastAt); // oldest first
    for (let i = 0; i < rejected.length - MAX_REJECTED; i++) delete store.declined[rejected[i][0]];
}

// Called from wordchainViet on every not_in_dict decline. `chained` = the word
// started with the required syllable (a real attempt, not thread chatter).
function recordDeclined(word, chained) {
    word = normalizeWord(word);
    if (!isValidShape(word)) return;
    const e = store.declined[word];
    if (e) {
        e.count += 1;
        e.lastAt = Date.now();
        if (chained) e.chained = true;
    } else {
        evictIfNeeded();
        store.declined[word] = { count: 1, lastAt: Date.now(), chained: !!chained, status: 'pending' };
    }
    save();
}

// ── Payout engine ───────────────────────────────────────────────────────────

// Apply a signed ngọc delta to a voter. Positive = reward (added). Negative =
// penalty, taken from real (non-locked) ngọc only and clamped at 0. Returns the
// signed amount actually applied.
function applyNgoc(currency, guildId, uid, amount) {
    if (!guildId || !amount) return 0;
    if (amount > 0) { currency.addNgoc(guildId, uid, amount); return amount; }
    const w = currency.getWallet(guildId, uid);
    const take = Math.min(w.ngoc, -amount);
    if (take > 0) currency.addNgoc(guildId, uid, -take);
    return -take;
}

// Settle every voter of a word against the verdict `truth` ('add' | 'reject').
// Idempotent: a word is only ever resolved once. No-op if there are no votes.
function resolveWord(word, truth) {
    const e = store.declined[word];
    if (!e || e.resolved) return null;
    const entries = e.votes ? Object.entries(e.votes) : [];
    if (!entries.length) { e.resolved = true; return null; }
    let yes = 0, no = 0;
    for (const [, r] of entries) { if (r.v === 1) yes += 1; else no += 1; }
    const cfg = economy.WORD_REVIEW;
    // A word still under threshold (admin resolving it while pending) never built a
    // real crowd, so skip the majority/minority bonus and pay a flat amount on the
    // admin's verdict. Graduated/auto-rejected words (≥ a threshold) keep the
    // crowd-aware payout.
    const reachedThreshold = yes >= cfg.APPROVE_THRESHOLD || no >= cfg.REJECT_THRESHOLD;
    const majority = yes > no ? 1 : (no > yes ? -1 : 0); // 0 = tie (no minority bonus/penalty)
    const currency = require('./currency');
    let paid = 0, docked = 0;
    for (const [uid, r] of entries) {
        const matched = (r.v === 1 && truth === 'add') || (r.v === -1 && truth === 'reject');
        let amount;
        if (!reachedThreshold) {
            amount = matched ? cfg.REWARD_FLAT : -cfg.PENALTY_FLAT;
        } else {
            const inMajority = majority === 0 ? true : (r.v === majority);
            amount = matched
                ? (inMajority ? cfg.REWARD : cfg.REWARD_MINORITY)
                : (inMajority ? -cfg.PENALTY : -cfg.PENALTY_MINORITY);
        }
        const applied = applyNgoc(currency, r.g, uid, amount);
        if (applied >= 0) paid += applied; else docked += -applied;
    }
    e.resolved = true;
    e.resolvedAt = Date.now();
    e.resolvedTruth = truth;
    log.info(`wordReview: resolved "${word}" as ${truth} — ${entries.length} voters, +${paid}/-${docked} ngọc`);
    return { word, truth, voters: entries.length, paid, docked };
}

// ── Player voting (filter layer 1) ────────────────────────────────────────────

function voteCountToday(userId) {
    const e = store.voteCount[userId];
    return (e && e.date === todayStr()) ? e.n : 0;
}

function getVoteCapInfo(userId) {
    const cap = economy.WORD_REVIEW.DAILY_VOTE_CAP;
    const used = voteCountToday(userId);
    return { used, cap, remaining: Math.max(0, cap - used) };
}

function bumpVoteCount(userId) {
    const today = todayStr();
    const e = store.voteCount[userId];
    if (!e || e.date !== today) store.voteCount[userId] = { date: today, n: 1 };
    else e.n += 1;
}

// The next pending word `userId` hasn't voted on yet, with its current tally.
// opts.excludeWord skips a specific word (used by the ⏭️ button); opts.random
// returns a random eligible word instead of the top-priority one (so repeated
// skips cycle through variety rather than ping-ponging the same two words).
function nextPendingFor(userId, opts = {}) {
    const { excludeWord, random } = opts;
    const cands = [];
    for (const [word, e] of Object.entries(store.declined)) {
        if (e.status !== 'pending') continue;
        if (e.votes && e.votes[userId]) continue;
        if (excludeWord && word === excludeWord) continue;
        const t = tallyOf(e);
        cands.push({ word, count: e.count, lastAt: e.lastAt, chained: !!e.chained, yes: t.yes, no: t.no });
    }
    if (!cands.length) return null;
    if (random) return cands[Math.floor(Math.random() * cands.length)];
    cands.sort(pendingCmp);
    return cands[0];
}

// Record a player's vote (v: 1 = real word, -1 = not a word). Enforces one vote
// per word per user (re-voting before graduation just overwrites) and the daily
// vote cap (new votes only). May graduate the word to the admin queue or
// auto-reject it. Returns { status, yes, no } where status is one of:
// 'recorded' | 'graduated' | 'autoRejected' | 'capped' | 'gone'.
function vote(guildId, userId, word, v) {
    word = normalizeWord(word);
    if (!isValidShape(word)) return { status: 'gone' };
    const e = store.declined[word];
    if (!e || e.status !== 'pending') return { status: 'gone' };
    e.votes = e.votes || {};
    const isNew = !e.votes[userId];
    if (isNew && voteCountToday(userId) >= economy.WORD_REVIEW.DAILY_VOTE_CAP) {
        return { status: 'capped' };
    }
    e.votes[userId] = { v: v === 1 ? 1 : -1, at: Date.now(), g: guildId };
    if (isNew) bumpVoteCount(userId);

    const { yes, no } = tallyOf(e);
    const cfg = economy.WORD_REVIEW;
    let status = 'recorded';
    if (yes >= cfg.APPROVE_THRESHOLD) {
        e.status = 'graduated';
        e.graduatedAt = Date.now();
        status = 'graduated';
    } else if (no >= cfg.REJECT_THRESHOLD) {
        if (yes >= 1) {
            // Contested: someone vouched for it, so let the admin be the truth
            // (protects an honest ✅ minority from a coordinated ❌-bomb).
            e.status = 'graduated';
            e.contested = true;
            e.graduatedAt = Date.now();
            status = 'graduated';
        } else {
            e.status = 'rejected';
            resolveWord(word, 'reject');
            status = 'autoRejected';
        }
    }
    save();
    return { status, yes, no };
}

// ── Admin review (filter layer 2) + dashboard state ───────────────────────────

function listState() {
    const wcv = require('./wordchainViet');
    const pending = [];
    const graduated = [];
    const stagedDeclined = [];
    const rejected = [];
    for (const [word, e] of Object.entries(store.declined)) {
        const t = tallyOf(e);
        const item = { word, count: e.count, lastAt: e.lastAt, chained: !!e.chained, yes: t.yes, no: t.no };
        if (e.status === 'staged') stagedDeclined.push(item);
        else if (e.status === 'rejected') rejected.push(item);
        else if (e.status === 'graduated') graduated.push({ ...item, contested: !!e.contested });
        else pending.push(item);
    }
    pending.sort(pendingCmp);
    // Strongest accepts first; contested (recommended-reject) sink to the bottom.
    graduated.sort((a, b) => ((b.yes - b.no) - (a.yes - a.no)) || (b.yes - a.yes) || (b.count - a.count));
    rejected.sort((a, b) => b.lastAt - a.lastAt);
    stagedDeclined.sort((a, b) => a.word.localeCompare(b.word, 'vi'));
    const staged = [
        ...stagedDeclined.map(i => ({ word: i.word, source: 'declined' })),
        ...store.manualStaged.map(w => ({ word: w, source: 'manual' }))
    ];
    const cfg = economy.WORD_REVIEW;
    return {
        pending, graduated, staged, rejected,
        dictSize: wcv.dictSize(),
        thresholds: { approve: cfg.APPROVE_THRESHOLD, reject: cfg.REJECT_THRESHOLD }
    };
}

function accept(word) {
    const e = store.declined[word];
    if (!e) throw new Error('Không tìm thấy từ trong danh sách chờ duyệt.');
    const wcv = require('./wordchainViet');
    resolveWord(word, 'add'); // pay voters (if any) before the entry is staged/removed
    if (wcv.isWordInDict(word)) {
        // Already added via an earlier batch — nothing to stage.
        delete store.declined[word];
    } else {
        e.status = 'staged';
    }
    save();
}

function reject(word) {
    const e = store.declined[word];
    if (!e) throw new Error('Không tìm thấy từ trong danh sách chờ duyệt.');
    resolveWord(word, 'reject');
    e.status = 'rejected';
    save();
}

// Bulk-reject every word in one status — the "select all wrong words at once"
// flow after the real words have been ✅-ed. Resolves any votes on the way out.
function rejectAllByStatus(status) {
    let n = 0;
    for (const [word, e] of Object.entries(store.declined)) {
        if (e.status !== status) continue;
        resolveWord(word, 'reject');
        e.status = 'rejected';
        n += 1;
    }
    if (n) {
        evictRejectedIfNeeded();
        save();
    }
    return { rejected: n };
}

function rejectAllPending() { return rejectAllByStatus('pending'); }
function rejectAllGraduated() { return rejectAllByStatus('graduated'); }

function restore(word) {
    const e = store.declined[word];
    if (!e) throw new Error('Không tìm thấy từ.');
    // Fresh start: prior payouts stand, but a restored word can be re-reviewed.
    e.status = 'pending';
    e.votes = {};
    e.resolved = false;
    delete e.contested;
    delete e.graduatedAt;
    save();
}

// Remove from the staged list: manual entries are dropped, declined entries go
// back to pending.
function unstage(word) {
    const idx = store.manualStaged.indexOf(word);
    if (idx !== -1) {
        store.manualStaged.splice(idx, 1);
        save();
        return;
    }
    const e = store.declined[word];
    if (e && e.status === 'staged') {
        e.status = 'pending';
        save();
        return;
    }
    throw new Error('Từ không nằm trong danh sách chờ ghi.');
}

function applyAction(action, word) {
    word = normalizeWord(word);
    if (!word) throw new Error('Thiếu từ.');
    if (action === 'accept') return accept(word);
    if (action === 'reject') return reject(word);
    if (action === 'restore') return restore(word);
    if (action === 'unstage') return unstage(word);
    throw new Error('Hành động không hợp lệ.');
}

// Manual entry: one word per line (commas/semicolons also split — words
// themselves contain a space).
function addManual(text) {
    const wcv = require('./wordchainViet');
    const added = [];
    const skipped = [];
    const items = String(text || '').split(/[\n,;]+/).map(normalizeWord).filter(Boolean);
    for (const word of items) {
        if (!isValidShape(word)) { skipped.push({ word, reason: 'không phải dạng 2 âm tiết' }); continue; }
        if (wcv.isWordInDict(word)) { skipped.push({ word, reason: 'đã có trong từ điển' }); continue; }
        const e = store.declined[word];
        if (store.manualStaged.includes(word) || (e && e.status === 'staged')) {
            skipped.push({ word, reason: 'đã trong danh sách chờ ghi' });
            continue;
        }
        if (e) e.status = 'staged';
        else store.manualStaged.push(word);
        added.push(word);
    }
    if (added.length) save();
    return { added, skipped };
}

// Commit the whole staged batch to the dictionary in one write.
function writeStaged() {
    const wcv = require('./wordchainViet');
    const words = Object.entries(store.declined)
        .filter(([, e]) => e.status === 'staged')
        .map(([w]) => w)
        .concat(store.manualStaged);
    if (words.length === 0) throw new Error('Danh sách chờ ghi đang trống.');
    const result = wcv.addWordsToDict(words);
    for (const w of words) delete store.declined[w];
    store.manualStaged = [];
    save();
    log.info(`wordReview: wrote ${result.added.length} words to dict (${result.skipped.length} skipped)`);
    return result;
}

// Daily prune: drop stale per-user vote counters (wired into the 00:05 sweep).
function pruneDaily(today) {
    today = today || todayStr();
    let removed = 0;
    for (const uid of Object.keys(store.voteCount)) {
        if (store.voteCount[uid].date !== today) { delete store.voteCount[uid]; removed += 1; }
    }
    if (removed) save();
    return removed;
}

module.exports = {
    recordDeclined,
    listState,
    applyAction,
    rejectAllPending,
    rejectAllGraduated,
    addManual,
    writeStaged,
    vote,
    nextPendingFor,
    getVoteCapInfo,
    pruneDaily
};
