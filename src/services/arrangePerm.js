const { data, saveData } = require('../state');

function ensureGuild(guildId) {
    if (!data.arrangePerm) data.arrangePerm = {};
    if (!data.arrangePerm[guildId]) {
        data.arrangePerm[guildId] = {
            whitelist: { users: [], roles: [] },
            graylist: { users: [], roles: [] }
        };
    }
    const g = data.arrangePerm[guildId];
    if (!g.whitelist) g.whitelist = { users: [], roles: [] };
    if (!g.graylist) g.graylist = { users: [], roles: [] };
    if (!g.whitelist.users) g.whitelist.users = [];
    if (!g.whitelist.roles) g.whitelist.roles = [];
    if (!g.graylist.users) g.graylist.users = [];
    if (!g.graylist.roles) g.graylist.roles = [];
    return g;
}

function addEntry(guildId, listName, kind, id) {
    const g = ensureGuild(guildId);
    const arr = g[listName][kind];
    if (arr.indexOf(id) !== -1) return false;
    arr.push(id);
    saveData();
    return true;
}

function removeEntry(guildId, listName, kind, id) {
    const g = ensureGuild(guildId);
    const arr = g[listName][kind];
    const idx = arr.indexOf(id);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    saveData();
    return true;
}

function getList(guildId, listName) {
    const g = ensureGuild(guildId);
    return { users: [...g[listName].users], roles: [...g[listName].roles] };
}

function memberMatches(listName, guildId, member) {
    const g = ensureGuild(guildId);
    const l = g[listName];
    if (l.users.indexOf(member.id) !== -1) return true;
    for (const roleId of l.roles) {
        if (member.roles && member.roles.cache && member.roles.cache.has(roleId)) return true;
    }
    return false;
}

function isWhitelisted(guildId, member) {
    return memberMatches('whitelist', guildId, member);
}

function isGraylisted(guildId, member) {
    return memberMatches('graylist', guildId, member);
}

module.exports = {
    addEntry,
    removeEntry,
    getList,
    isWhitelisted,
    isGraylisted
};
