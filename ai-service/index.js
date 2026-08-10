// qtbot-ai — isolated LLM chat service (Phase 3: per-channel sessions, ordered
// generations, provider failover). Runs as its own pm2 process; the bot talks
// to it over localhost HTTP. Authorization happens in the bot BEFORE requests
// reach here, so this must only ever bind to localhost.
const http = require('http');
const log = require('../logger');
const { config, loadSoul } = require('./config');
const { generateChatResponse, healthSnapshot } = require('./providers');
const sessions = require('./sessions');
const { enqueue, QueueFullError } = require('./queue');

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
    const messages = [
        { role: 'system', content: SYSTEM },
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

const server = http.createServer((req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const task =
        route === 'POST /chat' ? handleChat(req, res) :
        route === 'DELETE /session' ? handleSessionReset(req, res) :
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
