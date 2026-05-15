const { data, saveData } = require('../state');

function clearLowPrio(guildId) {
    if (!data.lowPrio || !data.lowPrio[guildId]) return;
    data.lowPrio[guildId] = {};
}

function clearHighPrio(guildId) {
    if (!data.highPrio || !data.highPrio[guildId]) return;
    data.highPrio[guildId] = {};
}

function clearLowPrioAll() {
    if (!data.lowPrio) return;
    for (const guildId in data.lowPrio) clearLowPrio(guildId);
    saveData();
}

function clearHighPrioAll() {
    if (!data.highPrio) return;
    for (const guildId in data.highPrio) clearHighPrio(guildId);
    saveData();
}

module.exports = { clearLowPrio, clearHighPrio, clearLowPrioAll, clearHighPrioAll };
