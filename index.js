require('dotenv').config();

const log = require('./logger');
const client = require('./src/client');
const { loadCommands } = require('./src/commands');
const { registerEvents } = require('./src/events');
const { flush: flushMetrics } = require('./src/services/metrics');
const dashboard = require('./src/services/dashboard');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    log.error('Set BOT_TOKEN env var!');
    process.exit(1);
}

function shutdown(signal) {
    log.info(`Received ${signal}, flushing metrics and exiting...`);
    flushMetrics();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loadCommands(client);
registerEvents(client);
dashboard.start();

client.login(TOKEN);
