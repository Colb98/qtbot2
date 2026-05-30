const { data, saveData } = require('../state');
const { addNgoc } = require('./currency');
const economy = require('../config/economy');

function ensurePath(guildId, postMessageId) {
    data.bangChienGrant = data.bangChienGrant || {};
    data.bangChienGrant[guildId] = data.bangChienGrant[guildId] || {};
    data.bangChienGrant[guildId][postMessageId] = data.bangChienGrant[guildId][postMessageId] || {};
    return data.bangChienGrant[guildId][postMessageId];
}

function grantIfNeeded(guildId, userId, postMessageId) {
    if (!postMessageId) return false;
    const granted = ensurePath(guildId, postMessageId);
    if (granted[userId]) return false;
    granted[userId] = true;
    addNgoc(guildId, userId, economy.BANG_CHIEN_REWARD);
    saveData();
    return true;
}

function revoke(guildId, userId, postMessageId) {
    if (!postMessageId) return false;
    if (!data.bangChienGrant || !data.bangChienGrant[guildId] || !data.bangChienGrant[guildId][postMessageId]) return false;
    const granted = data.bangChienGrant[guildId][postMessageId];
    if (!granted[userId]) return false;
    delete granted[userId];
    addNgoc(guildId, userId, -economy.BANG_CHIEN_REWARD);
    saveData();
    return true;
}

function retroactiveGrantAll(guildId) {
    const postId = data.lastPostMessageId && data.lastPostMessageId[guildId];
    if (!postId) return 0;
    const participants = (data.participants && data.participants[guildId]) || {};
    let count = 0;
    for (const uid of Object.keys(participants)) {
        if (grantIfNeeded(guildId, uid, postId)) count += 1;
    }
    return count;
}

module.exports = {
    get BANG_CHIEN_REWARD() { return economy.BANG_CHIEN_REWARD; },
    grantIfNeeded,
    revoke,
    retroactiveGrantAll
};
