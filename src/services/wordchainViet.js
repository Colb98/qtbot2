const {
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const log = require('../../logger');
const client = require('../client');
const { data, saveData } = require('../state');
const { addNgoc, renderEmote, fmt, todayStr } = require('./currency');
const economy = require('../config/economy');
const metrics = require('./metrics');

// Two pools: `full` validates player answers and is also the bot's answer pool
// (same arsenal as the players, so only true dead-tail words can kill the bot).
// `common` (everyday words) is only used to pick friendly round openers.
const rawDict = require('../../word_dict/tu2amtiet.json');

function buildFirstSyllableIndex(words) {
    const byFirst = {};
    for (const w of words) {
        const first = w.split(' ')[0];
        (byFirst[first] = byFirst[first] || []).push(w);
    }
    return byFirst;
}

const fullSet = new Set(rawDict.full);
const fullByFirst = buildFirstSyllableIndex(rawDict.full);
const commonByFirst = buildFirstSyllableIndex(rawDict.common);
log.info(`wordchainViet: dictionary loaded — full ${fullSet.size} words (${Object.keys(fullByFirst).length} buckets), common ${rawDict.common.length} words (${Object.keys(commonByFirst).length} buckets)`);

const HARD_CAP_MS = 2 * 24 * 60 * 60 * 1000;
const SURRENDER_COOLDOWN_MS = 10 * 1000;
const TIMER_GRACE_MS = 3000;

const sessions = new Map();
const threads = new Map();
const _msgLocks = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

// ── State helpers ──────────────────────────────────────────────────────────

function ensureRoot() {
    if (!data.wordchainViet) data.wordchainViet = {};
    const d = data.wordchainViet;
    if (!d.lifetime) d.lifetime = {};
    if (!d.weekly) d.weekly = {};
    if (!d.weeklyPaid) d.weeklyPaid = {};
    if (!d.wordCounts) d.wordCounts = {};
    if (!d.daily) d.daily = {};
}

// Per-user/day ngọc totals: { date, wordNgoc, bonusNgoc }.
function getDaily(guildId, userId) {
    ensureRoot();
    if (!data.wordchainViet.daily[guildId]) data.wordchainViet.daily[guildId] = {};
    const existing = data.wordchainViet.daily[guildId][userId];
    const today = todayStr();
    if (!existing || existing.date !== today) {
        data.wordchainViet.daily[guildId][userId] = { date: today, wordNgoc: 0, bonusNgoc: 0 };
    }
    return data.wordchainViet.daily[guildId][userId];
}

function getCapStatus(guildId, userId) {
    const cfg = economy.WORDCHAIN_VIET;
    const daily = getDaily(guildId, userId);
    return {
        wordNgoc: daily.wordNgoc, wordCap: cfg.DAILY_CAP_WORDS,
        bonusNgoc: daily.bonusNgoc, bonusCap: cfg.WIN_BONUS_DAILY_CAP
    };
}

// Drop stale per-user daily entries (position payout counts + daily ngọc totals).
function pruneDaily(today) {
    ensureRoot();
    today = today || todayStr();
    let removed = 0;
    for (const root of [data.wordchainViet.wordCounts, data.wordchainViet.daily]) {
        for (const guildId of Object.keys(root)) {
            const g = root[guildId];
            for (const uid of Object.keys(g)) {
                if (!g[uid] || g[uid].date !== today) { delete g[uid]; removed++; }
            }
            if (Object.keys(g).length === 0) delete root[guildId];
        }
    }
    if (removed) saveData();
    return removed;
}

// ── Week helpers ───────────────────────────────────────────────────────────

function weekStrAt(ts) {
    const shifted = new Date(ts + 7 * 3600 * 1000);
    const d = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekStr()         { return weekStrAt(Date.now()); }
function previousWeekStr() { return weekStrAt(Date.now() - 24 * 3600 * 1000); }

// ── Leaderboard (total valid words: lifetime + weekly) ─────────────────────

function addWords(guildId, userId, n) {
    if (!Number.isInteger(n) || n <= 0) return;
    ensureRoot();

    if (!data.wordchainViet.lifetime[guildId]) data.wordchainViet.lifetime[guildId] = {};
    const lt = data.wordchainViet.lifetime[guildId];
    lt[userId] = (lt[userId] || 0) + n;

    if (!data.wordchainViet.weekly[guildId]) data.wordchainViet.weekly[guildId] = {};
    const week = weekStr();
    const wk = data.wordchainViet.weekly[guildId][userId];
    if (!wk || wk.week !== week) {
        data.wordchainViet.weekly[guildId][userId] = { week, words: n };
    } else {
        wk.words += n;
    }
}

function getLifetimeTop(guildId, limit = 10) {
    ensureRoot();
    const scores = data.wordchainViet.lifetime[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

function getWeeklyTopForWeek(guildId, week, limit = 10) {
    ensureRoot();
    const scores = data.wordchainViet.weekly[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, e]) => e && e.week === week && e.words > 0)
        .map(([uid, e]) => [uid, e.words])
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

function getWeeklyTop(guildId, limit = 10) {
    return getWeeklyTopForWeek(guildId, weekStr(), limit);
}

// ── Weekly payout ──────────────────────────────────────────────────────────

function rewardForRank(rank) {
    for (const tier of economy.WORDCHAIN_VIET.WEEKLY_REWARDS) {
        if (rank >= tier.from && rank <= tier.to) return tier.ngoc;
    }
    return 0;
}

function getWeeklyRewardTable() {
    return economy.WORDCHAIN_VIET.WEEKLY_REWARDS;
}

function payoutWeek(guildId, week) {
    ensureRoot();
    const top = getWeeklyTopForWeek(guildId, week, 10);
    if (top.length === 0) return { week, paid: [] };
    const paid = [];
    for (let i = 0; i < top.length; i++) {
        const [userId, words] = top[i];
        const rank = i + 1;
        const ngoc = rewardForRank(rank);
        if (ngoc > 0) {
            addNgoc(guildId, userId, ngoc);
            paid.push({ userId, rank, words, ngoc });
        }
    }
    data.wordchainViet.weeklyPaid[guildId] = week;
    saveData();
    return { week, paid };
}

function payoutAllGuilds(week) {
    ensureRoot();
    const guilds = Object.keys(data.wordchainViet.weekly || {});
    const results = [];
    for (const guildId of guilds) {
        if (data.wordchainViet.weeklyPaid[guildId] === week) continue;
        const res = payoutWeek(guildId, week);
        if (res.paid.length > 0) {
            results.push({ guildId, ...res });
            log.info(`wordchainViet: paid weekly ${week} in guild ${guildId} — ${res.paid.length} winners`);
        }
    }
    return results;
}

async function announcePayout(guildId, result) {
    const channelId = (data.wordchainNotiChannel && data.wordchainNotiChannel[guildId])
        || (data.channelId && data.channelId[guildId]);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const lines = [`🏆 **Nối Từ Co-op — Tổng kết tuần ${result.week}**`];
    for (const w of result.paid) {
        lines.push(`Top ${w.rank}. <@${w.userId}> — **${fmt(w.words)}** từ · +**${fmt(w.ngoc)}** ${renderEmote('ngoc')} thưởng`);
    }
    await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } })
        .catch(e => log.warn('wordchainViet: announcePayout send failed', e));
}

async function runWeeklyPayout() {
    const week = previousWeekStr();
    log.info(`wordchainViet: running weekly payout for week ${week}`);
    const results = payoutAllGuilds(week);
    for (const r of results) await announcePayout(r.guildId, r);
    return results;
}

let _weeklyCronTask = null;
function scheduleWeeklyPayout() {
    if (_weeklyCronTask) return;
    let cron;
    try { cron = require('node-cron'); }
    catch (e) { log.warn('wordchainViet: node-cron not available, weekly payout disabled', e); return; }
    _weeklyCronTask = cron.schedule('0 0 * * 1', async () => {
        try { await runWeeklyPayout(); }
        catch (e) { log.error('wordchainViet: weekly payout cron error', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    log.info('wordchainViet: scheduled weekly payout — Mon 00:00 Asia/Ho_Chi_Minh');
}

// ── Word / dictionary helpers ──────────────────────────────────────────────

function normalize(text) {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitWord(word) {
    return word.split(' ');
}

function isInDict(word) {
    return fullSet.has(word);
}

// Player-side reachability: can anyone answer `syllable` from the full pool?
function hasUnusedContinuation(syllable, usedWords) {
    const bucket = fullByFirst[syllable];
    if (!Array.isArray(bucket)) return false;
    for (const w of bucket) {
        if (!usedWords.has(w)) return true;
    }
    return false;
}

// How many full-pool answers `word` leaves open for the players.
function countUnusedContinuations(word, usedWords) {
    const second = splitWord(word)[1];
    const bucket = fullByFirst[second];
    if (!Array.isArray(bucket)) return 0;
    let count = 0;
    for (const next of bucket) {
        if (next === word) continue;
        if (!usedWords.has(next)) count++;
    }
    return count;
}

function validateWord(word, lastSyllable, usedWords) {
    const tokens = splitWord(word);
    if (tokens.length !== 2) return 'shape';
    if (!isInDict(word)) return 'not_in_dict';
    if (lastSyllable !== null && tokens[0] !== lastSyllable) return 'wrong_chain';
    if (usedWords.has(word)) return 'used';
    return 'valid';
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const openerKeys = Object.keys(commonByFirst);

function pickRandomOpener(usedWords) {
    for (let i = 0; i < 500; i++) {
        const bucket = commonByFirst[randomFrom(openerKeys)];
        const word = randomFrom(bucket);
        if (usedWords.has(word)) continue;
        if (countUnusedContinuations(word, usedWords) > 10) return word;
    }
    return null;
}

// ── Bot brain: friendly early, hostile late ────────────────────────────────
// The bot answers from the full pool. Friendly: depth-1 minimax — pick the
// word that maximizes the bot's chances on its NEXT turn assuming players
// reply adversarially (i.e. maximize the minimum number of answers the bot
// keeps across every possible player reply). Hostile: pick randomly among
// words leaving players ≤ BOT_HOSTILE_MAX_CONT options — a squeeze, not an
// automatic kill. Hostile chance ramps with player words.

function hostileChance(playerCount) {
    const cfg = economy.WORDCHAIN_VIET;
    const over = playerCount - cfg.BOT_FRIENDLY_WORDS;
    if (over <= 0) return 0;
    return Math.min(over * cfg.BOT_HOSTILE_RAMP, cfg.BOT_HOSTILE_MAX);
}

// Per-syllable counts of already-used words, for O(1) continuation estimates
// inside the minimax loop (every used word sits in exactly one first-syllable
// bucket, so unused-in-bucket = bucket size − usedFirstCounts[syllable]).
function buildUsedFirstCounts(usedWords) {
    const counts = {};
    for (const w of usedWords) {
        const f = w.split(' ')[0];
        counts[f] = (counts[f] || 0) + 1;
    }
    return counts;
}

function pickFriendly(candidates, usedWords) {
    const usedFirst = buildUsedFirstCounts(usedWords);
    let best = [];
    let bestScore = -Infinity;
    for (const w of candidates) {
        const [wFirst, wTail] = splitWord(w);
        const replies = fullByFirst[wTail] || [];
        // Worst case over the player's replies: how many answers does the bot
        // keep if the player picks the reply that hurts it the most?
        let worst = Infinity;
        let hasReply = false;
        for (const r of replies) {
            if (r === w || usedWords.has(r)) continue;
            hasReply = true;
            const rTail = splitWord(r)[1];
            const bucket = fullByFirst[rTail];
            let c = bucket ? bucket.length - (usedFirst[rTail] || 0) : 0;
            if (bucket) {
                // `w` and `r` will be on the board by then but aren't in usedWords yet.
                if (wFirst === rTail) c -= 1; // w occupies a slot in the reply's bucket
                if (wTail === rTail) c -= 1;  // r continues itself (first(r) = wTail)
            }
            if (c < worst) worst = c;
            if (worst <= 0) break;
        }
        const score = hasReply ? worst : -1; // no reply = bot kills players: last resort when friendly
        if (score > bestScore) { bestScore = score; best = [w]; }
        else if (score === bestScore) best.push(w);
    }
    return best.length > 0 ? randomFrom(best) : randomFrom(candidates);
}

function pickHostile(candidates, usedWords) {
    const maxCont = economy.WORDCHAIN_VIET.BOT_HOSTILE_MAX_CONT;
    const squeeze = candidates.filter(w => countUnusedContinuations(w, usedWords) <= maxCont);
    if (squeeze.length > 0) return randomFrom(squeeze);
    // Nothing tight available — fall back to the lowest-continuation words
    // (still > maxCont options, so never an automatic kill).
    let best = [];
    let bestCount = Infinity;
    for (const w of candidates) {
        const c = countUnusedContinuations(w, usedWords);
        if (c < bestCount) { bestCount = c; best = [w]; }
        else if (c === bestCount) best.push(w);
    }
    return randomFrom(best);
}

function pickBotWord(syllable, usedWords, playerCount) {
    const bucket = fullByFirst[syllable];
    if (!Array.isArray(bucket) || bucket.length === 0) return null;
    const candidates = bucket.filter(w => !usedWords.has(w));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    if (Math.random() < hostileChance(playerCount)) return pickHostile(candidates, usedWords);
    return pickFriendly(candidates, usedWords);
}

// ── Rewards ────────────────────────────────────────────────────────────────

function rewardForPosition(i) {
    const cfg = economy.WORDCHAIN_VIET;
    const step = Math.floor((i - 1) / cfg.POSITIONS_PER_STEP);
    return Math.min(cfg.NGOC_PER_WORD_BASE + step * cfg.NGOC_PER_POSITION_STEP, cfg.NGOC_PER_WORD_MAX);
}

function timeoutSecondsFor(playerCount) {
    const ladder = economy.WORDCHAIN_VIET.TIMER_LADDER;
    for (const tier of ladder) {
        if (playerCount < tier.upTo) return tier.seconds;
    }
    return ladder[ladder.length - 1].seconds;
}

// ── Timer helpers ──────────────────────────────────────────────────────────

function armTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.nextTimeoutMs > 0) {
        session.timer = setTimeout(() => onTimeout(session.threadId), session.nextTimeoutMs);
    }
}

function armThreadHardCap(threadInfo, threadId) {
    if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
    threadInfo.hardCapTimer = setTimeout(() => closeThread(threadId, { reason: 'hard_cap' }), HARD_CAP_MS);
}

async function onTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    await endSession(threadId, { reason: 'timeout' });
}

// ── Core game flow ─────────────────────────────────────────────────────────

function getHelpText() {
    const cfg = economy.WORDCHAIN_VIET;
    return (
        `**Nối Từ Co-op — luật chơi**\n` +
        `• Bot mở đầu bằng một từ 2 âm tiết; bất kỳ ai trong thread cũng có thể nối tiếp (**co-op** — cả nhóm vs bot).\n` +
        `• Từ tiếp theo phải có **2 âm tiết**, có trong từ điển, và bắt đầu bằng **âm tiết cuối** của từ trước. Mỗi từ chỉ dùng 1 lần/ván.\n` +
        `• ✅ hợp lệ — ❌ không có trong từ điển / sai luật nối — ⛔ đã dùng rồi.\n` +
        `• **Thưởng Ngọc theo vị trí từ** (càng sâu càng nhiều): ${fmt(cfg.NGOC_PER_WORD_BASE)} → ${fmt(cfg.NGOC_PER_WORD_MAX)}/từ. Mỗi vị trí thưởng tối đa ${cfg.REWARD_CAP_PER_POSITION} lần/ngày · cap ${fmt(cfg.DAILY_CAP_WORDS)} ${renderEmote('ngoc')}/ngày.\n` +
        `• Bot **hiền** ${cfg.BOT_FRIENDLY_WORDS} từ đầu, sau đó **ngày càng hiểm** — cố dồn cả nhóm vào ngõ cụt. Dồn được bot vào ngõ cụt: +${fmt(cfg.WIN_BONUS)} ${renderEmote('ngoc')} cho người chốt (cần ván ≥ ${cfg.WIN_BONUS_MIN_WORDS} từ · cap ${fmt(cfg.WIN_BONUS_DAILY_CAP)}/ngày).\n` +
        `• **Hết giờ là hết ván** (vẫn nhận thưởng các từ đã nối). Thời gian rút dần khi nối càng sâu.\n` +
        `• BXH tuần & all-time xếp theo **tổng số từ** đã nối. Thưởng tuần Thứ Hai 00:00 GMT+7.\n` +
        `• Đầu hàng: gõ \`end\`, \`sur\`, \`surrender\` hoặc \`THUA\` (cần đóng góp ≥ 1 từ, sau ≥ 10s).`
    );
}

async function beginGame(thread, invokerId) {
    if (sessions.has(thread.id)) return;

    let threadInfo = threads.get(thread.id);
    if (!threadInfo) {
        threadInfo = { invokerId, hardCapTimer: null, lastRoundParticipants: null };
        threads.set(thread.id, threadInfo);
    } else if (invokerId) {
        threadInfo.invokerId = invokerId;
    }
    armThreadHardCap(threadInfo, thread.id);

    const usedWords = new Set();
    const opener = pickRandomOpener(usedWords);
    if (!opener) {
        await thread.send('Không tìm được từ mở đầu. Gõ `start` để thử lại.').catch(() => {});
        return;
    }

    const session = {
        guildId: thread.guildId,
        threadId: thread.id,
        usedWords,
        lastSyllable: null,
        positionOwners: [],
        playerCount: 0,
        startedAt: Date.now(),
        lastValidAt: null,
        nextTimeoutMs: 0,
        timer: null,
        ended: false
    };
    sessions.set(thread.id, session);

    usedWords.add(opener);
    session.lastSyllable = splitWord(opener)[1];
    session.lastValidAt = Date.now();

    const secs = timeoutSecondsFor(0);
    const endUnix = Math.floor(Date.now() / 1000) + secs;

    await thread.send(
        `**Ván mới — Nối Từ Co-op** (cả nhóm vs bot · gõ \`help\` xem luật & thưởng)\n` +
        `## ${opener}\n` +
        `Nối tiếp <t:${endUnix}:R> (~${secs}s) · Âm kế: **${session.lastSyllable}**`
    ).catch(e => log.warn('wordchainViet: send intro failed', e));

    session.nextTimeoutMs = secs * 1000 + TIMER_GRACE_MS;
    armTimer(session);
}

async function endSession(threadId, { reason, winnerId }) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.ended = true;
    if (session.timer) clearTimeout(session.timer);

    const threadInfo = threads.get(threadId);
    const thread = await client.channels.fetch(threadId).catch(() => null);

    const ownerPositions = new Map();
    for (let i = 0; i < session.positionOwners.length; i++) {
        const uid = session.positionOwners[i];
        if (!ownerPositions.has(uid)) ownerPositions.set(uid, []);
        ownerPositions.get(uid).push(i + 1);
    }

    const perUserSummary = [];
    let totalNgocAwarded = 0;
    const cfg = economy.WORDCHAIN_VIET;
    ensureRoot();

    const winBonus = (reason === 'dead_end' && winnerId && cfg.WIN_BONUS > 0
        && session.playerCount >= cfg.WIN_BONUS_MIN_WORDS) ? cfg.WIN_BONUS : 0;

    for (const [uid, positions] of ownerPositions) {
        if (!data.wordchainViet.wordCounts[session.guildId]) data.wordchainViet.wordCounts[session.guildId] = {};
        const countsRoot = data.wordchainViet.wordCounts[session.guildId];
        const today = todayStr();
        if (!countsRoot[uid] || countsRoot[uid].date !== today) {
            countsRoot[uid] = { date: today, counts: [] };
        }
        const counts = countsRoot[uid].counts;
        const daily = getDaily(session.guildId, uid);

        let reward = 0;
        for (const i of positions) {
            const prev = counts[i - 1] || 0;
            if (prev < cfg.REWARD_CAP_PER_POSITION) {
                const remaining = cfg.DAILY_CAP_WORDS - daily.wordNgoc - reward;
                if (remaining > 0) reward += Math.min(rewardForPosition(i), remaining);
            }
            counts[i - 1] = prev + 1;
        }
        daily.wordNgoc += reward;

        let bonus = 0;
        if (uid === winnerId && winBonus > 0) {
            bonus = Math.min(winBonus, Math.max(0, cfg.WIN_BONUS_DAILY_CAP - daily.bonusNgoc));
            daily.bonusNgoc += bonus;
        }

        const totalForUser = reward + bonus;
        if (totalForUser > 0) addNgoc(session.guildId, uid, totalForUser);
        addWords(session.guildId, uid, positions.length);
        totalNgocAwarded += totalForUser;
        perUserSummary.push({ userId: uid, wordCount: positions.length, reward, bonus });
    }

    if (threadInfo) {
        threadInfo.lastRoundParticipants = new Set(ownerPositions.keys());
    }

    if (ownerPositions.size > 0) saveData();

    try {
        const durationMs = session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0;
        metrics.recordWordchainViet({
            guildId: session.guildId,
            totalWords: session.playerCount,
            participants: ownerPositions.size,
            ngocAwarded: totalNgocAwarded,
            endReason: reason,
            durationMs,
            userIds: Array.from(ownerPositions.keys())
        });
    } catch (e) {
        log.warn('wordchainViet: metrics record failed', e);
    }

    if (thread) {
        const lines = [];
        if (reason === 'dead_end' && winnerId) {
            lines.push(`🎉 **Bot không còn từ để nối — <@${winnerId}> chốt hạ!**`);
        } else if (reason === 'bot_win') {
            lines.push(`💀 **Bot dồn cả nhóm vào ngõ cụt — không còn từ để nối!**`);
        } else if (reason === 'timeout') {
            lines.push(`⏰ **Hết giờ!** Game over.`);
        } else {
            lines.push(`🏁 Game over — đầu hàng.`);
        }
        if (session.playerCount === 0) {
            lines.push('Chưa ai nối được từ nào.');
        } else {
            lines.push(`Tổng số từ đã nối: **${session.playerCount}**`);
            perUserSummary.sort((a, b) => b.wordCount - a.wordCount);
            for (const s of perUserSummary) {
                const parts = [];
                if (s.reward > 0) parts.push(`+${fmt(s.reward)} ${renderEmote('ngoc')}`);
                else parts.push(`+0 ${renderEmote('ngoc')} (đã đạt cap)`);
                if (s.bonus > 0) parts.push(`🏆 +${fmt(s.bonus)} ${renderEmote('ngoc')} thưởng chốt hạ`);
                lines.push(`<@${s.userId}> — **${s.wordCount}** từ · ${parts.join(' · ')}`);
            }
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('wcv_start_new')
                .setLabel('Ván mới')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('wcv_close_init')
                .setLabel('Đóng thread')
                .setStyle(ButtonStyle.Secondary)
        );
        await thread.send({
            content: lines.join('\n'),
            components: [row],
            allowedMentions: { parse: [] }
        }).catch(e => log.warn('wordchainViet: send end message failed', e));
    }

    sessions.delete(threadId);
}

async function closeThread(threadId, { reason }) {
    const threadInfo = threads.get(threadId);
    if (threadInfo) {
        if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
        threads.delete(threadId);
    }
    const session = sessions.get(threadId);
    if (session && !session.ended) {
        session.ended = true;
        if (session.timer) clearTimeout(session.timer);
        sessions.delete(threadId);
    }

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) {
        const closingMsg = reason === 'hard_cap'
            ? '⏰ Thread không hoạt động quá 2 ngày. Đóng thread.'
            : '🔒 Thread đã được đóng.';
        await thread.send(closingMsg).catch(e => log.warn('wordchainViet: send close message failed', e));
        await thread.setLocked(true).catch(e => log.warn('wordchainViet: lock thread failed', e));
        await thread.setArchived(true).catch(e => log.warn('wordchainViet: archive thread failed', e));
    }
}

async function startSession({ channel, invokerId }) {
    if (channel.type !== ChannelType.GuildText) {
        throw new Error('not_text_channel');
    }
    const thread = await channel.threads.create({
        name: 'Nối Từ Co-op',
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Nối Từ Co-op started by ${invokerId}`
    });
    await beginGame(thread, invokerId);
    return thread;
}

// ── Buttons ────────────────────────────────────────────────────────────────

function canActOnRound(threadInfo, userId) {
    if (!threadInfo) return false;
    const participants = threadInfo.lastRoundParticipants;
    if (!participants || participants.size === 0) {
        return userId === threadInfo.invokerId;
    }
    return participants.has(userId);
}

async function showCloseConfirmation(msg) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`wcv_close_ok_${msg.author.id}`)
            .setLabel('OK')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`wcv_close_cancel_${msg.author.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
    await msg.reply({
        content: `<@${msg.author.id}> xác nhận đóng thread?`,
        components: [row],
        allowedMentions: { parse: [] }
    }).catch(e => log.warn('wordchainViet: send close confirmation failed', e));
}

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('wcv_')) return false;

    const id = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'wcv_start_new') {
        const threadInfo = threads.get(threadId);
        if (!threadInfo) {
            await interaction.reply({
                content: 'Không tìm được phiên này.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        if (sessions.has(threadId)) {
            await interaction.reply({
                content: 'Đã có ván đang chơi.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        if (!canActOnRound(threadInfo, interaction.user.id)) {
            await interaction.reply({
                content: 'Chỉ người chơi ván vừa rồi (hoặc người tạo thread nếu ván trống) mới bấm được nút này.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        await interaction.update({ components: [] }).catch(() => {});
        await beginGame(interaction.channel);
        return true;
    }

    if (id === 'wcv_close_init') {
        const threadInfo = threads.get(threadId);
        if (!threadInfo) {
            await interaction.reply({
                content: 'Không tìm được phiên này.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        if (!canActOnRound(threadInfo, interaction.user.id)) {
            await interaction.reply({
                content: 'Chỉ người chơi ván vừa rồi (hoặc người tạo thread nếu ván trống) mới đóng được thread.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`wcv_close_ok_${interaction.user.id}`)
                .setLabel('OK')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`wcv_close_cancel_${interaction.user.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
            content: `<@${interaction.user.id}> xác nhận đóng thread?`,
            components: [row],
            allowedMentions: { parse: [] }
        }).catch(() => {});
        return true;
    }

    if (id.startsWith('wcv_close_ok_') || id.startsWith('wcv_close_cancel_')) {
        const parts = id.split('_');
        const action = parts[2];
        const typerId = parts[3];

        if (interaction.user.id !== typerId) {
            await interaction.reply({
                content: 'Chỉ người gọi đóng thread mới có thể xác nhận.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }

        if (action === 'cancel') {
            await interaction.update({
                content: '❎ Đã hủy đóng thread.',
                components: []
            }).catch(() => {});
            return true;
        }

        await interaction.update({
            content: '✅ Đang đóng thread...',
            components: []
        }).catch(() => {});
        await closeThread(threadId, { reason: 'manual' });
        return true;
    }

    return false;
}

// ── Message handling ───────────────────────────────────────────────────────

async function handleThreadMessage(msg) {
    const threadId = msg.channel.id;
    const prev = _msgLocks.get(threadId) || Promise.resolve();
    const current = prev.then(() => _handleThreadMessageImpl(msg))
        .catch(e => log.warn('wordchainViet: handleThreadMessage error', e));
    _msgLocks.set(threadId, current);
    current.finally(() => {
        if (_msgLocks.get(threadId) === current) _msgLocks.delete(threadId);
    });
    return current;
}

async function _handleThreadMessageImpl(msg) {
    const threadInfo = threads.get(msg.channel.id);
    if (!threadInfo) return;
    if (msg.author.bot) return;

    armThreadHardCap(threadInfo, msg.channel.id);

    const word = normalize(msg.content);
    if (!word) return;

    if (word === 'help') {
        await msg.reply(getHelpText()).catch(() => {});
        return;
    }

    if (word === 'close') {
        await showCloseConfirmation(msg);
        return;
    }

    const session = sessions.get(msg.channel.id);

    if (!session || session.ended) {
        if (word === 'start') {
            if (!canActOnRound(threadInfo, msg.author.id)) return;
            await beginGame(msg.channel);
        }
        return;
    }

    const raw = msg.content.trim();
    const isSurrender = word === 'surrender' || word === 'sur' || word === 'end' || raw === 'THUA';
    if (isSurrender) {
        if (!session.positionOwners.includes(msg.author.id)) {
            await msg.reply('Bạn cần đóng góp ít nhất 1 từ trong ván này mới được đầu hàng.').catch(() => {});
            return;
        }
        const elapsed = Date.now() - session.lastValidAt;
        if (elapsed < SURRENDER_COOLDOWN_MS) {
            const remaining = Math.ceil((SURRENDER_COOLDOWN_MS - elapsed) / 1000);
            await msg.reply(`Chưa thể đầu hàng (đợi thêm ${remaining}s sau từ hợp lệ gần nhất).`).catch(() => {});
            return;
        }
        await msg.react('🏳️').catch(() => {});
        await endSession(session.threadId, { reason: 'surrender' });
        return;
    }

    const action = validateWord(word, session.lastSyllable, session.usedWords);

    if (action === 'shape') return; // plain chat in the thread — ignore silently
    if (action === 'not_in_dict' || action === 'wrong_chain') {
        try { metrics.recordWordchainVietReject({ guildId: msg.guildId }); } catch (e) { /* ignore */ }
        await msg.react('❌').catch(() => {});
        return;
    }
    if (action === 'used') {
        await msg.react('⛔').catch(() => {});
        return;
    }

    session.usedWords.add(word);
    session.playerCount += 1;
    session.positionOwners.push(msg.author.id);
    session.lastValidAt = Date.now();

    await msg.react('✅').catch(() => {});

    const playerSecond = splitWord(word)[1];
    const botWord = pickBotWord(playerSecond, session.usedWords, session.playerCount);
    if (!botWord) {
        await endSession(session.threadId, { reason: 'dead_end', winnerId: msg.author.id });
        return;
    }
    session.usedWords.add(botWord);
    const botSecond = splitWord(botWord)[1];
    session.lastSyllable = botSecond;

    if (!hasUnusedContinuation(botSecond, session.usedWords)) {
        if (session.timer) { clearTimeout(session.timer); session.timer = null; }
        await msg.channel.send(`**${botWord}**`).catch(() => {});
        await endSession(session.threadId, { reason: 'bot_win' });
        return;
    }

    const secs = timeoutSecondsFor(session.playerCount);
    const endUnix = Math.floor(Date.now() / 1000) + secs;
    const nextReward = rewardForPosition(session.playerCount + 1);

    await msg.channel.send(
        `**${botWord}**\n` +
        `Nối tiếp <t:${endUnix}:R> (~${secs}s) · Từ: **${session.playerCount}** · Âm kế: **${botSecond}** · Từ kế: +**${fmt(nextReward)}** ${renderEmote('ngoc')}`
    ).catch(e => log.warn('wordchainViet: send bot reply failed', e));

    session.nextTimeoutMs = secs * 1000 + TIMER_GRACE_MS;
    armTimer(session);
}

module.exports = {
    hasThread,
    startSession,
    handleThreadMessage,
    handleButtonInteraction,
    getLifetimeTop,
    getWeeklyTop,
    getWeeklyRewardTable,
    scheduleWeeklyPayout,
    runWeeklyPayout,
    getCapStatus,
    pruneDaily
};
