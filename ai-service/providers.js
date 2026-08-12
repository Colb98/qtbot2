const log = require('../logger');
const { config, loadProviders } = require('./config');
const metrics = require('./metrics');
const trace = require('./trace');

let providers = loadProviders(log);

// Per-provider health: name -> { cooldownUntil, lastFailure }. Survives
// rebuilds so reordering doesn't wipe cooldown state.
const health = new Map();
function ensureHealth() {
    for (const p of providers) if (!health.has(p.name)) health.set(p.name, { cooldownUntil: 0, lastFailure: null });
}
ensureHealth();

// Re-read order/model config (after an admin change) without restarting.
function rebuild() {
    providers = loadProviders(log);
    ensureHealth();
    log.info(`[ai] providers rebuilt: ${providers.map(p => `${p.name}(${p.model})`).join(' → ') || '(none)'}`);
}

function setCooldown(name, ms, reason) {
    const h = health.get(name);
    h.cooldownUntil = Date.now() + ms;
    h.lastFailure = reason;
    log.warn(`[ai] provider ${name} → ${reason}, cooldown ${Math.round(ms / 1000)}s`);
}

function healthSnapshot() {
    const out = {};
    for (const [name, h] of health) {
        out[name] = {
            healthy: Date.now() >= h.cooldownUntil,
            lastFailure: h.lastFailure,
            cooldownUntil: h.cooldownUntil || null,
        };
    }
    return out;
}

// Open models sometimes emit reasoning tags or stray whitespace. Strip hard:
// closed <think> blocks anywhere, and everything from an unclosed <think> on
// (a truncated output is reasoning, never answer). A fully-eaten completion
// becomes '' → 'empty completion' upstream → normal failover, instead of
// think-text leaking into parsers or Discord replies.
function normalize(text) {
    let s = String(text || '').trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, '');
    const open = s.search(/<think>/i);
    if (open !== -1) s = s.slice(0, open);
    return s.trim();
}

class AllProvidersFailedError extends Error {
    constructor(attempts) {
        super(`All providers failed: ${attempts.map((a) => `${a.provider}: ${a.error.slice(0, 120)}`).join('; ')}`);
        this.name = 'AllProvidersFailedError';
        this.attempts = attempts; // structured [{provider, error}], for traces
    }
}

async function callProvider(p, messages, maxTokens, temperature, timeoutMs) {
    const res = await fetch(p.url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${p.key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: p.model,
            messages,
            max_tokens: maxTokens,
            temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        err.status = res.status;
        err.retryAfterMs = parseFloat(res.headers.get('retry-after')) * 1000 || null;
        throw err;
    }
    const data = await res.json();
    const text = normalize(data.choices?.[0]?.message?.content);
    if (!text) throw new Error('empty completion');
    return { text, usage: data.usage || null };
}

/**
 * Route a chat completion through the provider chain.
 * Failover on transient errors (429/5xx/timeout/network) and provider-side
 * config errors (401/403 — that provider is broken, not the request).
 * 400 means WE built a bad payload: fail immediately, don't burn the chain.
 */
async function generateChatResponse(messages, opts = {}) {
    if (!providers.length) throw new Error('No AI providers configured');
    const maxTokens = opts.maxTokens || config.maxResponseTokens;
    const temperature = opts.temperature ?? config.temperature;
    const timeoutMs = opts.timeoutMs || config.providerTimeoutMs;
    const now = Date.now();
    let eligible = providers.filter(p => now >= health.get(p.name).cooldownUntil);
    if (!eligible.length) eligible = providers; // everyone cooling down: best-effort anyway

    // usage is missing on some providers — fall back to the chars/4 estimate.
    const estimate = (list) => Math.ceil(list.reduce((n, m) => n + m.content.length, 0) / 4);

    // Qwen soft-switch: tiny-budget calls (opts.noThink — the classifier) must
    // not burn their tokens thinking. Prompt-level and per-model, decided here
    // because only this loop knows which model actually serves the call — the
    // other providers never see the directive.
    const msgsFor = (p) => {
        if (!opts.noThink || !/qwen/i.test(p.model)) return messages;
        const out = [...messages];
        const last = out[out.length - 1];
        out[out.length - 1] = { ...last, content: `${last.content}\n/no_think` };
        return out;
    };

    const attempts = [];
    for (const p of eligible) {
        const started = Date.now();
        try {
            const { text, usage } = await callProvider(p, msgsFor(p), maxTokens, temperature, timeoutMs);
            const h = health.get(p.name);
            h.cooldownUntil = 0; h.lastFailure = null; // a success clears cooldown state
            const latencyMs = Date.now() - started;
            const tokensIn = usage?.prompt_tokens ?? estimate(messages);
            const tokensOut = usage?.completion_tokens ?? Math.ceil(text.length / 4);
            metrics.provider(p.name, { ok: true, latencyMs, fallback: attempts.length > 0, tokensIn, tokensOut });
            if (opts.trace) {
                const s = trace.step(opts.trace, opts.stepType || 'generation', { provider: p.name, model: p.model });
                s.startedAt = started;
                trace.endStep(opts.trace, s, { ok: true, tokensIn, tokensOut, attempts: attempts.length ? [...attempts] : undefined, detail: text });
            }
            log.info(`[ai] provider=${p.name} model=${p.model} latency=${latencyMs}ms` +
                (usage ? ` tokens_in=${usage.prompt_tokens} tokens_out=${usage.completion_tokens}` : ''));
            // model/attempts ride along so callers that record their own trace
            // steps (classify/verify) can explain their latency.
            return { text, provider: p.name, model: p.model, attempts: attempts.length ? [...attempts] : undefined };
        } catch (e) {
            // Structured for the trace pills — full-ish message, not a stub.
            attempts.push({ provider: p.name, error: e.message.slice(0, 300) });
            metrics.provider(p.name, { ok: false, rateLimited: e.status === 429 });
            if (e.status === 400) {
                log.error(`[ai] provider ${p.name} rejected payload (our bug, no failover):`, e.message);
                recordFailedStep(opts, attempts);
                throw e;
            }
            if (e.status === 401 || e.status === 403) {
                setCooldown(p.name, 10 * 60 * 1000, `auth_error_${e.status}`);
            } else if (e.status === 429) {
                setCooldown(p.name, e.retryAfterMs || config.providerCooldownMs, 'rate_limited');
            } else {
                // 5xx / timeout / network
                setCooldown(p.name, Math.min(config.providerCooldownMs, 30000), e.name === 'TimeoutError' ? 'timeout' : `error_${e.status || e.code || 'network'}`);
            }
        }
    }
    recordFailedStep(opts, attempts);
    throw new AllProvidersFailedError(attempts);
}

function recordFailedStep(opts, attempts) {
    if (!opts.trace) return;
    const s = trace.step(opts.trace, opts.stepType || 'generation');
    trace.endStep(opts.trace, s, {
        ok: false, attempts: [...attempts],
        detail: attempts.map((a) => `${a.provider}: ${a.error}`).join('\n'),
    });
}

module.exports = { generateChatResponse, healthSnapshot, rebuild, AllProvidersFailedError, _normalize: normalize };
