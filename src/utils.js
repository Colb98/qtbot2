const { data } = require('./state');
const { CLASS_SHORT, MANAGER_ID } = require('./constants');

function isSuperAdmin(userId) {
    return userId === MANAGER_ID;
}

function isManager(guildId, userId) {
    return !!(data.managerId && data.managerId[guildId] && data.managerId[guildId].indexOf(userId) !== -1);
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

module.exports = {
    isSuperAdmin,
    isManager,
    isAbsent,
    isParticipant,
    isValidTimeToRegister,
    getUserDisplayName,
    getClassEmoji,
    sanitizeIngame,
    getNextSaturday
};
