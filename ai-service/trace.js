// Per-request flow traces for the /ai admin page: every chat request records
// its ordered steps (classify → think → generation → search → read → reply)
// with durations, success/failure and truncated detail text.
//
// In-memory ring buffer only, volatile across restarts by design: traces hold
// raw LLM thinking and fetched web text (privacy + size), and their useful
// window is "the last hour of weirdness". Durable numbers live in metrics.js.
// Memory bound: traceMax × ~10 steps × traceDetailMaxChars ≈ a few MB.
const { config } = require('./config');

const ring = []; // newest last; capped at config.traceMax
let seq = 0;

const clip = (s) => typeof s === 'string' ? s.slice(0, config.traceDetailMaxChars) : s;

function start({ sessionKey, guildId, channelId, userId, name, userChars }) {
    if (!config.traceEnabled) return null;
    const t = {
        id: `${Date.now().toString(36)}-${seq++}`,
        sessionKey, guildId, channelId, userId, name,
        startedAt: Date.now(), endedAt: null, totalMs: null,
        status: 'running', userChars, replyChars: null, error: null,
        steps: [],
    };
    // Pushed immediately so a crash mid-request still leaves a visible trace.
    ring.push(t);
    if (ring.length > config.traceMax) ring.shift();
    return t;
}

function step(trace, type, meta = {}) {
    if (!trace) return null;
    const s = { type, startedAt: Date.now(), ms: null, ok: null, ...meta };
    trace.steps.push(s);
    return s;
}

function endStep(trace, s, { ok, detail, ...fields } = {}) {
    if (!trace || !s) return;
    s.ms = Date.now() - s.startedAt;
    s.ok = ok !== false;
    if (detail != null) s.detail = clip(detail);
    Object.assign(s, fields);
}

function finish(trace, { status, replyChars = null, error = null } = {}) {
    if (!trace) return;
    trace.endedAt = Date.now();
    trace.totalMs = trace.endedAt - trace.startedAt;
    trace.status = status;
    trace.replyChars = replyChars;
    trace.error = error ? String(error).slice(0, 300) : null;
}

// Compact one-line label per step for the list view, e.g. gen(groq).
function stepLabel(s) {
    if (s.type === 'generation') return `gen(${s.provider || '?'})`;
    if (s.type === 'classify') return `classify:${s.result || '?'}`;
    if (s.type === 'sufficiency') return `sufficiency:${s.result || '?'}`;
    if (s.type === 'doc') return `doc:${s.name || '?'}`;
    if (s.type === 'blocked') return `blocked:${s.name || '?'}(${s.result || '?'})`;
    if (s.type === 'budget') return `budget:${s.result || '?'}`;
    return s.type;
}

// Total LLM tokens spent on one request: every provider call records
// tokensIn/tokensOut on its step (generation, classify, verify, craft, ...),
// so the request total is just the sum over steps.
function tokenTotals(t) {
    let tokensIn = 0, tokensOut = 0;
    for (const s of t.steps) {
        tokensIn += s.tokensIn || 0;
        tokensOut += s.tokensOut || 0;
    }
    return { tokensIn, tokensOut };
}

function list() {
    return [...ring].reverse().map((t) => ({
        id: t.id, startedAt: t.startedAt, userId: t.userId, name: t.name,
        sessionKey: t.sessionKey, status: t.status, totalMs: t.totalMs,
        userChars: t.userChars, replyChars: t.replyChars, error: t.error,
        steps: t.steps.map(stepLabel).join('→'),
        ...tokenTotals(t),
    }));
}

function get(id) {
    return ring.find((t) => t.id === id) || null;
}

module.exports = { start, step, endStep, finish, list, get, tokenTotals };
