const { data, saveData } = require('../state');

function ensureGuild(guildId) {
    if (!data.kimlan) data.kimlan = {};
    if (!data.kimlan[guildId]) data.kimlan[guildId] = {};
    return data.kimlan[guildId];
}

function findGroupKey(guildId, name) {
    const guild = ensureGuild(guildId);
    const lower = name.toLowerCase();
    for (const key of Object.keys(guild)) {
        if (key.toLowerCase() === lower) return key;
    }
    return null;
}

function getGroup(guildId, name) {
    const key = findGroupKey(guildId, name);
    if (!key) return null;
    return { name: key, members: data.kimlan[guildId][key] };
}

function addMembers(guildId, name, userIds) {
    const guild = ensureGuild(guildId);
    let key = findGroupKey(guildId, name);
    if (!key) { key = name; guild[key] = []; }
    const set = new Set(guild[key]);
    const added = [];
    for (const uid of userIds) {
        if (!set.has(uid)) { set.add(uid); added.push(uid); }
    }
    guild[key] = [...set];
    saveData();
    return { groupName: key, added, currentMembers: guild[key] };
}

function removeMembers(guildId, name, userIds) {
    const key = findGroupKey(guildId, name);
    if (!key) return { groupName: null, removed: [], currentMembers: [] };
    const removeSet = new Set(userIds);
    const before = data.kimlan[guildId][key];
    const after = before.filter(uid => !removeSet.has(uid));
    const removed = before.filter(uid => removeSet.has(uid));
    data.kimlan[guildId][key] = after;
    saveData();
    return { groupName: key, removed, currentMembers: after };
}

function deleteGroup(guildId, name) {
    const key = findGroupKey(guildId, name);
    if (!key) return false;
    delete data.kimlan[guildId][key];
    saveData();
    return true;
}

function listGroups(guildId) {
    const guild = ensureGuild(guildId);
    return Object.keys(guild).map(key => ({ name: key, members: guild[key] }));
}

function getKimlanGroupsForGuild(guildId) {
    const guild = ensureGuild(guildId);
    return Object.values(guild).filter(arr => arr.length >= 2).map(arr => [...arr]);
}

function ensureModsGuild(guildId) {
    if (!data.kimlanMods) data.kimlanMods = {};
    if (!data.kimlanMods[guildId]) data.kimlanMods[guildId] = [];
    return data.kimlanMods[guildId];
}

function addMod(guildId, userId) {
    const mods = ensureModsGuild(guildId);
    if (mods.indexOf(userId) === -1) { mods.push(userId); saveData(); return true; }
    return false;
}

function removeMod(guildId, userId) {
    const mods = ensureModsGuild(guildId);
    const idx = mods.indexOf(userId);
    if (idx === -1) return false;
    mods.splice(idx, 1);
    saveData();
    return true;
}

function listMods(guildId) {
    return [...ensureModsGuild(guildId)];
}

function isMod(guildId, userId) {
    return ensureModsGuild(guildId).indexOf(userId) !== -1;
}

module.exports = {
    getGroup,
    addMembers,
    removeMembers,
    deleteGroup,
    listGroups,
    getKimlanGroupsForGuild,
    addMod,
    removeMod,
    listMods,
    isMod
};
