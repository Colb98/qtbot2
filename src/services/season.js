// Season system — runtime service. Single source of truth for season state.
//
// Reads/writes data.season:
//   {
//     current,                 // active season id
//     lengthDays,              // cadence (runtime-configurable)
//     startedAt, endsAt,       // current season window (ms epoch)
//     announceChannel: { [guildId]: channelId },
//     scoreTs: { [guildId]: { [userId]: ts } },  // tiebreak: last score increase
//     history: [ { id, endedAt, top: { [guildId]: [userId,...] } } ]
//   }
//
// The leaderboard "reset" is achieved WITHOUT mutating wallets: scoring,
// faucets and exchanges all resolve through the CURRENT season's item keys, so
// past-season premium items are simply never referenced again — frozen by
// construction (see isFrozenPremiumKey).
const { data, saveData } = require('../state');
const economy = require('../config/economy');
const cfg = require('../config/season');
const log = require('../../logger');

const DAY_MS = 86400000;
const GMT7_OFFSET_MS = 7 * 3600 * 1000;

// Snap a timestamp UP to the next 00:00 GMT+7 boundary at or after it.
function snapToMidnightGmt7(ts) {
    const shifted = ts + GMT7_OFFSET_MS;
    return Math.ceil(shifted / DAY_MS) * DAY_MS - GMT7_OFFSET_MS;
}

function computeEndsAt(fromTs, lengthDays) {
    return snapToMidnightGmt7(fromTs + lengthDays * DAY_MS);
}

function ensureState() {
    if (!data.season || typeof data.season !== 'object') {
        const now = Date.now();
        const lengthDays = cfg.SEASON_LENGTH_DAYS_DEFAULT;
        data.season = {
            current: 1,
            lengthDays,
            startedAt: now,
            endsAt: computeEndsAt(now, lengthDays),
            announceChannel: {},
            scoreTs: {},
            history: []
        };
        saveData();
    }
    const s = data.season;
    if (typeof s.current !== 'number') s.current = 1;
    if (typeof s.lengthDays !== 'number' || s.lengthDays <= 0) s.lengthDays = cfg.SEASON_LENGTH_DAYS_DEFAULT;
    if (typeof s.startedAt !== 'number') s.startedAt = Date.now();
    if (typeof s.endsAt !== 'number') s.endsAt = computeEndsAt(s.startedAt, s.lengthDays);
    if (!s.announceChannel || typeof s.announceChannel !== 'object') s.announceChannel = {};
    if (!s.scoreTs || typeof s.scoreTs !== 'object') s.scoreTs = {};
    if (!Array.isArray(s.history)) s.history = [];
    return s;
}

function getState() { return ensureState(); }
function getCurrentSeasonId() { return ensureState().current; }

// Config object for the active season. Falls back to the highest defined season
// if `current` ever runs past the configured list (degenerate safety).
function getCurrentSeason() {
    const id = getCurrentSeasonId();
    return cfg.getSeason(id) || cfg.getSeason(cfg.MAX_SEASON_ID);
}

// ── Item resolution ─────────────────────────────────────────────────────────
function resolveItem(tier, seasonId = getCurrentSeasonId()) {
    const s = cfg.getSeason(seasonId) || getCurrentSeason();
    return s.items[tier];
}

function currentPremiumKeys() {
    const s = getCurrentSeason();
    return new Set(cfg.TIER_IDS.map(t => s.items[t]));
}

// A premium key from any season that is NOT the current season's → frozen.
function isFrozenPremiumKey(key) {
    return cfg.allPremiumKeys().has(key) && !currentPremiumKeys().has(key);
}

// True if a wallet key contributes to the leaderboard score this season.
function isScoredKey(key) {
    return key === 'thienthuong' || currentPremiumKeys().has(key);
}

// Gacha rolls the logical tier-1 pet as 'cao'; map it to the current season's
// concrete key at the award site (keeps gacha.js season-agnostic). Non-premium
// gacha results (nhuom/dieu/kythuong/thienthuong) map to themselves.
function mapGachaKey(k) {
    return k === 'cao' ? resolveItem('pet1') : k;
}

// TT-equivalent score multiplier for a logical tier. Same ladder every season;
// reads live economy values so admin overrides apply without a restart.
function tierMult(tier) {
    switch (tier) {
        case 'pet1': return economy.TT_PER_CAO;
        case 'pet2': return economy.TT_PER_CAO * economy.CAO_PER_CAO5;
        case 'pet3': return economy.TT_PER_CAO * economy.CAO_PER_CAO5 * economy.CAO5_PER_CAO9;
        case 'thanthu': return economy.PHUONGBANG_TT;
        case 'thanthuplus': return economy.PHUONGBANG_TT + economy.PHUONGHOA_TT;
        case 'thantrang': return economy.THANTRANG_TT;
        default: return 0;
    }
}

// Scored items for the CURRENT season: the 6 premium tiers + cross-season TT.
// Shape: [{ key, mult, tier }]  (tier === null for thiên thưởng).
function scoredItems() {
    const s = getCurrentSeason();
    const out = cfg.TIER_IDS.map(tier => ({ key: s.items[tier], mult: tierMult(tier), tier }));
    out.push({ key: 'thienthuong', mult: 1, tier: null });
    return out;
}

// ── Tiebreak score timestamps ───────────────────────────────────────────────
// Stamped only on a score INCREASE (gacha pull yielding pet1/TT, receiving a
// gift of a scored item). Equal scores rank by earliest stamp ("first to reach
// the score wins"); missing stamp = earliest (pre-tracking holders rank above).
function bumpScoreTime(guildId, userId) {
    if (!guildId || !userId) return;
    const s = ensureState();
    if (!s.scoreTs[guildId]) s.scoreTs[guildId] = {};
    s.scoreTs[guildId][userId] = Date.now();
    saveData();
}

function getScoreTime(guildId, userId) {
    const s = ensureState();
    return (s.scoreTs[guildId] && s.scoreTs[guildId][userId]) || 0;
}

// ── Scoring / ranking ───────────────────────────────────────────────────────
function computeUserScore(guildId, userId) {
    const w = data.wallet && data.wallet[guildId] && data.wallet[guildId][userId];
    if (!w || !w.items) return 0;
    let score = 0;
    for (const { key, mult } of scoredItems()) {
        const n = (w.items[key] || 0) + ((w.lockedItems && w.lockedItems[key]) || 0);
        score += n * mult;
    }
    return score;
}

// Full ranking for a guild, sorted score desc then scoreTs asc (first-to-reach).
// Returns [{ userId, score, owned: {key:qty}, ts }].
function rankGuild(guildId) {
    const wallets = data.wallet && data.wallet[guildId];
    if (!wallets) return [];
    const items = scoredItems();
    const rankings = [];
    for (const [userId, w] of Object.entries(wallets)) {
        if (!w || !w.items) continue;
        let score = 0;
        const owned = {};
        for (const { key, mult } of items) {
            const n = (w.items[key] || 0) + ((w.lockedItems && w.lockedItems[key]) || 0);
            owned[key] = n;
            score += n * mult;
        }
        if (score > 0) rankings.push({ userId, score, owned, ts: getScoreTime(guildId, userId) });
    }
    rankings.sort((a, b) => (b.score - a.score) || (a.ts - b.ts));
    return rankings;
}

// 1-based rank of a user (and their score), or null if unranked.
function getUserRank(guildId, userId) {
    const ranking = rankGuild(guildId);
    const idx = ranking.findIndex(r => r.userId === userId);
    if (idx === -1) return { rank: null, score: computeUserScore(guildId, userId), total: ranking.length };
    return { rank: idx + 1, score: ranking[idx].score, total: ranking.length };
}

// ── Window / schedule ───────────────────────────────────────────────────────
function timeRemainingMs() {
    const s = ensureState();
    return Math.max(0, s.endsAt - Date.now());
}

function setLengthDays(days) {
    const s = ensureState();
    s.lengthDays = days;
    s.endsAt = computeEndsAt(s.startedAt, days);
    saveData();
    return s;
}

function setEndsAt(ts) {
    const s = ensureState();
    s.endsAt = ts;
    saveData();
    return s;
}

function setAnnounceChannel(guildId, channelId) {
    const s = ensureState();
    s.announceChannel[guildId] = channelId;
    saveData();
    return s;
}

// ── Rollover ────────────────────────────────────────────────────────────────
// Snapshot the ending season, grant permanent trophies, advance to the next.
// Idempotent: the normal path only fires when now >= endsAt and immediately
// re-arms endsAt; force=true (admin) runs regardless. Title grants use set-union
// so a double-fire never duplicates.
async function runRollover(client, { force = false } = {}) {
    const s = ensureState();
    const now = Date.now();
    if (!force && now < s.endsAt) return { rolled: false, reason: 'not-due' };

    const profile = require('./profile'); // lazy — avoids load-order coupling
    const endingId = s.current;
    const ending = cfg.getSeason(endingId);
    if (!ending) {
        // Nothing sensible to snapshot; just re-arm and bail.
        s.startedAt = s.endsAt;
        s.endsAt = computeEndsAt(s.startedAt, s.lengthDays);
        saveData();
        return { rolled: false, reason: 'no-config' };
    }

    const historyTop = {};
    const announcements = []; // [{ guildId, top: [{userId, score}] }]
    const wallets = data.wallet || {};

    for (const guildId of Object.keys(wallets)) {
        const ranking = rankGuild(guildId);

        // 1-3. Top-leaderboard titles + borders for ranks 1-5.
        const topSnap = [];
        for (let i = 0; i < Math.min(5, ranking.length); i++) {
            const { userId, score } = ranking[i];
            const rank = i + 1;
            const tt = ending.topTitles[rank];
            if (tt) {
                profile.grantTitle(guildId, userId, tt.id);
                if (tt.border) profile.grantBorder(guildId, userId, tt.border);
            }
            topSnap.push({ userId, score });
        }
        historyTop[guildId] = topSnap.map(t => t.userId);
        if (topSnap.length) announcements.push({ guildId, top: topSnap });

        // Item-ownership titles — snapshot every wallet's holdings of the
        // ENDING season's premium tiers (locked + non-locked ≥ 1).
        const guildWallets = wallets[guildId] || {};
        for (const [userId, w] of Object.entries(guildWallets)) {
            if (!w || !w.items) continue;
            for (const tier of cfg.TIER_IDS) {
                const key = ending.items[tier];
                const owned = (w.items[key] || 0) + ((w.lockedItems && w.lockedItems[key]) || 0);
                const title = ending.titles[tier];
                if (owned >= 1 && title) profile.grantSeasonAchievement(guildId, userId, title.achId);
            }
        }
    }

    // Advance the season window.
    s.history.push({ id: endingId, endedAt: s.endsAt, top: historyTop });
    const nextId = endingId + 1;
    if (cfg.getSeason(nextId)) s.current = nextId;
    else log.warn(`season: no config for season ${nextId}; staying on season ${endingId}`);
    s.startedAt = s.endsAt <= now ? s.endsAt : now;
    s.endsAt = computeEndsAt(s.startedAt, s.lengthDays);
    s.scoreTs = {}; // fresh tiebreak race for the new season
    saveData();

    if (client) { try { await announceRollover(client, endingId, announcements); } catch (e) { log.error('season: announce failed', e); } }

    log.info(`season: rolled over season ${endingId} → ${s.current} (force=${force})`);
    return { rolled: true, endingId, newId: s.current, announcements };
}

async function maybeRollover(client) {
    const s = ensureState();
    if (Date.now() >= s.endsAt) return runRollover(client, { force: false });
    return { rolled: false, reason: 'not-due' };
}

async function announceRollover(client, endingId, announcements) {
    const s = ensureState();
    const ending = cfg.getSeason(endingId);
    const newSeason = getCurrentSeason();
    for (const { guildId, top } of announcements) {
        const channelId = s.announceChannel[guildId];
        if (!channelId) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        const lines = [
            `# 🏆 Kết thúc Mùa ${endingId} — ${ending ? ending.name : ''}`,
            `Bảng xếp hạng Thiên Thưởng đã chốt. **Top 5** nhận danh hiệu vĩnh viễn:`
        ];
        for (let i = 0; i < top.length; i++) {
            const tt = ending && ending.topTitles[i + 1];
            const name = await resolveName(channel.guild, top[i].userId);
            lines.push(`**${i + 1}.** ${name} — *${tt ? tt.name : ''}*`);
        }
        lines.push('');
        lines.push(`Vật phẩm cao cấp mùa cũ đã **đóng băng** (giữ trong kho để trưng bày, không còn tính điểm) và tặng chủ nhân **danh hiệu sưu tầm**.`);
        lines.push(`🌟 **Mùa ${newSeason.id} — ${newSeason.name}** bắt đầu! Gõ \`!season\` để xem chi tiết.`);
        await channel.send({ content: lines.join('\n') }).catch(e => log.error('season: send failed', e));
    }
}

async function resolveName(guild, userId) {
    const reg = data.registrations && data.registrations[guild.id] && data.registrations[guild.id][userId];
    if (reg && (reg.ingame || reg.displayName)) return reg.ingame || reg.displayName;
    const m = await guild.members.fetch(userId).catch(() => null);
    return m ? m.displayName : userId;
}

module.exports = {
    ensureState,
    getState,
    getCurrentSeasonId,
    getCurrentSeason,
    resolveItem,
    currentPremiumKeys,
    isFrozenPremiumKey,
    isScoredKey,
    mapGachaKey,
    tierMult,
    scoredItems,
    bumpScoreTime,
    getScoreTime,
    computeUserScore,
    rankGuild,
    getUserRank,
    timeRemainingMs,
    setLengthDays,
    setEndsAt,
    setAnnounceChannel,
    computeEndsAt,
    runRollover,
    maybeRollover
};
