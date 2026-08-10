// Offline smoke test for ai-service: fakes two OpenAI-compatible providers
// (groq always 429s, openrouter answers with <think> noise) and verifies the
// service fails over, normalizes output, and reports provider health.
//   node scripts/smoke_ai_service.js
const http = require('http');
const assert = require('assert');

function fakeProvider(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

(async () => {
    const rateLimited = await fakeProvider((req, res) => {
        res.writeHead(429, { 'retry-after': '30' });
        res.end(JSON.stringify({ error: 'rate limited' }));
    });
    const answering = await fakeProvider((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: '<think>hmm</think>  Chào bạn!' } }],
            usage: { prompt_tokens: 42, completion_tokens: 5 },
        }));
    });

    // Must be set before ai-service modules load (dotenv won't override these).
    process.env.AI_SERVICE_PORT = '3999';
    process.env.AI_PROVIDER_ORDER = 'groq,openrouter';
    process.env.GROQ_API_KEY = 'fake';
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${rateLimited.port}/v1/chat/completions`;
    process.env.OPENROUTER_API_KEY = 'fake';
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${answering.port}/v1/chat/completions`;

    require('../ai-service/index.js');
    await new Promise((r) => setTimeout(r, 300)); // let the service bind

    const chatRes = await fetch('http://127.0.0.1:3999/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u1', displayName: 'Tester', channelId: 'c1', content: 'xin chào' }),
    });
    assert.strictEqual(chatRes.status, 200, `chat status ${chatRes.status}`);
    const chat = await chatRes.json();
    assert.strictEqual(chat.text, 'Chào bạn!', `normalize failed: ${JSON.stringify(chat.text)}`);
    assert.strictEqual(chat.provider, 'openrouter', `expected failover to openrouter, got ${chat.provider}`);

    const health = await (await fetch('http://127.0.0.1:3999/health')).json();
    assert.strictEqual(health.providers.groq.healthy, false, 'groq should be cooling down after 429');
    assert.strictEqual(health.providers.groq.lastFailure, 'rate_limited');
    assert.strictEqual(health.providers.openrouter.healthy, true);

    const bad = await fetch('http://127.0.0.1:3999/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u1', content: '   ' }),
    });
    assert.strictEqual(bad.status, 400, 'empty content should be rejected');

    console.log('PASS: failover groq(429) → openrouter, <think> stripped, health + validation OK');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
