// Offline smoke test for ai-service (Phases 1–6). Fakes all three providers:
//   cloudflare → always 500, groq → always 429, openrouter → ECHOES the exact
//   messages array it received (so we can assert what history was sent).
// Covers: 3-provider failover, cooldowns, session history & isolation, reset,
// per-session queue depth, all-providers-fail 502, disk persistence, search
// loop, reasoning flow (classify + hidden think), metrics, request traces,
// and restart-recovery drills (clean restart + truncated data files).
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
const msgFor = (channelId, content, name = 'Tester', userId = 'u1') =>
    ({ guildId: 'g1', channelId, userId, displayName: name, content });

(async () => {
    const cfPort = await fakeProvider((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); });
    const groqPort = await fakeProvider((req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end('{}'); });
    const orPort = await fakeProvider(async (req, res) => {
        // OpenAI-compat model listing — includes a gemini-style "models/" prefix
        // and an audio model that the service must filter out.
        if (req.method === 'GET' && req.url.includes('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ data: [{ id: 'models/model-b' }, { id: 'model-a' }, { id: 'whisper-large-v3' }] }));
        }
        const body = await readBody(req);
        const last = body.messages[body.messages.length - 1].content;
        // Reasoning classifier: mode picked by marker in the question;
        // FORCE_CLASSIFY_FAIL simulates a broken classifier (must fail open).
        // A qwen-named model "thinks" unless the /no_think soft-switch arrived.
        if (body.messages[0].content.includes('routing classifier')) {
            if (last.includes('FORCE_CLASSIFY_FAIL')) { res.writeHead(500); return res.end('{}'); }
            if (last.includes('SLOW_CLASSIFY')) await new Promise((r) => setTimeout(r, 300));
            if (/qwen/i.test(body.model) && !last.includes('/no_think')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    choices: [{ message: { content: '<think>\nOkay, the user' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 8 },
                }));
            }
            const label = last.includes('SUY_LUẬN') ? 'RESEARCH' : last.includes('TÌNH_HUỐNG') ? 'SOCIAL' : 'NOW';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: label } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        // Social single-pass reply, keyed on its instruction wording; a
        // VERIFY_BAIT conversation gets a deliberately-bad draft.
        if (last.includes('social/boundary situation')) {
            const bad = JSON.stringify(body.messages).includes('VERIFY_BAIT');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: bad
                    ? 'DRAFT_SAI: trả lời lạc đề hoàn toàn.'
                    : 'PUNCHLINE: Đá bằng niềm tin hả sếp? Em có nút kick đâu.' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        // Verifier: fail only the marked-bad draft.
        if (body.messages[0].content.includes('reply checker')) {
            const fail = last.includes('DRAFT_SAI');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: fail
                    ? '{"pass": false, "reason": "missed the question"}'
                    : '{"pass": true}' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        // Persona-free task analysis (think/research), keyed on its header.
        if (last.includes('[Task analysis')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: 'intent: compare builds\nconclusion: KẾ HOẠCH: so sánh 3 ý chính rồi kết luận.' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        if (last.includes('FORCE_FAIL')) { res.writeHead(500); return res.end('{}'); }
        // normalize() drills: closed think block with leading whitespace, and
        // a truncated (unclosed) one that must strip to nothing.
        if (last.includes('THINK_LEAK')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: '\n<think>lảm nhảm nội bộ</think>OK_SẠCH' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        if (last.includes('THINK_TRUNC')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: '\n<think>bị cắt giữa chừng' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        if (last.includes('SLOW')) await new Promise((r) => setTimeout(r, 300));
        // A user message containing DÙNG_SEARCH makes the "model" request a web
        // search; on the result list it selects page 1 to read; once page
        // contents come back it echoes as usual.
        if (last.includes('DÙNG_SEARCH') && !last.includes('Search results')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: '[[search: giá vàng hôm nay]]' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        if (last.includes('[Search results')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: '[[read: 1]]' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        // Memory-update prompts get a fixed rewrite — including a user who never
        // spoke (u999), which the service must refuse to write.
        if (body.messages[0].content.includes('LONG-TERM MEMORY')) {
            // Two-tier shape: Core + dated Recent, incl. an expired bullet the
            // code-level pruneExpired backstop must drop (test 13b).
            const today = new Date().toISOString().slice(0, 10);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                choices: [{ message: { content: JSON.stringify({
                    server: 'Server hay bàn guild war',
                    channel: 'Kênh test nói về game',
                    users: {
                        u1: `## Core\n- Tester hay hỏi về guild war\n## Recent\n- (2020-01-01) chuyện cũ mèm phải quên\n- (${today}) đang cày event`,
                        u999: 'kẻ lạ không được ghi',
                    },
                }) } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ model: body.model, messages: body.messages }) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
    });

    // Tavily fake leads with a video result — the domain filter must divert it
    // so the readable numbered list starts at the text page.
    const searchPort = await fakeProvider((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            results: [
                { title: 'Video giá vàng', url: 'https://www.tiktok.com/@x/video/123', content: 'xem video nhé' },
                { title: 'Giá vàng SJC', url: 'https://example.com/gold', content: 'Giá vàng hôm nay 88 triệu/lượng' },
            ],
        }));
    });
    // Serper (primary backend) returns nothing → cascade must fall through to
    // Tavily. Jina reader fake serves full page content for the result URL.
    const serperPort = await fakeProvider((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ organic: [] }));
    });
    const jinaPort = await fakeProvider((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('BÀI VIẾT ĐẦY ĐỦ: Giá vàng SJC hôm nay niêm yết 88,5 triệu đồng/lượng chiều bán ra, ' +
            'tăng 300 nghìn so với hôm qua. Vàng nhẫn 9999 giao dịch quanh 76,2 triệu đồng/lượng. ' +
            'Chuyên gia dự báo giá còn biến động theo đà thế giới.');
    });

    // Must be set before ai-service modules load (dotenv won't override these).
    // Compaction thresholds are tiny so it triggers within a few (huge, echoed)
    // exchanges; session caps are huge so the emergency trim never interferes.
    process.env.AI_COMPACT_THRESHOLD_TOKENS = '150';
    process.env.AI_COMPACT_KEEP_RECENT = '2';
    process.env.AI_SESSION_MAX_TOKENS = '100000';
    process.env.AI_SESSION_MAX_MESSAGES = '200';
    process.env.AI_SERVICE_PORT = '3999';
    process.env.AI_PROVIDER_ORDER = 'cloudflare,groq,openrouter';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'fake';
    process.env.CLOUDFLARE_API_TOKEN = 'fake';
    process.env.CLOUDFLARE_BASE_URL = `http://127.0.0.1:${cfPort}/v1/chat/completions`;
    process.env.GROQ_API_KEY = 'fake';
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${groqPort}/v1/chat/completions`;
    process.env.OPENROUTER_API_KEY = 'fake';
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${orPort}/v1/chat/completions`;
    process.env.XAI_API_KEY = 'fake';
    process.env.XAI_BASE_URL = `http://127.0.0.1:${orPort}/v1/chat/completions`; // same echo server
    process.env.GEMINI_API_KEY = 'fake';
    process.env.GEMINI_BASE_URL = `http://127.0.0.1:${orPort}/v1/chat/completions`; // same echo server
    process.env.TAVILY_API_KEY = 'fake';
    process.env.TAVILY_BASE_URL = `http://127.0.0.1:${searchPort}/search`;
    process.env.SERPER_API_KEY = 'fake';
    process.env.SERPER_BASE_URL = `http://127.0.0.1:${serperPort}/search`;
    process.env.JINA_BASE_URL = `http://127.0.0.1:${jinaPort}/`;

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

    // 11. Grok (xAI) provider routes and uses its default model.
    await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerOrder: ['grok'] }),
    });
    const c11 = await (await chat(msgFor('chanF', 'thử grok'))).json();
    assert.strictEqual(c11.provider, 'grok');
    assert.ok(c11.text.includes('grok-4.5'), `grok default model should apply, got: ${c11.text.slice(0, 80)}`);
    console.log('ok 11 — grok (xAI) provider works with default model');

    // 11b. Gemini (Google) provider routes and uses its default model.
    await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerOrder: ['gemini'] }),
    });
    const c11b = await (await chat(msgFor('chanF2', 'thử gemini'))).json();
    assert.strictEqual(c11b.provider, 'gemini');
    assert.ok(c11b.text.includes('gemini-2.5-flash'), `gemini default model should apply, got: ${c11b.text.slice(0, 80)}`);
    console.log('ok 11b — gemini (Google) provider works with default model');

    // 12. Compaction: after several exchanges the old messages are folded into
    // a rolling summary (carried in the system message) and only the recent
    // tail stays verbatim. The echo provider makes this inspectable: parse the
    // reply to see exactly what context the model received.
    await chat(msgFor('chanG', 'nói về guild war nhé'));
    await chat(msgFor('chanG', 'tin nhắn thứ hai'));
    await chat(msgFor('chanG', 'tin nhắn thứ ba'));
    await new Promise((r) => setTimeout(r, 400)); // let queued compaction run
    const c12 = await (await chat(msgFor('chanG', 'còn nhớ gì không?'))).json();
    const payload = JSON.parse(c12.text);
    assert.strictEqual(payload.messages[0].role, 'system');
    assert.ok(payload.messages[0].content.includes('Summary of earlier conversation'),
        'system message should carry the rolling summary');
    assert.ok(payload.messages[0].content.includes('nói về guild war'),
        'old content should survive inside the summary');
    assert.strictEqual(payload.messages.length, 4,
        `context should be system + ${process.env.AI_COMPACT_KEEP_RECENT} kept + 1 new, got ${payload.messages.length}`);
    console.log('ok 12 — compaction folds old messages into summary, keeps recent tail');

    // 13. Memory promotion: compaction wrote scoped memory files; the
    // non-speaker (u999) file must have been refused.
    await new Promise((r) => setTimeout(r, 300)); // let the mem:g1 queue drain
    const memDir = path.join(DATA_DIR, 'memory');
    assert.ok(fs.readFileSync(path.join(memDir, 'server-g1.md'), 'utf8').includes('guild war'));
    assert.ok(fs.readFileSync(path.join(memDir, 'channel-chanG.md'), 'utf8').includes('Kênh test'));
    assert.ok(fs.readFileSync(path.join(memDir, 'user-u1.md'), 'utf8').includes('Tester hay hỏi'));
    assert.ok(!fs.existsSync(path.join(memDir, 'user-u999.md')), 'non-speaker memory must be refused');
    console.log('ok 13 — memory promoted on compaction, non-speaker write refused');

    // 13b. Aging backstop: the expired dated Recent bullet dies in code even
    // though the fake model returned it; fresh dated + Core bullets survive.
    const u1mem = fs.readFileSync(path.join(memDir, 'user-u1.md'), 'utf8');
    assert.ok(!u1mem.includes('2020-01-01'), 'expired Recent bullet must be pruned');
    assert.ok(u1mem.includes('## Core'), 'Core section survives');
    assert.ok(u1mem.includes('đang cày event'), 'fresh Recent bullet survives');
    console.log('ok 13b — expired Recent bullets pruned deterministically, Core kept');

    // 14. Scoped retrieval + isolation: u1 sees own memory; u2 sees server
    // memory but never u1's file; chanB (never compacted) has no channel memory.
    const c14a = JSON.parse((await (await chat(msgFor('chanG', 'nhớ gì về tôi?'))).json()).text);
    assert.ok(c14a.messages[0].content.includes('Server memory'));
    assert.ok(c14a.messages[0].content.includes('Tester hay hỏi'), 'u1 should get own memory');
    const c14b = JSON.parse((await (await chat(msgFor('chanB', 'chào', 'Khách', 'u2'))).json()).text);
    assert.ok(c14b.messages[0].content.includes('Server memory'), 'server memory is shared');
    assert.ok(!c14b.messages[0].content.includes('Tester hay hỏi'), 'u1 memory leaked to u2');
    assert.ok(!c14b.messages[0].content.includes('Channel memory'), 'chanB has no channel memory');
    console.log('ok 14 — retrieval scoped to server + channel + speaker; no cross-user leak');

    // 15. Two-step search tool loop: model emits [[search: ...]] → cascade
    // runs (serper empty → tavily hits) → model gets the numbered result list
    // and selects [[read: 1]] → page fetched via jina reader → regenerates
    // with full page content as labeled untrusted context. Final answer
    // (echo) proves the result list, the selected page's content and the
    // original question were all in the last generation's context.
    const c15 = await (await chat(msgFor('chanH', 'DÙNG_SEARCH giá vàng bao nhiêu?'))).json();
    assert.deepStrictEqual(c15.searchQueries, ['giá vàng hôm nay']);
    assert.strictEqual(c15.pagesRead, 1, 'exactly one page should have been read');
    assert.ok(c15.text.includes('Search results'), 'results block should reach the model');
    assert.ok(c15.text.includes('Giá vàng SJC'), 'search result title should reach the model');
    assert.ok(c15.text.includes('[Page contents'), 'page contents block should reach the model');
    assert.ok(c15.text.includes('BÀI VIẾT ĐẦY ĐỦ'), 'selected page content should reach the model');
    assert.ok(c15.text.includes('DÙNG_SEARCH giá vàng bao nhiêu?'), 'original question should stay in context');
    assert.ok(!c15.text.includes('Source: https://www.tiktok.com'),
        'video results must never appear in the numbered/readable list');
    assert.ok(c15.text.includes('video result(s) hidden'), 'hidden-video note should reach the model');
    console.log('ok 15 — search → select → read-pages loop grounds the answer; video results filtered');

    // 16. RULES.md + member advice: both must reach the system prompt; advice
    // is capped and removable.
    const adv = await fetch('http://127.0.0.1:3999/advice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'g1', text: 'Luôn trả lời kèm emoji 🦆', author: 'Tester' }),
    });
    assert.strictEqual(adv.status, 200);
    const c16 = JSON.parse((await (await chat(msgFor('chanB', 'test quy tắc'))).json()).text);
    assert.ok(c16.messages[0].content.includes('RULES — reply rules'), 'RULES.md should be in the system prompt');
    assert.ok(c16.messages[0].content.includes('Luôn trả lời kèm emoji'), 'member advice should be in the system prompt');
    const advDel = await fetch('http://127.0.0.1:3999/advice', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'g1', index: 0 }),
    });
    assert.strictEqual((await advDel.json()).items.length, 0);
    const c16b = JSON.parse((await (await chat(msgFor('chanB', 'sau khi xoá'))).json()).text);
    assert.ok(!c16b.messages[0].content.includes('Luôn trả lời kèm emoji'), 'removed advice must leave the prompt');
    const advBad = await fetch('http://127.0.0.1:3999/advice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId: 'g1', text: 'x'.repeat(400) }),
    });
    assert.strictEqual(advBad.status, 400, 'oversized advice must be rejected');
    console.log('ok 16 — RULES.md + member advice in prompt; add/remove/caps work');

    const getTraces = async (id) =>
        (await fetch('http://127.0.0.1:3999/admin/traces' + (id ? `?id=${encodeURIComponent(id)}` : ''))).json();
    const getMetrics = async () => (await fetch('http://127.0.0.1:3999/admin/metrics')).json();

    // 17. Reasoning fast-path: a short message never reaches the classifier —
    // trace shows classify skipped-short and no think step.
    await chat(msgFor('chanI', 'ngắn thôi'));
    const t17 = (await getTraces()).traces[0];
    assert.ok(t17.steps.includes('classify:immediate'), `steps: ${t17.steps}`);
    assert.ok(!t17.steps.includes('think'), 'short message must not trigger a think step');
    const d17 = await getTraces(t17.id);
    assert.strictEqual(d17.steps[0].reason, 'skipped-short');
    assert.strictEqual(d17.status, 'ok');
    console.log('ok 17 — short messages skip the classifier, trace records skipped-short');

    // 18. Deep path: classifier says DEEP → hidden think pass grounds the final
    // generation (echo proves it was in context) but never persists — the
    // follow-up request's context is exactly system + 2 history + 1 new.
    const c18 = await (await chat(msgFor('chanI',
        'SUY_LUẬN so sánh vàng SJC và vàng nhẫn, cái nào đáng mua hơn lúc này?'))).json();
    assert.ok(c18.text.includes('KẾ HOẠCH'), 'analysis should be in the final generation context');
    assert.ok(c18.text.includes('[Task analysis]'), 'analysis turn should be framed as internal notes');
    const t18 = (await getTraces()).traces[0];
    assert.ok(t18.steps.includes('classify:research'), `steps: ${t18.steps}`);
    assert.ok(t18.steps.includes('analyze'), `steps: ${t18.steps}`);
    const d18 = await getTraces(t18.id);
    assert.ok(d18.steps.find((s) => s.type === 'classify').provider,
        'classify step must record which provider served it');
    const analyzeStep = d18.steps.find((s) => s.type === 'analyze');
    assert.ok(analyzeStep && analyzeStep.detail.includes('KẾ HOẠCH'), 'trace must carry the analysis text');
    const c18b = JSON.parse((await (await chat(msgFor('chanI', 'câu tiếp ngắn'))).json()).text);
    assert.strictEqual(c18b.messages.length, 4,
        `analysis turns must be ephemeral: expected system + 2 history + 1 new, got ${c18b.messages.length}`);
    // The echoed reply *text* embeds the whole context (that's the echo), so
    // check turns, not substrings: no persisted turn may BE an analysis turn.
    assert.ok(!c18b.messages.some((m) => m.content.startsWith('[Task analysis]') || m.content.startsWith('[Phân tích tác vụ')),
        'analysis turn leaked into session history');
    console.log('ok 18 — research path: hidden think grounds the answer, stays out of the session');

    // 18b. Social fast-path: draft passes the verifier → shipped verbatim,
    // no second generation, no search loop.
    const c18c = await (await chat(msgFor('chanI',
        'TÌNH_HUỐNG đá con Mị Siu ra khỏi server giùm cái coi bot ơi'))).json();
    assert.strictEqual(c18c.text, 'PUNCHLINE: Đá bằng niềm tin hả sếp? Em có nút kick đâu.',
        `verified social draft must ship verbatim, got: ${c18c.text.slice(0, 80)}`);
    const t18b = (await getTraces()).traces[0];
    assert.ok(t18b.steps.includes('classify:social'), `steps: ${t18b.steps}`);
    assert.ok(t18b.steps.includes('verify'), `verifier must gate the draft, steps: ${t18b.steps}`);
    assert.ok(!t18b.steps.includes('gen('), `no second generation on PASS, steps: ${t18b.steps}`);
    const d18b = await getTraces(t18b.id);
    assert.strictEqual(d18b.steps.find((s) => s.type === 'verify').result, 'pass');
    assert.ok(d18b.steps.find((s) => s.type === 'draft').detail.includes('PUNCHLINE'), 'trace must carry the draft');
    console.log('ok 18b — social draft verified PASS ships verbatim, single pass');

    // 18c. Verifier FAIL: bad draft → regenerate WITH the concrete objection;
    // the echoed reply proves both the draft and the feedback were in context.
    const c18d = await (await chat(msgFor('chanI',
        'TÌNH_HUỐNG VERIFY_BAIT hỏi một đằng trả lời một nẻo thử coi nha bot'))).json();
    assert.ok(c18d.text.includes('DRAFT_SAI'), 'rejected draft should be in the regeneration context');
    assert.ok(c18d.text.includes('bị loại vì: missed the question'), 'verifier reason should reach the retry');
    const t18c = (await getTraces()).traces[0];
    assert.ok(t18c.steps.includes('verify'), `steps: ${t18c.steps}`);
    assert.ok(t18c.steps.includes('gen('), `FAIL must trigger a regeneration, steps: ${t18c.steps}`);
    assert.strictEqual((await getTraces(t18c.id)).steps.find((s) => s.type === 'verify').result, 'fail');
    console.log('ok 18c — verifier FAIL regenerates with specific feedback');

    // 19. Fail-open: a broken classifier must degrade to an immediate answer,
    // never a failed request.
    const r19 = await chat(msgFor('chanI',
        'FORCE_CLASSIFY_FAIL câu hỏi này đủ dài để vượt ngưỡng gọi classifier nhé'));
    assert.strictEqual(r19.status, 200, 'classifier failure must not fail the chat');
    const d19 = await getTraces((await getTraces()).traces[0].id);
    const cls19 = d19.steps.find((s) => s.type === 'classify');
    assert.strictEqual(cls19.ok, false);
    assert.strictEqual(cls19.result, 'error-fallback');
    console.log('ok 19 — classifier failure fails open to an immediate answer');

    // 20. Metrics counters + atomic persistence.
    const m20 = await getMetrics();
    assert.ok(m20.today.messages > 0, 'messages counted');
    assert.ok(m20.today.classifyResearch >= 1, 'research classification counted');
    assert.ok(m20.today.classifySocial >= 1, 'social classification counted');
    assert.ok(m20.today.verifyFails >= 1, 'verifier rejection counted');
    assert.ok(m20.today.thinkSteps >= 1, 'think steps counted');
    assert.ok(m20.today.searches >= 1, 'searches counted');
    assert.ok(m20.today.pagesRead >= 1, 'page reads counted');
    assert.ok(m20.today.compactions >= 1, 'compactions counted');
    assert.ok(m20.today.perUser.u1 > 0, 'per-user counts');
    assert.ok(Object.keys(m20.today.providers).length > 0, 'per-provider counters exist');
    require('../ai-service/metrics').flushSync();
    const metricsDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'metrics.json'), 'utf8'));
    assert.ok(Object.keys(metricsDisk.days).length >= 1, 'metrics persisted');
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'metrics.json.tmp')), 'atomic write leaves no tmp file');
    console.log('ok 20 — metrics counted and persisted atomically');

    // 21. Restart recovery drill: sessions + metrics survive a clean restart,
    // traces are volatile by design (in-memory ring only).
    const preMessages = m20.today.messages;
    const restartService = async (corrupt) => {
        const svc = require('../ai-service/index.js');
        require('../ai-service/sessions').flushSync();
        require('../ai-service/metrics').flushSync();
        svc.server.closeAllConnections();
        await new Promise((r) => svc.server.close(r));
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}ai-service${path.sep}`)) delete require.cache[key];
        }
        if (corrupt) corrupt();
        require('../ai-service/index.js');
        await new Promise((r) => setTimeout(r, 300));
    };
    await restartService();
    const c21 = JSON.parse((await (await chat(msgFor('chanA', 'sau restart nhé'))).json()).text);
    assert.ok(JSON.stringify(c21.messages).includes('sau reset'), 'chanA history must survive restart');
    const m21 = await getMetrics();
    assert.ok(m21.today.messages >= preMessages, 'metrics must survive restart');
    const t21 = (await getTraces()).traces;
    assert.strictEqual(t21.length, 1, `traces are volatile by design; expected only the post-restart request, got ${t21.length}`);
    console.log('ok 21 — restart drill: sessions + metrics restored, traces reset as designed');

    // 22. Truncated-file drill: a crash mid-write must not brick the boot —
    // the service starts fresh instead of crashing on corrupt JSON.
    await restartService(() => {
        fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), '{"truncated');
        fs.writeFileSync(path.join(DATA_DIR, 'metrics.json'), '{"truncated');
    });
    const h22 = await fetch('http://127.0.0.1:3999/health');
    assert.strictEqual(h22.status, 200, 'service must boot with corrupt data files');
    const r22 = await chat(msgFor('chanA', 'vẫn sống chứ?'));
    assert.strictEqual(r22.status, 200, 'chat must work after corrupt-file boot');
    console.log('ok 22 — truncated data files do not brick the service');

    // 23. Ambient channel context: nearest channel messages reach the system
    // prompt as a labeled untrusted block, entries already in the session are
    // deduped, and the block is never persisted to the session.
    await chat(msgFor('chanK', 'xin chào kênh K'));
    const r23 = await chat({
        ...msgFor('chanK', 'mọi người đang nói gì vậy?'),
        recent: [
            { name: 'Người lạ', content: 'hôm nay đi ăn lẩu không?' },
            { name: 'GameBot', content: '🎰 Kết quả xổ số: 8-8-8' },
            { name: 'Tester', content: 'xin chào kênh K' }, // already in session → dedup
        ],
    });
    const c23 = JSON.parse((await r23.json()).text);
    const sys23 = c23.messages[0].content;
    const ambientBlock = sys23.slice(sys23.indexOf('ambient context'));
    assert.ok(sys23.includes('Latest messages in this channel'), 'ambient block should be in the system prompt');
    assert.ok(ambientBlock.includes('Người lạ: hôm nay đi ăn lẩu không?'), 'ambient messages should reach the model');
    assert.ok(ambientBlock.includes('GameBot: 🎰 Kết quả xổ số: 8-8-8'), 'bot announcements are context too');
    assert.ok(!ambientBlock.includes('xin chào kênh K'), 'session turns must be deduped from ambient context');
    require('../ai-service/sessions').flushSync();
    // The echoed *reply* legitimately contains the system prompt (echo provider),
    // so check turns: ambient must never be appended as a session message.
    const disk23 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
    const sessK = disk23['ch:g1:chanK'];
    assert.strictEqual(sessK.messages.length, 4, 'only the 2 real exchanges persist');
    assert.ok(sessK.messages.filter((m) => m.role === 'user').every((m) => !m.content.includes('đi ăn lẩu')),
        'ambient context must never persist as session turns');
    console.log('ok 23 — ambient channel context injected, deduped, never persisted');

    // 24. Model listing for the dashboard combo-box: real provider ids only —
    // "models/" prefix stripped, non-chat models filtered, unknown provider 400.
    const m24 = await (await fetch('http://127.0.0.1:3999/admin/models?provider=openrouter')).json();
    assert.deepStrictEqual(m24.models, ['model-a', 'model-b'],
        `expected filtered+sorted ids, got ${JSON.stringify(m24)}`);
    assert.strictEqual((await fetch('http://127.0.0.1:3999/admin/models?provider=bogus')).status, 400);
    console.log('ok 24 — /admin/models lists real provider models, filtered and prefix-stripped');

    // 25. Reasoning-tag hygiene: closed <think> blocks (even with leading
    // whitespace) are stripped from replies; a truncated unclosed one strips
    // to nothing → empty completion → failover/502, never think-text on Discord.
    const c25 = await (await chat(msgFor('chanM', 'THINK_LEAK nè'))).json();
    assert.strictEqual(c25.text, 'OK_SẠCH', `think block must be stripped, got: ${c25.text.slice(0, 60)}`);
    const r25 = await chat(msgFor('chanM', 'THINK_TRUNC nè'));
    assert.strictEqual(r25.status, 502, 'truncated think must become empty completion, not a leaked reply');
    console.log('ok 25 — <think> blocks never reach Discord (stripped or failed over)');

    // 26. Qwen soft-switch: with a qwen model serving, the classifier call
    // carries /no_think — without it the fake "thinks" and the label is lost.
    await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { gemini: 'qwen-test-27b' } }),
    });
    const c26 = await (await chat(msgFor('chanM',
        'SUY_LUẬN so sánh hai build này giúp em với nha, cái nào ngon hơn?'))).json();
    const t26 = (await getTraces()).traces[0];
    assert.ok(t26.steps.includes('classify:research'),
        `classifier must get /no_think under qwen and still label correctly, steps: ${t26.steps}`);
    assert.ok(c26.text.includes('KẾ HOẠCH'), 'analysis should still ground the answer under qwen');
    await fetch('http://127.0.0.1:3999/admin/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { gemini: '' } }),
    });
    console.log('ok 26 — /no_think reaches qwen-served classifier calls only');

    // 27. Latency guards, via a restart with a tight budget + short reasoning
    // timeout (env is read at module load):
    process.env.AI_CHAT_BUDGET_MS = '1';
    process.env.AI_REASONING_TIMEOUT_MS = '100';
    await restartService();
    // 27a. Over-budget: the model asks for a search but no round may start —
    // markers stripped, fallback line ships instead of a reply nobody would see.
    const c27 = await (await chat(msgFor('chanN', 'DÙNG_SEARCH giá vàng bao nhiêu?'))).json();
    assert.deepStrictEqual(c27.searchQueries, [], 'no search round may start past the budget');
    assert.strictEqual(c27.text, 'Mình tìm chưa ra thông tin, thử lại sau nhé.',
        `expected the stripped-marker fallback, got: ${c27.text.slice(0, 60)}`);
    // 27b. Sick-provider classify: 300ms response vs 100ms reasoning timeout →
    // fast TimeoutError → fail-open to immediate, chat still succeeds.
    const r27 = await chat(msgFor('chanN', 'SLOW_CLASSIFY câu này đủ dài để bị đem đi phân loại nè bot'));
    assert.strictEqual(r27.status, 200, 'slow classifier must fail open, not fail the chat');
    const d27 = await getTraces((await getTraces()).traces[0].id);
    assert.strictEqual(d27.steps.find((s) => s.type === 'classify').result, 'error-fallback');
    console.log('ok 27 — time budget stops search rounds; short reasoning timeout fails over fast');

    // 28. Memory admin CRUD (files survived both restart drills — only
    // sessions/metrics were truncated).
    const memApi = 'http://127.0.0.1:3999/admin/memory';
    const list28 = (await (await fetch(memApi)).json()).files;
    assert.ok(list28.length >= 3, `expected server/channel/user files, got ${list28.length}`);
    assert.ok(list28.every((f) => f.scope && f.preview !== undefined && f.size > 0), 'list carries scope/preview/size');
    const got = await (await fetch(`${memApi}?file=user-u1.md`)).json();
    assert.ok(got.content.includes('Tester hay hỏi'), 'file content readable');
    const put28 = await fetch(memApi, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'user-u1.md', content: '## Core\n- Tester đã được admin sửa tay' }),
    });
    assert.strictEqual(put28.status, 200);
    assert.ok((await (await fetch(`${memApi}?file=user-u1.md`)).json()).content.includes('sửa tay'), 'edit persisted');
    for (const bad of ['../../etc/passwd', 'user-x.txt', 'sessions.json', 'user-..%2F.md']) {
        const r = await fetch(memApi, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: bad, content: 'x' }),
        });
        assert.strictEqual(r.status, 400, `bad name must be rejected: ${bad}`);
    }
    const del28 = await fetch(memApi, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'user-u1.md' }),
    });
    assert.strictEqual(del28.status, 200);
    assert.strictEqual((await fetch(`${memApi}?file=user-u1.md`)).status, 404, 'deleted file must 404');
    assert.ok(!(await (await fetch(memApi)).json()).files.some((f) => f.file === 'user-u1.md'), 'deleted file left the list');
    console.log('ok 28 — memory admin CRUD works, name whitelist blocks traversal');

    console.log('PASS: all Phase 1–6 + reasoning + traces + admin smoke checks green');
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
