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
const { addNgoc, renderEmote, fmt } = require('./currency');
const economy = require('../config/economy');

const DICT_PATH = path.join(__dirname, '..', '..', 'word_dict', 'english_worddict.txt');
const rawDict = fs.readFileSync(DICT_PATH, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim().toLowerCase())
    .filter(w => /^[a-z]+$/.test(w) && w.length >= 2);
const wordSet = new Set(rawDict);
const byFirstLetter = {};
for (const w of rawDict) {
    const k = w[0];
    if (!byFirstLetter[k]) byFirstLetter[k] = [];
    byFirstLetter[k].push(w);
}
log.info(`wordchainEng: dictionary loaded — ${wordSet.size} words`);

const HARD_CAP_MS = 2 * 24 * 60 * 60 * 1000;
const SURRENDER_COOLDOWN_MS = 10 * 1000;

const sessions = new Map();
const threads = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

function ensureRoot() {
    if (!data.wordchainEng) {
        data.wordchainEng = { lifetime: {}, weekly: {}, wordCounts: {} };
    }
    if (!data.wordchainEng.lifetime) data.wordchainEng.lifetime = {};
    if (!data.wordchainEng.weekly) data.wordchainEng.weekly = {};
    if (!data.wordchainEng.wordCounts) data.wordchainEng.wordCounts = {};
}

function weekStr() {
    const shifted = new Date(Date.now() + 7 * 3600 * 1000);
    const d = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function timeoutSecondsFor(playerCount) {
    for (const tier of economy.WORDCHAIN_ENG.TIMER_LADDER) {
        if (playerCount < tier.upTo) return tier.seconds;
    }
    const ladder = economy.WORDCHAIN_ENG.TIMER_LADDER;
    return ladder[ladder.length - 1].seconds;
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickBotWord(firstLetter, usedWords) {
    const bucket = byFirstLetter[firstLetter];
    if (!Array.isArray(bucket) || bucket.length === 0) return null;
    const pool = bucket.filter(w => !usedWords.has(w));
    if (pool.length === 0) return null;
    const rareSet = new Set(economy.WORDCHAIN_ENG.RARE_END_LETTERS);
    const easy = [];
    const rare = [];
    for (const w of pool) {
        if (rareSet.has(w[w.length - 1])) rare.push(w);
        else easy.push(w);
    }
    if (easy.length === 0) return randomFrom(rare);
    if (rare.length === 0) return randomFrom(easy);
    if (Math.random() < economy.WORDCHAIN_ENG.RARE_END_RATE) return randomFrom(rare);
    return randomFrom(easy);
}

function validateWord(word, requiredFirstLetter, usedWords) {
    if (!/^[a-z]+$/.test(word) || word.length < 2) return 'shape';
    if (!wordSet.has(word)) return 'not_in_dict';
    if (requiredFirstLetter && word[0] !== requiredFirstLetter) return 'wrong_chain';
    if (usedWords.has(word)) return 'used';
    return 'valid';
}

function normalize(text) {
    return text.trim().toLowerCase();
}

function computeReward(guildId, userId, finalCount) {
    const cfg = economy.WORDCHAIN_ENG;
    ensureRoot();
    const arr = (data.wordchainEng.wordCounts[guildId] && data.wordchainEng.wordCounts[guildId][userId]) || [];
    let total = 0;
    for (let i = 1; i <= finalCount; i++) {
        const prev = arr[i - 1] || 0;
        if (prev < cfg.REWARD_CAP_PER_POSITION) {
            total += (i <= cfg.WORD_THRESHOLD) ? cfg.NGOC_PER_WORD : cfg.NGOC_PER_WORD_AFTER;
        }
    }
    return total;
}

function commitWordCounts(guildId, userId, finalCount) {
    ensureRoot();
    if (!data.wordchainEng.wordCounts[guildId]) data.wordchainEng.wordCounts[guildId] = {};
    const root = data.wordchainEng.wordCounts[guildId];
    if (!root[userId]) root[userId] = [];
    const arr = root[userId];
    for (let i = 1; i <= finalCount; i++) {
        arr[i - 1] = (arr[i - 1] || 0) + 1;
    }
}

function updateLifetime(guildId, userId, value) {
    ensureRoot();
    if (!data.wordchainEng.lifetime[guildId]) data.wordchainEng.lifetime[guildId] = {};
    const cur = data.wordchainEng.lifetime[guildId][userId] || 0;
    if (value > cur) data.wordchainEng.lifetime[guildId][userId] = value;
    return data.wordchainEng.lifetime[guildId][userId];
}

function updateWeekly(guildId, userId, value) {
    ensureRoot();
    if (!data.wordchainEng.weekly[guildId]) data.wordchainEng.weekly[guildId] = {};
    const week = weekStr();
    const entry = data.wordchainEng.weekly[guildId][userId];
    if (!entry || entry.week !== week) {
        data.wordchainEng.weekly[guildId][userId] = { week, best: value };
    } else if (value > entry.best) {
        entry.best = value;
    }
    return data.wordchainEng.weekly[guildId][userId].best;
}

function getLifetimeTop(guildId, limit = 10) {
    ensureRoot();
    const scores = data.wordchainEng.lifetime[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

function getWeeklyTop(guildId, limit = 10) {
    ensureRoot();
    const scores = data.wordchainEng.weekly[guildId];
    if (!scores) return [];
    const week = weekStr();
    return Object.entries(scores)
        .filter(([, e]) => e && e.week === week && e.best > 0)
        .map(([uid, e]) => [uid, e.best])
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

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

function getHelpText() {
    return (
        `**English Wordchain — luật chơi**\n` +
        `• Gõ một từ tiếng Anh để bắt đầu lượt đầu. Bot sẽ trả lời, bạn nối tiếp.\n` +
        `• Từ tiếp theo phải bắt đầu bằng **chữ cái cuối** của từ trước.\n` +
        `• Mỗi từ chỉ được dùng 1 lần / ván.\n` +
        `• ✅ hợp lệ — ❌ không có / sai luật nối — ⛔ đã dùng.\n` +
        `• Đầu hàng: gõ \`end\`, \`surrender\` hoặc \`sur\` (sau ≥ 10s).\n` +
        `• Thời gian rút dần khi bạn tiến xa: 1-10 = 60s, 11-20 = 45s, 21-30 = 30s, 31-40 = 15s, 41-50 = 10s, 51+ = 5s.\n` +
        `• Hết ván nhận Ngọc theo số từ nối được (mỗi vị trí từ chỉ thưởng tối đa 10 lần).`
    );
}

async function beginGame(thread) {
    if (sessions.has(thread.id)) return;

    let threadInfo = threads.get(thread.id);
    if (!threadInfo) {
        threadInfo = { hardCapTimer: null };
        threads.set(thread.id, threadInfo);
    }
    armThreadHardCap(threadInfo, thread.id);

    const session = {
        guildId: thread.guildId,
        threadId: thread.id,
        usedWords: new Set(),
        requiredFirstLetter: null,
        playerId: null,
        playerCount: 0,
        lastValidAt: null,
        nextTimeoutMs: 0,
        timer: null,
        ended: false
    };
    sessions.set(thread.id, session);

    const intro =
        `**Ván mới — English Wordchain**\n` +
        `Gõ một từ tiếng Anh bất kỳ để bắt đầu (≥ 2 chữ cái, chỉ a-z).\n` +
        `Sau lượt đầu, bạn sẽ có 60s mỗi lượt; thời gian rút dần khi tiến xa.\n` +
        `Gõ \`help\` để xem luật, \`end\` để đầu hàng, \`close\` để đóng thread.`;
    await thread.send(intro).catch(e => log.warn('wordchainEng: send intro failed', e));
}

async function endSession(threadId, { reason }) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.ended = true;
    if (session.timer) clearTimeout(session.timer);

    const thread = await client.channels.fetch(threadId).catch(() => null);

    let lines = [];
    let reward = 0;
    let lifetimeBest = 0;
    let weeklyBest = 0;

    if (session.playerId && session.playerCount > 0) {
        reward = computeReward(session.guildId, session.playerId, session.playerCount);
        if (reward > 0) addNgoc(session.guildId, session.playerId, reward);
        commitWordCounts(session.guildId, session.playerId, session.playerCount);
        lifetimeBest = updateLifetime(session.guildId, session.playerId, session.playerCount);
        weeklyBest = updateWeekly(session.guildId, session.playerId, session.playerCount);
        saveData();
    }

    const reasonText =
        reason === 'timeout' ? 'hết giờ'
        : reason === 'dead_end' ? 'bot không còn từ để nối'
        : reason === 'surrender' ? 'đầu hàng'
        : 'kết thúc';

    if (thread) {
        if (!session.playerId || session.playerCount === 0) {
            lines.push(`🏁 Game over — ${reasonText}.`);
            lines.push('Bạn chưa nối được từ nào.');
        } else {
            lines.push(`🏁 Game over — ${reasonText}.`);
            lines.push(`<@${session.playerId}> nối được **${session.playerCount}** từ.`);
            if (reward > 0) lines.push(`Nhận **${fmt(reward)}** ${renderEmote('ngoc')}.`);
            else lines.push(`Không có Ngọc lần này (đã đạt giới hạn ${economy.WORDCHAIN_ENG.REWARD_CAP_PER_POSITION} lần ở mọi vị trí đạt được).`);
            lines.push(`Lifetime best: **${lifetimeBest}** · Tuần này: **${weeklyBest}**`);
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('wce_start_new')
                .setLabel('Ván mới')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('wce_close_init')
                .setLabel('Đóng thread')
                .setStyle(ButtonStyle.Secondary)
        );
        await thread.send({
            content: lines.join('\n'),
            components: [row],
            allowedMentions: { parse: [] }
        }).catch(e => log.warn('wordchainEng: send end message failed', e));
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
        await thread.send(closingMsg).catch(e => log.warn('wordchainEng: send close message failed', e));
        await thread.setLocked(true).catch(e => log.warn('wordchainEng: lock thread failed', e));
        await thread.setArchived(true).catch(e => log.warn('wordchainEng: archive thread failed', e));
    }
}

async function startSession({ channel, invokerId }) {
    if (channel.type !== ChannelType.GuildText) {
        throw new Error('not_text_channel');
    }
    const thread = await channel.threads.create({
        name: `English Wordchain`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `English Wordchain started by ${invokerId}`
    });
    await beginGame(thread);
    return thread;
}

async function showCloseConfirmation(msg) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`wce_close_ok_${msg.author.id}`)
            .setLabel('OK')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`wce_close_cancel_${msg.author.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
    await msg.reply({
        content: `<@${msg.author.id}> xác nhận đóng thread?`,
        components: [row],
        allowedMentions: { parse: [] }
    }).catch(e => log.warn('wordchainEng: send close confirmation failed', e));
}

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('wce_')) return false;

    const id = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'wce_start_new') {
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
        await interaction.update({ components: [] }).catch(() => {});
        await beginGame(interaction.channel);
        return true;
    }

    if (id === 'wce_close_init') {
        const threadInfo = threads.get(threadId);
        if (!threadInfo) {
            await interaction.reply({
                content: 'Không tìm được phiên này.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return true;
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`wce_close_ok_${interaction.user.id}`)
                .setLabel('OK')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`wce_close_cancel_${interaction.user.id}`)
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

    if (id.startsWith('wce_close_ok_') || id.startsWith('wce_close_cancel_')) {
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

async function handleThreadMessage(msg) {
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
            await beginGame(msg.channel);
        }
        return;
    }

    const isSurrender = word === 'surrender' || word === 'sur' || word === 'end';
    if (isSurrender) {
        if (!session.lastValidAt) {
            await msg.reply('Chưa có từ hợp lệ nào — chưa thể đầu hàng.').catch(() => {});
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

    if (session.playerId && msg.author.id !== session.playerId) {
        return;
    }

    const action = validateWord(word, session.requiredFirstLetter, session.usedWords);

    if (action === 'shape' || action === 'not_in_dict' || action === 'wrong_chain') {
        await msg.react('❌').catch(() => {});
        return;
    }
    if (action === 'used') {
        await msg.react('⛔').catch(() => {});
        return;
    }

    session.usedWords.add(word);
    session.playerCount += 1;
    session.lastValidAt = Date.now();
    if (!session.playerId) session.playerId = msg.author.id;

    await msg.react('✅').catch(() => {});

    const playerLast = word[word.length - 1];
    const botWord = pickBotWord(playerLast, session.usedWords);
    if (!botWord) {
        await endSession(session.threadId, { reason: 'dead_end' });
        return;
    }
    session.usedWords.add(botWord);
    const botLast = botWord[botWord.length - 1];
    session.requiredFirstLetter = botLast;

    const secs = timeoutSecondsFor(session.playerCount);
    session.nextTimeoutMs = secs * 1000;
    const endUnix = Math.floor(Date.now() / 1000) + secs;
    armTimer(session);

    const replyContent =
        `**${botWord}**\n` +
        `Trả lời <t:${endUnix}:R> · Words: **${session.playerCount}** · Chữ kế: **${botLast.toUpperCase()}**`;
    await msg.channel.send(replyContent).catch(e => log.warn('wordchainEng: send bot reply failed', e));
}

module.exports = {
    hasThread,
    startSession,
    handleThreadMessage,
    handleButtonInteraction,
    getLifetimeTop,
    getWeeklyTop
};
