// qtbot-ai — isolated LLM chat service (Phase 3: per-channel sessions, ordered
// generations, provider failover). Runs as its own pm2 process; the bot talks
// to it over localhost HTTP. Authorization happens in the bot BEFORE requests
// reach here, so this must only ever bind to localhost.
const http = require('http');
const log = require('../logger');
const {
    config, loadSoul, loadRules,
    KNOWN_PROVIDERS, effectiveOrder, modelFor, fallbackModelFor, credsFor,
    getOverrides, saveOverrides,
} = require('./config');
const advice = require('./advice');
const { generateChatResponse, healthSnapshot, rebuild } = require('./providers');
const sessions = require('./sessions');
const { enqueue, QueueFullError } = require('./queue');
const { maybeScheduleCompaction } = require('./compaction');
const memory = require('./memory');
const search = require('./search');

// Channel sessions are shared, multi-speaker conversations: user turns are
// prefixed with the speaker's display name so the model can track who's who.
const RULES = loadRules();
const SYSTEM = loadSoul() +
    (RULES ? `\n\n${RULES}` : '') +
    '\n\nUser messages are formatted "Name: content" so you know who is speaking. ' +
    'Do NOT prefix your own replies with a name (like "QT:").' +
    (config.searchEnabled
        ? '\n\n## Web search tool\nWhen you need fresh or time-sensitive information, reply with EXACTLY one line: ' +
          '[[search: <short query>]] — you will receive a numbered list of results (title + snippet + URL). ' +
          'Then pick the most relevant results and reply with EXACTLY one line: [[read: <numbers separated by commas>]] ' +
          'to receive their full page content. For questions needing detail ' +
          '(guides, builds, how-to), ALWAYS read pages before answering — snippets alone are not enough. ' +
          'When answering, mention 1-2 source names (site or page title) in plain text — no links needed.'
        : '');

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

async function runChat(sessionKey, { guildId, channelId, userId, name, userText }) {
    const started = Date.now();
    const history = sessions.getHistory(sessionKey);
    const summary = sessions.getSummary(sessionKey);
    // Scoped memory only (§11): server + this channel + the current speaker.
    const mem = memory.getContext(guildId, channelId, userId);
    let system = SYSTEM;
    const guildAdvice = advice.renderForPrompt(guildId);
    if (guildAdvice) system += `\n\n${guildAdvice}`;
    if (mem.server) system += `\n\n## Server memory\n${mem.server}`;
    if (mem.channel) system += `\n\n## Channel memory\n${mem.channel}`;
    if (mem.user) system += `\n\n## Memory about ${name}\n${mem.user}`;
    if (summary) system += `\n\n## Summary of earlier conversation\n${summary}`;
    const messages = [
        { role: 'system', content: system },
        ...history.map((m) => m.role === 'user'
            ? { role: 'user', content: `${m.name}: ${m.content}` }
            : { role: 'assistant', content: m.content }),
        { role: 'user', content: `${name}: ${userText}` },
    ];
    let { text, provider } = await generateChatResponse(messages);

    // Tool loop: the model asks for a search via [[search: ...]], receives a
    // numbered result list, then may select pages to read via [[read: 1,3]].
    // Both steps are capped per message; intermediate steps stay out of the
    // session — only the user's message and the final answer persist.
    const searchQueries = [];
    const readsDone = [];
    let lastResults = [];
    let pagesRead = 0;
    while (config.searchEnabled) {
        const query = search.extractQuery(text);
        // Same-query repeats are loop bait (a model can echo the prior tool
        // step from its context) — one run per distinct query per message.
        if (query && !searchQueries.includes(query) && searchQueries.length < config.searchMaxPerMessage) {
            searchQueries.push(query);
            const { block, results } = await search.run(query);
            lastResults = results;
            messages.push({ role: 'assistant', content: `[[search: ${query}]]` });
            messages.push({ role: 'user', content: block });
            ({ text, provider } = await generateChatResponse(messages));
            continue;
        }
        const idx = config.fetchEnabled && lastResults.length ? search.extractRead(text) : null;
        if (idx) {
            // Same-selection repeats are the [[read]] flavor of loop bait; the
            // key is scoped to the search so a new query re-opens selection.
            const key = `${searchQueries.length}:${idx.join(',')}`;
            if (readsDone.includes(key) || readsDone.length >= config.searchMaxPerMessage) break;
            readsDone.push(key);
            pagesRead += idx.length;
            const block = await search.readPages(searchQueries[searchQueries.length - 1], lastResults, idx);
            messages.push({ role: 'assistant', content: `[[read: ${idx.join(',')}]]` });
            messages.push({ role: 'user', content: block });
            ({ text, provider } = await generateChatResponse(messages));
            continue;
        }
        break;
    }
    text = search.stripMarkers(text) || 'Mình tìm chưa ra thông tin, thử lại sau nhé.';

    // Only successful exchanges enter history — a failed generation leaves the
    // session exactly as it was, so a retry isn't a duplicate.
    sessions.append(sessionKey, { role: 'user', name, userId, content: userText });
    sessions.append(sessionKey, { role: 'assistant', content: text });
    maybeScheduleCompaction(sessionKey); // runs after us on this session's queue
    log.info(`[ai] done session=${sessionKey} provider=${provider} history=${history.length} ` +
        `searches=${searchQueries.length} pagesRead=${pagesRead} total=${Date.now() - started}ms`);
    return { text, provider, searchQueries, pagesRead };
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
        task = enqueue(sessionKey, () => runChat(sessionKey, {
            guildId, channelId, userId, name, userText: content.slice(0, 4000),
        }), config.sessionQueueDepth);
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

async function handleAdvice(req, res) {
    if (req.method === 'GET') {
        const guildId = new URL(req.url, 'http://x').searchParams.get('guildId');
        if (!guildId) return send(res, 400, { error: 'guildId required' });
        return send(res, 200, { items: advice.list(guildId) });
    }
    const body = await readJsonBody(req);
    if (!body.guildId) return send(res, 400, { error: 'guildId required' });
    try {
        if (req.method === 'POST') return send(res, 200, { items: advice.add(body.guildId, body.text, body.author) });
        const items = advice.remove(body.guildId, body.index);
        if (items === null) return send(res, 400, { error: 'Số thứ tự không đúng.' });
        return send(res, 200, { items });
    } catch (e) {
        return send(res, 400, { error: e.message });
    }
}

const server = http.createServer((req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const task =
        route === 'POST /chat' ? handleChat(req, res) :
        route === 'DELETE /session' ? handleSessionReset(req, res) :
        route === 'GET /advice' || route === 'POST /advice' || route === 'DELETE /advice' ? handleAdvice(req, res) :
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
