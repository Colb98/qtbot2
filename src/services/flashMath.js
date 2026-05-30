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
const { genEquation } = require('./mathGen');

const HARD_CAP_MS = 24 * 60 * 60 * 1000;
const TIMER_GRACE_MS = 2000;

const sessions = new Map();   // threadId -> game session
const threads  = new Map();   // threadId -> { invokerId, hardCapTimer }
const _msgLocks = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

// ── State helpers ──────────────────────────────────────────────────────────

function ensureRoot() {
    if (!data.flashMath) data.flashMath = {};
    if (!data.flashMath.scores)    data.flashMath.scores    = {};
    if (!data.flashMath.dailyCaps) data.flashMath.dailyCaps = {};
}

function getDailyCap(guildId, userId) {
    ensureRoot();
    if (!data.flashMath.dailyCaps[guildId]) data.flashMath.dailyCaps[guildId] = {};
    const existing = data.flashMath.dailyCaps[guildId][userId];
    const today = todayStr();
    if (!existing || existing.date !== today) {
        data.flashMath.dailyCaps[guildId][userId] = { date: today, earned: 0 };
    }
    return data.flashMath.dailyCaps[guildId][userId];
}

// Award `amount` ngọc, clamped to the player's remaining daily cap. Returns the
// amount actually granted (0 once the cap is reached).
function earnNgoc(guildId, userId, amount) {
    const cap = getDailyCap(guildId, userId);
    const remaining = economy.FLASHMATH.DAILY_CAP - cap.earned;
    const actual = Math.min(amount, Math.max(0, remaining));
    if (actual > 0) {
        cap.earned += actual;
        addNgoc(guildId, userId, actual);
    }
    saveData();
    return actual;
}

function getCapStatus(guildId, userId) {
    const cap = getDailyCap(guildId, userId);
    return { earned: cap.earned, cap: economy.FLASHMATH.DAILY_CAP };
}

// ── Leaderboard (lifetime correct answers, wordchain-style) ─────────────────

function incrementScore(guildId, userId) {
    ensureRoot();
    if (!data.flashMath.scores[guildId]) data.flashMath.scores[guildId] = {};
    data.flashMath.scores[guildId][userId] = (data.flashMath.scores[guildId][userId] || 0) + 1;
    return data.flashMath.scores[guildId][userId];
}

function getTopScores(guildId, limit = 10) {
    ensureRoot();
    const scores = data.flashMath.scores[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

// ── Difficulty ladder ───────────────────────────────────────────────────────

function ladderRow(level) {
    const ladder = economy.FLASHMATH.LADDER;
    const idx = Math.min(Math.max(level - 1, 0), ladder.length - 1);
    return ladder[idx];
}

function levelFor(correctCount) {
    return Math.floor(correctCount / economy.FLASHMATH.QUESTIONS_PER_LEVEL) + 1;
}

function rewardFor(level) {
    const cfg = economy.FLASHMATH;
    return Math.min(cfg.NGOC_PER_CORRECT_BASE + (level - 1) * cfg.NGOC_PER_LEVEL_STEP, cfg.NGOC_PER_CORRECT_MAX);
}

function makeQuestion(level) {
    const row = ladderRow(level);
    return genEquation({
        nums: row.nums, min: row.min, max: row.max, ops: row.ops,
        multMax: economy.FLASHMATH.MULT_MAX_FACTOR
    });
}

// ── Timer helpers ──────────────────────────────────────────────────────────

function armTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    const row = ladderRow(session.level);
    session.timer = setTimeout(() => onTimeout(session.threadId), row.timeS * 1000 + TIMER_GRACE_MS);
}

function armThreadHardCap(threadInfo, threadId) {
    if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
    threadInfo.hardCapTimer = setTimeout(() => closeThread(threadId, { reason: 'hard_cap' }), HARD_CAP_MS);
}

// ── Core game flow ─────────────────────────────────────────────────────────

async function sendNextQuestion(session, thread) {
    session.level = levelFor(session.correctCount);
    const q = makeQuestion(session.level);
    session.current = q;

    const row = ladderRow(session.level);
    const endUnix = Math.floor((Date.now() + row.timeS * 1000) / 1000);
    const reward = rewardFor(session.level);

    await thread.send(
        `🧮 **Câu ${session.correctCount + 1} · Cấp ${session.level}**\n` +
        `## ${q.text} = ?\n` +
        `⏱️ Trả lời trước <t:${endUnix}:R> · người nhanh nhất +**${fmt(reward)}** ${renderEmote('ngoc')}`
    ).catch(e => log.warn('flashMath: send question failed', e));

    armTimer(session);
}

async function onTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.timer = null;
    session.consecutiveMisses++;

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (!thread) { sessions.delete(threadId); return; }

    const answer = session.current ? session.current.answer : '?';

    if (session.consecutiveMisses >= economy.FLASHMATH.MAX_MISSES) {
        session.ended = true;
        sessions.delete(threadId);
        await thread.send(
            `⏰ **Hết giờ!** Đáp án: **${answer}**\n` +
            `Đã bỏ qua **${session.consecutiveMisses}** câu liên tiếp. Tạm dừng.`
        ).catch(() => {});
        await showContinuePrompt(thread);
    } else {
        await thread.send(
            `⏰ **Hết giờ!** Đáp án: **${answer}** (bỏ qua ${session.consecutiveMisses}/${economy.FLASHMATH.MAX_MISSES})`
        ).catch(() => {});
        await sendNextQuestion(session, thread);
    }
}

async function showContinuePrompt(thread) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fm_continue').setLabel('Tiếp tục').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('fm_close_init').setLabel('Đóng thread').setStyle(ButtonStyle.Secondary)
    );
    await thread.send({
        content: '❓ Tiếp tục chơi? (Gõ `continue` hoặc bấm nút)',
        components: [row]
    }).catch(() => {});
}

function newSession(guildId, threadId, invokerId) {
    return {
        guildId,
        threadId,
        invokerId,
        level: 1,
        correctCount: 0,
        consecutiveMisses: 0,
        current: null,
        timer: null,
        ended: false
    };
}

async function beginGame(thread, invokerId) {
    if (sessions.has(thread.id)) return;

    let threadInfo = threads.get(thread.id);
    if (!threadInfo) {
        threadInfo = { invokerId, hardCapTimer: null };
        threads.set(thread.id, threadInfo);
    } else if (invokerId) {
        threadInfo.invokerId = invokerId;
    }
    armThreadHardCap(threadInfo, thread.id);

    const session = newSession(thread.guildId, thread.id, invokerId);
    sessions.set(thread.id, session);

    const cfg = economy.FLASHMATH;
    await thread.send(
        `⚡ **Flash Math** — trả lời nhanh phép tính! Ai gõ đáp án đúng **trước** sẽ nhận ngọc.\n` +
        `• Độ khó tăng mỗi **${cfg.QUESTIONS_PER_LEVEL}** câu đúng (số lớn dần → tối đa 3 số → rồi rút ngắn thời gian xuống ${ladderRow(99).timeS}s).\n` +
        `• Thưởng tăng theo cấp · Cap ngày: **${fmt(cfg.DAILY_CAP)}** ${renderEmote('ngoc')}/người.\n` +
        `• Gõ \`end\` để dừng, \`close\` để đóng thread.`
    ).catch(e => log.warn('flashMath: send intro failed', e));

    await sendNextQuestion(session, thread);
}

async function startSession({ channel, invokerId }) {
    if (channel.type !== ChannelType.GuildText) throw new Error('not_text_channel');
    const thread = await channel.threads.create({
        name: 'Flash Math',
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Flash Math started by ${invokerId}`
    });
    threads.set(thread.id, { invokerId, hardCapTimer: null });
    await beginGame(thread, invokerId);
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
        const m = reason === 'hard_cap'
            ? '⏰ Thread không hoạt động quá 24 giờ. Đóng thread.'
            : '🔒 Thread đã được đóng.';
        await thread.send(m).catch(() => {});
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
    }
}

// ── Button handling ────────────────────────────────────────────────────────

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('fm_')) return false;

    const id = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'fm_continue') {
        const threadInfo = threads.get(threadId);
        if (!threadInfo) {
            await interaction.reply({ content: 'Không tìm được phiên này.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        const active = sessions.get(threadId);
        if (active && !active.ended) {
            await interaction.reply({ content: 'Đã có ván đang chơi.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        if (active) sessions.delete(threadId);
        await interaction.update({ components: [] }).catch(() => {});
        const session = newSession(interaction.guildId, threadId, threadInfo.invokerId);
        sessions.set(threadId, session);
        armThreadHardCap(threadInfo, threadId);
        await sendNextQuestion(session, interaction.channel);
        return true;
    }

    if (id === 'fm_close_init') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fm_close_ok_${interaction.user.id}`).setLabel('OK').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`fm_close_cancel_${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
            content: `<@${interaction.user.id}> xác nhận đóng thread?`,
            components: [row],
            allowedMentions: { parse: [] }
        }).catch(() => {});
        return true;
    }

    if (id.startsWith('fm_close_ok_') || id.startsWith('fm_close_cancel_')) {
        const parts = id.split('_');
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
    const threadId = msg.channel.id;
    const prev = _msgLocks.get(threadId) || Promise.resolve();
    const current = prev.then(() => _handleThreadMessageImpl(msg))
        .catch(e => log.warn('flashMath: handleThreadMessage error', e));
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

    const raw = msg.content.trim();
    if (!raw) return;
    const lower = raw.toLowerCase();

    // Resume a paused game via text.
    if ((lower === 'start' || lower === 'continue') && !sessions.has(msg.channel.id)) {
        const session = newSession(msg.guildId, msg.channel.id, threadInfo.invokerId);
        sessions.set(msg.channel.id, session);
        await sendNextQuestion(session, msg.channel);
        return;
    }

    if (lower === 'close') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fm_close_ok_${msg.author.id}`).setLabel('OK').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`fm_close_cancel_${msg.author.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        await msg.reply({ content: `<@${msg.author.id}> xác nhận đóng thread?`, components: [row], allowedMentions: { parse: [] } }).catch(() => {});
        return;
    }

    const session = sessions.get(msg.channel.id);
    if (!session || session.ended) return;

    if (lower === 'end') {
        if (session.timer) { clearTimeout(session.timer); session.timer = null; }
        session.ended = true;
        sessions.delete(msg.channel.id);
        await msg.react('🏳️').catch(() => {});
        await msg.channel.send(`🏁 <@${msg.author.id}> đã dừng trò chơi.`).catch(() => {});
        await showContinuePrompt(msg.channel);
        return;
    }

    // Only react to numeric answers (so people can still chat in the thread).
    if (!/^-?\d+$/.test(raw)) return;
    if (!session.current) return;
    if (parseInt(raw, 10) !== session.current.answer) return;

    // Correct — first to answer wins this question.
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    session.consecutiveMisses = 0;
    session.correctCount++;
    incrementScore(session.guildId, msg.author.id);
    const reward = rewardFor(session.level);
    const earned = earnNgoc(session.guildId, msg.author.id, reward);

    await msg.react('✅').catch(() => {});
    const rewardText = earned > 0
        ? `+${fmt(earned)} ${renderEmote('ngoc')}`
        : `+0 ${renderEmote('ngoc')} (đã đạt cap ngày)`;
    await msg.reply(`✅ **Đúng!** ${rewardText}`).catch(() => {});

    await sendNextQuestion(session, msg.channel);
}

module.exports = {
    hasThread,
    startSession,
    handleThreadMessage,
    handleButtonInteraction,
    getTopScores,
    getCapStatus
};
