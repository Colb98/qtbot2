// Offline smoke test for ai-service (Phases 1–3). Fakes all three providers:
//   cloudflare → always 500, groq → always 429, openrouter → ECHOES the exact
//   messages array it received (so we can assert what history was sent).
// Covers: 3-provider failover, cooldowns, session history & isolation, reset,
// per-session queue depth, all-providers-fail 502, disk persistence.
//   node scripts/smoke_ai_service.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DATA_DIR = path.join(__dirname, '..', 'ai-service', 'data');
fs.rmSync(DATA_DIR, { recursive: true, force: true }); // fresh session state

function fakeProvider(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
}

const readBody = (req) => new Promise((r) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
});

const chat = (body) => fetch('http://127.0.0.1:3999/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const msgFor = (channelId, content, name = 'Tester') =>
    ({ guildId: 'g1', channelId, userId: 'u1', displayName: name, content });

(async () => {
    const cfPort = await fakeProvider((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); });
    const groqPort = await fakeProvider((req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end('{}'); });
    const orPort = await fakeProvider(async (req, res) => {
        const body = await readBody(req);
        const last = body.messages[body.messages.length - 1].content;
        if (last.includes('FORCE_FAIL')) { res.writeHead(500); return res.end('{}'); }
        if (last.includes('SLOW')) await new Promise((r) => setTimeout(r, 300));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ model: body.model, messages: body.messages }) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
    });

    // Must be set before ai-service modules load (dotenv won't override these).
    process.env.AI_SERVICE_PORT = '3999';
    process.env.AI_PROVIDER_ORDER = 'cloudflare,groq,openrouter';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'fake';
    process.env.CLOUDFLARE_API_TOKEN = 'fake';
    process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${cfPort}/v1/chat/completions`;
    process.env.GROQ_API_KEY = 'fake';
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${groqPort}/v1/chat/completions`;
    process.env.OPENROUTER_API_KEY = 'fake';
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${orPort}/v1/chat/completions`;

    require('../ai-service/index.js');
    await new Promise((r) => setTimeout(r, 300)); // let the service bind

    // 1. Failover across the full chain: cloudflare 500 → groq 429 → openrouter.
    const r1 = await chat(msgFor('chanA', 'xin chào'));
    assert.strictEqual(r1.status, 200);
    const c1 = await r1.json();
    assert.strictEqual(c1.provider, 'openrouter', `expected openrouter, got ${c1.provider}`);
    const health = (await (await fetch('http://127.0.0.1:3999/health')).json()).providers;
    assert.strictEqual(health.cloudflare.healthy, false);
    assert.strictEqual(health.cloudflare.lastFailure, 'error_500');
    assert.strictEqual(health.groq.healthy, false);
    assert.strictEqual(health.groq.lastFailure, 'rate_limited');
    assert.strictEqual(health.openrouter.healthy, true);
    console.log('ok 1 — failover cloudflare(500) → groq(429) → openrouter, cooldowns recorded');

    // 2. History: second message in the same channel carries the first exchange,
    //    with the speaker-name prefix.
    const c2 = await (await chat(msgFor('chanA', 'câu thứ hai'))).json();
    assert.ok(c2.text.includes('Tester: xin chào'), 'history should contain first user turn with name prefix');
    assert.ok(c2.text.includes('"role":"assistant"'), 'history should contain first assistant turn');
    console.log('ok 2 — session history with speaker names reaches the model');

    // 3. Isolation: another channel must not see chanA's conversation.
    const c3 = await (await chat(msgFor('chanB', 'kênh khác'))).json();
    assert.ok(!c3.text.includes('xin chào'), 'channel B leaked channel A history');
    console.log('ok 3 — channel sessions are isolated');

    // 4. Reset clears the session.
    const rr = await fetch('http://127.0.0.1:3999/session', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'g1', channelId: 'chanA' }),
    });
    assert.strictEqual((await rr.json()).existed, true);
    const c4 = await (await chat(msgFor('chanA', 'sau reset'))).json();
    assert.ok(!c4.text.includes('xin chào'), 'history survived reset');
    console.log('ok 4 — !ai reset wipes the channel session');

    // 5. Queue depth: 6 concurrent generations on one session → 3 run, 3 busy.
    const burst = await Promise.all(
        Array.from({ length: 6 }, (_, i) => chat(msgFor('chanC', `SLOW ${i}`)).then((r) => r.status)));
    assert.strictEqual(burst.filter((s) => s === 200).length, 3, `statuses: ${burst}`);
    assert.strictEqual(burst.filter((s) => s === 429).length, 3, `statuses: ${burst}`);
    console.log('ok 5 — per-session queue caps at 3, overflow returns 429');

    // 6. Everything down (cf+groq cooling, openrouter forced to fail) → clean 502,
    //    and the failed exchange must not pollute history.
    const rf = await chat(msgFor('chanD', 'FORCE_FAIL'));
    assert.strictEqual(rf.status, 502, `expected 502, got ${rf.status}`);
    console.log('ok 6 — all providers failing → graceful 502');

    // 7. Persistence: flushed file reflects post-reset state only.
    require('../ai-service/sessions').flushSync();
    const disk = fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8');
    assert.ok(disk.includes('sau reset'), 'disk should contain current chanA session');
    assert.ok(!disk.includes('xin chào'), 'disk should not contain pre-reset history');
    assert.ok(!disk.includes('FORCE_FAIL'), 'failed generations must not enter history');
    console.log('ok 7 — sessions persist to disk, failed exchanges excluded');

    // 8. Admin config: snapshot reflects env order and configured creds.
    const snap = await (await fetch('http://127.0.0.1:3999/admin/config')).json();
    assert.deepStrictEqual(snap.order, ['cloudflare', 'groq', 'openrouter']);
    assert.ok(snap.providers.every((p) => p.configured), 'all fakes have creds');
    console.log('ok 8 — GET /admin/config snapshot');

    // 9. Reorder + model override apply live, no restart; success clears cooldown.
    const put = await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerOrder: ['openrouter'], models: { openrouter: 'my-custom-model' } }),
    });
    assert.strictEqual(put.status, 200);
    const c9 = await (await chat(msgFor('chanE', 'sau đổi config'))).json();
    assert.strictEqual(c9.provider, 'openrouter');
    assert.ok(c9.text.includes('my-custom-model'), 'model override should reach the provider');
    const snap9 = await (await fetch('http://127.0.0.1:3999/admin/config')).json();
    assert.strictEqual(snap9.providers.find((p) => p.name === 'openrouter').health.healthy, true,
        'success should clear cooldown');
    const overridesDisk = fs.readFileSync(path.join(DATA_DIR, 'overrides.json'), 'utf8');
    assert.ok(overridesDisk.includes('my-custom-model'), 'overrides should persist to disk');
    console.log('ok 9 — reorder + model override applied live and persisted');

    // 10. Validation: unknown provider names and oversized models are rejected.
    const bad1 = await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerOrder: ['bogus'] }),
    });
    assert.strictEqual(bad1.status, 400);
    const bad2 = await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { openrouter: 'x'.repeat(200) } }),
    });
    assert.strictEqual(bad2.status, 400);
    console.log('ok 10 — admin config validation rejects bad input');

    console.log('PASS: all Phase 1–3 + admin smoke checks green');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
