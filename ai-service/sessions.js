// Per-channel conversation sessions. Key: `ch:<guildId>:<channelId>`.
// Entries: { role: 'user'|'assistant', name?, content, ts }.
// Capped by message count AND estimated tokens — when Phase 4 lands, the trim
// point below is where compaction (summarize instead of drop) plugs in.
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { config } = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');

const sessions = new Map(); // key -> entry[]

try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) sessions.set(k, v);
    log.info(`[ai] restored ${sessions.size} sessions from disk`);
} catch (e) {
    if (e.code !== 'ENOENT') log.warn('[ai] could not restore sessions:', e.message);
}

let flushTimer = null;
function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushSync(); }, 3000);
    flushTimer.unref();
}

function flushSync() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(sessions)));
    } catch (e) {
        log.error('[ai] session flush failed:', e.message);
    }
}

const estimateTokens = (list) => Math.ceil(list.reduce((n, m) => n + m.content.length, 0) / 4);

function append(key, entry) {
    const list = sessions.get(key) || [];
    list.push({ ...entry, ts: Date.now() });
    while (list.length > config.sessionMaxMessages || estimateTokens(list) > config.sessionMaxTokens) {
        list.shift(); // Phase 4: compact into a rolling summary here instead of dropping
    }
    sessions.set(key, list);
    scheduleFlush();
}

function getHistory(key) {
    return sessions.get(key) || [];
}

function reset(key) {
    const existed = sessions.delete(key);
    if (existed) scheduleFlush();
    return existed;
}

module.exports = { append, getHistory, reset, flushSync };
