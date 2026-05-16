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
const dict = require('../../word_dict/vietnamese_wordchain.json');

const dictKeys = Object.keys(dict).filter(k => Array.isArray(dict[k]) && dict[k].length > 0);
const popularKeys = dictKeys.filter(k => dict[k].length >= 10);

const HARD_CAP_MS = 2 * 24 * 60 * 60 * 1000;
const SURRENDER_COOLDOWN_MS = 10 * 1000;

function getScore(guildId, userId) {
    return (data.wordchainScores && data.wordchainScores[guildId] && data.wordchainScores[guildId][userId]) || 0;
}

function incrementScore(guildId, userId) {
    data.wordchainScores = data.wordchainScores || {};
    data.wordchainScores[guildId] = data.wordchainScores[guildId] || {};
    data.wordchainScores[guildId][userId] = (data.wordchainScores[guildId][userId] || 0) + 1;
    saveData();
    return data.wordchainScores[guildId][userId];
}

function getTopScores(guildId, limit = 10) {
    const scores = data.wordchainScores && data.wordchainScores[guildId];
    if (!scores) return [];
    return Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
}

const sessions = new Map();
const threads = new Map();

function hasThread(threadId) {
    return threads.has(threadId);
}

function normalize(text) {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitWord(word) {
    return word.split(' ');
}

function isInDict(word) {
    const tokens = splitWord(word);
    if (tokens.length !== 2) return false;
    const bucket = dict[tokens[0]];
    return Array.isArray(bucket) && bucket.includes(word);
}

function hasUnusedContinuation(syllable, usedWords) {
    const bucket = dict[syllable];
    if (!Array.isArray(bucket)) return false;
    for (const w of bucket) {
        if (!usedWords.has(w)) return true;
    }
    return false;
}

function countUnusedContinuations(word, usedWords) {
    const second = splitWord(word)[1];
    const bucket = dict[second];
    if (!Array.isArray(bucket)) return 0;
    let count = 0;
    for (const next of bucket) {
        if (next === word) continue;
        if (!usedWords.has(next)) count++;
    }
    return count;
}

function isWinningMove(word, usedWords) {
    return countUnusedContinuations(word, usedWords) === 0;
}

function isEasyChain(word, usedWords) {
    return countUnusedContinuations(word, usedWords) > 5;
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickFromBucket(bucket, usedWords, turn) {
    if (!Array.isArray(bucket) || bucket.length === 0) return null;
    const candidates = bucket.filter(w => !usedWords.has(w));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const winning = [];
    const nonWinning = [];
    for (const w of candidates) {
        if (isWinningMove(w, usedWords)) winning.push(w);
        else nonWinning.push(w);
    }
    if (nonWinning.length === 0) return randomFrom(winning);

    const fullPoolRate = Math.min(turn * 0.001, 1.0);
    if (Math.random() < fullPoolRate) return randomFrom(candidates);

    const easy = nonWinning.filter(w => isEasyChain(w, usedWords));
    if (easy.length > 0 && Math.random() < 0.95) return randomFrom(easy);
    return randomFrom(nonWinning);
}

function pickBotWord(syllable, usedWords, turn) {
    return pickFromBucket(dict[syllable], usedWords, turn);
}

function pickRandomOpener(usedWords) {
    const pool = popularKeys.length > 0 ? popularKeys : dictKeys;
    for (let i = 0; i < 500; i++) {
        const key = randomFrom(pool);
        const bucket = dict[key];
        if (!Array.isArray(bucket) || bucket.length === 0) continue;
        const word = randomFrom(bucket);
        if (usedWords.has(word)) continue;
        if (countUnusedContinuations(word, usedWords) > 10) return word;
    }
    return null;
}

function validateWord(word, lastSyllable, usedWords) {
    const tokens = splitWord(word);
    if (tokens.length !== 2) return 'shape';
    if (!isInDict(word)) return 'not_in_dict';
    if (lastSyllable !== null && tokens[0] !== lastSyllable) return 'wrong_chain';
    if (usedWords.has(word)) return 'used';
    return 'valid';
}

function armTimer(session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.timeoutMs > 0) {
        session.timer = setTimeout(() => onTimeout(session.threadId), session.timeoutMs);
    }
}

function armThreadHardCap(threadInfo, threadId) {
    if (threadInfo.hardCapTimer) clearTimeout(threadInfo.hardCapTimer);
    threadInfo.hardCapTimer = setTimeout(() => closeThread(threadId, { reason: 'hard_cap' }), HARD_CAP_MS);
}

async function onTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    const winnerId = session.lastPlayerId;
    await endSession(threadId, { winnerId: winnerId || null, reason: 'timeout' });
}

async function endSession(threadId, { winnerId, reason }) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.ended = true;
    if (session.timer) clearTimeout(session.timer);

    const thread = await client.channels.fetch(threadId).catch(() => null);

    if (thread) {
        let message;
        if (winnerId === null) {
            message = '⏰ Hết giờ. Trò chơi kết thúc, không có người thắng.';
        } else if (winnerId === 'bot') {
            const botReason = reason === 'timeout' ? 'người chơi quá thời gian'
                : reason === 'surrender' ? 'người chơi đầu hàng'
                : 'không còn từ để nối';
            message = `🎉 Bot thắng! Lý do: ${botReason}.`;
        } else {
            const reasonText = reason === 'timeout' ? 'đối thủ quá thời gian'
                : reason === 'surrender' ? 'đối thủ đầu hàng'
                : 'không còn từ để nối';
            const newScore = incrementScore(session.guildId, winnerId);
            message = `🎉 Chúc mừng <@${winnerId}> đã thắng! Lý do: ${reasonText}. (Tổng điểm: **${newScore}**)`;
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('wc_start_new')
                .setLabel('Ván mới')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('wc_close_init')
                .setLabel('Đóng thread')
                .setStyle(ButtonStyle.Secondary)
        );
        await thread.send({ content: message, components: [row] })
            .catch(e => log.warn('wordchain: send end message failed', e));
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
        await thread.send(closingMsg).catch(e => log.warn('wordchain: send close message failed', e));
        await thread.setLocked(true).catch(e => log.warn('wordchain: lock thread failed', e));
        await thread.setArchived(true).catch(e => log.warn('wordchain: archive thread failed', e));
    }
}

function getHelpText(threadInfo) {
    const timerLine = threadInfo.timeoutMinutes > 0
        ? `• Thời gian chờ: ${threadInfo.timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).`
        : `• Không giới hạn thời gian — chỉ kết thúc khi dead-end hoặc đầu hàng.`;
    return (
        `**Trò chơi Nối Từ — chế độ ${threadInfo.mode}**\n` +
        `• Mỗi từ phải có đúng 2 âm tiết và có trong từ điển.\n` +
        `• Âm tiết đầu của từ tiếp theo phải khớp với âm tiết cuối của từ trước.\n` +
        `• Mỗi từ chỉ được dùng 1 lần trong ván.\n` +
        `• ✅ hợp lệ — ❌ không có trong từ điển / sai luật nối — ⛔ đã dùng rồi.\n` +
        `• Đầu hàng: gõ \`surrender\`, \`sur\`, \`end\` hoặc \`THUA\` (sau ≥ 10s kể từ từ hợp lệ gần nhất).\n` +
        `• Sau khi ván kết thúc, bấm nút **Ván mới** để chơi tiếp hoặc **Đóng thread** để đóng.\n` +
        timerLine +
        (threadInfo.mode === 'PVP' ? `\n• PVP: không được chơi 2 lượt liên tiếp.` : '')
    );
}

async function beginGame(thread, mode, timeoutMinutes) {
    if (sessions.has(thread.id)) return;

    let threadInfo = threads.get(thread.id);
    if (!threadInfo) {
        threadInfo = { mode, timeoutMinutes, hardCapTimer: null };
        threads.set(thread.id, threadInfo);
    } else {
        threadInfo.mode = mode;
        threadInfo.timeoutMinutes = timeoutMinutes;
    }
    armThreadHardCap(threadInfo, thread.id);

    const usedWords = new Set();
    const session = {
        mode,
        guildId: thread.guildId,
        threadId: thread.id,
        timeoutMs: timeoutMinutes * 60 * 1000,
        timeoutMinutes,
        lastWord: null,
        lastSyllable: null,
        lastPlayerId: null,
        lastValidAt: null,
        usedWords,
        timer: null,
        ended: false
    };
    sessions.set(thread.id, session);

    const timerLine = timeoutMinutes > 0
        ? `• Thời gian chờ: ${timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).`
        : `• Không giới hạn thời gian — chỉ kết thúc khi dead-end hoặc đầu hàng.`;
    const startMessage = `**Ván mới — chế độ ${mode}**\n` + timerLine + (mode === 'PVP' ? `\n• PVP: không được chơi 2 lượt liên tiếp.` : '');
    await thread.send(startMessage);

    if (mode === 'BOT') {
        const opener = pickRandomOpener(usedWords);
        if (!opener) {
            await thread.send('Không tìm được từ mở đầu. Gõ `start` để thử lại.');
            sessions.delete(thread.id);
            return;
        }
        usedWords.add(opener);
        const [, second] = splitWord(opener);
        session.lastWord = opener;
        session.lastSyllable = second;
        session.lastPlayerId = 'bot';
        session.lastValidAt = Date.now();
        await thread.send(`**${opener}**`);
    }

    armTimer(session);
}

async function startSession({ channel, invokerId, mode, timeoutMinutes }) {
    if (channel.type !== ChannelType.GuildText) {
        throw new Error('not_text_channel');
    }
    const thread = await channel.threads.create({
        name: `Nối từ — ${mode}`,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: `Wordchain ${mode} started by ${invokerId}`
    });
    await beginGame(thread, mode, timeoutMinutes);
    return thread;
}

async function showCloseConfirmation(msg) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`wc_close_ok_${msg.author.id}`)
            .setLabel('OK')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`wc_close_cancel_${msg.author.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
    await msg.reply({
        content: `<@${msg.author.id}> xác nhận đóng thread?`,
        components: [row]
    }).catch(e => log.warn('wordchain: send close confirmation failed', e));
}

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;
    if (!interaction.customId.startsWith('wc_')) return false;

    const id = interaction.customId;
    const threadId = interaction.channel.id;

    if (id === 'wc_start_new') {
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
        await beginGame(interaction.channel, threadInfo.mode, threadInfo.timeoutMinutes);
        return true;
    }

    if (id === 'wc_close_init') {
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
                .setCustomId(`wc_close_ok_${interaction.user.id}`)
                .setLabel('OK')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`wc_close_cancel_${interaction.user.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
            content: `<@${interaction.user.id}> xác nhận đóng thread?`,
            components: [row]
        }).catch(() => {});
        return true;
    }

    if (id.startsWith('wc_close_ok_') || id.startsWith('wc_close_cancel_')) {
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
        await msg.reply(getHelpText(threadInfo)).catch(() => {});
        return;
    }

    if (word === 'close') {
        await showCloseConfirmation(msg);
        return;
    }

    const session = sessions.get(msg.channel.id);

    if (!session || session.ended) {
        if (word === 'start') {
            await beginGame(msg.channel, threadInfo.mode, threadInfo.timeoutMinutes);
        }
        return;
    }

    const raw = msg.content.trim();
    const isSurrender = word === 'surrender' || word === 'sur' || word === 'end' || raw === 'THUA';
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
        if (session.mode === 'PVP' && session.lastPlayerId === msg.author.id) {
            await msg.reply('Bạn vừa chơi từ hợp lệ, không thể tự đầu hàng.').catch(() => {});
            return;
        }
        const winnerId = session.mode === 'BOT' ? 'bot' : session.lastPlayerId;
        await msg.react('🏳️').catch(() => {});
        await endSession(session.threadId, { winnerId, reason: 'surrender' });
        return;
    }

    let action;
    if (session.mode === 'PVP' && session.lastPlayerId === msg.author.id) {
        action = 'wrong_turn';
    } else {
        action = validateWord(word, session.lastSyllable, session.usedWords);
    }

    let second = null;
    if (action === 'valid') {
        session.usedWords.add(word);
        [, second] = splitWord(word);
        session.lastWord = word;
        session.lastSyllable = second;
        session.lastPlayerId = msg.author.id;
        session.lastValidAt = Date.now();
        armTimer(session);
    }

    if (action === 'wrong_turn') {
        await msg.react('❌').catch(() => {});
        await msg.reply('Không phải lượt của bạn (PVP không cho chơi 2 lượt liên tiếp).').catch(() => {});
        return;
    }
    if (action === 'shape' || action === 'not_in_dict' || action === 'wrong_chain') {
        await msg.react('❌').catch(() => {});
        return;
    }
    if (action === 'used') {
        await msg.react('⛔').catch(() => {});
        return;
    }

    await msg.react('✅').catch(() => {});

    if (!hasUnusedContinuation(second, session.usedWords)) {
        await endSession(session.threadId, { winnerId: msg.author.id, reason: 'dead_end' });
        return;
    }

    if (session.mode === 'BOT') {
        const turn = session.usedWords.size + 1;
        const botWord = pickBotWord(second, session.usedWords, turn);
        if (!botWord) {
            await endSession(session.threadId, { winnerId: msg.author.id, reason: 'dead_end' });
            return;
        }
        session.usedWords.add(botWord);
        const [, botSecond] = splitWord(botWord);
        session.lastWord = botWord;
        session.lastSyllable = botSecond;
        session.lastPlayerId = 'bot';
        session.lastValidAt = Date.now();
        armTimer(session);
        await msg.channel.send(`**${botWord}**`);

        if (!hasUnusedContinuation(botSecond, session.usedWords)) {
            await endSession(session.threadId, { winnerId: 'bot', reason: 'dead_end' });
        }
    }
}

module.exports = { hasThread, startSession, handleThreadMessage, handleButtonInteraction, getTopScores };
