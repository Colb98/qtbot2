const fs = require('fs');
const path = require('path');
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

const DICT_PATH = path.join(__dirname, '..', '..', 'word_dict', 'vietnamese_22k.txt');
const wordList = fs.readFileSync(DICT_PATH, 'utf8')
    .split(/\r?\n/)
    .map(w => w.trim())
    .filter(w => w.includes(' ') && w.split(' ').length === 2);
log.info(`vuaTiengViet: loaded ${wordList.length} two-syllable words`);

const HARD_CAP_MS = 24 * 60 * 60 * 1000;
const TIMER_GRACE_MS = 2000;

const sessions = new Map();
const threads  = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

// ── State helpers ──────────────────────────────────────────────────────────

function ensureRoot() {
    if (!data.vuaTiengViet) data.vuaTiengViet = {};
    const d = data.vuaTiengViet;
    if (!d.dailyCaps)   d.dailyCaps   = {};
    if (!d.weekly)      d.weekly      = {};
    if (!d.lifetime)    d.lifetime    = {};
    if (!d.weeklyPaid)  d.weeklyPaid  = {};
    if (!d.weeklyOptOut) d.weeklyOptOut = {};
}

function isOptedOut(guildId, userId) {
    ensureRoot();
    const g = data.vuaTiengViet.weeklyOptOut[guildId];
    return !!(g && g[userId]);
}

function toggleOptOut(guildId, userId) {
    ensureRoot();
    if (!data.vuaTiengViet.weeklyOptOut[guildId]) data.vuaTiengViet.weeklyOptOut[guildId] = {};
    const g = data.vuaTiengViet.weeklyOptOut[guildId];
    if (g[userId]) { delete g[userId]; saveData(); return false; }
    g[userId] = true;
    saveData();
    return true;
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

// ── Daily cap helpers ──────────────────────────────────────────────────────

function getDailyCap(guildId, userId) {
    ensureRoot();
    if (!data.vuaTiengViet.dailyCaps[guildId]) data.vuaTiengViet.dailyCaps[guildId] = {};
    const existing = data.vuaTiengViet.dailyCaps[guildId][userId];
    const today = todayStr();
    if (!existing || existing.date !== today) {
        data.vuaTiengViet.dailyCaps[guildId][userId] = { date: today, earned: 0 };
    }
    return data.vuaTiengViet.dailyCaps[guildId][userId];
}

function earnNgoc(guildId, userId, difficulty, amount) {
    const cfg = economy.VUATIENGVIET[difficulty.toUpperCase()];
    const cap = getDailyCap(guildId, userId);
    const remaining = cfg.DAILY_CAP - cap.earned;
    const actual = Math.min(amount, Math.max(0, remaining));
    if (actual > 0) {
        cap.earned += actual;
        addNgoc(guildId, userId, actual);
    }
    // Word count always increments regardless of ngọc cap
    updateLifetime(guildId, userId);
    updateWeekly(guildId, userId);
    saveData();
    return actual;
}

function getCapStatus(guildId, userId) {
    const cap = getDailyCap(guildId, userId);
    return {
        easy:   { earned: cap.earned, cap: economy.VUATIENGVIET.EASY.DAILY_CAP   },
        medium: { earned: cap.earned, cap: economy.VUATIENGVIET.MEDIUM.DAILY_CAP },
        hard:   { earned: cap.earned, cap: economy.VUATIENGVIET.HARD.DAILY_CAP   }
    };
}

function resetDailyCaps(guildId) {
    ensureRoot();
    const count = Object.keys(data.vuaTiengViet.dailyCaps[guildId] || {}).length;
    data.vuaTiengViet.dailyCaps[guildId] = {};
    saveData();
    return count;
}

// ── Leaderboard ────────────────────────────────────────────────────────────

function updateLifetime(guildId, userId) {
    ensureRoot();
    if (!data.vuaTiengViet.lifetime[guildId]) data.vuaTiengViet.lifetime[guildId] = {};
    data.vuaTiengViet.lifetime[guildId][userId] = (data.vuaTiengViet.lifetime[guildId][userId] || 0) + 1;
}

function updateWeekly(guildId, userId) {
    ensureRoot();
    if (!data.vuaTiengViet.weekly[guildId]) data.vuaTiengViet.weekly[guildId] = {};
    const week = weekStr();
    const entry = data.vuaTiengViet.weekly[guildId][userId];
    if (!entry || entry.week !== week) {
        data.vuaTiengViet.weekly[guildId][userId] = { week, words: 1 };
    } else {
        entry.words = (entry.words || 0) + 1;
    }
}

function getLifetimeTop(guildId, limit = 10) {
    ensureRoot();
    const scores = data.vuaTiengViet.lifetime[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

function getWeeklyTop(guildId, limit = 10) {
    return getWeeklyTopForWeek(guildId, weekStr(), limit);
}

function getWeeklyTopForWeek(guildId, week, limit = 10) {
    ensureRoot();
    const scores = data.vuaTiengViet.weekly[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, e]) => e && e.week === week && (e.words || 0) > 0)
        .map(([uid, e]) => [uid, e.words || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

// ── Weekly payout ──────────────────────────────────────────────────────────

function rewardForRank(rank) {
    for (const tier of economy.VUATIENGVIET.WEEKLY_REWARDS) {
        if (rank >= tier.from && rank <= tier.to) return tier.ngoc;
    }
    return 0;
}

function getWeeklyRewardTable() {
    return economy.VUATIENGVIET.WEEKLY_REWARDS;
}

function payoutWeek(guildId, week) {
    ensureRoot();
    const rawTop = getWeeklyTopForWeek(guildId, week, 50);
    const top = rawTop.filter(([uid]) => !isOptedOut(guildId, uid)).slice(0, 10);
    if (top.length === 0) return { week, paid: [] };
    const paid = [];
    for (let i = 0; i < top.length; i++) {
        const [userId, words] = top[i];
        const rank = i + 1;
        const reward = rewardForRank(rank);
        if (reward > 0) {
            addNgoc(guildId, userId, reward);
            paid.push({ userId, rank, words, reward });
        }
    }
    data.vuaTiengViet.weeklyPaid[guildId] = week;
    saveData();
    return { week, paid };
}

function payoutAllGuilds(week) {
    ensureRoot();
    const guilds = Object.keys(data.vuaTiengViet.weekly || {});
    const results = [];
    for (const guildId of guilds) {
        const alreadyPaid = data.vuaTiengViet.weeklyPaid[guildId];
        if (alreadyPaid === week) continue;
        const res = payoutWeek(guildId, week);
        if (res.paid.length > 0) {
            results.push({ guildId, ...res });
            log.info(`vuaTiengViet: paid weekly ${week} in guild ${guildId} — ${res.paid.length} winners`);
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
    const lines = [`🏆 **Vua Tiếng Việt — Tổng kết tuần ${result.week}**`];
    for (const w of result.paid) {
        lines.push(`Top ${w.rank}. <@${w.userId}> — **${fmt(w.words)}** từ · +**${fmt(w.reward)}** ${renderEmote('ngoc')} thưởng`);
    }
    await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } })
        .catch(e => log.warn('vuaTiengViet: announcePayout send failed', e));
}

async function runWeeklyPayout() {
    const week = previousWeekStr();
    log.info(`vuaTiengViet: running weekly payout for week ${week}`);
    const results = payoutAllGuilds(week);
    for (const r of results) await announcePayout(r.guildId, r);
    return results;
}

let _weeklyCronTask = null;
function scheduleWeeklyPayout() {
    if (_weeklyCronTask) return;
    let cron;
    try { cron = require('node-cron'); }
    catch (e) { log.warn('vuaTiengViet: node-cron not available, weekly payout disabled', e); return; }
    _weeklyCronTask = cron.schedule('0 0 * * 1', async () => {
        try { await runWeeklyPayout(); }
        catch (e) { log.error('vuaTiengViet: weekly payout cron error', e); }
    }, { timezone: 'Asia/Ho_Chi_Minh' });
    log.info('vuaTiengViet: scheduled weekly payout — Mon 00:00 Asia/Ho_Chi_Minh');
}

// ── Game helpers ───────────────────────────────────────────────────────────

function randomWord() {
    return wordList[Math.floor(Math.random() * wordList.length)];
}

function shuffled(chars) {
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars;
}

function scrambleWord(word, difficulty) {
    const syllables = word.normalize('NFC').split(' ');
    return syllables.map(syl => {
        const chars = difficulty === 'easy'
            ? [...syl].map((c, i) => i === 0 ? c.toUpperCase() : c.toLowerCase())
            : [...syl].map(c => c.toUpperCase());
        return shuffled(chars).join('/');
    }).join('_');
}

function normalizeAnswer(text) {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function difficultyLabel(d) {
    if (d === 'easy')   return 'Dễ';
    if (d === 'medium') return 'Trung Bình';
    return 'Khó';
}

function difficultyEmoji(d) {
    if (d === 'easy')   return '🟢';
    if (d === 'medium') return '🟡';
    return '🔴';
}

// ── Timer helpers ──────────────────────────────────────────────────────────

function armTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    const cfg = economy.VUATIENGVIET[session.difficulty.toUpperCase()];
    session.wordEndAt = Date.now() + cfg.TIME_LIMIT_S * 1000;
    session.timer = setTimeout(() => onTimeout(session.threadId), cfg.TIME_LIMIT_S * 1000 + TIMER_GRACE_MS);
}

function armThreadHardCap(threadInfo, threadId) {
    if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
    threadInfo.hardCapTimer = setTimeout(() => closeThread(threadId, { reason: 'hard_cap' }), HARD_CAP_MS);
}

// ── Core game flow ─────────────────────────────────────────────────────────

async function sendNextWord(session, thread) {
    const word = randomWord();
    session.currentWord = normalizeAnswer(word);
    session.scrambled   = scrambleWord(word, session.difficulty);

    const cfg     = economy.VUATIENGVIET[session.difficulty.toUpperCase()];
    const endUnix = Math.floor((Date.now() + cfg.TIME_LIMIT_S * 1000) / 1000);

    await thread.send(
        `🔤 **Từ bị xáo trộn:** \`${session.scrambled}\`\n` +
        `⏱️ Trả lời trước <t:${endUnix}:R> · +${fmt(cfg.NGOC_PER_WORD)} ${renderEmote('ngoc')}/từ`
    ).catch(e => log.warn('vuaTiengViet: send word failed', e));

    armTimer(session);
}

async function onTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.timer = null;
    session.consecutiveMisses++;

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) { sessions.delete(threadId); return; }

    if (session.consecutiveMisses >= economy.VUATIENGVIET.MAX_MISSES) {
        session.ended = true;
        await thread.send(
            `⏰ **Hết giờ!** Đáp án là: **${session.currentWord}**\n` +
            `Đã bỏ qua **${session.consecutiveMisses}** từ liên tiếp. Trò chơi tạm dừng.`
        ).catch(() => {});
        await showContinuePrompt(thread);
    } else {
        await thread.send(
            `⏰ **Hết giờ!** Đáp án là: **${session.currentWord}**\n` +
            `Tiếp tục... (bỏ qua ${session.consecutiveMisses}/${economy.VUATIENGVIET.MAX_MISSES})`
        ).catch(() => {});
        await sendNextWord(session, thread);
    }
}

async function showContinuePrompt(thread) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vtv_continue')
            .setLabel('Tiếp tục')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('vtv_close_init')
            .setLabel('Đóng thread')
            .setStyle(ButtonStyle.Secondary)
    );
    await thread.send({
        content: '❓ Bạn có muốn tiếp tục trò chơi không?',
        components: [row]
    }).catch(() => {});
}

async function beginGame(thread, invokerId, difficulty) {
    if (sessions.has(thread.id)) return;

    let threadInfo = threads.get(thread.id);
    if (!threadInfo) {
        threadInfo = { hardCapTimer: null, invokerId, difficulty };
        threads.set(thread.id, threadInfo);
    } else {
        if (invokerId)  threadInfo.invokerId  = invokerId;
        if (difficulty) threadInfo.difficulty = difficulty;
    }
    armThreadHardCap(threadInfo, thread.id);

    const cfg = economy.VUATIENGVIET[difficulty.toUpperCase()];
    const session = {
        guildId: thread.guildId,
        threadId: thread.id,
        difficulty,
        invokerId,
        currentWord: null,
        scrambled: null,
        consecutiveMisses: 0,
        timer: null,
        ended: false,
        wordEndAt: null,
        startedAt: Date.now()
    };
    sessions.set(thread.id, session);

    await thread.send(
        `${difficultyEmoji(difficulty)} **Vua Tiếng Việt — ${difficultyLabel(difficulty)}**\n` +
        `Đoán từ bị xáo trộn trong **${cfg.TIME_LIMIT_S}s** mỗi từ.\n` +
        `Mỗi từ đúng: +**${fmt(cfg.NGOC_PER_WORD)}** ${renderEmote('ngoc')} · Cap ngày: **${fmt(cfg.DAILY_CAP)}** ${renderEmote('ngoc')}`
    ).catch(e => log.warn('vuaTiengViet: send intro failed', e));

    await sendNextWord(session, thread);
}

async function startSession({ channel, invokerId, difficulty = 'easy' }) {
    if (channel.type !== ChannelType.GuildText) throw new Error('not_text_channel');
    const thread = await channel.threads.create({
        name: `Vua Tiếng Việt — ${difficultyLabel(difficulty)}`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Vua Tiếng Việt started by ${invokerId}`
    });
    threads.set(thread.id, { hardCapTimer: null, invokerId, difficulty });
    await beginGame(thread, invokerId, difficulty);
    return thread;
}

// ── Thread closing ─────────────────────────────────────────────────────────

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
    }
    sessions.delete(threadId);

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) {
        const msg = reason === 'hard_cap'
            ? '⏰ Thread không hoạt động quá 24 giờ. Đóng thread.'
            : '🔒 Thread đã được đóng.';
        await thread.send(msg).catch(() => {});
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
    }
}

// ── Button handling ────────────────────────────────────────────────────────

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('vtv_')) return false;

    const id       = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'vtv_continue') {
        const threadInfo = threads.get(threadId);
        if (!threadInfo) {
            await interaction.reply({ content: 'Không tìm được phiên này.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        if (sessions.has(threadId)) {
            await interaction.reply({ content: 'Đã có ván đang chơi.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        await interaction.update({ components: [] }).catch(() => {});
        const difficulty = threadInfo.difficulty || 'easy';
        const session = {
            guildId: interaction.guildId,
            threadId,
            difficulty,
            invokerId: threadInfo.invokerId,
            currentWord: null,
            scrambled: null,
            consecutiveMisses: 0,
            timer: null,
            ended: false,
            wordEndAt: null,
            startedAt: Date.now(),
            totalCorrect: 0
        };
        sessions.set(threadId, session);
        armThreadHardCap(threadInfo, threadId);
        await sendNextWord(session, interaction.channel);
        return true;
    }

    if (id === 'vtv_close_init') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`vtv_close_ok_${interaction.user.id}`)
                .setLabel('OK')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`vtv_close_cancel_${interaction.user.id}`)
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

    if (id.startsWith('vtv_close_ok_') || id.startsWith('vtv_close_cancel_')) {
        const parts  = id.split('_');
        const action = parts[2];
        const typerId = parts.slice(3).join('_');

        if (interaction.user.id !== typerId) {
            await interaction.reply({ content: 'Chỉ người gọi đóng thread mới có thể xác nhận.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        if (action === 'cancel') {
            await interaction.update({ content: '❎ Đã hủy đóng thread.', components: [] }).catch(() => {});
            return true;
        }
        await interaction.update({ content: '✅ Đang đóng thread...', components: [] }).catch(() => {});
        await closeThread(threadId, { reason: 'manual' });
        return true;
    }

    return false;
}

// ── Message handling ───────────────────────────────────────────────────────

async function handleThreadMessage(msg) {
    const threadInfo = threads.get(msg.channel.id);
    if (!threadInfo) return;
    if (msg.author.bot) return;

    armThreadHardCap(threadInfo, msg.channel.id);

    const session = sessions.get(msg.channel.id);
    if (!session || session.ended) return;

    const answer = normalizeAnswer(msg.content);
    if (!answer) return;

    // Early exit
    if (answer === 'end') {
        if (session.timer) { clearTimeout(session.timer); session.timer = null; }
        session.ended = true;
        await msg.react('🏳️').catch(() => {});
        await msg.channel.send(`🏁 <@${msg.author.id}> đã kết thúc trò chơi.`).catch(() => {});
        await showContinuePrompt(msg.channel);
        return;
    }

    if (answer !== session.currentWord) return;

    // Correct answer
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    session.consecutiveMisses = 0;

    const cfg    = economy.VUATIENGVIET[session.difficulty.toUpperCase()];
    const earned = earnNgoc(session.guildId, msg.author.id, session.difficulty, cfg.NGOC_PER_WORD);

    await msg.react('✅').catch(() => {});
    const rewardText = earned > 0
        ? `+${fmt(earned)} ${renderEmote('ngoc')}`
        : `+0 ${renderEmote('ngoc')} (đã đạt cap ngày)`;
    await msg.reply(`✅ **Đúng rồi!** ${rewardText}`).catch(() => {});

    await sendNextWord(session, msg.channel);
}

module.exports = {
    hasThread,
    startSession,
    handleThreadMessage,
    handleButtonInteraction,
    getLifetimeTop,
    getWeeklyTop,
    getWeeklyRewardTable,
    getCapStatus,
    resetDailyCaps,
    scheduleWeeklyPayout,
    runWeeklyPayout,
    isOptedOut,
    toggleOptOut
};
