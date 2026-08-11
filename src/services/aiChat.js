// AI chat gateway — the ONLY bridge between Discord and the qtbot-ai process.
// All authorization, trigger detection and rate limiting happens here, before
// anything reaches the LLM service. The LLM side gets text in, text out.
const log = require('../../logger');
const { data, saveData } = require('../state');
const { isSuperAdmin } = require('../utils');

const ENABLED = process.env.AI_ENABLED === 'true';
const SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:3001';
const CHANNEL_IDS = new Set((process.env.AI_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const ALLOWED_ROLE_IDS = (process.env.AI_ALLOWED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_REQUEST_TIMEOUT_MS, 10) || 60000;
const USER_COOLDOWN_MS = parseInt(process.env.AI_USER_COOLDOWN_MS, 10) || 5000;
const MAX_CONCURRENT = parseInt(process.env.AI_MAX_CONCURRENT, 10) || 3;
// Nearest channel messages sent along as ambient context; 0 disables (the
// `|| 10` idiom would eat an explicit 0, hence the isFinite check).
const CONTEXT_MESSAGES = Number.isFinite(parseInt(process.env.AI_CONTEXT_MESSAGES, 10))
    ? parseInt(process.env.AI_CONTEXT_MESSAGES, 10) : 10;

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
    if (/^!ai(\s|$)/i.test(msg.content.trim())) {
        if (!isAuthorized(msg.member)) return false; // fall through, command chain ignores it
        handleAiCommand(msg).catch((e) => log.error('[aiChat] !ai command failed:', e));
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

// Ambient context: the nearest channel messages BEFORE the trigger, oldest
// first — including other members' and other bots' messages (game results are
// context too), so the AI can read the room. The service dedups anything
// already in its session history and never persists these. Best-effort: a
// fetch failure just means no ambient context.
async function collectRecent(msg) {
    if (CONTEXT_MESSAGES <= 0) return [];
    try {
        const fetched = await msg.channel.messages.fetch({ limit: Math.min(CONTEXT_MESSAGES, 25), before: msg.id });
        return [...fetched.values()]
            .reverse() // Discord returns newest first
            .map((m) => ({
                name: m.member?.displayName || m.author.displayName || m.author.username,
                // cleanContent resolves mentions to names; drop our own "-# 🔎" note lines.
                content: m.cleanContent.replace(/^-# .*$/gm, '').trim().slice(0, 300),
            }))
            .filter((r) => r.content);
    } catch (e) {
        log.warn('[aiChat] could not fetch channel context:', e.message);
        return [];
    }
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
                recent: await collectRecent(msg),
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

async function serviceCall(method, path, body) {
    const opts = { method, signal: AbortSignal.timeout(5000) };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(`${SERVICE_URL}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `ai-service HTTP ${res.status}`);
    return data;
}

// Editing AI rules is superadmin-approved: the superadmin grants/revokes
// per-user permission with `!ai allow/deny @user`; grants persist in data.json
// (bot-side — authorization never lives in the AI service).
function ruleEditors(guildId) {
    if (!data.aiRuleEditors) data.aiRuleEditors = {};
    if (!data.aiRuleEditors[guildId]) data.aiRuleEditors[guildId] = [];
    return data.aiRuleEditors[guildId];
}

function canEditRules(guildId, userId) {
    return isSuperAdmin(userId) || ruleEditors(guildId).includes(userId);
}

function parseUserId(arg) {
    const m = arg.match(/^<@!?(\d{5,25})>$|^(\d{5,25})$/);
    return m ? (m[1] || m[2]) : null;
}

function renderRules(items) {
    if (!items.length) return 'Chưa có quy tắc nào. Thêm bằng `!ai rule <nội dung>`.';
    return '📏 **Quy tắc bổ sung cho AI:**\n' +
        items.map((r, i) => `\`${i + 1}.\` ${r.text} — *${r.author || '?'}*`).join('\n') +
        '\n-# `!ai rule <nội dung>` thêm · `!ai rule xoa <số>` xoá';
}

// `!ai reset` | `!ai rules` | `!ai rule <text>` | `!ai rule xoa <n>`
async function handleAiCommand(msg) {
    const arg = msg.content.trim().replace(/^!ai\s*/i, '');
    const guildId = msg.guildId;
    try {
        if (/^reset$/i.test(arg)) {
            await serviceCall('DELETE', '/session', { guildId, channelId: msg.channelId });
            return void await msg.reply('🧹 Bot đã quên đoạn chat trong kênh này (quy tắc và trí nhớ dài hạn vẫn giữ).');
        }
        if (/^rules?$/i.test(arg)) {
            const { items } = await serviceCall('GET', `/advice?guildId=${guildId}`);
            return void await msg.reply(renderRules(items));
        }
        const grant = arg.match(/^(allow|deny)\s+(\S+)$/i);
        if (grant) {
            if (!isSuperAdmin(msg.author.id)) return void await msg.reply('🔒 Chỉ Superadmin mới cấp/thu quyền sửa quy tắc.');
            const targetId = parseUserId(grant[2]);
            if (!targetId) return void await msg.reply('Dùng: `!ai allow @user` hoặc `!ai deny @user`.');
            const editors = ruleEditors(guildId);
            const allow = grant[1].toLowerCase() === 'allow';
            if (allow && !editors.includes(targetId)) editors.push(targetId);
            if (!allow) data.aiRuleEditors[guildId] = editors.filter((id) => id !== targetId);
            saveData();
            const list = data.aiRuleEditors[guildId];
            return void await msg.reply((allow ? `✅ <@${targetId}> giờ được sửa quy tắc AI.` : `🚫 Đã thu quyền của <@${targetId}>.`) +
                `\n-# Được cấp quyền: ${list.length ? list.map((id) => `<@${id}>`).join(', ') : '(chưa ai)'} — Superadmin luôn có quyền.`);
        }
        const del = arg.match(/^rule\s+(?:xoa|xoá|del)\s+(\d+)$/i);
        const addMatch = !del && arg.match(/^rule\s+([\s\S]+)$/i);
        if (del || addMatch) {
            if (!canEditRules(guildId, msg.author.id)) {
                return void await msg.reply('🔒 Sửa quy tắc AI cần được Superadmin cấp quyền (`!ai allow @user`). Bạn vẫn xem được bằng `!ai rules`.');
            }
            if (del) {
                const { items } = await serviceCall('DELETE', '/advice', { guildId, index: parseInt(del[1], 10) - 1 });
                return void await msg.reply('🗑️ Đã xoá.\n' + renderRules(items));
            }
            const { items } = await serviceCall('POST', '/advice', {
                guildId, text: addMatch[1], author: msg.member?.displayName || msg.author.username,
            });
            return void await msg.reply(`✅ Đã thêm quy tắc — AI sẽ áp dụng từ tin nhắn sau.\n` + renderRules(items));
        }
        await msg.reply('Lệnh AI: `!ai reset` · `!ai rules` · `!ai rule <nội dung>` · `!ai rule xoa <số>` · `!ai allow/deny @user` (Superadmin)');
    } catch (e) {
        log.error('[aiChat] !ai command failed:', e.message);
        msg.reply(`⚠️ ${e.message.startsWith('ai-service') ? 'AI đang tạm nghỉ, thử lại sau chút nhé.' : e.message}`).catch(() => {});
    }
}

module.exports = { maybeHandle };
