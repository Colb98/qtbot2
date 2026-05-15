const fs = require('fs');
const path = require('path');
const log = require('../../logger');

function walkCommandFiles(dir) {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkCommandFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js') {
            out.push(full);
        }
    }
    return out;
}

function loadCommands(client, dir = __dirname) {
    const files = walkCommandFiles(dir);
    for (const file of files) {
        try {
            const cmd = require(file);
            if (cmd && cmd.data && typeof cmd.execute === 'function') {
                client.commands.set(cmd.data.name, cmd);
            } else {
                log.warn(`Skipping ${file}: missing data or execute`);
            }
        } catch (e) {
            log.error(`Failed to load command ${file}`, e);
        }
    }
    log.info(`Loaded ${client.commands.size} slash commands.`);
}

function getAllCommandJSON(dir = __dirname) {
    const files = walkCommandFiles(dir);
    const out = [];
    for (const file of files) {
        try {
            const cmd = require(file);
            if (cmd && cmd.data) out.push(cmd.data.toJSON());
        } catch (e) {
            log.error(`Failed to load command JSON ${file}`, e);
        }
    }
    return out;
}

module.exports = { loadCommands, getAllCommandJSON };
