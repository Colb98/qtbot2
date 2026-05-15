const { ChannelType } = require('discord.js');
const log = require('../../logger');
const client = require('../client');
const dict = require('../../word_dict/vietnamese_wordchain.json');

const dictKeys = Object.keys(dict).filter(k => Array.isArray(dict[k]) && dict[k].length > 0);

const HARD_CAP_MS = 2 * 24 * 60 * 60 * 1000;

const sessions = new Map();

function hasSession(threadId) {
    return sessions.has(threadId);
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

function isWinningMove(word, usedWords) {
    return countUnusedContinuations(word, usedWords) === 0;
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
    for (let i = 0; i < 500; i++) {
        const key = randomFrom(dictKeys);
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

async function onTimeout(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    const winnerId = session.lastPlayerId;
    if (winnerId) {
        await endSession(threadId, { winnerId, reason: 'timeout' });
    } else {
        await endSession(threadId, { winnerId: null, reason: 'timeout' });
    }
}

async function onHardCap(threadId) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    const winnerId = session.lastPlayerId;
    if (winnerId) {
        await endSession(threadId, { winnerId, reason: 'hard_cap' });
    } else {
        await endSession(threadId, { winnerId: null, reason: 'hard_cap' });
    }
}

async function endSession(threadId, { winnerId, reason }) {
    const session = sessions.get(threadId);
    if (!session || session.ended) return;
    session.ended = true;
    if (session.timer) clearTimeout(session.timer);
    if (session.hardCapTimer) clearTimeout(session.hardCapTimer);

    const thread = await client.channels.fetch(threadId).catch(() => null);

    if (thread) {
        let message;
        if (winnerId === null) {
            message = reason === 'hard_cap'
                ? '⏰ Phiên đã kéo dài quá 2 ngày. Trò chơi kết thúc, không có người thắng.'
                : '⏰ Hết giờ. Trò chơi kết thúc, không có người thắng.';
        } else if (winnerId === 'bot') {
            const botReason = reason === 'timeout' ? 'người chơi quá thời gian'
                : reason === 'surrender' ? 'người chơi đầu hàng'
                : reason === 'hard_cap' ? 'phiên kéo dài quá 2 ngày'
                : 'không còn từ để nối';
            message = `🎉 Bot thắng! Lý do: ${botReason}.`;
        } else {
            const reasonText = reason === 'timeout' ? 'đối thủ quá thời gian'
                : reason === 'surrender' ? 'đối thủ đầu hàng'
                : reason === 'hard_cap' ? 'phiên kéo dài quá 2 ngày'
                : 'không còn từ để nối';
            message = `🎉 Chúc mừng <@${winnerId}> đã thắng! Lý do: ${reasonText}.`;
        }
        await thread.send(message).catch(e => log.warn('wordchain: send end message failed', e));
        await thread.setLocked(true).catch(e => log.warn('wordchain: lock thread failed', e));
        await thread.setArchived(true).catch(e => log.warn('wordchain: archive thread failed', e));
    }

    sessions.delete(threadId);
}

function getHelpText(session) {
    const timerLine = session.timeoutMinutes > 0
        ? `• Thời gian chờ: ${session.timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).`
        : `• Không giới hạn thời gian — chỉ kết thúc khi dead-end hoặc đầu hàng.`;
    return (
        `**Trò chơi Nối Từ — chế độ ${session.mode}**\n` +
        `• Mỗi từ phải có đúng 2 âm tiết và có trong từ điển.\n` +
        `• Âm tiết đầu của từ tiếp theo phải khớp với âm tiết cuối của từ trước.\n` +
        `• Mỗi từ chỉ được dùng 1 lần trong ván.\n` +
        `• ✅ hợp lệ — ❌ không có trong từ điển / sai luật nối — ⛔ đã dùng rồi.\n` +
        `• Đầu hàng: gõ \`surrender\`, \`sur\`, \`end\` hoặc \`THUA\` (sau ≥ 30s kể từ từ hợp lệ gần nhất).\n` +
        timerLine +
        (session.mode === 'PVP' ? `\n• PVP: không được chơi 2 lượt liên tiếp.` : '')
    );
}

async function startSession({ channel, invokerId, mode, timeoutMinutes }) {
    if (channel.type !== ChannelType.GuildText) {
        throw new Error('not_text_channel');
    }
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const thread = await channel.threads.create({
        name: `Nối từ — ${mode}`,
        autoArchiveDuration: 60,
        type: ChannelType.PublicThread,
        reason: `Wordchain ${mode} started by ${invokerId}`
    });

    const usedWords = new Set();
    const session = {
        mode,
        guildId: channel.guildId,
        threadId: thread.id,
        timeoutMs,
        timeoutMinutes,
        lastWord: null,
        lastSyllable: null,
        lastPlayerId: null,
        lastValidAt: null,
        usedWords,
        timer: null,
        hardCapTimer: null,
        ended: false
    };
    sessions.set(thread.id, session);
    session.hardCapTimer = setTimeout(() => onHardCap(thread.id), HARD_CAP_MS);

    const timerLine = timeoutMinutes > 0
        ? `• Thời gian chờ: ${timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).`
        : `• Không giới hạn thời gian — chỉ kết thúc khi dead-end hoặc đầu hàng.`;
    const startMessage = timerLine + (mode === 'PVP' ? `\n• PVP: không được chơi 2 lượt liên tiếp.` : '');
    await thread.send(startMessage);

    if (mode === 'BOT') {
        const opener = pickRandomOpener(usedWords);
        if (!opener) {
            await thread.send('Không tìm được từ mở đầu. Trò chơi kết thúc.');
            await endSession(thread.id, { winnerId: null, reason: 'no_opener' });
            return thread;
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
    return thread;
}

async function handleThreadMessage(msg) {
    const session = sessions.get(msg.channel.id);
    if (!session || session.ended) return;
    if (msg.author.bot) return;

    const word = normalize(msg.content);
    if (!word) return;

    if (word === 'help') {
        await msg.reply(getHelpText(session)).catch(() => {});
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
        if (elapsed < 30000) {
            const remaining = Math.ceil((30000 - elapsed) / 1000);
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

module.exports = { hasSession, startSession, handleThreadMessage };
