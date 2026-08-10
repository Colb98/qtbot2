// AI chat gateway — the ONLY bridge between Discord and the qtbot-ai process.
// All authorization, trigger detection and rate limiting happens here, before
// anything reaches the LLM service. The LLM side gets text in, text out.
const log = require('../../logger');

const ENABLED = process.env.AI_ENABLED === 'true';
const SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:3001';
const CHANNEL_IDS = new Set((process.env.AI_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const ALLOWED_ROLE_IDS = (process.env.AI_ALLOWED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_REQUEST_TIMEOUT_MS, 10) || 60000;
const USER_COOLDOWN_MS = parseInt(process.env.AI_USER_COOLDOWN_MS, 10) || 5000;
const MAX_CONCURRENT = parseInt(process.env.AI_MAX_CONCURRENT, 10) || 3;

if (ENABLED && !ALLOWED_ROLE_IDS.length) {
    log.warn('[aiChat] AI_ENABLED but AI_ALLOWED_ROLE_IDS is empty — nobody can use AI chat');
}

const lastRequestAt = new Map();   // userId -> ts (request cooldown)
const lastRejectAt = new Map();    // userId -> ts (don't spam rejection replies)
let inFlight = 0;

function isAuthorized(member) {
    if (!member) return false;
    return ALLOWED_ROLE_IDS.some((id) => member.roles.cache.has(id));
}

// Mentioned directly, or replying to one of the bot's messages.
function isAddressingBot(msg) {
    const botId = msg.client.user.id;
    return msg.mentions.users.has(botId) || msg.mentions.repliedUser?.id === botId;
}

function stripBotMention(msg) {
    return msg.content.replace(new RegExp(`<@!?${msg.client.user.id}>`, 'g'), '').trim();
}

function chunkText(text, size = 2000) {
    const chunks = [];
    let rest = text;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size / 2) cut = size; // no good break point: hard split
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

/**
 * Called from messageCreate. Returns true if this message belongs to AI chat
 * (so the caller stops routing), false to let normal handling continue.
 * Never throws; the actual LLM round-trip runs detached from the event handler.
 */
function maybeHandle(msg) {
    if (!ENABLED || !msg.guildId) return false;
    if (msg.content.trim().toLowerCase() === '!ai reset') {
        if (!isAuthorized(msg.member)) return false; // fall through, command chain ignores it
        resetSession(msg).catch((e) => log.error('[aiChat] reset failed:', e));
        return true;
    }
    if (msg.content.startsWith('!')) return false; // bot commands win, even in the AI channel
    const inAiChannel = CHANNEL_IDS.has(msg.channelId);
    const addressed = isAddressingBot(msg);
    if (!inAiChannel && !addressed) return false;

    if (!isAuthorized(msg.member)) {
        // Silent in the AI channel (people may just be chatting); brief reply
        // when the bot is explicitly addressed, at most once a minute per user.
        if (addressed && Date.now() - (lastRejectAt.get(msg.author.id) || 0) > 60000) {
            lastRejectAt.set(msg.author.id, Date.now());
            msg.reply('🔒 Bạn chưa có quyền chat với AI.').catch(() => {});
        }
        return addressed; // claimed only if it was directed at the bot
    }

    const now = Date.now();
    if (now - (lastRequestAt.get(msg.author.id) || 0) < USER_COOLDOWN_MS || inFlight >= MAX_CONCURRENT) {
        msg.react('⏳').catch(() => {});
        return true;
    }
    lastRequestAt.set(msg.author.id, now);

    processMessage(msg).catch((e) => log.error('[aiChat] unexpected failure:', e));
    return true;
}

async function processMessage(msg) {
    const content = stripBotMention(msg);
    if (!content) return;

    inFlight++;
    // Typing lasts ~10s per call; refresh while the LLM works.
    msg.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    try {
        const res = await fetch(`${SERVICE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                guildId: msg.guildId,
                channelId: msg.channelId,
                userId: msg.author.id,
                displayName: msg.member?.displayName || msg.author.username,
                content,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 429) { msg.react('⏳').catch(() => {}); return; } // session busy
        if (!res.ok) throw new Error(`ai-service HTTP ${res.status}`);
        const { text, searchQueries } = await res.json();
        const note = searchQueries?.length
            ? `-# 🔎 tìm web: ${searchQueries.map((q) => `"${q}"`).join(' · ')}\n` : '';
        const chunks = chunkText(note + text);
        await msg.reply({ content: chunks.shift(), allowedMentions: { repliedUser: false } });
        for (const c of chunks) await msg.channel.send(c);
    } catch (e) {
        log.error(`[aiChat] request failed user=${msg.author.id}:`, e.message);
        msg.reply('🧠 AI đang tạm nghỉ, thử lại sau chút nhé.').catch(() => {});
    } finally {
        clearInterval(typing);
        inFlight--;
    }
}

async function resetSession(msg) {
    try {
        const res = await fetch(`${SERVICE_URL}/session`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId: msg.guildId, channelId: msg.channelId }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`ai-service HTTP ${res.status}`);
        await msg.reply('🧹 Bot đã quên đoạn chat trong kênh này.');
    } catch (e) {
        log.error('[aiChat] session reset failed:', e.message);
        msg.reply('🧠 AI đang tạm nghỉ, thử lại sau chút nhé.').catch(() => {});
    }
}

module.exports = { maybeHandle };
