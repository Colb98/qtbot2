// Profile card test — runnable with `node test/profileCard.test.js`.
//
// 1. Renders 14 cards covering all 7 sects × both genders into
//    `test/output/profile_card/` so you can eyeball the layout (incl. the
//    new "Nhất Mộng Giang Hồ" watermark and display-name override).
// 2. Exercises the 5-per-day render cap via the profile service, using a
//    sandbox guild/user key — cleans up after itself so data.json stays
//    untouched.
//
// No test framework — assertions throw on failure and the script exits
// non-zero. Output PNGs are written even if the cap assertions fail.

const fs = require('fs');
const path = require('path');

const profileCard = require('../src/services/profileCard');
const profile = require('../src/services/profile');
const { data } = require('../src/state');

const OUT_DIR = path.resolve(__dirname, 'output', 'profile_card');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const TEST_GUILD = '__test_guild__';
const TEST_USER  = '__test_user__';

// ── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ✓ ${msg}`); }
    else      { failed++; console.error(`  ✗ ${msg}`); }
}
function section(title) { console.log(`\n── ${title} ──`); }

function emptyWallet() {
    const items = { nhuom: 0, dieu: 0, cao: 0, cao5: 0, cao9: 0, kythuong: 0, thienthuong: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 };
    return {
        ngoc: 0, lockedNgoc: 0,
        items: { ...items },
        lockedItems: { ...items }
    };
}

function makePlayer({ sect, gender, ingame, ngoc = 0, items = {}, slots = [null, null, null], showNgoc = false, jackpot = null, wcRank = null, vtvRank = null }) {
    const w = emptyWallet();
    w.ngoc = ngoc;
    for (const [k, v] of Object.entries(items)) w.items[k] = v;
    return {
        userId: 'visual-test',
        ingame,
        sect,
        gender,
        wallet: w,
        profile: {
            gender,
            displayName: null,
            itemSlot1: slots[0], itemSlot2: slots[1], itemSlot3: slots[2],
            showNgoc,
            biggestJackpot: jackpot,
            selectedTitle: null,
            selectedBorder: null,
            badgeSlots: [null, null, null]
        },
        stats: {
            biggestJackpot: jackpot,
            wordchainRank: wcRank, wordchainTotal: 42, wordchainBest: 30,
            vtvRank: vtvRank, vtvTotal: 30, vtvWords: 120
        }
    };
}

// ── Visual render matrix ───────────────────────────────────────────────────
const SECTS = [
    { name: 'Cửu Linh',   slug: 'cl' },
    { name: 'Huyết Hà',   slug: 'hh' },
    { name: 'Toái Mộng',  slug: 'tm' },
    { name: 'Thần Tương', slug: 'tt' },
    { name: 'Tố Vấn',     slug: 'tv' },
    { name: 'Thiết Y',    slug: 'ty' },
    { name: 'Long Ngâm',  slug: 'ln' }
];

const SAMPLE_NAMES = ['Hàn Thanh', 'Vũ Liên', 'Trầm Mộng', 'Lý Phong', 'Mai Nhi', 'Thiên Cơ', 'Long Vũ'];

async function renderVisualMatrix() {
    section('Visual render matrix — 7 sects × 2 genders → test/output/profile_card/');
    for (let i = 0; i < SECTS.length; i++) {
        const sect = SECTS[i];
        for (const gender of ['m', 'f']) {
            const player = makePlayer({
                sect: sect.name,
                gender,
                ingame: SAMPLE_NAMES[i],
                ngoc: 50_000 + i * 12_345,
                items: { cao9: 1, phuonghoang1: 1, thienthuong: 50 },
                slots: ['cao9', 'phuonghoang1', 'thienthuong'],
                showNgoc: true,
                jackpot: { amount: 800_000 + i * 100_000, game: 'Slot', ts: Date.now() },
                wcRank: i + 1,
                vtvRank: (i % 5) + 1
            });
            const file = `${String(i + 1).padStart(2, '0')}_${sect.slug}_${gender}.png`;
            try {
                const png = await profileCard.renderProfileCard(player);
                fs.writeFileSync(path.join(OUT_DIR, file), png);
                assert(png && png.length > 1000, `${file} rendered (${png.length} bytes)`);
            } catch (e) {
                assert(false, `${file} render failed: ${e.message}`);
            }
        }
    }
}

// Extra cards exercising the new features (display-name override, no items,
// minimal/empty profile, very long name).
async function renderFeatureSamples() {
    section('Feature samples — display name, edge cases');

    const samples = [
        {
            file: 'feature_display_name_override.png',
            mutate: (p) => { p.ingame = 'Tên Ingame Sẽ Bị Ghi Đè'; p.profile.displayName = 'Display Override Name'; p.ingame = p.profile.displayName; }
        },
        {
            file: 'feature_no_items_no_ngoc.png',
            mutate: (p) => { p.profile.itemSlot1 = p.profile.itemSlot2 = p.profile.itemSlot3 = null; p.profile.showNgoc = false; p.stats.biggestJackpot = null; }
        },
        {
            file: 'feature_long_name.png',
            mutate: (p) => { p.ingame = 'Nguyễn Đặng Hoàng Phương Thảo Đệ Nhất'; }
        },
        {
            file: 'feature_watermark_only.png',
            mutate: (p) => { p.profile.itemSlot1 = p.profile.itemSlot2 = p.profile.itemSlot3 = null; p.profile.showNgoc = false; p.stats.biggestJackpot = null; p.stats.wordchainRank = null; p.stats.vtvRank = null; p.ingame = 'Watermark Check'; }
        }
    ];

    for (const s of samples) {
        const player = makePlayer({
            sect: 'Huyết Hà', gender: 'f', ingame: 'Vũ Liên',
            ngoc: 12_345,
            items: { cao9: 3, thienthuong: 99 },
            slots: ['cao9', 'thienthuong', null],
            showNgoc: true,
            jackpot: { amount: 250_000, game: 'Coinflip', ts: Date.now() }
        });
        s.mutate(player);
        try {
            const png = await profileCard.renderProfileCard(player);
            fs.writeFileSync(path.join(OUT_DIR, s.file), png);
            assert(png && png.length > 1000, `${s.file} rendered (${png.length} bytes)`);
        } catch (e) {
            assert(false, `${s.file} render failed: ${e.message}`);
        }
    }
}

// ── Daily render cap ───────────────────────────────────────────────────────
function cleanTestProfile() {
    if (data.profile && data.profile[TEST_GUILD]) {
        delete data.profile[TEST_GUILD][TEST_USER];
        if (Object.keys(data.profile[TEST_GUILD]).length === 0) delete data.profile[TEST_GUILD];
    }
}

function testDailyCap() {
    section('Daily render cap — 5/day, reset 00:00 GMT+7');
    cleanTestProfile();

    const status0 = profile.getCardRenderStatus(TEST_GUILD, TEST_USER);
    assert(status0.limit === 5, `limit is 5 (got ${status0.limit})`);
    assert(status0.used === 0,  `fresh profile used = 0 (got ${status0.used})`);
    assert(status0.remaining === 5, `fresh profile remaining = 5 (got ${status0.remaining})`);

    // First 5 consumes succeed
    for (let i = 1; i <= 5; i++) {
        const r = profile.consumeCardRender(TEST_GUILD, TEST_USER);
        assert(r.ok === true,                   `consume #${i} ok`);
        assert(r.used === i,                    `consume #${i} used = ${i}`);
        assert(r.remaining === 5 - i,           `consume #${i} remaining = ${5 - i}`);
    }

    // 6th and beyond are rejected
    const r6 = profile.consumeCardRender(TEST_GUILD, TEST_USER);
    assert(r6.ok === false,    '6th consume rejected');
    assert(r6.used === 5,      '6th consume reports used=5');
    assert(r6.remaining === 0, '6th consume reports remaining=0');

    const r7 = profile.consumeCardRender(TEST_GUILD, TEST_USER);
    assert(r7.ok === false, '7th consume also rejected');

    // Simulate day rollover by rewinding the stored date
    const prof = profile.getProfile(TEST_GUILD, TEST_USER);
    prof.cardRenderCap.date = '2000-01-01';
    const rRollover = profile.consumeCardRender(TEST_GUILD, TEST_USER);
    assert(rRollover.ok === true,    'rollover: consume after date change succeeds');
    assert(rRollover.used === 1,     'rollover: counter reset to 1');
    assert(rRollover.remaining === 4,'rollover: remaining = 4');

    // getCardRenderStatus must not mutate
    const before = profile.getCardRenderStatus(TEST_GUILD, TEST_USER);
    const after  = profile.getCardRenderStatus(TEST_GUILD, TEST_USER);
    assert(before.used === after.used, 'getCardRenderStatus is read-only');

    cleanTestProfile();
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    profileCard.registerFonts();
    await renderVisualMatrix();
    await renderFeatureSamples();
    testDailyCap();

    console.log(`\n── Summary ──\n  passed: ${passed}\n  failed: ${failed}`);
    console.log(`\nOpen images: ${OUT_DIR}`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
    console.error('Test runner crashed:', e);
    process.exit(2);
});
