// Long-term memory: per-guild server memory, per-channel and per-user files
// under ai-service/data/memory/ (plain markdown — inspectable and hand-editable
// on the VPS). Updates run on the messages being compacted away — durable facts
// get promoted here at exactly the moment they'd otherwise be lost.
//
// The write model is REWRITE, not append: the model receives the current files
// plus the folded transcript and must return complete replacement files inside
// a hard budget, so memory physically cannot grow unbounded. Char caps are
// re-enforced in code as a backstop. A failed or unparseable update is skipped
// harmlessly — memory is best-effort, chat never depends on a write succeeding.
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { config } = require('./config');
const { generateChatResponse } = require('./providers');
const { enqueue, QueueFullError } = require('./queue');
const metrics = require('./metrics');

const MEM_DIR = path.join(__dirname, 'data', 'memory');

const safe = (id) => String(id).replace(/[^0-9A-Za-z_-]/g, '');
const serverFile = (guildId) => `server-${safe(guildId)}.md`;
const channelFile = (channelId) => `channel-${safe(channelId)}.md`;
const userFile = (userId) => `user-${safe(userId)}.md`;

function read(name) {
    try { return fs.readFileSync(path.join(MEM_DIR, name), 'utf8').trim(); }
    catch (_) { return ''; }
}

function write(name, text) {
    fs.mkdirSync(MEM_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEM_DIR, name), text.trim() + '\n');
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) : text);

// Scoped retrieval (§11): a message from user A in channel X sees server +
// channel-X + user-A memory ONLY. Caps here bound worst-case prompt cost.
function getContext(guildId, channelId, userId) {
    if (!config.memoryEnabled) return { server: '', channel: '', user: '' };
    return {
        server: clip(read(serverFile(guildId)), config.memoryServerMaxChars),
        channel: clip(read(channelFile(channelId)), config.memoryScopeMaxChars),
        user: clip(read(userFile(userId)), config.memoryScopeMaxChars),
    };
}

const MEMORY_SYSTEM = `You are the LONG-TERM MEMORY component of QT, a Discord bot.
Task: REWRITE the memory files completely, merging in facts worth keeping from the new conversation.

KEEP only stable, long-term useful information: preferences, jobs, usual language,
nicknames, recurring inside jokes, long-running server events/activities.
DO NOT keep one-off trivia (what someone ate today, a single joke, temporary details).
If nothing new is worth keeping for a file, return that file unchanged.
Each file: bullet points, IN VIETNAMESE, max ~120 words.

Return ONLY syntactically valid JSON, nothing else:
{"server": "<server memory file>", "channel": "<channel memory file>", "users": {"<userId>": "<that user's memory file>"}}
"users" may only contain userIds that appear in the conversation.`;

function parseMemoryJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch (_) { return null; }
}

async function updateFromTranscript(guildId, channelId, messages) {
    const speakers = [...new Set(messages.filter((m) => m.role === 'user' && m.userId).map((m) => m.userId))];
    const current = {
        server: read(serverFile(guildId)),
        channel: read(channelFile(channelId)),
        users: Object.fromEntries(speakers.map((id) => [id, read(userFile(id))])),
    };
    const transcript = messages
        .map((m) => (m.role === 'user' ? `[${m.userId || '?'}] ${m.name}: ${m.content}` : `QT (bot): ${m.content}`))
        .join('\n');

    const { text } = await generateChatResponse([
        { role: 'system', content: MEMORY_SYSTEM },
        { role: 'user', content: `## Current memory\n${JSON.stringify(current)}\n\n## Conversation that just happened\n${transcript}` },
    ], { maxTokens: config.memoryMaxTokens });

    const parsed = parseMemoryJson(text);
    if (!parsed) { log.warn(`[ai] memory update unparseable guild=${guildId}, skipped`); return; }

    const wrote = [];
    if (typeof parsed.server === 'string' && parsed.server.trim()) {
        write(serverFile(guildId), clip(parsed.server, config.memoryServerMaxChars));
        wrote.push('server');
    }
    if (typeof parsed.channel === 'string' && parsed.channel.trim()) {
        write(channelFile(channelId), clip(parsed.channel, config.memoryScopeMaxChars));
        wrote.push('channel');
    }
    if (parsed.users && typeof parsed.users === 'object') {
        for (const [id, text2] of Object.entries(parsed.users)) {
            // Isolation guard: the model may only touch files of people who
            // actually spoke in this chunk — it cannot invent or overwrite
            // an absent user's memory.
            if (!speakers.includes(id)) { log.warn(`[ai] memory for non-speaker ${id} ignored`); continue; }
            if (typeof text2 !== 'string' || !text2.trim()) continue;
            write(userFile(id), clip(text2, config.memoryScopeMaxChars));
            wrote.push(`user:${id}`);
        }
    }
    if (wrote.length) metrics.inc('memoryWrites');
    log.info(`[ai] memory write guild=${guildId} channel=${channelId} scopes=[${wrote.join(', ')}]`);
}

// Serialized per guild: two channels compacting at once share the server file,
// so their read-rewrite-write cycles must not interleave.
function scheduleUpdate(guildId, channelId, messages) {
    if (!config.memoryEnabled || !messages.length) return;
    try {
        enqueue(`mem:${guildId}`, () => updateFromTranscript(guildId, channelId, messages), 5)
            .catch((e) => log.warn(`[ai] memory update failed guild=${guildId}: ${e.message}`));
    } catch (e) {
        if (!(e instanceof QueueFullError)) throw e;
    }
}

module.exports = { getContext, scheduleUpdate };
