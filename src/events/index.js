const fs = require('fs');
const path = require('path');
const log = require('../../logger');

function registerEvents(client) {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'index.js');
    for (const file of files) {
        try {
            const event = require(path.join(__dirname, file));
            if (!event || !event.name || typeof event.execute !== 'function') {
                log.warn(`Skipping event ${file}: missing name or execute`);
                continue;
            }
            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args));
            } else {
                client.on(event.name, (...args) => event.execute(...args));
            }
        } catch (e) {
            log.error(`Failed to load event ${file}`, e);
        }
    }
    log.info(`Registered events from ${files.length} files.`);
}

module.exports = { registerEvents };
