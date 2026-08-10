// qtbot-ai — isolated LLM chat service (Phase 1: stateless chat, provider failover).
// Runs as its own pm2 process; the bot talks to it over localhost HTTP.
// Authorization happens in the bot BEFORE requests reach here, so this must
// only ever bind to localhost.
const http = require('http');
const log = require('../logger');
const { config, loadSoul } = require('./config');
const { generateChatResponse, healthSnapshot } = require('./providers');

const SOUL = loadSoul();

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
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

async function handleChat(req, res) {
    const body = await readJsonBody(req);
    const { userId, displayName, content } = body;
    if (!userId || typeof content !== 'string' || !content.trim()) {
        return send(res, 400, { error: 'userId and non-empty content required' });
    }
    const started = Date.now();
    log.info(`[ai] request user=${userId} channel=${body.channelId || '-'} chars=${content.length}`);

    // Phase 1 is stateless: SOUL + speaker identity + the single message.
    // Sessions/history land in Phase 3, compaction in Phase 4.
    const messages = [
        { role: 'system', content: `${SOUL}\n\nNgười đang nói chuyện với bạn: ${displayName || 'một thành viên'}.` },
        { role: 'user', content: content.slice(0, 4000) },
    ];
    const { text, provider } = await generateChatResponse(messages);
    log.info(`[ai] done user=${userId} provider=${provider} total=${Date.now() - started}ms`);
    send(res, 200, { text, provider });
}

const server = http.createServer((req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const task =
        route === 'POST /chat' ? handleChat(req, res) :
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
        log.info(`[ai] received ${sig}, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
