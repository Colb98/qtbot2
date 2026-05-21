const { data } = require('./state');
const { CLASS_SHORT, MANAGER_ID } = require('./constants');
const kimlan = require('./services/kimlan');

function isSuperAdmin(userId) {
    return userId === MANAGER_ID;
}

function isManager(guildId, userId) {
    return !!(data.managerId && data.managerId[guildId] && data.managerId[guildId].indexOf(userId) !== -1);
}

function isOwner(interaction) {
    return interaction.member.id === interaction.guild.ownerId;
}

function canManageKimlan(interaction) {
    const uid = interaction.member.id;
    return isOwner(interaction) || isSuperAdmin(uid) || kimlan.isMod(interaction.guildId, uid);
}

function sanitizeKimlanName(name) {
    if (typeof name !== 'string') throw new Error('Tên kim lan không hợp lệ');
    const cleaned = name.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (cleaned.length < 1 || cleaned.length > 32) throw new Error('Tên kim lan phải dài 1-32 ký tự');
    if (!/^[\p{L}\p{N} _-]+$/u.test(cleaned)) throw new Error('Tên kim lan chỉ chấp nhận chữ, số, dấu cách, _ và -');
    return cleaned;
}

function isAbsent(guildId, uid) {
    return !!(data.absents && data.absents[guildId] && data.absents[guildId][uid] === true);
}

function isParticipant(guildId, uid) {
    return !!(data.participants && data.participants[guildId] && data.participants[guildId][uid] === true);
}

function isValidTimeToRegister(guildId) {
    const validUntil = data.postValidUntil && data.postValidUntil[guildId];
    if (!validUntil) return true;
    return Date.now() <= validUntil;
}

function getUserDisplayName(userId, guildId) {
    const reg = data.registrations[guildId] && data.registrations[guildId][userId];
    return reg ? (reg.ingame ? reg.ingame : (reg.displayName ? reg.displayName : reg.tag)) : userId;
}

function getClassEmoji(index) {
    return `<:class${CLASS_SHORT[index].toLowerCase()}:${data.emoteIds[index]}>`;
}

function sanitizeIngame(name) {
    const cleaned = name.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (cleaned.length < 2 || cleaned.length > 32) throw new Error('Invalid length');
    if (!/^[\p{L}\p{N} _-]+$/u.test(cleaned)) throw new Error('Invalid chars');
    return cleaned;
}

function getNextSaturday() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilSaturday = 6 - dayOfWeek;
    const saturday = new Date(today);
    saturday.setDate(today.getDate() + daysUntilSaturday);
    return saturday;
}

const GAME_COOLDOWN_MS = 3000;
const gameCooldowns = new Map();

function checkGameCooldown(userId) {
    const now = Date.now();
    const last = gameCooldowns.get(userId);
    if (last && (now - last) < GAME_COOLDOWN_MS) {
        return { onCooldown: true, msLeft: GAME_COOLDOWN_MS - (now - last) };
    }
    gameCooldowns.set(userId, now);
    return { onCooldown: false, msLeft: 0 };
}

async function replyEphemeral(msg, content, ttlMs = 3000) {
    try {
        const reply = await msg.reply(content);
        setTimeout(() => { reply.delete().catch(() => {}); }, ttlMs);
        return reply;
    } catch (e) {
        return null;
    }
}

module.exports = {
    isSuperAdmin,
    isManager,
    isOwner,
    canManageKimlan,
    sanitizeKimlanName,
    isAbsent,
    isParticipant,
    isValidTimeToRegister,
    getUserDisplayName,
    getClassEmoji,
    sanitizeIngame,
    getNextSaturday,
    checkGameCooldown,
    replyEphemeral,
    GAME_COOLDOWN_MS
};
