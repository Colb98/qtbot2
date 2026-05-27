// Lixi (red envelope) — split T ngọc into N random parts, each part >= floor(T/(2N)).
// Players claim parts by reacting to the post; first-come-first-served until N
// people have claimed. State lives in data.lixi[messageId].

const { data, saveData } = require('../state');

const LIXI_MAX_PEOPLE = 50;
const LIXI_EMOJI = '🧧';

// Generate N random portions of total T, each >= floor(T/(2N)).
//   1. Reserve `min = floor(T/(2N))` per part (so min*N is locked).
//   2. Distribute the remaining T - min*N across N buckets via random
//      "stars and bars" — pick N-1 cut points in [0, remaining], sort, and
//      take consecutive differences.
// Returns an array of N integers summing to T, then shuffled.
function splitLixi(total, people) {
    if (!Number.isInteger(total) || !Number.isInteger(people)) throw new Error('total and people must be integers');
    if (people <= 0) throw new Error('people must be positive');
    if (total < people) throw new Error('total must be at least people');

    const min = Math.floor(total / (2 * people));
    const reserved = min * people;
    const remaining = total - reserved;

    const cuts = [];
    for (let i = 0; i < people - 1; i++) cuts.push(Math.floor(Math.random() * (remaining + 1)));
    cuts.sort((a, b) => a - b);

    const parts = new Array(people);
    let prev = 0;
    for (let i = 0; i < people - 1; i++) {
        parts[i] = min + (cuts[i] - prev);
        prev = cuts[i];
    }
    parts[people - 1] = min + (remaining - prev);

    // Shuffle so order of claim is independent of generation order.
    for (let i = parts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    return parts;
}

function ensureRoot() {
    if (!data.lixi) data.lixi = {};
    return data.lixi;
}

function createLixi({ messageId, channelId, guildId, authorId, total, people, parts }) {
    const root = ensureRoot();
    root[messageId] = {
        channelId, guildId, authorId, total, people,
        parts,                  // remaining unclaimed shares
        claimed: {},            // userId -> amount
        claimOrder: []          // userId order for display
    };
    saveData();
    return root[messageId];
}

function getLixi(messageId) {
    return data.lixi && data.lixi[messageId];
}

// Try to claim one part for `userId`. Returns { ok, amount } on success,
// { ok: false, reason } otherwise. Reasons: 'not_found', 'author', 'already',
// 'exhausted'.
function claim(messageId, userId) {
    const lx = getLixi(messageId);
    if (!lx) return { ok: false, reason: 'not_found' };
    if (lx.authorId === userId) return { ok: false, reason: 'author' };
    if (lx.claimed[userId]) return { ok: false, reason: 'already' };
    if (!lx.parts || lx.parts.length === 0) return { ok: false, reason: 'exhausted' };
    const amount = lx.parts.shift();
    lx.claimed[userId] = amount;
    lx.claimOrder.push(userId);
    saveData();
    return { ok: true, amount, exhausted: lx.parts.length === 0 };
}

function deleteLixi(messageId) {
    if (data.lixi && data.lixi[messageId]) {
        delete data.lixi[messageId];
        saveData();
    }
}

module.exports = {
    LIXI_MAX_PEOPLE,
    LIXI_EMOJI,
    splitLixi,
    createLixi,
    getLixi,
    claim,
    deleteLixi
};
