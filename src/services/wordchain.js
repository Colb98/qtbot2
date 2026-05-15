const { ChannelType } = require('discord.js');
const log = require('../../logger');
const client = require('../client');
const dict = require('../../word_dict/vietnamese_wordchain.json');

const dictKeys = Object.keys(dict).filter(k => Array.isArray(dict[k]) && dict[k].length > 0);

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
    const second = splitWord(word)[1];
    const bucket = dict[second];
    if (!Array.isArray(bucket)) return true;
    for (const next of bucket) {
        if (next !== word && !usedWords.has(next)) return false;
    }
    return true;
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
    return randomFrom(nonWinning);
}

function pickBotWord(syllable, usedWords, turn) {
    return pickFromBucket(dict[syllable], usedWords, turn);
}

function pickRandomOpener(usedWords, turn) {
    for (let i = 0; i < 50; i++) {
        const key = randomFrom(dictKeys);
        const word = pickFromBucket(dict[key], usedWords, turn);
        if (word) return word;
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
    session.timer = setTimeout(() => onTimeout(session.threadId), session.timeoutMs);
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
            message = `🎉 Bot thắng! Lý do: ${reason === 'timeout' ? 'người chơi quá thời gian' : 'không còn từ để nối'}.`;
        } else {
            const reasonText = reason === 'timeout' ? 'đối thủ quá thời gian' : 'không còn từ để nối';
            message = `🎉 Chúc mừng <@${winnerId}> đã thắng! Lý do: ${reasonText}.`;
        }
        await thread.send(message).catch(e => log.warn('wordchain: send end message failed', e));
        await thread.setLocked(true).catch(e => log.warn('wordchain: lock thread failed', e));
        await thread.setArchived(true).catch(e => log.warn('wordchain: archive thread failed', e));
    }

    sessions.delete(threadId);
}

function getHelpText(session) {
    return (
        `**Trò chơi Nối Từ — chế độ ${session.mode}**\n` +
        `• Mỗi từ phải có đúng 2 âm tiết và có trong từ điển.\n` +
        `• Âm tiết đầu của từ tiếp theo phải khớp với âm tiết cuối của từ trước.\n` +
        `• Mỗi từ chỉ được dùng 1 lần trong ván.\n` +
        `• ✅ hợp lệ — ❌ không có trong từ điển / sai luật nối — ⛔ đã dùng rồi.\n` +
        `• Thời gian chờ: ${session.timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).` +
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
        usedWords,
        timer: null,
        ended: false
    };
    sessions.set(thread.id, session);

    const startMessage =
        `• Thời gian chờ: ${timeoutMinutes} phút mỗi lượt (chỉ từ hợp lệ mới reset đồng hồ).` +
        (mode === 'PVP' ? `\n• PVP: không được chơi 2 lượt liên tiếp.` : '');
    await thread.send(startMessage);

    if (mode === 'BOT') {
        const opener = pickRandomOpener(usedWords, 1);
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
        armTimer(session);
        await msg.channel.send(`**${botWord}**`);

        if (!hasUnusedContinuation(botSecond, session.usedWords)) {
            await endSession(session.threadId, { winnerId: 'bot', reason: 'dead_end' });
        }
    }
}

module.exports = { hasSession, startSession, handleThreadMessage };
