const fs = require('fs');
const path = require('path');
const log = require('../../logger');

// Review queue for the !noitu (Nối Từ Co-op) dictionary. The dataset is small,
// so legit words get ❌-ed in game; every declined 2-syllable play is recorded
// here as a candidate. An admin reviews them on the dashboard (/words): ✅
// stages a word, ❌ rejects it (it won't resurface), manual entries can be
// staged too, and one Write commits the whole staged batch into
// word_dict/tu2amtiet.json via wordchainViet.addWordsToDict.
//
// wordchainViet is required lazily inside functions: it requires this module
// at load time (to record declines), so a top-level require would be circular.

const STORE_PATH = path.resolve(__dirname, '../../word_dict/noitu_review.json');
const TMP_PATH = STORE_PATH + '.tmp';
const SAVE_DEBOUNCE_MS = 1000;
const MAX_PENDING = 2000;

// declined: { [word]: { count, lastAt, chained, status: 'pending'|'staged'|'rejected' } }
// manualStaged: words typed by the admin (never seen in game), staged directly.
function loadStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return {
            declined: raw.declined && typeof raw.declined === 'object' ? raw.declined : {},
            manualStaged: Array.isArray(raw.manualStaged) ? raw.manualStaged : []
        };
    } catch (e) {
        return { declined: {}, manualStaged: [] };
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

function normalizeWord(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Same shape the game accepts: exactly 2 syllables, letters only.
const TOKEN_RE = /^\p{L}+$/u;
function isValidShape(word) {
    const tokens = word.split(' ');
    return tokens.length === 2 && tokens.every(t => TOKEN_RE.test(t));
}

// Spam guard: the queue is fed by arbitrary thread messages, so cap the
// pending backlog by evicting the least-played, oldest entry.
function evictIfNeeded() {
    const pending = Object.entries(store.declined).filter(([, e]) => e.status === 'pending');
    if (pending.length < MAX_PENDING) return;
    pending.sort((a, b) => (a[1].count - b[1].count) || (a[1].lastAt - b[1].lastAt));
    delete store.declined[pending[0][0]];
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

function listState() {
    const wcv = require('./wordchainViet');
    const pending = [];
    const stagedDeclined = [];
    const rejected = [];
    for (const [word, e] of Object.entries(store.declined)) {
        const item = { word, count: e.count, lastAt: e.lastAt, chained: !!e.chained };
        if (e.status === 'staged') stagedDeclined.push(item);
        else if (e.status === 'rejected') rejected.push(item);
        else pending.push(item);
    }
    // Real chain attempts first, then by play count and recency.
    pending.sort((a, b) => (b.chained - a.chained) || (b.count - a.count) || (b.lastAt - a.lastAt));
    rejected.sort((a, b) => b.lastAt - a.lastAt);
    stagedDeclined.sort((a, b) => a.word.localeCompare(b.word, 'vi'));
    const staged = [
        ...stagedDeclined.map(i => ({ word: i.word, source: 'declined' })),
        ...store.manualStaged.map(w => ({ word: w, source: 'manual' }))
    ];
    return { pending, staged, rejected, dictSize: wcv.dictSize() };
}

function accept(word) {
    const e = store.declined[word];
    if (!e) throw new Error('Không tìm thấy từ trong danh sách chờ duyệt.');
    const wcv = require('./wordchainViet');
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
    e.status = 'rejected';
    save();
}

function restore(word) {
    const e = store.declined[word];
    if (!e) throw new Error('Không tìm thấy từ.');
    e.status = 'pending';
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

module.exports = {
    recordDeclined,
    listState,
    applyAction,
    addManual,
    writeStaged
};
