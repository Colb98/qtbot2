// Loads the same .env as the bot (repo root on dev, /root/qtbot on VPS).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./persist');

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
    // Soft wall-clock budget per /chat request: past it, no new search/read
    // rounds start and analysis is skipped — the reply must reach the bot
    // before ITS timeout (AI_REQUEST_TIMEOUT_MS), or nobody sees it.
    chatBudgetMs: int('AI_CHAT_BUDGET_MS', 90000),
    // Tiny reasoning calls (classify/verify, <100 tokens) get a short provider
    // timeout: if 8 tokens take longer than this, the provider is sick —
    // fail over fast instead of burning the full providerTimeoutMs.
    reasoningTimeoutMs: int('AI_REASONING_TIMEOUT_MS', 10000),
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
        && !!(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY),
    searchMaxResults: int('AI_SEARCH_MAX_RESULTS', 10),
    searchMinResults: int('AI_SEARCH_MIN_RESULTS', 3),   // fewer → cascade to next backend
    searchTimeoutMs: int('AI_SEARCH_TIMEOUT_MS', 10000),
    searchMaxPerMessage: int('AI_SEARCH_MAX_PER_MESSAGE', 2),
    searchDailyLimit: int('AI_SEARCH_DAILY_LIMIT', 200),
    searchBlockMaxChars: int('AI_SEARCH_BLOCK_MAX_CHARS', 15000), // hard cap per tool block
    // Video/social platforms: page fetchers cannot extract transcripts, so
    // these results are dead weight for [[read]] — filtered out of the numbered
    // list. Entries with a '/' match host+path prefix (bilibili articles stay).
    searchBlockDomains: (process.env.AI_SEARCH_BLOCK_DOMAINS ||
        'youtube.com,youtu.be,tiktok.com,douyin.com,facebook.com,instagram.com,kuaishou.com,bilibili.com/video')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    fetchEnabled: process.env.AI_FETCH_ENABLED !== 'false',
    fetchMaxPages: int('AI_FETCH_MAX_PAGES', 4),          // max pages per [[read]] selection
    fetchTimeoutMs: int('AI_FETCH_TIMEOUT_MS', 8000),
    fetchMaxCharsPerPage: int('AI_FETCH_MAX_CHARS', 3500),
    memoryEnabled: process.env.AI_MEMORY_ENABLED !== 'false',
    memoryServerMaxChars: int('AI_MEMORY_SERVER_MAX_CHARS', 4800), // ~1200 tokens
    memoryScopeMaxChars: int('AI_MEMORY_SCOPE_MAX_CHARS', 1600),   // ~400 tokens (channel & user)
    memoryMaxTokens: int('AI_MEMORY_MAX_TOKENS', 700),             // LLM output budget for rewrites
    contextMaxMessages: int('AI_CONTEXT_MESSAGES', 10),           // ambient channel messages per request (0 disables)
    contextMaxChars: int('AI_CONTEXT_MAX_CHARS', 300),            // per ambient message
    reasoningEnabled: process.env.AI_REASONING_ENABLED !== 'false',
    reasoningMinChars: int('AI_REASONING_MIN_CHARS', 40),          // shorter → immediate, no classifier call
    reasoningContextTurns: int('AI_REASONING_CONTEXT_TURNS', 4),   // recent turns shown to the classifier
    reasoningClassifierMaxTokens: int('AI_REASONING_CLASSIFIER_MAX_TOKENS', 8),
    reasoningThinkMaxTokens: int('AI_REASONING_THINK_MAX_TOKENS', 400),   // research mode
    reasoningAnalyzeMaxTokens: int('AI_REASONING_ANALYZE_MAX_TOKENS', 250), // think mode
    reasoningSocialMaxTokens: int('AI_REASONING_SOCIAL_MAX_TOKENS', 150),   // social/tone-plan mode
    reasoningDailyLimit: int('AI_REASONING_DAILY_LIMIT', 300),     // all reasoning-layer calls per day
    verifyEnabled: process.env.AI_VERIFY_ENABLED !== 'false',      // PASS/FAIL gate on social drafts
    verifyMaxTokens: int('AI_VERIFY_MAX_TOKENS', 60),
    traceEnabled: process.env.AI_TRACE_ENABLED !== 'false',
    traceMax: int('AI_TRACE_MAX', 200),                            // ring buffer size (in-memory only)
    traceDetailMaxChars: int('AI_TRACE_DETAIL_MAX_CHARS', 2000),   // per-step detail truncation
    metricsEnabled: process.env.AI_METRICS_ENABLED !== 'false',
    metricsRetentionDays: int('AI_METRICS_RETENTION_DAYS', 30),
    providerOrder: (process.env.AI_PROVIDER_ORDER || 'groq,cloudflare,openrouter,grok,gemini')
        .split(',').map(s => s.trim()).filter(Boolean),
};

const KNOWN_PROVIDERS = ['groq', 'cloudflare', 'openrouter', 'grok', 'gemini'];

const DEFAULT_MODELS = {
    cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    groq: 'llama-3.3-70b-versatile',
    openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
    grok: 'grok-4.5',
    gemini: 'gemini-2.5-flash',
};
// grok (xAI) deliberately uses XAI_* keys — GROK_API_KEY next to GROQ_API_KEY
// would be a typo waiting to happen.
const ENV_MODEL_KEYS = { cloudflare: 'CLOUDFLARE_MODEL', groq: 'GROQ_MODEL', openrouter: 'OPENROUTER_MODEL', grok: 'XAI_MODEL', gemini: 'GEMINI_MODEL' };

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
    writeAtomic(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
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
    if (name === 'gemini') {
        // Google's OpenAI-compat endpoint — same Bearer + chat/completions
        // shape as every other provider. GOOGLE_API_KEY accepted as an alias.
        const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!key) return null;
        return {
            url: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            key,
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
        return 'You are a friendly assistant in a Vietnamese Discord server. Reply briefly and naturally, in Vietnamese.';
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
