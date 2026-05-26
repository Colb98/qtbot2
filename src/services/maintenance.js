const { MANAGER_ID } = require('../constants');

let maintenanceMode = false;

function isMaintenance() {
    return maintenanceMode;
}

function setMaintenance(on) {
    maintenanceMode = !!on;
    return maintenanceMode;
}

// True when maintenance blocks this user. Super admin and guild owner bypass.
function isBlockedByMaintenance(userId, guild) {
    if (!maintenanceMode) return false;
    if (userId === MANAGER_ID) return false;
    if (guild && guild.ownerId === userId) return false;
    return true;
}

module.exports = { isMaintenance, setMaintenance, isBlockedByMaintenance };
