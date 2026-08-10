// qtbot-ai — isolated LLM chat service (Phase 3: per-channel sessions, ordered
// generations, provider failover). Runs as its own pm2 process; the bot talks
// to it over localhost HTTP. Authorization happens in the bot BEFORE requests
// reach here, so this must only ever bind to localhost.
const http = require('http');
const log = require('../logger');
const {
    config, loadSoul,
    KNOWN_PROVIDERS, effectiveOrder, modelFor, fallbackModelFor, credsFor,
    getOverrides, saveOverrides,
} = require('./config');
const { generateChatResponse, healthSnapshot, rebuild } = require('./providers');
const sessions = require('./sessions');
const { enqueue, QueueFullError } = require('./queue');
const { maybeScheduleCompaction } = require('./compaction');

// Channel sessions are shared, multi-speaker conversations: user turns are
// prefixed with the speaker's display name so the model can track who's who.
const SYSTEM = loadSoul() +
    '\n\nTin nhắn của người dùng có dạng "Tên: nội dung" để bạn biết ai đang nói. ' +
    'KHÔNG thêm tiền tố tên (kiểu "QT:") vào câu trả lời của bạn.';

function readJsonBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(new Error('invalid JSON')); }
        });
        req.on('error', reject);
    });
}

function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

const sessionKeyOf = (b) => `ch:${b.guildId}:${b.channelId}`;

async function runChat(sessionKey, name, userText) {
    const started = Date.now();
    const history = sessions.getHistory(sessionKey);
    const summary = sessions.getSummary(sessionKey);
    const messages = [
        { role: 'system', content: SYSTEM + (summary ? `\n\n## Tóm tắt phần trước của cuộc trò chuyện\n${summary}` : '') },
        ...history.map((m) => m.role === 'user'
            ? { role: 'user', content: `${m.name}: ${m.content}` }
            : { role: 'assistant', content: m.content }),
        { role: 'user', content: `${name}: ${userText}` },
    ];
    const { text, provider } = await generateChatResponse(messages);
    // Only successful exchanges enter history — a failed generation leaves the
    // session exactly as it was, so a retry isn't a duplicate.
    sessions.append(sessionKey, { role: 'user', name, content: userText });
    sessions.append(sessionKey, { role: 'assistant', content: text });
    maybeScheduleCompaction(sessionKey); // runs after us on this session's queue
    log.info(`[ai] done session=${sessionKey} provider=${provider} history=${history.length} total=${Date.now() - started}ms`);
    return { text, provider };
}

async function handleChat(req, res) {
    const body = await readJsonBody(req);
    const { guildId, channelId, userId, displayName, content } = body;
    if (!guildId || !channelId || !userId || typeof content !== 'string' || !content.trim()) {
        return send(res, 400, { error: 'guildId, channelId, userId and non-empty content required' });
    }
    const sessionKey = sessionKeyOf(body);
    const name = String(displayName || 'thành viên').slice(0, 60);
    log.info(`[ai] request user=${userId} session=${sessionKey} chars=${content.length}`);
    let task;
    try {
        task = enqueue(sessionKey, () => runChat(sessionKey, name, content.slice(0, 4000)), config.sessionQueueDepth);
    } catch (e) {
        if (e instanceof QueueFullError) return send(res, 429, { error: 'session busy' });
        throw e;
    }
    send(res, 200, await task);
}

async function handleSessionReset(req, res) {
    const body = await readJsonBody(req);
    if (!body.guildId || !body.channelId) return send(res, 400, { error: 'guildId and channelId required' });
    const existed = sessions.reset(sessionKeyOf(body));
    log.info(`[ai] session reset ${sessionKeyOf(body)} existed=${existed}`);
    send(res, 200, { ok: true, existed });
}

// What the admin dashboard sees: full catalog (including unconfigured or
// disabled providers), effective order, and live health.
function adminSnapshot() {
    const health = healthSnapshot();
    const order = effectiveOrder();
    return {
        order,
        providers: KNOWN_PROVIDERS.map((name) => ({
            name,
            configured: !!credsFor(name),           // creds present in env
            active: order.includes(name) && !!credsFor(name),
            override: getOverrides().models[name] || null,
            effectiveModel: modelFor(name),
            fallbackModel: fallbackModelFor(name),  // what applies if override is cleared
            health: health[name] || { healthy: true, lastFailure: null, cooldownUntil: null },
        })),
    };
}

async function handleAdminConfig(req, res) {
    if (req.method === 'GET') return send(res, 200, adminSnapshot());

    const body = await readJsonBody(req);
    const next = getOverrides();
    if (body.providerOrder !== undefined) {
        if (!Array.isArray(body.providerOrder) || !body.providerOrder.length) {
            return send(res, 400, { error: 'providerOrder must be a non-empty array' });
        }
        const order = [...new Set(body.providerOrder.map(String))];
        const bad = order.filter((n) => !KNOWN_PROVIDERS.includes(n));
        if (bad.length) return send(res, 400, { error: `unknown providers: ${bad.join(', ')}` });
        next.providerOrder = order;
    }
    if (body.models !== undefined) {
        if (!body.models || typeof body.models !== 'object') return send(res, 400, { error: 'models must be an object' });
        for (const [name, model] of Object.entries(body.models)) {
            if (!KNOWN_PROVIDERS.includes(name)) return send(res, 400, { error: `unknown provider: ${name}` });
            const m = String(model || '').trim();
            if (m.length > 150) return send(res, 400, { error: `model name too long for ${name}` });
            if (m) next.models[name] = m;
            else delete next.models[name]; // empty = revert to env/default
        }
    }
    saveOverrides(next);
    rebuild();
    log.info(`[ai] admin config updated: order=${effectiveOrder().join(',')}`);
    send(res, 200, adminSnapshot());
}

const server = http.createServer((req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const task =
        route === 'POST /chat' ? handleChat(req, res) :
        route === 'DELETE /session' ? handleSessionReset(req, res) :
        route === 'GET /admin/config' || route === 'PUT /admin/config' ? handleAdminConfig(req, res) :
        route === 'GET /health' ? Promise.resolve(send(res, 200, { ok: true, providers: healthSnapshot() })) :
        Promise.resolve(send(res, 404, { error: 'not found' }));
    task.catch((e) => {
        log.error(`[ai] ${route} failed:`, e.message);
        if (!res.headersSent) send(res, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 502, { error: 'generation failed' });
    });
});

server.listen(config.port, config.host, () => {
    log.info(`[ai] qtbot-ai listening on http://${config.host}:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log.info(`[ai] received ${sig}, flushing sessions and shutting down`);
        sessions.flushSync();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
