require('dotenv').config();

const log = require('./logger');
const client = require('./src/client');
const { loadCommands } = require('./src/commands');
const { registerEvents } = require('./src/events');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    log.error('Set BOT_TOKEN env var!');
    process.exit(1);
}

loadCommands(client);
registerEvents(client);

client.login(TOKEN);
