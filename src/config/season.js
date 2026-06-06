// Season system — static configuration.
//
// A "season" lasts SEASON_LENGTH_DAYS (8 weeks by default, runtime-configurable
// via data.season.lengthDays). Each season has its own set of premium reward
// items (new emotes, same value ladder) plus a catalog of permanent profile
// trophies players keep forever:
//   • item-ownership titles  — granted at season end for holding a premium item.
//   • top-leaderboard titles — granted at season end to the Top 5 of !toptt
//     (Top 1-3 also get a border).
//
// This file is PURE DATA + pure helpers (no runtime deps beyond economy), so it
// can be required by both services/season.js and services/profile.js without any
// circular dependency.
//
// ── Adding a new season ──────────────────────────────────────────────────────
//   1. Add a SEASONS[n] entry below (copy the template).
//   2. Append its 6 item keys to ITEM_KEYS / ITEM_LABELS / wallet defaults in
//      services/currency.js and VALID_ITEM_KEYS in services/profile.js.
//   3. Upload the 6 new emotes (!upload_ingame_emotes) once art is ready.
// Everything else (gacha/exchanges/scoring/rollover) auto-targets the current
// season — no further code changes.

// Default cadence. The live value lives in data.season.lengthDays and can be
// changed at runtime with !season_setlength.
const SEASON_LENGTH_DAYS_DEFAULT = 56; // 8 weeks

// The six logical premium tiers, cheapest → most valuable. Stable across seasons.
// (Thiên thưởng is NOT a tier — it is a single cross-season key that always counts.)
const TIER_IDS = ['pet1', 'pet2', 'pet3', 'thanthu', 'thanthuplus', 'thantrang'];

// Human label for a tier (used in !season / placeholders, season-agnostic).
const TIER_LABELS = {
    pet1: 'Linh thú Tier 1',
    pet2: 'Linh thú Tier 2',
    pet3: 'Linh thú Tier 3',
    thanthu: 'Thần Thú',
    thanthuplus: 'Thần Thú+',
    thantrang: 'Thần Trang'
};

const SEASONS = {
    1: {
        id: 1,
        name: 'Hồ Phượng',
        // logical tier → concrete wallet item key (the keys that exist today)
        items: {
            pet1: 'cao', pet2: 'cao5', pet3: 'cao9',
            thanthu: 'phuonghoang1', thanthuplus: 'phuonghoang2', thantrang: 'thantrang'
        },
        // Item-ownership titles (snapshotted at season end → seasonAchievements).
        titles: {
            pet1:        { achId: 's1_own_pet1',        name: 'Tiểu Hồ Tiên Tử' },
            pet2:        { achId: 's1_own_pet2',        name: 'Ngũ Vĩ Yêu Hồ' },
            pet3:        { achId: 's1_own_pet3',        name: 'Cửu Vĩ Thiên Hồ' },
            thanthu:     { achId: 's1_own_thanthu',     name: 'Băng Phách Phượng Nghi' },
            thanthuplus: { achId: 's1_own_thanthuplus', name: 'Phần Thiên Hoả Phượng' },
            thantrang:   { achId: 's1_own_thantrang',   name: 'Vân Thường Thần Chủ' }
        },
        // Top-leaderboard titles (1-5) + borders (1-3) granted at season end.
        topTitles: {
            1: { id: 's1_top1',  name: 'Độc Bá Thương Khung', border: 's1_border1' },
            2: { id: 's1_top2',  name: 'Tàng Bảo Chí Tôn',    border: 's1_border2' },
            3: { id: 's1_top3',  name: 'Hoàng Kim Tàng Chủ',  border: 's1_border3' },
            4: { id: 's1_top45', name: 'Tụ Bảo Chân Nhân' },
            5: { id: 's1_top45', name: 'Tụ Bảo Chân Nhân' }
        }
    },

    // ── Season 2 — PLACEHOLDER ───────────────────────────────────────────────
    // Functional so rollover never breaks, but the display names / emotes are
    // TODO. Finalize the names below and upload the 6 emotes (keys: s2_pet1 …
    // s2_thantrang) before this season goes live (~8 weeks after deploy).
    2: {
        id: 2,
        name: 'Mùa 2',
        items: {
            pet1: 's2_pet1', pet2: 's2_pet2', pet3: 's2_pet3',
            thanthu: 's2_thanthu', thanthuplus: 's2_thanthuplus', thantrang: 's2_thantrang'
        },
        titles: {
            pet1:        { achId: 's2_own_pet1',        name: 'Tân Tinh Linh' },
            pet2:        { achId: 's2_own_pet2',        name: 'Linh Vũ Sứ' },
            pet3:        { achId: 's2_own_pet3',        name: 'Vạn Linh Chi Chủ' },
            thanthu:     { achId: 's2_own_thanthu',     name: 'Thần Thú Khế Ước' },
            thanthuplus: { achId: 's2_own_thanthuplus', name: 'Thượng Cổ Thần Thú' },
            thantrang:   { achId: 's2_own_thantrang',   name: 'Thiên Y Vô Phược' }
        },
        topTitles: {
            1: { id: 's2_top1',  name: 'Vạn Bảo Chi Tổ',   border: 's2_border1' },
            2: { id: 's2_top2',  name: 'Tàng Bảo Chí Tôn',  border: 's2_border2' },
            3: { id: 's2_top3',  name: 'Danh Chấn Tứ Hải',  border: 's2_border3' },
            4: { id: 's2_top45', name: 'Bách Bảo Đại Nhân' },
            5: { id: 's2_top45', name: 'Bách Bảo Đại Nhân' }
        }
    }
};

const SEASON_IDS = Object.keys(SEASONS).map(Number).sort((a, b) => a - b);
const MAX_SEASON_ID = SEASON_IDS[SEASON_IDS.length - 1];

function getSeason(id) {
    return SEASONS[id] || null;
}

// Every concrete premium item key, across all seasons (used to detect which
// keys are "premium" and therefore freeze when not in the current season).
function allPremiumKeys() {
    const keys = new Set();
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        for (const tier of TIER_IDS) keys.add(s.items[tier]);
    }
    return keys;
}

// Flat list of every season's item-ownership title def, for building the
// profile achievement catalog. Returns [{ achId, name, seasonId, tier }].
function allOwnershipTitleDefs() {
    const out = [];
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        for (const tier of TIER_IDS) {
            const t = s.titles[tier];
            if (t) out.push({ achId: t.achId, name: t.name, seasonId: id, tier });
        }
    }
    return out;
}

// Flat list of every season's top-leaderboard title def, de-duplicated by id
// (Top 4 and 5 share one id). Returns [{ id, name, seasonId, ranks:[..], border }].
function allTopTitleDefs() {
    const out = [];
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        const byId = new Map();
        for (const rank of [1, 2, 3, 4, 5]) {
            const t = s.topTitles[rank];
            if (!t) continue;
            if (!byId.has(t.id)) byId.set(t.id, { id: t.id, name: t.name, seasonId: id, ranks: [], border: t.border || null });
            byId.get(t.id).ranks.push(rank);
        }
        out.push(...byId.values());
    }
    return out;
}

const TOP_TITLE_BY_ID = new Map(allTopTitleDefs().map(t => [t.id, t]));
const OWNERSHIP_TITLE_BY_ID = new Map(allOwnershipTitleDefs().map(t => [t.achId, t]));

module.exports = {
    SEASON_LENGTH_DAYS_DEFAULT,
    TIER_IDS,
    TIER_LABELS,
    SEASONS,
    SEASON_IDS,
    MAX_SEASON_ID,
    getSeason,
    allPremiumKeys,
    allOwnershipTitleDefs,
    allTopTitleDefs,
    TOP_TITLE_BY_ID,
    OWNERSHIP_TITLE_BY_ID
};
