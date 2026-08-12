// Adaptive reasoning with personality applied exactly ONCE, at reply time:
// - classify():    tiny router → immediate | social | think | research
// - socialReply(): single persona pass whose output IS the final reply
// - verify():      PASS/FAIL gate on social drafts — a checker, never a
//                  rewriter (a second "polish" pass is what flattens replies)
// - analyzeTask(): persona-FREE structured analysis for think/research —
//                  English, telegraphic, forbidden from drafting the reply,
//                  so the final generation cannot anchor on its wording.
// Every extra LLM call here is daily-capped and FAILS OPEN: any error
// degrades to answering directly, never to a failed request.
const log = require('../logger');
const { config } = require('./config');
const { generateChatResponse } = require('./providers');
const metrics = require('./metrics');
const trace = require('./trace');

// In-memory daily counter for all reasoning-layer calls — free-tier backstop,
// resets on restart by design (same pattern as search.js).
let daily = { day: '', count: 0 };
function underDailyLimit() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) daily = { day: today, count: 0 };
    return daily.count < config.reasoningDailyLimit;
}

const CLASSIFIER_SYSTEM =
    'You are a routing classifier for a Discord chatbot. Classify the LAST message by the ' +
    'kind of reasoning it needs before answering. Reply with EXACTLY one word:\n' +
    'NOW — banter, greetings, reactions, simple known facts, short follow-ups.\n' +
    'SOCIAL — refusals, boundaries, drama, roasts, requests aimed at the bot itself ' +
    '(kick/ban someone, give money/roles, do admin things), sensitive social situations.\n' +
    'THINK — logic, math, comparisons, planning that can be answered from the conversation ' +
    'without looking anything up.\n' +
    'RESEARCH — needs facts you may not have: news, prices, game builds/meta/guides, ' +
    'versions, events, real people.';

// Social single-pass: this call produces the FINAL reply (shipped verbatim by
// index.js after the verifier). The smoke test keys on 'social/boundary
// situation' — keep in sync.
const SOCIAL_INSTRUCTION =
    '[Instruction — the user does NOT see this turn.] This is a social/boundary ' +
    'situation (refusal, drama, roast, a request aimed at you), not a research task. ' +
    'Write your FINAL reply to the CURRENT message now, in Tiểu Bot\'s sassy Gen Z ' +
    '"lồi lõm" voice (see SOUL): Vietnamese, short, punchline-first, concrete to THIS ' +
    'situation — do not repeat your earlier replies. If a boundary applies (no admin ' +
    'powers, refuse scams/illegal stuff), state it with sass, not robot politeness. ' +
    'Output ONLY the reply text — no analysis, no numbering, no preamble.';

// Persona-free scratchpad. English + telegraphic on purpose: structurally and
// linguistically as far as possible from the bot's final Vietnamese voice, so
// nothing in it is copyable into a reply. The smoke test keys on
// '[Task analysis' — keep in sync.
const ANALYZE_HEADER =
    '[Task analysis — NOT a reply. Do NOT draft the response. Do NOT imitate the ' +
    'bot\'s personality. Do NOT write anything addressed to the user.] ' +
    'Analyze only what is necessary to answer correctly. Return concise telegraphic ' +
    'lines in ENGLISH:\n' +
    'intent: what the user actually needs\n' +
    'facts: what is known from the conversation, memory and rules\n' +
    'constraints: rules that bound the answer\n' +
    'avoid: likely mistakes\n' +
    'conclusion: what a correct answer must contain';
const ANALYZE_TEMPLATES = {
    think: ANALYZE_HEADER,
    research: ANALYZE_HEADER + '\n' +
        'search_query: if web facts are needed — the EXACT query and its language per the ' +
        'search rules (official Chinese terms for CN games, text pages, no videos); else "none"',
};

const VERIFY_SYSTEM =
    'You are a reply checker for a Discord bot. Judge the DRAFT against the user message. ' +
    'FAIL only for: a factual error, ignoring or missing the actual question, or unsafe ' +
    'content (agreeing to scams/illegal acts/admin actions). Style, tone, sass, slang and ' +
    'bluntness are NEVER reasons to fail. Reply with EXACTLY one line of JSON: ' +
    '{"pass": true} or {"pass": false, "reason": "<short reason>"}.';

const clipTurn = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// → { mode: 'immediate'|'social'|'think'|'research', reason }
async function classify({ history, summary, userText, name, trace: t }) {
    let reason;
    if (!config.reasoningEnabled) reason = 'skipped-disabled';
    else if (userText.length < config.reasoningMinChars) reason = 'skipped-short';
    else if (!underDailyLimit()) reason = 'skipped-limit';
    if (reason) {
        const s = trace.step(t, 'classify');
        trace.endStep(t, s, { ok: true, result: 'immediate', reason });
        metrics.inc('classifyImmediate');
        return { mode: 'immediate', reason };
    }

    const MODES = { NOW: 'immediate', SOCIAL: 'social', THINK: 'think', RESEARCH: 'research' };

    const recent = history.slice(-config.reasoningContextTurns)
        .map((m) => `${m.role === 'user' ? (m.name || 'user') : 'bot'}: ${clipTurn(m.content, 200)}`)
        .join('\n');
    let content = recent ? `Recent conversation:\n${recent}\n\n` : '';
    if (summary) content += `Summary of earlier conversation: ${clipTurn(summary, 300)}\n\n`;
    content += `Last message from ${name}: ${clipTurn(userText, 500)}`;

    const s = trace.step(t, 'classify');
    daily.count++;
    try {
        const { text, provider, model, attempts } = await generateChatResponse([
            { role: 'system', content: CLASSIFIER_SYSTEM },
            { role: 'user', content },
        ], { maxTokens: config.reasoningClassifierMaxTokens, temperature: 0, noThink: true, timeoutMs: config.reasoningTimeoutMs, role: 'fast' });
        const m = /\b(RESEARCH|SOCIAL|THINK|NOW)\b/i.exec(text);
        const mode = m ? MODES[m[1].toUpperCase()] : 'immediate'; // garbage → immediate
        trace.endStep(t, s, { ok: true, result: mode, reason: 'classified', provider, model, attempts, detail: text });
        metrics.inc(`classify${mode[0].toUpperCase()}${mode.slice(1)}`);
        return { mode, reason: 'classified' };
    } catch (e) {
        // Fail-open: a broken classifier must never fail the request.
        log.warn('[ai] classifier failed, answering immediately:', e.message);
        trace.endStep(t, s, { ok: false, result: 'error-fallback', attempts: e.attempts, detail: e.message });
        metrics.inc('classifyImmediate');
        return { mode: 'immediate', reason: 'error-fallback' };
    }
}

// → { text, provider } | null. The one pass that knows the persona AND writes
// the reply. Null → index.js falls back to the normal generation path.
async function socialReply({ messages, trace: t }) {
    if (!underDailyLimit()) return null;
    daily.count++;
    try {
        const { text, provider } = await generateChatResponse(
            [...messages, { role: 'user', content: SOCIAL_INSTRUCTION }],
            { maxTokens: config.reasoningSocialMaxTokens, trace: t, stepType: 'draft' },
        );
        metrics.inc('thinkSteps');
        return { text, provider };
    } catch (e) {
        log.warn('[ai] social draft failed, using normal path:', e.message);
        return null;
    }
}

// → { pass, reason }. A gate, not an editor: it may reject a draft (with a
// concrete reason for the retry) but never touches the wording. Fails open —
// an unverifiable draft ships rather than blocking the reply.
async function verify({ userText, draftText, trace: t }) {
    if (!config.verifyEnabled || !underDailyLimit()) return { pass: true, reason: null };
    const s = trace.step(t, 'verify');
    daily.count++;
    try {
        const { text, provider, model, attempts } = await generateChatResponse([
            { role: 'system', content: VERIFY_SYSTEM },
            { role: 'user', content: `User message: ${clipTurn(userText, 500)}\n\nDRAFT reply: ${draftText}` },
        ], { maxTokens: config.verifyMaxTokens, temperature: 0, noThink: true, timeoutMs: config.reasoningTimeoutMs, role: 'fast' });
        const m = /\{[\s\S]*\}/.exec(text);
        const parsed = m ? JSON.parse(m[0]) : { pass: true };
        const pass = parsed.pass !== false;
        trace.endStep(t, s, { ok: true, result: pass ? 'pass' : 'fail', provider, model, attempts, detail: text });
        if (!pass) metrics.inc('verifyFails');
        return { pass, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : null };
    } catch (e) {
        trace.endStep(t, s, { ok: false, result: 'error-pass', attempts: e.attempts, detail: e.message });
        return { pass: true, reason: null };
    }
}

// → analysisText | null. Persona-free by construction: index.js hands it
// messages built on TASK_SYSTEM (rules + facts, no SOUL, no member advice).
async function analyzeTask({ messages, mode, trace: t }) {
    const instruction = ANALYZE_TEMPLATES[mode];
    if (!instruction || !underDailyLimit()) return null;
    const budget = mode === 'think' ? config.reasoningAnalyzeMaxTokens : config.reasoningThinkMaxTokens;
    daily.count++;
    try {
        const { text } = await generateChatResponse(
            [...messages, { role: 'user', content: instruction }],
            { maxTokens: budget, trace: t, stepType: 'analyze' },
        );
        metrics.inc('thinkSteps');
        return text;
    } catch (e) {
        log.warn('[ai] task analysis failed, answering without it:', e.message);
        return null;
    }
}

module.exports = { classify, socialReply, verify, analyzeTask };
