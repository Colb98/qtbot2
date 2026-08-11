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

// Adaptive routing: not every question deserves the same thinking. The
// classifier picks one of four modes; each non-NOW mode gets its own think
// template and token budget, and EVERY template ends with a mandatory voice
// step so the final reply keeps Tiểu Bot's sassy tone instead of inheriting a
// bureaucratic outline.
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

// The exact bracket prefix is load-bearing: the smoke test's fake provider
// keys on it to recognize a think turn ('[Private reasoning step'), and on
// 'tone plan' to recognize the social template. Keep in sync with the test.
const THINK_PREFIX =
    '[Private reasoning step — the user will NEVER see this text. Do not greet, do not ' +
    'write the final reply.] ';
const VOICE_STEP =
    'Finally: draft 1-2 opening lines / punchlines in Tiểu Bot\'s sassy Gen Z "lồi lõm" ' +
    'voice (see SOUL) — concrete and situation-specific, NOT generic politeness.';

const THINK_TEMPLATES = {
    social: THINK_PREFIX +
        'This is a social/boundary situation, NOT a research task. Make a brief tone plan ' +
        '(max ~80 words, Vietnamese): 1) What is the situation and which boundary or fact ' +
        'applies (e.g. you have NO admin powers)? 2) ' + VOICE_STEP,
    think: THINK_PREFIX +
        'Think step by step, briefly (max ~150 words, Vietnamese): 1) What is really being ' +
        'asked? 2) Reason it out from the conversation, memory and rules — compare, ' +
        'calculate, weigh options. 3) Outline the answer. 4) ' + VOICE_STEP,
    research: THINK_PREFIX +
        'Think step by step, briefly (max ~200 words, Vietnamese): ' +
        '1) What is really being asked? 2) What do you already know from the conversation, ' +
        'memory and rules? 3) What is uncertain or might need a web search ([[search]] is ' +
        'available in your NEXT reply, not this one)? If searching: write the EXACT query you ' +
        'will use and its language, following the search rules (official Chinese terms for CN ' +
        'games, text pages — you cannot watch videos). 4) Outline the answer. 5) ' + VOICE_STEP,
};

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
        const { text } = await generateChatResponse([
            { role: 'system', content: CLASSIFIER_SYSTEM },
            { role: 'user', content },
        ], { maxTokens: config.reasoningClassifierMaxTokens, temperature: 0 });
        const m = /\b(RESEARCH|SOCIAL|THINK|NOW)\b/i.exec(text);
        const mode = m ? MODES[m[1].toUpperCase()] : 'immediate'; // garbage → immediate
        trace.endStep(t, s, { ok: true, result: mode, reason: 'classified', detail: text });
        metrics.inc(`classify${mode[0].toUpperCase()}${mode.slice(1)}`);
        return { mode, reason: 'classified' };
    } catch (e) {
        // Fail-open: a broken classifier must never fail the request.
        log.warn('[ai] classifier failed, answering immediately:', e.message);
        trace.endStep(t, s, { ok: false, result: 'error-fallback', detail: e.message });
        metrics.inc('classifyImmediate');
        return { mode: 'immediate', reason: 'error-fallback' };
    }
}

// → thinkText | null. Null on any failure — the caller just answers directly.
// Template and token budget adapt to the classified mode; the step itself
// (provider, model, tokens, the thinking text) is recorded by providers.js
// under stepType 'think'.
async function think({ messages, mode, trace: t }) {
    const instruction = THINK_TEMPLATES[mode];
    if (!instruction || !underDailyLimit()) return null;
    const budget = mode === 'social' ? config.reasoningSocialMaxTokens
        : mode === 'think' ? config.reasoningAnalyzeMaxTokens
        : config.reasoningThinkMaxTokens;
    daily.count++;
    try {
        const { text } = await generateChatResponse(
            [...messages, { role: 'user', content: instruction }],
            { maxTokens: budget, trace: t, stepType: 'think' },
        );
        metrics.inc('thinkSteps');
        return text;
    } catch (e) {
        log.warn('[ai] think step failed, answering without it:', e.message);
        return null;
    }
}

module.exports = { classify, think, THINK_TEMPLATES };
