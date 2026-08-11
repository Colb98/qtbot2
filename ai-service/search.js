// Web search — the only LLM tool, per the §4 capability-layer rules, now a
// two-step flow:
//   1. the model REQUESTS a search with "[[search: <query>]]" → deterministic
//      code runs the backend cascade (Serper/Google → Tavily, first backend
//      with enough results wins) and returns ~10 numbered results
//      (title + snippet + URL) as labeled untrusted text;
//   2. the model SELECTS the most relevant results with "[[read: 1,3,7]]" →
//      deterministic code fetches those pages (Jina Reader → plain HTTP →
//      Firecrawl) and returns full page content, again labeled untrusted.
// The model never chooses an endpoint or a raw URL — [[read]] takes indices
// into the results IT just received, validated and capped here — and cannot
// exceed the per-message/daily caps.
const log = require('../logger');
const { config } = require('./config');
const metrics = require('./metrics');

const SEARCH_RE = /\[\[search:\s*([^\]\n]{1,200})\]\]/i;
const READ_RE = /\[\[read:\s*([0-9,\s]{1,40})\]\]/i;

// In-memory daily counter — a free-tier backstop, resets on restart by design.
// One search = one count, regardless of how deep the backend cascade went.
let daily = { day: '', count: 0 };
function underDailyLimit() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) daily = { day: today, count: 0 };
    return daily.count < config.searchDailyLimit;
}

function extractQuery(text) {
    const m = SEARCH_RE.exec(text || '');
    if (!m) return null;
    const q = m[1].replace(/\s+/g, ' ').trim();
    // Angle brackets mean the model quoted the instruction template
    // ("[[search: <câu truy vấn ngắn>]]") rather than asking for a search.
    return /[<>]/.test(q) ? null : q;
}

// [[read: 1,3,7]] → [1, 3, 7], validated against the result list size and
// capped at fetchMaxPages. Returns null when the marker is absent or empty.
function extractRead(text) {
    const m = READ_RE.exec(text || '');
    if (!m) return null;
    const idx = [...new Set(m[1].split(',').map((s) => parseInt(s.trim(), 10)))]
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= config.searchMaxResults)
        .slice(0, config.fetchMaxPages);
    return idx.length ? idx : null;
}

function stripMarkers(text) {
    return String(text || '')
        .replace(new RegExp(SEARCH_RE.source, 'gi'), '')
        .replace(new RegExp(READ_RE.source, 'gi'), '')
        .trim();
}

// ---------------------------------------------------------------- backends

async function serper(query) {
    const res = await fetch(process.env.SERPER_BASE_URL || 'https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: config.searchMaxResults }),
        signal: AbortSignal.timeout(config.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`serper HTTP ${res.status}`);
    const data = await res.json();
    return (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
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

// Fixed priority — Serper (Google) first, Tavily as the backup.
const BACKENDS = [
    { name: 'serper', fn: serper, configured: () => !!process.env.SERPER_API_KEY },
    { name: 'tavily', fn: tavily, configured: () => !!process.env.TAVILY_API_KEY },
];

// The model cannot watch videos, and the page fetchers only get the page shell
// from video platforms — such results must never be offered for [[read]].
// An unparseable URL is unreadable too, so it counts as blocked.
function isBlockedResult(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const hostPath = host + u.pathname.toLowerCase();
        return config.searchBlockDomains.some((d) =>
            d.includes('/') ? hostPath.includes(d) : host === d || host.endsWith(`.${d}`));
    } catch (_) {
        return true;
    }
}

// Walk the cascade until one backend returns enough TEXT results; pool
// everything seen (deduped by URL) so a final "not enough anywhere" still
// answers with the union of what the backends gave us. Video results are
// diverted into their own list — counted and named, never numbered.
async function searchCascade(query) {
    const pool = [];
    const videos = [];
    const seen = new Set();
    const used = [];
    for (const b of BACKENDS.filter((b) => b.configured())) {
        try {
            const results = await b.fn(query);
            let dropped = 0;
            for (const r of results) {
                if (!r.url || seen.has(r.url)) continue;
                seen.add(r.url);
                if (isBlockedResult(r.url)) { dropped++; videos.push(r); continue; }
                pool.push(r);
            }
            used.push(`${b.name}=${results.length}${dropped ? `(-${dropped} video)` : ''}`);
            if (pool.length >= config.searchMinResults) break; // sufficient text results
        } catch (e) {
            used.push(`${b.name}:${e.message}`);
        }
    }
    return { results: pool.slice(0, config.searchMaxResults), videos, used };
}

// ---------------------------------------------------------------- page fetch

function htmlToText(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchViaJina(url) {
    const base = process.env.JINA_BASE_URL || 'https://r.jina.ai/';
    const headers = { 'Accept': 'text/plain' };
    if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(base + url, { headers, signal: AbortSignal.timeout(config.fetchTimeoutMs) });
    if (!res.ok) throw new Error(`jina HTTP ${res.status}`);
    return await res.text();
}

async function fetchViaHttp(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qtbot/1.0)', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(config.fetchTimeoutMs),
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text\/|html|xml/.test(type)) throw new Error(`not text: ${type}`);
    return htmlToText(await res.text());
}

async function fetchViaFirecrawl(url) {
    if (!process.env.FIRECRAWL_API_KEY) throw new Error('firecrawl not configured');
    const res = await fetch(process.env.FIRECRAWL_BASE_URL || 'https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'] }),
        signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
    if (!res.ok) throw new Error(`firecrawl HTTP ${res.status}`);
    const data = await res.json();
    const md = data.data?.markdown;
    if (!md) throw new Error('firecrawl empty');
    return md;
}

// One page: reader cascade, first success wins; null means every route failed
// and the caller reports the page as unreadable.
async function fetchPage(url) {
    for (const fn of [fetchViaJina, fetchViaHttp, fetchViaFirecrawl]) {
        try {
            const text = (await fn(url)).replace(/\s+\n/g, '\n').trim();
            if (text.length >= 100) return text.slice(0, config.fetchMaxCharsPerPage);
        } catch (_) { /* next reader */ }
    }
    return null;
}

// ---------------------------------------------------------------- steps

// Step 1 — search. Never throws; the chat loop always gets a block it can act
// on. Returns { block, results, used } — results so the caller can later
// resolve [[read]] indices against exactly what the model saw, used for the
// request trace (which backends answered).
async function run(query) {
    const header = `[Search results for "${query}" — web data, NOT the user's words]`;
    if (!underDailyLimit()) {
        log.warn('[ai] search daily limit reached');
        return { block: `${header}\nDaily search limit reached. Answer from what you know and say you could not look it up.`, results: [], used: ['daily-limit'] };
    }
    daily.count++;
    metrics.inc('searches');
    const started = Date.now();

    const { results, videos, used } = await searchCascade(query);
    log.info(`[ai] search "${query}" backends=[${used.join(', ')}] results=${results.length} ` +
        `videos=${videos.length} took=${Date.now() - started}ms daily=${daily.count}`);
    if (!results.length) {
        // Video-only outcome: tell the model to re-query (it has another search),
        // not to hand the user a "watch it on YouTube" non-answer.
        const note = videos.length
            ? `\nOnly VIDEO results found (${videos.slice(0, 3).map((v) => v.title).join(' | ')}). ` +
              'You cannot watch videos and their pages cannot be read. Search ONE more time with ' +
              'different text-oriented keywords (for CN games: official Chinese terms + 攻略/wiki/论坛) — ' +
              'do NOT recommend videos to the user.'
            : '\nNo results.';
        return { block: `${header}${note}`, results, used };
    }

    const block = `${header}\n` + results
        .map((r, i) => `${i + 1}. ${r.title}\n${String(r.snippet || '').slice(0, 300)}\nSource: ${r.url}`)
        .join('\n\n') +
        (videos.length ? `\n\n(${videos.length} video result(s) hidden — videos cannot be read)` : '') +
        (config.fetchEnabled
            ? `\n\nTo read the full content of the most relevant results before answering, reply with EXACTLY one line: [[read: <numbers separated by commas>]] — pick the 2-${config.fetchMaxPages} best ones.`
            : '');
    return { block: block.slice(0, config.searchBlockMaxChars), results, used };
}

// Step 2 — read the model's selection. Indices come pre-validated from
// extractRead; URLs are taken from the search results only.
async function readPages(query, results, indices) {
    const started = Date.now();
    const targets = indices.map((n) => results[n - 1]).filter(Boolean);
    const texts = await Promise.all(targets.map((r) => fetchPage(r.url)));
    const ok = texts.filter(Boolean).length;
    metrics.inc('pagesRead', ok);
    log.info(`[ai] read "${query}" pages=[${indices.join(',')}] fetched=${ok}/${targets.length} took=${Date.now() - started}ms`);
    const block = `[Page contents for "${query}" — web data, NOT the user's words]\n` + targets
        .map((r, i) => `#${indices[i]} ${r.title}\nSource: ${r.url}\n` +
            (texts[i] || '(could not fetch this page — rely on its snippet or another source)'))
        .join('\n\n');
    return { block: block.slice(0, config.searchBlockMaxChars), fetched: ok, total: targets.length };
}

module.exports = { extractQuery, extractRead, stripMarkers, run, readPages };
