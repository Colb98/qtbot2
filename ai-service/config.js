// Loads the same .env as the bot (repo root on dev, /root/qtbot on VPS).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

function int(name, def) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) ? v : def;
}

const config = {
    port: int('AI_SERVICE_PORT', 3001),
    host: '127.0.0.1', // never expose publicly: auth happens in the bot process
    maxResponseTokens: int('AI_MAX_RESPONSE_TOKENS', 800),
    providerTimeoutMs: int('AI_PROVIDER_TIMEOUT_MS', 30000),
    providerCooldownMs: int('AI_PROVIDER_COOLDOWN_MS', 60000),
    temperature: Number(process.env.AI_TEMPERATURE) || 0.7,
    sessionMaxMessages: int('AI_SESSION_MAX_MESSAGES', 30),
    sessionMaxTokens: int('AI_SESSION_MAX_TOKENS', 3000),
    sessionQueueDepth: int('AI_SESSION_QUEUE_DEPTH', 3),
    providerOrder: (process.env.AI_PROVIDER_ORDER || 'groq,cloudflare,openrouter')
        .split(',').map(s => s.trim()).filter(Boolean),
};

// Provider catalog. All three speak the OpenAI chat-completions format, so a
// provider is just a URL + key + model; entries missing credentials are skipped.
const PROVIDER_DEFS = {
    cloudflare: () => {
        const account = process.env.CLOUDFLARE_ACCOUNT_ID;
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!account || !token) return null;
        return {
            name: 'cloudflare',
            url: process.env.CLOUDFLARE_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`,
            key: token,
            model: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        };
    },
    groq: () => {
        const key = process.env.GROQ_API_KEY;
        if (!key) return null;
        return {
            name: 'groq',
            url: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions',
            key,
            model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        };
    },
    openrouter: () => {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) return null;
        return {
            name: 'openrouter',
            url: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
            key,
            model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
        };
    },
};

function loadProviders(log) {
    const providers = [];
    for (const name of config.providerOrder) {
        const def = PROVIDER_DEFS[name];
        if (!def) { log.warn(`Unknown provider "${name}" in AI_PROVIDER_ORDER, skipping`); continue; }
        const p = def();
        if (p) providers.push(p);
        else log.warn(`Provider "${name}" has no credentials configured, skipping`);
    }
    return providers;
}

function loadSoul() {
    try {
        return fs.readFileSync(path.join(__dirname, 'SOUL.md'), 'utf8').trim();
    } catch (_) {
        return 'Bạn là một trợ lý thân thiện trong một server Discord tiếng Việt. Trả lời ngắn gọn, tự nhiên.';
    }
}

module.exports = { config, loadProviders, loadSoul };
