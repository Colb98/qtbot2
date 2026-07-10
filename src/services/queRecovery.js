const { PermissionFlagsBits } = require('discord.js');
const { data, saveData } = require('../state');
const { getWallet } = require('./currency');
const metrics = require('./metrics');

// ── Quẻ Bói penalty claw-back ────────────────────────────────────────────────
//
// The settlement edge case (rutque.js §10.1) forgives whatever part of a hung
// penalty the player can't cover — the "Phạt X — chỉ còn Y, trừ hết & tha
// phần còn lại." line. Players exploited it by emptying their wallet (bank /
// gift) right before settling, so the penalty evaporated. The forgiven amount
// was never recorded anywhere (metrics only logged the deducted part), so the
// only remaining ledger is the bot's own chat messages.
//
// This service re-scans chat history for those settlement lines, reconstructs
// forgiven = penalty − deducted per player, and charges it back — balances
// are ALLOWED TO GO NEGATIVE (the forgiven debt is reinstated).
//
// Idempotent: processed message IDs live in data.queRecovery[guildId].done,
// so re-running `apply` never double-charges. Driven by the superadmin
// command `!rutque thuhoi` (messageCommands.js).

// The điểm-phúc settle system (and its forgiveness line) shipped in v2.13.0
// on 2026-07-09 GMT+7 — no older message can contain the string.
const DEFAULT_SINCE_MS = Date.UTC(2026, 6, 8, 17, 0, 0);

const NEEDLE = 'tha phần còn lại';
// Matches: `Phạt ${fmt(penalty)} ${ngocEmote()} — chỉ còn ${fmt(deducted)},
// trừ hết & tha phần còn lại.` — fmt() is en-US grouping ("12,345"); the emote
// between the numbers renders as a custom-emoji tag or plain text, so accept
// anything within the line.
const FORGIVE_RE = /Phạt ([\d,]+) [^\n]*?— chỉ còn ([\d,]+), trừ hết & tha phần còn lại\./g;

// Sum of forgiven ngọc across every settlement line in one message.
function parseForgiven(content) {
    const re = new RegExp(FORGIVE_RE.source, 'g');
    let total = 0;
    let m;
    while ((m = re.exec(content))) {
        const penalty = Number(m[1].replace(/,/g, ''));
        const deducted = Number(m[2].replace(/,/g, ''));
        if (Number.isFinite(penalty) && Number.isFinite(deducted) && penalty > deducted) {
            total += penalty - deducted;
        }
    }
    return total;
}

// Settlement lines ride on several kinds of bot messages (text-command
// replies, button followUps, auto-session edits, keepsakes). No single signal
// covers them all — notably the replay buttons that normally encode the owner
// are OMITTED exactly when the wallet hit 0 (the exploit case) — so try every
// identity path in order of reliability. Returns a userId or null.
async function attribute(message) {
    // Button/slash responses carry the triggering user.
    const im = message.interactionMetadata;
    if (im && im.user && im.user.id) return im.user.id;
    if (message.interaction && message.interaction.user) return message.interaction.user.id;
    // Text-command results are msg.reply()s to the player's command.
    if (message.reference && message.reference.messageId) {
        const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (ref && !ref.author.bot) return ref.author.id;
    }
    // Owner id embedded in component customIds (cf:/tong:/mat:/slot:/auto:…).
    const ids = new Set();
    for (const row of message.components || []) {
        for (const comp of row.components || []) {
            for (const part of String(comp.customId || '').split(':')) {
                if (/^\d{17,20}$/.test(part)) ids.add(part);
            }
        }
    }
    if (ids.size === 1) return ids.values().next().value;
    // Keepsake posts ping the player.
    if (message.mentions && message.mentions.users.size === 1) return message.mentions.users.first().id;
    return null;
}

function isScannable(ch, me) {
    if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased()) return false;
    const perms = ch.permissionsFor ? ch.permissionsFor(me) : null;
    return !!(perms && perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ReadMessageHistory));
}

// Walk one channel newest→oldest down to sinceMs, collecting forgiven
// settlements authored by the bot.
async function scanChannel(channel, sinceMs, onBatch) {
    const botId = channel.client.user.id;
    const entries = [];
    let scanned = 0;
    let before;
    for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;
        for (const message of batch.values()) {
            if (message.createdTimestamp < sinceMs) continue;
            scanned++;
            if (message.author.id !== botId) continue;
            if (!message.content || !message.content.includes(NEEDLE)) continue;
            const forgiven = parseForgiven(message.content);
            if (forgiven <= 0) continue;
            entries.push({
                messageId: message.id,
                channelId: channel.id,
                userId: await attribute(message),
                forgiven,
                ts: message.createdTimestamp
            });
        }
        const oldest = batch.last();
        before = oldest.id;
        if (onBatch) await onBatch(scanned);
        if (oldest.createdTimestamp < sinceMs) break;
    }
    return { entries, scanned };
}

function recFor(guildId) {
    data.queRecovery = data.queRecovery || {};
    data.queRecovery[guildId] = data.queRecovery[guildId] || { done: {} };
    return data.queRecovery[guildId];
}

// Scan the guild (explicit channels, or every readable text channel).
// Entries already charged back by a previous apply are split out.
async function scanGuild({ guild, channels, sinceMs, onProgress }) {
    sinceMs = sinceMs || DEFAULT_SINCE_MS;
    const me = guild.members.me;
    const targets = (channels && channels.length ? channels : [...guild.channels.cache.values()])
        .filter(ch => isScannable(ch, me));
    const rec = recFor(guild.id);
    const all = [];
    let scanned = 0;
    for (let i = 0; i < targets.length; i++) {
        const ch = targets[i];
        const res = await scanChannel(ch, sinceMs, onProgress
            ? (n) => onProgress({ channel: ch, index: i + 1, total: targets.length, scanned: scanned + n })
            : null);
        scanned += res.scanned;
        all.push(...res.entries);
    }
    const entries = all.filter(e => !rec.done[e.messageId]);
    return { entries, alreadyDone: all.length - entries.length, scanned, channelCount: targets.length };
}

// Charge the forgiven amounts back. Locked ngọc drains first (mirrors
// spendNgocForGame); the remainder comes out of `ngoc`, which MAY GO NEGATIVE.
// Unattributed and already-done entries are skipped. Returns per-user results.
function applyRecovery(guildId, entries) {
    const rec = recFor(guildId);
    const perUser = new Map();
    for (const e of entries) {
        if (!e.userId || rec.done[e.messageId]) continue;
        rec.done[e.messageId] = { u: e.userId, f: e.forgiven, at: Date.now() };
        perUser.set(e.userId, (perUser.get(e.userId) || 0) + e.forgiven);
    }
    const results = [];
    for (const [userId, total] of perUser.entries()) {
        const w = getWallet(guildId, userId);
        const lockedUsed = Math.min(total, Math.max(0, w.lockedNgoc));
        w.lockedNgoc -= lockedUsed;
        w.ngoc -= (total - lockedUsed);
        // Burn the reclaimed ngọc in the ledger — the original settlement only
        // recorded the part it managed to deduct at the time.
        metrics.recordQueSettlement({ guildId, userId, paid: 0, penalty: total });
        results.push({ userId, total, ngoc: w.ngoc, lockedNgoc: w.lockedNgoc });
    }
    if (results.length) saveData();
    return results;
}

module.exports = {
    DEFAULT_SINCE_MS,
    parseForgiven,
    scanGuild,
    applyRecovery
};
