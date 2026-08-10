// Loads the same .env as the bot (repo root on dev, /root/qtbot on VPS).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');

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
    compactionEnabled: process.env.AI_COMPACTION_ENABLED !== 'false',
    compactThresholdTokens: int('AI_COMPACT_THRESHOLD_TOKENS', 2000),
    compactKeepRecent: int('AI_COMPACT_KEEP_RECENT', 10),
    summaryMaxTokens: int('AI_SUMMARY_MAX_TOKENS', 500),
    searchEnabled: process.env.AI_SEARCH_ENABLED !== 'false'
        && !!(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY),
    searchMaxResults: int('AI_SEARCH_MAX_RESULTS', 4),
    searchTimeoutMs: int('AI_SEARCH_TIMEOUT_MS', 10000),
    searchMaxPerMessage: int('AI_SEARCH_MAX_PER_MESSAGE', 2),
    searchDailyLimit: int('AI_SEARCH_DAILY_LIMIT', 200),
    memoryEnabled: process.env.AI_MEMORY_ENABLED !== 'false',
    memoryServerMaxChars: int('AI_MEMORY_SERVER_MAX_CHARS', 4800), // ~1200 tokens
    memoryScopeMaxChars: int('AI_MEMORY_SCOPE_MAX_CHARS', 1600),   // ~400 tokens (channel & user)
    memoryMaxTokens: int('AI_MEMORY_MAX_TOKENS', 700),             // LLM output budget for rewrites
    providerOrder: (process.env.AI_PROVIDER_ORDER || 'groq,cloudflare,openrouter,grok')
        .split(',').map(s => s.trim()).filter(Boolean),
};

const KNOWN_PROVIDERS = ['groq', 'cloudflare', 'openrouter', 'grok'];

const DEFAULT_MODELS = {
    cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    groq: 'llama-3.3-70b-versatile',
    openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
    grok: 'grok-4.5',
};
// grok (xAI) deliberately uses XAI_* keys — GROK_API_KEY next to GROQ_API_KEY
// would be a typo waiting to happen.
const ENV_MODEL_KEYS = { cloudflare: 'CLOUDFLARE_MODEL', groq: 'GROQ_MODEL', openrouter: 'OPENROUTER_MODEL', grok: 'XAI_MODEL' };

// Runtime overrides set from the admin dashboard; persisted so they survive
// restarts. Precedence: override > env > hardcoded default.
let overrides = { providerOrder: null, models: {} };
try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    if (Array.isArray(raw.providerOrder) && raw.providerOrder.length) overrides.providerOrder = raw.providerOrder;
    if (raw.models && typeof raw.models === 'object') overrides.models = raw.models;
} catch (e) {
    if (e.code !== 'ENOENT') console.warn('[ai] could not read overrides.json:', e.message);
}

function getOverrides() {
    return { providerOrder: overrides.providerOrder, models: { ...overrides.models } };
}

function saveOverrides(next) {
    overrides = next;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
}

// The model that wins without any override (what the dashboard shows as placeholder).
function fallbackModelFor(name) {
    return process.env[ENV_MODEL_KEYS[name]] || DEFAULT_MODELS[name];
}

function modelFor(name) {
    return overrides.models[name] || fallbackModelFor(name);
}

function credsFor(name) {
    if (name === 'cloudflare') {
        const account = process.env.CLOUDFLARE_ACCOUNT_ID;
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!account || !token) return null;
        return {
            url: process.env.CLOUDFLARE_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`,
            key: token,
        };
    }
    if (name === 'groq') {
        if (!process.env.GROQ_API_KEY) return null;
        return {
            url: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions',
            key: process.env.GROQ_API_KEY,
        };
    }
    if (name === 'openrouter') {
        if (!process.env.OPENROUTER_API_KEY) return null;
        return {
            url: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
            key: process.env.OPENROUTER_API_KEY,
        };
    }
    if (name === 'grok') {
        if (!process.env.XAI_API_KEY) return null;
        return {
            url: process.env.XAI_BASE_URL || 'https://api.x.ai/v1/chat/completions',
            key: process.env.XAI_API_KEY,
        };
    }
    return null;
}

function effectiveOrder() {
    return overrides.providerOrder || config.providerOrder;
}

function loadProviders(log) {
    const providers = [];
    for (const name of effectiveOrder()) {
        if (!KNOWN_PROVIDERS.includes(name)) { log.warn(`Unknown provider "${name}" in order, skipping`); continue; }
        const creds = credsFor(name);
        if (creds) providers.push({ name, ...creds, model: modelFor(name) });
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

// Behavioral rules, git-tracked next to SOUL.md — edit + redeploy to change
// how the bot answers (SOUL is who it is; RULES is how it must behave).
function loadRules() {
    try {
        return fs.readFileSync(path.join(__dirname, 'RULES.md'), 'utf8').trim();
    } catch (_) {
        return '';
    }
}

module.exports = {
    config, loadProviders, loadSoul, loadRules,
    KNOWN_PROVIDERS, effectiveOrder, modelFor, fallbackModelFor, credsFor,
    getOverrides, saveOverrides,
};
