// Throwaway offline test for services/exchange.js. Run: node scripts/_exchange_test.js
const assert = require('assert');
const { data, saveData } = require('../src/state');
const { getWallet } = require('../src/services/currency');
const ex = require('../src/services/exchange');

const G = '__exch_test_guild__', U = 'u1';
function freshWallet(over = {}) {
    if (data.wallet && data.wallet[G]) delete data.wallet[G];
    const w = getWallet(G, U);
    Object.assign(w, { ngoc: 0, lockedNgoc: 0 }, over.top || {});
    Object.assign(w.items, over.items || {});
    Object.assign(w.lockedItems, over.locked || {});
    return w;
}

// 1. Catalog: season 1 active → 6 S1 entries, no S2 keys.
const cat = ex.catalog();
assert.deepStrictEqual(cat.map(e => e.key), ['cao', 'cao5', 'cao9', 'phuonghoang1', 'phuonghoang2', 'thantrang']);
assert.strictEqual(cat.find(e => e.key === 'cao5').value, 9);
assert.strictEqual(cat.find(e => e.key === 'cao9').value, 27);
assert.strictEqual(cat.find(e => e.key === 'cao9').dismantlable, true);
assert.strictEqual(cat.find(e => e.key === 'thantrang').dismantlable, false);
console.log('catalog ok');

// 2. Exchange TT → cáo.
let w = freshWallet({ items: { thienthuong: 10 } });
let r = ex.performExchange(G, U, 'cao', 2);
assert.ok(r.ok, r.error);
assert.strictEqual(w.items.cao, 2);
assert.strictEqual(w.items.thienthuong, 4);

// 3. Exchange cáo → cáo5 'all' (7 cáo → 2 cáo5, 1 left).
w = freshWallet({ items: { cao: 7 } });
r = ex.performExchange(G, U, 'cao5', 'all');
assert.ok(r.ok, r.error);
assert.strictEqual(r.n, 2);
assert.strictEqual(w.items.cao, 1);
assert.strictEqual(w.items.cao5, 2);

// 4. Compound cost: 1 Phượng Băng + 200 TT → Phượng Hoả.
w = freshWallet({ items: { phuonghoang1: 1, thienthuong: 250 } });
r = ex.performExchange(G, U, 'phuonghoang2', 1);
assert.ok(r.ok, r.error);
assert.strictEqual(w.items.phuonghoang2, 1);
assert.strictEqual(w.items.phuonghoang1, 0);
assert.strictEqual(w.items.thienthuong, 50);

// 5. Insufficient funds error.
w = freshWallet({ items: { thienthuong: 2 } });
r = ex.performExchange(G, U, 'cao', 1);
assert.ok(!r.ok);
console.log('exchange ok');

// 6. Dismantle cáo (3 TT, no penalty).
w = freshWallet({ items: { cao: 2 } });
let q = ex.dismantleQuote(G, U, 'cao', 2);
assert.ok(q.ok && !q.penalized);
r = ex.performDismantle(G, U, 'cao', 2, 'plain');
assert.ok(r.ok, r.error);
assert.strictEqual(r.received, 6);
assert.strictEqual(w.items.thienthuong, 6);
assert.strictEqual(w.items.cao, 0);

// 7. Dismantle cáo5 ×1 — penalized: TT route 9−ceil(0.9)=8; ngọc route 9 TT − 9000 ngọc.
w = freshWallet({ items: { cao5: 1 } });
q = ex.dismantleQuote(G, U, 'cao5', 1);
assert.ok(q.ok && q.penalized);
assert.strictEqual(q.total, 9);
assert.strictEqual(q.ttPenalty, 1);
assert.strictEqual(q.ngocCost, 9000);
r = ex.performDismantle(G, U, 'cao5', 1, 'tt');
assert.ok(r.ok, r.error);
assert.strictEqual(r.received, 8);
assert.strictEqual(w.items.thienthuong, 8);

// 8. Ngọc route: full TT, pay ngọc.
w = freshWallet({ items: { cao5: 1 }, top: { ngoc: 10000 } });
r = ex.performDismantle(G, U, 'cao5', 1, 'ngoc');
assert.ok(r.ok, r.error);
assert.strictEqual(r.received, 9);
assert.strictEqual(w.items.thienthuong, 9);
assert.strictEqual(w.ngoc, 1000);

// 9. Ngọc route blocked when broke.
w = freshWallet({ items: { cao5: 1 }, top: { ngoc: 100 } });
r = ex.performDismantle(G, U, 'cao5', 1, 'ngoc');
assert.ok(!r.ok);

// 10. Penalized dismantle requires explicit mode.
w = freshWallet({ items: { cao5: 1 } });
r = ex.performDismantle(G, U, 'cao5', 1, 'plain');
assert.ok(!r.ok);

// 11. cao9 ×2: total 54, ttPenalty ceil(5.4)=6, ngocCost ceil(54*0.2*5000)=54000.
w = freshWallet({ items: { cao9: 2 } });
q = ex.dismantleQuote(G, U, 'cao9', 2);
assert.strictEqual(q.total, 54);
assert.strictEqual(q.ttPenalty, 6);
assert.strictEqual(q.ngocCost, 54000);

// 12. Locked split: locked cáo dismantle → locked TT.
w = freshWallet({ items: { cao: 1 }, locked: { cao: 2 } });
r = ex.performDismantle(G, U, 'cao', 3, 'plain');
assert.ok(r.ok, r.error);
assert.strictEqual(w.items.thienthuong, 3);
assert.strictEqual(w.lockedItems.thienthuong, 6);

// 13. Locked split on exchange: TT part-locked → output locked accordingly.
w = freshWallet({ items: { thienthuong: 3 }, locked: { thienthuong: 3 } });
r = ex.performExchange(G, U, 'cao', 2);
assert.ok(r.ok, r.error);
assert.strictEqual(w.items.cao, 1);
assert.strictEqual(w.lockedItems.cao, 1);

// 14. 'all' dismantle of nothing → friendly error.
w = freshWallet({});
q = ex.dismantleQuote(G, U, 'cao', 'all');
assert.ok(!q.ok);

// 15. Cosmetics not dismantlable.
w = freshWallet({ items: { thantrang: 1 } });
q = ex.dismantleQuote(G, U, 'thantrang', 1);
assert.ok(!q.ok);
console.log('dismantle ok');

// 16. UI builders don't throw and respect ownership filters.
w = freshWallet({ items: { cao: 2, cao5: 1 } });
assert.strictEqual(ex.buildDoiComponents(G, U, null).length, 2);
assert.strictEqual(ex.buildDoiComponents(G, U, 'cao').length, 2);
assert.ok(ex.buildPhangiaiComponents(G, U, 'cao'));
w = freshWallet({});
assert.strictEqual(ex.buildPhangiaiComponents(G, U, null), null);
q = ex.dismantleQuote(G, U, 'cao5', 1);
w = freshWallet({ items: { cao5: 1 } });
q = ex.dismantleQuote(G, U, 'cao5', 1);
assert.ok(ex.buildPenaltyConfirm(U, q).components.length === 1);
console.log('ui ok');

// Cleanup test guild from local dev data.
if (data.wallet) delete data.wallet[G];
saveData();
console.log('ALL PASS');
process.exit(0);
