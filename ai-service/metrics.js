// Phase 6 metrics: daily-bucketed counters persisted to data/metrics.json.
// The goal is knowing whether free-tier usage is sustainable — counts and
// sums only, no dashboards-grade timeseries. Same load/debounced-flush
// lifecycle as sessions.js; buckets older than the retention window are
// pruned on day rollover.
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { config } = require('./config');
const { writeAtomic } = require('./persist');

const FILE = path.join(__dirname, 'data', 'metrics.json');

let days = {};
try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw.days === 'object') days = raw.days;
    log.info(`[ai] restored metrics (${Object.keys(days).length} day buckets)`);
} catch (e) {
    if (e.code !== 'ENOENT') log.warn('[ai] could not restore metrics:', e.message);
}

const dayKey = () => new Date().toISOString().slice(0, 10);

function emptyDay() {
    return {
        messages: 0, errors: 0, latencyMs: 0, latencyCount: 0,
        perUser: {}, providers: {},
        searches: 0, pagesRead: 0, compactions: 0, memoryWrites: 0,
        classifyDeep: 0, classifyImmediate: 0, thinkSteps: 0,
    };
}

let currentKey = null;
function today() {
    const key = dayKey();
    if (key !== currentKey) {
        currentKey = key;
        if (!days[key]) days[key] = emptyDay();
        // Prune expired buckets on rollover.
        const cutoff = new Date(Date.now() - config.metricsRetentionDays * 86400000).toISOString().slice(0, 10);
        for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
    }
    return days[key];
}

let flushTimer = null;
function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushSync(); }, 3000);
    flushTimer.unref();
}

function flushSync() {
    if (!config.metricsEnabled) return;
    try {
        writeAtomic(FILE, JSON.stringify({ days }));
    } catch (e) {
        log.error('[ai] metrics flush failed:', e.message);
    }
}

function inc(name, by = 1) {
    if (!config.metricsEnabled) return;
    const d = today();
    d[name] = (d[name] || 0) + by;
    scheduleFlush();
}

function incUser(userId) {
    if (!config.metricsEnabled) return;
    const d = today();
    d.perUser[userId] = (d.perUser[userId] || 0) + 1;
    scheduleFlush();
}

function provider(name, { ok, latencyMs = 0, rateLimited = false, fallback = false, tokensIn = 0, tokensOut = 0 } = {}) {
    if (!config.metricsEnabled) return;
    const d = today();
    const p = d.providers[name] || (d.providers[name] = {
        requests: 0, errors: 0, rateLimited: 0, fallbacks: 0,
        latencyMs: 0, latencyCount: 0, tokensIn: 0, tokensOut: 0,
    });
    p.requests += 1;
    if (ok) {
        p.latencyMs += latencyMs; p.latencyCount += 1;
        p.tokensIn += tokensIn; p.tokensOut += tokensOut;
        if (fallback) p.fallbacks += 1;
    } else {
        p.errors += 1;
        if (rateLimited) p.rateLimited += 1;
    }
    scheduleFlush();
}

function requestDone(totalMs, ok) {
    if (!config.metricsEnabled) return;
    const d = today();
    d.latencyMs += totalMs; d.latencyCount += 1;
    if (!ok) d.errors += 1;
    scheduleFlush();
}

// today's bucket in full plus the last 7 day keys for trend context.
function snapshot() {
    const t = today();
    const keys = Object.keys(days).sort().slice(-7);
    const recent = {};
    for (const k of keys) recent[k] = days[k];
    return { today: t, days: recent };
}

module.exports = { inc, incUser, provider, requestDone, snapshot, flushSync };
