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

// Open models sometimes emit reasoning tags or stray whitespace.
function normalize(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^<think>[\s\S]*/i, '') // unclosed think block: model never got to the answer
        .trim();
}

class AllProvidersFailedError extends Error {
    constructor(attempts) {
        super(`All providers failed: ${attempts.join('; ')}`);
        this.name = 'AllProvidersFailedError';
    }
}

async function callProvider(p, messages, maxTokens, temperature) {
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
        signal: AbortSignal.timeout(config.providerTimeoutMs),
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
    const now = Date.now();
    let eligible = providers.filter(p => now >= health.get(p.name).cooldownUntil);
    if (!eligible.length) eligible = providers; // everyone cooling down: best-effort anyway

    // usage is missing on some providers — fall back to the chars/4 estimate.
    const estimate = (list) => Math.ceil(list.reduce((n, m) => n + m.content.length, 0) / 4);

    const attempts = [];
    for (const p of eligible) {
        const started = Date.now();
        try {
            const { text, usage } = await callProvider(p, messages, maxTokens, temperature);
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
            return { text, provider: p.name };
        } catch (e) {
            attempts.push(`${p.name}: ${e.message.slice(0, 120)}`);
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
    trace.endStep(opts.trace, s, { ok: false, attempts: [...attempts], detail: attempts.join('; ') });
}

module.exports = { generateChatResponse, healthSnapshot, rebuild, AllProvidersFailedError, _normalize: normalize };
