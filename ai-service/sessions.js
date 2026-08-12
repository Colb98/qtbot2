// Per-channel conversation sessions. Key: `ch:<guildId>:<channelId>`.
// Session shape: { summary: string|null, messages: [{role, name?, content, ts}] }
// — `summary` is the rolling compacted history, `messages` the recent verbatim
// tail. Compaction (compaction.js) folds old messages into the summary once the
// tail crosses the token threshold; the caps here are only the emergency
// backstop for when compaction is disabled or failing.
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { config } = require('./config');
const { writeAtomic } = require('./persist');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');

const sessions = new Map(); // key -> {summary, messages}

try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v)) sessions.set(k, { summary: null, messages: v }); // pre-compaction format
        else if (v && Array.isArray(v.messages)) sessions.set(k, { summary: v.summary || null, messages: v.messages });
    }
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
        writeAtomic(FILE, JSON.stringify(Object.fromEntries(sessions)));
    } catch (e) {
        log.error('[ai] session flush failed:', e.message);
    }
}

const estimateTokens = (list) => Math.ceil(list.reduce((n, m) => n + m.content.length, 0) / 4);

function append(key, entry) {
    const s = sessions.get(key) || { summary: null, messages: [] };
    s.messages.push({ ...entry, ts: Date.now() });
    // Emergency backstop only — normally compaction fires well before this.
    while (s.messages.length > config.sessionMaxMessages || estimateTokens(s.messages) > config.sessionMaxTokens) {
        s.messages.shift();
    }
    sessions.set(key, s);
    scheduleFlush();
}

function getHistory(key) {
    const s = sessions.get(key);
    return s ? s.messages : [];
}

function getSummary(key) {
    const s = sessions.get(key);
    return s ? s.summary : null;
}

// Enough tail to be worth folding, then over EITHER budget — token count (a
// verbose conversation) or message count (a long low-token one). The count
// path is what lets memory get promoted from short-reply chat, which never
// reaches the token threshold before the emergency trim.
function needsCompaction(key) {
    const s = sessions.get(key);
    if (!s || s.messages.length <= config.compactKeepRecent) return false;
    return estimateTokens(s.messages) > config.compactThresholdTokens
        || s.messages.length >= config.compactMaxMessages;
}

// Split the tail for the summarizer: [toCompact, toKeep].
function splitForCompaction(key) {
    const s = sessions.get(key);
    if (!s) return [[], []];
    return [s.messages.slice(0, -config.compactKeepRecent), s.messages.slice(-config.compactKeepRecent)];
}

// Runs inside the session queue, so messages cannot change mid-compaction —
// but the session may have been reset while the summary generated: no-op then.
function applyCompaction(key, summary) {
    const s = sessions.get(key);
    if (!s) return false;
    s.summary = summary;
    s.messages = s.messages.slice(-config.compactKeepRecent);
    scheduleFlush();
    return true;
}

function reset(key) {
    const existed = sessions.delete(key);
    if (existed) scheduleFlush();
    return existed;
}

module.exports = { append, getHistory, getSummary, needsCompaction, splitForCompaction, applyCompaction, reset, flushSync, estimateTokens };
