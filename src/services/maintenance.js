let maintenanceMode = false;

function isMaintenance() {
    return maintenanceMode;
}

function setMaintenance(on) {
    maintenanceMode = !!on;
    return maintenanceMode;
}

module.exports = { isMaintenance, setMaintenance };
