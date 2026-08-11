// Brief reasoning flow: a routing classifier decides whether a question needs
// a hidden "think" pass before answering, or an immediate reply. Both extra
// LLM calls are small, daily-capped, and fail-open — any failure degrades to
// today's behavior (answer immediately), never to a failed request.
const log = require('../logger');
const { config } = require('./config');
const { generateChatResponse } = require('./providers');
const metrics = require('./metrics');
const trace = require('./trace');

// In-memory daily counter for classifier+think calls — free-tier backstop,
// resets on restart by design (same pattern as search.js).
let daily = { day: '', count: 0 };
function underDailyLimit() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) daily = { day: today, count: 0 };
    return daily.count < config.reasoningDailyLimit;
}

const CLASSIFIER_SYSTEM =
    'You are a routing classifier for a Discord chatbot. Decide if the LAST message ' +
    'needs DEEP reasoning before answering (multi-step analysis, math/logic, planning, ' +
    'comparisons, debugging, strategy/build questions, anything the bot could get wrong ' +
    'by answering instantly) or an IMMEDIATE casual reply (greetings, banter, reactions, ' +
    'simple known facts, short follow-ups). ' +
    'Reply with EXACTLY one word: DEEP or NOW.';

// The exact bracket prefix is load-bearing: the smoke test's fake provider
// keys on it to recognize the think turn. Keep in sync with the test.
const THINK_INSTRUCTION =
    '[Private reasoning step — the user will NEVER see this text. Do not greet, do not ' +
    'write the final reply.] Think step by step, briefly (max ~200 words, Vietnamese): ' +
    '1) What is really being asked? 2) What do you already know from the conversation, ' +
    'memory and rules? 3) What is uncertain or might need a web search ([[search]] is ' +
    'available in your NEXT reply, not this one)? 4) Outline the answer.';

const clipTurn = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// → { mode: 'deep'|'immediate', reason }
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

    const recent = history.slice(-config.reasoningContextTurns)
        .map((m) => `${m.role === 'user' ? (m.name || 'user') : 'bot'}: ${clipTurn(m.content, 200)}`)
        .join('\n');
    let content = recent ? `Recent conversation:\n${recent}\n\n` : '';
    if (summary) content += `Summary of earlier conversation: ${clipTurn(summary, 300)}\n\n`;
    content += `Last message from ${name}: ${clipTurn(userText, 500)}`;

    const s = trace.step(t, 'classify');
    daily.count++;
    try {
        const { text } = await generateChatResponse([
            { role: 'system', content: CLASSIFIER_SYSTEM },
            { role: 'user', content },
        ], { maxTokens: config.reasoningClassifierMaxTokens, temperature: 0 });
        const deep = /\bDEEP\b/i.test(text);
        trace.endStep(t, s, { ok: true, result: deep ? 'deep' : 'immediate', reason: 'classified', detail: text });
        metrics.inc(deep ? 'classifyDeep' : 'classifyImmediate');
        return { mode: deep ? 'deep' : 'immediate', reason: 'classified' };
    } catch (e) {
        // Fail-open: a broken classifier must never fail the request.
        log.warn('[ai] classifier failed, answering immediately:', e.message);
        trace.endStep(t, s, { ok: false, result: 'error-fallback', detail: e.message });
        metrics.inc('classifyImmediate');
        return { mode: 'immediate', reason: 'error-fallback' };
    }
}

// → thinkText | null. Null on any failure — the caller just answers directly.
// The step itself (provider, model, tokens, the thinking text) is recorded by
// providers.js under stepType 'think'.
async function think({ messages, trace: t }) {
    if (!underDailyLimit()) return null;
    daily.count++;
    try {
        const { text } = await generateChatResponse(
            [...messages, { role: 'user', content: THINK_INSTRUCTION }],
            { maxTokens: config.reasoningThinkMaxTokens, trace: t, stepType: 'think' },
        );
        metrics.inc('thinkSteps');
        return text;
    } catch (e) {
        log.warn('[ai] think step failed, answering without it:', e.message);
        return null;
    }
}

module.exports = { classify, think, THINK_INSTRUCTION };
