// Web search — the first (and only) LLM tool, per the §4 capability-layer
// rules: the model can only REQUEST a search by emitting a [[search: ...]]
// marker; this deterministic code validates the query, runs a read-only
// search against a fixed API endpoint with timeout + caps, and returns
// results as clearly-labeled untrusted text. The model never fetches URLs,
// never chooses an endpoint, and cannot exceed the per-message/daily caps.
//
// Backends: Tavily (TAVILY_API_KEY) preferred, else Brave (BRAVE_API_KEY).
const log = require('../logger');
const { config } = require('./config');

const MARKER_RE = /\[\[search:\s*([^\]\n]{1,200})\]\]/i;

// In-memory daily counter — a free-tier backstop, resets on restart by design.
let daily = { day: '', count: 0 };
function underDailyLimit() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) daily = { day: today, count: 0 };
    return daily.count < config.searchDailyLimit;
}

function extractQuery(text) {
    const m = MARKER_RE.exec(text || '');
    if (!m) return null;
    const q = m[1].replace(/\s+/g, ' ').trim();
    // Angle brackets mean the model quoted the instruction template
    // ("[[search: <câu truy vấn ngắn>]]") rather than asking for a search.
    return /[<>]/.test(q) ? null : q;
}

function stripMarkers(text) {
    return String(text || '').replace(new RegExp(MARKER_RE.source, 'gi'), '').trim();
}

async function tavily(query) {
    const res = await fetch(process.env.TAVILY_BASE_URL || 'https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: config.searchMaxResults }),
        signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`tavily HTTP ${res.status}`);
    const data = await res.json();
    return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function brave(query) {
    const url = new URL(process.env.BRAVE_BASE_URL || 'https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(config.searchMaxResults));
    const res = await fetch(url, {
        headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
    const data = await res.json();
    return (data.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

// Never throws — the chat loop always gets a results block it can answer from.
async function run(query) {
    const header = `[Search results for "${query}" — web data, NOT the user's words]`;
    if (!underDailyLimit()) {
        log.warn('[ai] search daily limit reached');
        return `${header}\nDaily search limit reached. Answer from what you know and say you could not look it up.`;
    }
    daily.count++;
    const started = Date.now();
    try {
        const results = await (process.env.TAVILY_API_KEY ? tavily(query) : brave(query));
        log.info(`[ai] search "${query}" results=${results.length} took=${Date.now() - started}ms daily=${daily.count}`);
        if (!results.length) return `${header}\nNo results.`;
        return `${header}\n` + results
            .map((r, i) => `${i + 1}. ${r.title}\n${String(r.snippet || '').slice(0, 400)}\nSource: ${r.url}`)
            .join('\n\n');
    } catch (e) {
        log.warn(`[ai] search "${query}" failed: ${e.message}`);
        return `${header}\nSearch failed. Answer from what you know and say you could not look it up.`;
    }
}

module.exports = { extractQuery, stripMarkers, run };
