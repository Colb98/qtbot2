// Season system — static configuration.
//
// A "season" lasts SEASON_LENGTH_DAYS (8 weeks by default, runtime-configurable
// via data.season.lengthDays). Each season has its own set of premium reward
// items (new emotes) plus a catalog of permanent profile trophies players keep
// forever:
//   • item-ownership titles  — granted at season end for holding a premium item.
//   • top-leaderboard titles — granted at season end to the Top 5 of !toptt
//     (Top 1-3 also get a profile badge).
//   • ngọc-leaderboard titles + badges — granted at season end to the Top 3
//     of !topngoc.
//
// Badges are permanent showcase trophies (assets/profile_card/badges/<id>.png):
// a player slots them into the profile-card showcase row alongside items; the
// card shows HOW the badge was earned (rank + board + season) instead of a qty.
//
// Per-season knobs:
//   • items   — which logical tiers exist this season + their concrete wallet
//     keys. A season may omit tiers (e.g. Season 2+ has no `pet3`).
//   • topNgoc — ngọc-leaderboard titles + badges for Top 1-3 of !topngoc.
//   • ratios — exchange amounts (TT↔pet, pet↔pet, TT→cosmetic). Any omitted
//     field falls back to the global economy.js default (see services/season.js
//     exchangeRatio). Season 1 omits `ratios` entirely → behaves exactly as
//     before and stays editable via the admin economy panel.
//
// This file is PURE DATA + pure helpers (no requires), so it can be required by
// both services/season.js and services/profile.js with no circular dependency.
//
// ── Adding a new season ──────────────────────────────────────────────────────
//   1. Add a SEASONS[n] entry below (copy a template; set items/ratios/titles).
//   2. Append its item keys to ITEM_KEYS / ITEM_LABELS in services/currency.js
//      (VALID_ITEM_KEYS in profile.js is derived from ITEM_KEYS automatically).
//   3. Upload the new emotes (!upload_ingame_emotes) once art is ready.
// Everything else (gacha/exchanges/scoring/rollover) auto-targets the current
// season — no further code changes.

// Default cadence. The live value lives in data.season.lengthDays and can be
// changed at runtime with !season_setlength.
const SEASON_LENGTH_DAYS_DEFAULT = 56; // 8 weeks

// All logical premium tiers, in canonical (cheapest → most valuable) order.
// A given season uses a SUBSET of these (whatever appears in its `items`).
// (Thiên thưởng is NOT a tier — it is a single cross-season key that always counts.)
const TIER_IDS = ['pet1', 'pet2', 'pet3', 'thanthu', 'thanthuplus', 'thantrang'];

// Human label for a tier (season-agnostic; used in placeholders).
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
        // `ratios` omitted → all exchange amounts fall back to economy.js
        // (TT_PER_CAO=3, CAO_PER_CAO5=3, CAO5_PER_CAO9=3, PHUONGBANG_TT=200,
        //  PHUONGHOA_TT=200, THANTRANG_TT=100). Keeps Season 1 admin-editable.
        // Item-ownership titles (snapshotted at season end → seasonAchievements).
        titles: {
            pet1:        { achId: 's1_own_pet1',        name: 'Tiểu Hồ Tiên Tử' },
            pet2:        { achId: 's1_own_pet2',        name: 'Ngũ Vĩ Yêu Hồ' },
            pet3:        { achId: 's1_own_pet3',        name: 'Cửu Vĩ Thiên Hồ' },
            thanthu:     { achId: 's1_own_thanthu',     name: 'Băng Phách Phượng Nghi' },
            thanthuplus: { achId: 's1_own_thanthuplus', name: 'Phần Thiên Hoả Phượng' },
            thantrang:   { achId: 's1_own_thantrang',   name: 'Vân Thường Thần Chủ' }
        },
        // Top-leaderboard titles (1-5) + badges (1-3) granted at season end.
        topTitles: {
            1: { id: 's1_top1',  name: 'Độc Bá Thương Khung', badge: 's1_top_tt_1' },
            2: { id: 's1_top2',  name: 'Tàng Bảo Chí Tôn',    badge: 's1_top_tt_2' },
            3: { id: 's1_top3',  name: 'Hoàng Kim Tàng Chủ',  badge: 's1_top_tt_3' },
            4: { id: 's1_top45', name: 'Tụ Bảo Chân Nhân' },
            5: { id: 's1_top45', name: 'Tụ Bảo Chân Nhân' }
        },
        // Ngọc-leaderboard titles + badges (Top 1-3 of !topngoc) at season end.
        topNgoc: {
            1: { id: 's1_ngoc1', name: 'Ngọc Đế Chí Tôn',     badge: 's1_top_ngoc_1' },
            2: { id: 's1_ngoc2', name: 'Bích Ngọc Tôn Giả',   badge: 's1_top_ngoc_2' },
            3: { id: 's1_ngoc3', name: 'Thanh Ngọc Chân Quân', badge: 's1_top_ngoc_3' }
        }
    },

    // ── Season 2 — PLACEHOLDER ───────────────────────────────────────────────
    // Functional so rollover never breaks, but display names / emotes are TODO.
    // Only TWO pet tiers (no pet3); pet2 = 5 × pet1. Finalize names + upload the
    // 5 emotes (s2_pet1, s2_pet2, s2_thanthu, s2_thanthuplus, s2_thantrang)
    // before this season goes live (~8 weeks after deploy).
    2: {
        id: 2,
        name: 'Mùa 2',
        items: {
            pet1: 's2_pet1', pet2: 's2_pet2',
            thanthu: 's2_thanthu', thanthuplus: 's2_thanthuplus', thantrang: 's2_thantrang'
        },
        ratios: {
            pet1PerPet2: 5
            // ttPerPet1, ttPerThanthu, ttPerThanthuplus, ttPerThantrang → economy defaults
        },
        titles: {
            pet1:        { achId: 's2_own_pet1',        name: 'Tân Tinh Linh' },
            pet2:        { achId: 's2_own_pet2',        name: 'Linh Vũ Sứ' },
            thanthu:     { achId: 's2_own_thanthu',     name: 'Thần Thú Khế Ước' },
            thanthuplus: { achId: 's2_own_thanthuplus', name: 'Thượng Cổ Thần Thú' },
            thantrang:   { achId: 's2_own_thantrang',   name: 'Thiên Y Vô Phược' }
        },
        topTitles: {
            1: { id: 's2_top1',  name: 'Vạn Bảo Chi Tổ',   badge: 's2_top_tt_1' },
            2: { id: 's2_top2',  name: 'Tàng Bảo Chí Tôn',  badge: 's2_top_tt_2' },
            3: { id: 's2_top3',  name: 'Danh Chấn Tứ Hải',  badge: 's2_top_tt_3' },
            4: { id: 's2_top45', name: 'Bách Bảo Đại Nhân' },
            5: { id: 's2_top45', name: 'Bách Bảo Đại Nhân' }
        },
        topNgoc: {
            1: { id: 's2_ngoc1', name: 'Tài Khuynh Thiên Hạ',  badge: 's2_top_ngoc_1' },
            2: { id: 's2_ngoc2', name: 'Ngọc Mãn Càn Khôn',    badge: 's2_top_ngoc_2' },
            3: { id: 's2_ngoc3', name: 'Phú Giáp Nhất Phương', badge: 's2_top_ngoc_3' }
        }
    }
};

const SEASON_IDS = Object.keys(SEASONS).map(Number).sort((a, b) => a - b);
const MAX_SEASON_ID = SEASON_IDS[SEASON_IDS.length - 1];

function getSeason(id) {
    return SEASONS[id] || null;
}

// Tiers present in a season, in canonical order.
function seasonTiers(id) {
    const s = SEASONS[id];
    if (!s) return [];
    return TIER_IDS.filter(t => s.items[t]);
}

// Whether a season has a given tier.
function hasTier(tier, id) {
    const s = SEASONS[id];
    return !!(s && s.items[tier]);
}

// Every concrete premium item key, across all seasons (used to detect which
// keys are "premium" and therefore freeze when not in the current season).
function allPremiumKeys() {
    const keys = new Set();
    for (const id of SEASON_IDS) {
        for (const key of Object.values(SEASONS[id].items)) keys.add(key);
    }
    return keys;
}

// Flat list of every season's item-ownership title def, for building the
// profile achievement catalog. Returns [{ achId, name, seasonId, tier }].
function allOwnershipTitleDefs() {
    const out = [];
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        for (const tier of seasonTiers(id)) {
            const t = s.titles[tier];
            if (t) out.push({ achId: t.achId, name: t.name, seasonId: id, tier });
        }
    }
    return out;
}

// Flat list of every season's top-leaderboard title def (both boards),
// de-duplicated by id (Top 4 and 5 share one id).
// Returns [{ id, name, seasonId, ranks:[..], board: 'tt'|'ngoc', badge }].
function allTopTitleDefs() {
    const out = [];
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        const byId = new Map();
        for (const rank of [1, 2, 3, 4, 5]) {
            const t = s.topTitles[rank];
            if (!t) continue;
            if (!byId.has(t.id)) byId.set(t.id, { id: t.id, name: t.name, seasonId: id, ranks: [], board: 'tt', badge: t.badge || null });
            byId.get(t.id).ranks.push(rank);
        }
        for (const rank of [1, 2, 3]) {
            const t = s.topNgoc && s.topNgoc[rank];
            if (!t) continue;
            byId.set(t.id, { id: t.id, name: t.name, seasonId: id, ranks: [rank], board: 'ngoc', badge: t.badge || null });
        }
        out.push(...byId.values());
    }
    return out;
}

const TOP_TITLE_BY_ID = new Map(allTopTitleDefs().map(t => [t.id, t]));

// ── Badge catalog ────────────────────────────────────────────────────────────
// Every badge across all seasons: { id, seasonId, rank, board: 'tt'|'ngoc' }.
// `id` doubles as the asset filename (assets/profile_card/badges/<id>.png).
function allBadgeDefs() {
    const out = [];
    for (const id of SEASON_IDS) {
        const s = SEASONS[id];
        for (const rank of [1, 2, 3]) {
            const tt = s.topTitles[rank];
            if (tt && tt.badge) out.push({ id: tt.badge, seasonId: id, rank, board: 'tt' });
            const tn = s.topNgoc && s.topNgoc[rank];
            if (tn && tn.badge) out.push({ id: tn.badge, seasonId: id, rank, board: 'ngoc' });
        }
    }
    return out;
}

const BADGE_BY_ID = new Map(allBadgeDefs().map(b => [b.id, b]));
const BADGE_BOARD_LABELS = { tt: 'Thiên Thưởng', ngoc: 'Ngọc' };

// Human description of how a badge was earned: "Top 1 Thiên Thưởng — Mùa 1".
function badgeLabel(badgeId) {
    const b = BADGE_BY_ID.get(badgeId);
    if (!b) return badgeId;
    return `Top ${b.rank} ${BADGE_BOARD_LABELS[b.board]} — Mùa ${b.seasonId}`;
}
const OWNERSHIP_TITLE_BY_ID = new Map(allOwnershipTitleDefs().map(t => [t.achId, t]));

module.exports = {
    SEASON_LENGTH_DAYS_DEFAULT,
    TIER_IDS,
    TIER_LABELS,
    SEASONS,
    SEASON_IDS,
    MAX_SEASON_ID,
    getSeason,
    seasonTiers,
    hasTier,
    allPremiumKeys,
    allOwnershipTitleDefs,
    allTopTitleDefs,
    allBadgeDefs,
    badgeLabel,
    TOP_TITLE_BY_ID,
    OWNERSHIP_TITLE_BY_ID,
    BADGE_BY_ID,
    BADGE_BOARD_LABELS
};
