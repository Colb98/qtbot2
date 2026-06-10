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
// The leaderboard "reset" is achieved WITHOUT mutating wallets: scoring and
// faucets (gacha/gifts/sells) resolve through the CURRENT season's item keys,
// so past-season premium items never score again (see isFrozenPremiumKey).
// They are NOT fully frozen though: services/exchange.js keeps every past
// season's items exchangeable (!doi) and its pets dismantlable (!phangiai,
// with a penalty for high-value pets) — converting old pets back into TT is
// the only way they re-enter the scored economy.
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
    return new Set(Object.values(s.items));
}

// Whether the current season has a given logical tier (e.g. Season 2+ has no pet3).
function hasTier(tier) {
    return cfg.hasTier(tier, getCurrentSeasonId());
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

// Per-tier exchange amounts, with a global economy.js fallback for any field a
// season omits. Season 1 omits `ratios` entirely (→ all economy defaults, still
// admin-editable); Season 2+ override only what differs (e.g. pet1PerPet2: 5).
const ECON_RATIO_DEFAULT = {
    ttPerPet1: () => economy.TT_PER_CAO,        // TT to mint 1 pet1 (!doi cao)
    pet1PerPet2: () => economy.CAO_PER_CAO5,    // pet1 per pet2 (!doi cao5)
    pet2PerPet3: () => economy.CAO5_PER_CAO9,   // pet2 per pet3 (!doi cao9)
    ttPerThanthu: () => economy.PHUONGBANG_TT,  // TT → thanthu (!doi phuongbang)
    ttPerThanthuplus: () => economy.PHUONGHOA_TT, // extra TT for thanthu→thanthuplus (!doi phuonghoa)
    ttPerThantrang: () => economy.THANTRANG_TT  // TT → thantrang (!doi thantrang)
};

function exchangeRatio(name, seasonId = getCurrentSeasonId()) {
    const s = cfg.getSeason(seasonId);
    if (s && s.ratios && s.ratios[name] != null) return s.ratios[name];
    const def = ECON_RATIO_DEFAULT[name];
    return def ? def() : undefined;
}

// TT-equivalent score multiplier for a logical tier, derived from the season's
// exchange ratios (so the value ladder follows the per-season ratios).
function tierMult(tier, seasonId = getCurrentSeasonId()) {
    const r = (name) => exchangeRatio(name, seasonId);
    switch (tier) {
        case 'pet1': return r('ttPerPet1');
        case 'pet2': return r('ttPerPet1') * r('pet1PerPet2');
        case 'pet3': return r('ttPerPet1') * r('pet1PerPet2') * r('pet2PerPet3');
        case 'thanthu': return r('ttPerThanthu');
        case 'thanthuplus': return r('ttPerThanthu') + r('ttPerThanthuplus');
        case 'thantrang': return r('ttPerThantrang');
        default: return 0;
    }
}

// Scored items for the CURRENT season: its premium tiers + cross-season TT.
// Shape: [{ key, mult, tier }]  (tier === null for thiên thưởng).
function scoredItems() {
    const s = getCurrentSeason();
    const out = cfg.seasonTiers(s.id).map(tier => ({ key: s.items[tier], mult: tierMult(tier, s.id), tier }));
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

// Ngọc leaderboard for a guild (same ranking as !topngoc): total ngọc
// (locked + non-locked) desc. Returns [{ userId, ngoc }].
function rankGuildNgoc(guildId) {
    const wallets = data.wallet && data.wallet[guildId];
    if (!wallets) return [];
    const rankings = [];
    for (const [userId, w] of Object.entries(wallets)) {
        if (!w) continue;
        const total = (w.ngoc || 0) + (w.lockedNgoc || 0);
        if (total > 0) rankings.push({ userId, ngoc: total });
    }
    rankings.sort((a, b) => b.ngoc - a.ngoc);
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
    const historyTopNgoc = {};
    const announcements = []; // [{ guildId, top: [{userId, score}], topNgoc: [{userId, ngoc}] }]
    const wallets = data.wallet || {};

    for (const guildId of Object.keys(wallets)) {
        const ranking = rankGuild(guildId);

        // Thiên Thưởng board: titles for ranks 1-5, badges for ranks 1-3.
        const topSnap = [];
        for (let i = 0; i < Math.min(5, ranking.length); i++) {
            const { userId, score } = ranking[i];
            const rank = i + 1;
            const tt = ending.topTitles[rank];
            if (tt) {
                profile.grantTitle(guildId, userId, tt.id);
                if (tt.badge) profile.grantBadge(guildId, userId, tt.badge);
            }
            topSnap.push({ userId, score });
        }
        historyTop[guildId] = topSnap.map(t => t.userId);

        // Ngọc board: titles + badges for ranks 1-3.
        const ngocRanking = rankGuildNgoc(guildId);
        const ngocSnap = [];
        for (let i = 0; i < Math.min(3, ngocRanking.length); i++) {
            const { userId, ngoc } = ngocRanking[i];
            const tn = ending.topNgoc && ending.topNgoc[i + 1];
            if (tn) {
                profile.grantTitle(guildId, userId, tn.id);
                if (tn.badge) profile.grantBadge(guildId, userId, tn.badge);
            }
            ngocSnap.push({ userId, ngoc });
        }
        historyTopNgoc[guildId] = ngocSnap.map(t => t.userId);

        if (topSnap.length || ngocSnap.length) announcements.push({ guildId, top: topSnap, topNgoc: ngocSnap });

        // Item-ownership titles — snapshot every wallet's holdings of the
        // ENDING season's premium tiers (locked + non-locked ≥ 1).
        const guildWallets = wallets[guildId] || {};
        for (const [userId, w] of Object.entries(guildWallets)) {
            if (!w || !w.items) continue;
            for (const tier of cfg.seasonTiers(endingId)) {
                const key = ending.items[tier];
                const owned = (w.items[key] || 0) + ((w.lockedItems && w.lockedItems[key]) || 0);
                const title = ending.titles[tier];
                if (owned >= 1 && title) profile.grantSeasonAchievement(guildId, userId, title.achId);
            }
        }
    }

    // Advance the season window.
    s.history.push({ id: endingId, endedAt: s.endsAt, top: historyTop, topNgoc: historyTopNgoc });
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
    for (const { guildId, top, topNgoc } of announcements) {
        const channelId = s.announceChannel[guildId];
        if (!channelId) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        const lines = [
            `# 🏆 Kết thúc Mùa ${endingId} — ${ending ? ending.name : ''}`,
            `Bảng xếp hạng Thiên Thưởng đã chốt. **Top 5** nhận danh hiệu vĩnh viễn (Top 1-3 kèm **huy hiệu** trưng trên profile):`
        ];
        for (let i = 0; i < top.length; i++) {
            const tt = ending && ending.topTitles[i + 1];
            const name = await resolveName(channel.guild, top[i].userId);
            lines.push(`**${i + 1}.** ${name} — *${tt ? tt.name : ''}*${i < 3 ? ' 🎖️' : ''}`);
        }
        if (topNgoc && topNgoc.length) {
            lines.push('');
            lines.push(`Bảng xếp hạng Ngọc: **Top 3** nhận danh hiệu vĩnh viễn + **huy hiệu**:`);
            for (let i = 0; i < topNgoc.length; i++) {
                const tn = ending && ending.topNgoc && ending.topNgoc[i + 1];
                const name = await resolveName(channel.guild, topNgoc[i].userId);
                lines.push(`**${i + 1}.** ${name} — *${tn ? tn.name : ''}* 🎖️`);
            }
        }
        lines.push('');
        lines.push(`Vật phẩm cao cấp mùa cũ **không còn tính điểm BXH** (vẫn đổi/phân giải qua \`!doi\` / \`!phangiai\`, không bán/tặng) và tặng chủ nhân **danh hiệu sưu tầm**.`);
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
    hasTier,
    exchangeRatio,
    tierMult,
    scoredItems,
    bumpScoreTime,
    getScoreTime,
    computeUserScore,
    rankGuild,
    rankGuildNgoc,
    getUserRank,
    timeRemainingMs,
    setLengthDays,
    setEndsAt,
    setAnnounceChannel,
    computeEndsAt,
    runRollover,
    maybeRollover
};
