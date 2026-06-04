require('dotenv').config();

const log = require('./logger');
const client = require('./src/client');
const { loadCommands } = require('./src/commands');
const { registerEvents } = require('./src/events');
const { flush: flushMetrics } = require('./src/services/metrics');
const { flushSync: flushState } = require('./src/state');
const dashboard = require('./src/services/dashboard');
const renderPool = require('./src/services/renderPool');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    log.error('Set BOT_TOKEN env var!');
    process.exit(1);
}

function shutdown(signal) {
    log.info(`Received ${signal}, flushing metrics and exiting...`);
    flushMetrics();
    flushState();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
    log.error('uncaughtException, flushing state before exit:', e);
    try { flushState(); } catch (_) {}
    process.exit(1);
});
process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection:', e);
    try { flushState(); } catch (_) {}
});

loadCommands(client);
registerEvents(client);
renderPool.start();
dashboard.start(client);

client.login(TOKEN);
