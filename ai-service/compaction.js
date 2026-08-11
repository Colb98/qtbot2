// Automatic session compaction: folds older messages into a rolling structured
// summary via the same provider router, keeping the recent tail verbatim.
// Scheduled as a follow-up task on the session's own queue right after a
// response is sent — so it never delays a reply and never races a generation.
const log = require('../logger');
const { config } = require('./config');
const { generateChatResponse } = require('./providers');
const sessions = require('./sessions');
const memory = require('./memory');
const { enqueue, QueueFullError } = require('./queue');
const metrics = require('./metrics');

// Structured schema: freeform summaries drop odd-shaped details; forcing fixed
// sections makes the model check each category (§9 of the integration plan).
const SUMMARIZE_SYSTEM = `You summarize a Discord conversation (multiple users chatting with the bot QT).
Merge the "previous summary" (if any) with the new messages into ONE summary using exactly these sections:
- Participants: who is chatting, memorable traits/roles
- Topics: what is being discussed, key developments
- Decisions / conclusions: what got settled
- Unresolved: open questions or unfinished business
- Jokes / nicknames: running jokes, special names in use
- Other notable facts

Skip empty sections. Write concisely IN VIETNAMESE, bullet points, max ~300 words.
Return only the summary, no preamble.`;

function transcriptOf(messages) {
    return messages
        .map((m) => (m.role === 'user' ? `${m.name}: ${m.content}` : `QT (bot): ${m.content}`))
        .join('\n');
}

async function compactSession(sessionKey) {
    if (!sessions.needsCompaction(sessionKey)) return; // reset/compacted while queued
    const [old, keep] = sessions.splitForCompaction(sessionKey);
    if (!old.length) return;

    const prev = sessions.getSummary(sessionKey);
    const started = Date.now();
    const { text: summary } = await generateChatResponse([
        { role: 'system', content: SUMMARIZE_SYSTEM },
        {
            role: 'user',
            content: (prev ? `## Previous summary\n${prev}\n\n` : '') +
                `## Conversation to fold into the summary\n${transcriptOf(old)}`,
        },
    ], { maxTokens: config.summaryMaxTokens });

    if (sessions.applyCompaction(sessionKey, summary)) {
        metrics.inc('compactions');
        log.info(`[ai] compacted session=${sessionKey} folded=${old.length} kept=${keep.length} ` +
            `summaryChars=${summary.length} took=${Date.now() - started}ms`);
        // Two-tier design: durable facts get promoted to long-term memory from
        // exactly the messages the summary is about to blur out.
        const [, guildId, channelId] = sessionKey.split(':');
        memory.scheduleUpdate(guildId, channelId, old);
    }
}

// Fire-and-forget from the chat path. Queue-full just means it retries after
// the next message; a summarize failure leaves the session intact (the
// emergency trim in sessions.append bounds growth meanwhile).
function maybeScheduleCompaction(sessionKey) {
    if (!config.compactionEnabled || !sessions.needsCompaction(sessionKey)) return;
    try {
        enqueue(sessionKey, () => compactSession(sessionKey), config.sessionQueueDepth)
            .catch((e) => log.warn(`[ai] compaction failed session=${sessionKey}: ${e.message}`));
    } catch (e) {
        if (!(e instanceof QueueFullError)) throw e;
    }
}

module.exports = { maybeScheduleCompaction };
