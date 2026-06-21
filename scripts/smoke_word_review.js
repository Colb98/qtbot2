// Throwaway: verify wordReview voting → graduation/auto-reject → payout matrix.
// Stubs currency + wordchainViet via require.cache before loading wordReview, so
// no real state/dict/discord is touched. Exits fast so the debounced save timer
// (unref'd) never writes noitu_review.json.

const path = require('path');

// Fake currency: a tiny in-memory wallet store.
const wallets = {};
function getWallet(g, u) {
    wallets[g] = wallets[g] || {};
    wallets[g][u] = wallets[g][u] || { ngoc: 0 };
    return wallets[g][u];
}
const currencyStub = {
    getWallet,
    addNgoc(g, u, amt) { getWallet(g, u).ngoc += amt; return getWallet(g, u).ngoc; }
};
require.cache[require.resolve('../src/services/currency')] = { id: 'currency', exports: currencyStub, loaded: true };

// Fake wordchainViet: identity canonicalize, empty dict.
const wcvStub = { canonicalize: s => s, isWordInDict: () => false, dictSize: () => 0, addWordsToDict: () => ({ added: [], skipped: [] }) };
require.cache[require.resolve('../src/services/wordchainViet')] = { id: 'wcv', exports: wcvStub, loaded: true };

const wr = require('../src/services/wordReview');

const G = 'g1';
let failures = 0;
function check(label, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

// ── Scenario 1: accept branch, admin confirms (crowd right) ──
wr.recordDeclined('mây trời', true);
currencyStub.addNgoc(G, 'u4', 500); // give dissenter ngọc so penalty is visible
check('u1 vote recorded', wr.vote(G, 'u1', 'mây trời', 1).status === 'recorded');
check('u2 vote recorded', wr.vote(G, 'u2', 'mây trời', 1).status === 'recorded');
check('u4 dissent recorded', wr.vote(G, 'u4', 'mây trời', -1).status === 'recorded');
check('u3 vote graduates', wr.vote(G, 'u3', 'mây trời', 1).status === 'graduated');
check('graduated appears in admin list', wr.listState().graduated.some(x => x.word === 'mây trời'));
wr.applyAction('accept', 'mây trời');
check('u1 +70 (correct, majority)', getWallet(G, 'u1').ngoc === 70);
check('u3 +70 (correct, majority)', getWallet(G, 'u3').ngoc === 70);
check('u4 -150 (wrong, minority)', getWallet(G, 'u4').ngoc === 350);

// ── Scenario 2: accept branch, admin OVERRULES (crowd wrong, dissenter right) ──
wr.recordDeclined('cat dog', true);
['a1', 'a2', 'a3', 'a4'].forEach(u => currencyStub.addNgoc(G, u, 500));
wr.vote(G, 'a1', 'cat dog', 1);
wr.vote(G, 'a2', 'cat dog', 1);
wr.vote(G, 'a4', 'cat dog', -1);     // dissenter, before graduation
wr.vote(G, 'a3', 'cat dog', 1);      // graduates (3 ✅)
wr.applyAction('reject', 'cat dog'); // admin overrules → truth = reject
check('a1 -50 (wrong, majority)', getWallet(G, 'a1').ngoc === 450);
check('a3 -50 (wrong, majority)', getWallet(G, 'a3').ngoc === 450);
check('a4 +200 (correct, minority bonus)', getWallet(G, 'a4').ngoc === 700);

// ── Scenario 3: clean auto-reject (0 ✅), consensus = truth ──
wr.recordDeclined('xxz yyz', true);
check('b1 ❌ recorded', wr.vote(G, 'b1', 'xxz yyz', -1).status === 'recorded');
check('b2 ❌ recorded', wr.vote(G, 'b2', 'xxz yyz', -1).status === 'recorded');
check('b3 ❌ auto-rejects', wr.vote(G, 'b3', 'xxz yyz', -1).status === 'autoRejected');
check('b1 +70 (correct ❌, majority)', getWallet(G, 'b1').ngoc === 70);
check('b3 +70 (correct ❌, majority)', getWallet(G, 'b3').ngoc === 70);
check('auto-rejected not in admin graduated list', !wr.listState().graduated.some(x => x.word === 'xxz yyz'));

// ── Scenario 4: contested reject (≥1 ✅) escalates to admin instead of auto-reject ──
wr.recordDeclined('foo bar', true);
wr.vote(G, 'c1', 'foo bar', 1);   // one voucher
wr.vote(G, 'c2', 'foo bar', -1);
wr.vote(G, 'c3', 'foo bar', -1);
const contested = wr.vote(G, 'c4', 'foo bar', -1); // 3 ❌ but contested
check('contested → graduated (not autoRejected)', contested.status === 'graduated');
check('contested word flagged in admin list', wr.listState().graduated.some(x => x.word === 'foo bar' && x.contested));

// ── Scenario 5: daily vote cap ──
// (cap is economy.WORD_REVIEW.DAILY_VOTE_CAP; we just check the helper math.)
const cap = require('../src/config/economy').WORD_REVIEW.DAILY_VOTE_CAP;
const info = wr.getVoteCapInfo('u1');
check('vote cap info sane', info.cap === cap && info.used >= 1 && info.remaining === cap - info.used);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
