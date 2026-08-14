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
const guard = require('./guard');

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
// guard.sanitize on read: memory is model-written FROM member chat, so it is
// an indirect injection channel into every future prompt — hidden chars and
// role/tool markers that survived a rewrite die here.
function getContext(guildId, channelId, userId) {
    if (!config.memoryEnabled) return { server: '', channel: '', user: '' };
    return {
        server: guard.sanitize(clip(read(serverFile(guildId)), config.memoryServerMaxChars)),
        channel: guard.sanitize(clip(read(channelFile(channelId)), config.memoryScopeMaxChars)),
        user: guard.sanitize(clip(read(userFile(userId)), config.memoryScopeMaxChars)),
    };
}

// Two-tier retention: the CORE impression of a person/place is kept forever,
// episodic items carry a date and expire — memory stays compact AND fresh.
// Built per call because it embeds today's date.
const memorySystem = () => `You are the LONG-TERM MEMORY component of QT, a Discord bot.
Task: REWRITE the memory files completely, merging in facts worth keeping from the new conversation.

Each file has two sections:
## Core — stable impression, UNDATED bullets: identity, personality, relationships,
nicknames, recurring jokes/stories, preferences, jobs/skills, usual language.
Keep indefinitely; update a bullet when the fact changes.
## Recent — episodic, every bullet MUST start with a date "(YYYY-MM-DD)":
ongoing events, temporary situations, things true this week.

Aging rules, applied on EVERY rewrite:
- Today is ${new Date().toISOString().slice(0, 10)}. DROP Recent bullets older than ${config.memoryRecentDays} days —
  unless the topic came up again in the new conversation; then move it (undated) into Core.
- One-off trivia (what someone ate today, a single joke) never enters memory at all.
- If nothing new is worth keeping for a file, return that file unchanged.
Each file: bullet points IN VIETNAMESE, max ~120 words, headers exactly "## Core" and
"## Recent" (omit an empty section).

Return ONLY syntactically valid JSON, nothing else:
{"server": "<server memory file>", "channel": "<channel memory file>", "users": {"<userId>": "<that user's memory file>"}}
"users" may only contain userIds that appear in the conversation.`;

// Deterministic backstop for the aging rule: expired dated bullets die here
// even when the model ignores the instruction.
function pruneExpired(text) {
    const cutoff = new Date(Date.now() - config.memoryRecentDays * 86400000).toISOString().slice(0, 10);
    return String(text).split('\n')
        .filter((line) => {
            const m = /^\s*-\s*\((\d{4}-\d{2}-\d{2})\)/.exec(line);
            return !m || m[1] >= cutoff;
        })
        .join('\n');
}

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

    // Runs on the MAIN (reasoning) model — memory judgment (what's worth
    // keeping, Core vs Recent) benefits from reasoning. AI_MEMORY_MAX_TOKENS is
    // sized generously so the model can think AND emit the full JSON; if it
    // still overflows, the JSON truncates and this write is skipped (logged).
    const { text } = await generateChatResponse([
        { role: 'system', content: memorySystem() },
        { role: 'user', content: `## Current memory\n${JSON.stringify(current)}\n\n## Conversation that just happened\n${transcript}` },
    ], { maxTokens: config.memoryMaxTokens });

    const parsed = parseMemoryJson(text);
    if (!parsed) { log.warn(`[ai] memory update unparseable guild=${guildId}, skipped`); return; }

    const wrote = [];
    if (typeof parsed.server === 'string' && parsed.server.trim()) {
        write(serverFile(guildId), clip(pruneExpired(parsed.server), config.memoryServerMaxChars));
        wrote.push('server');
    }
    if (typeof parsed.channel === 'string' && parsed.channel.trim()) {
        write(channelFile(channelId), clip(pruneExpired(parsed.channel), config.memoryScopeMaxChars));
        wrote.push('channel');
    }
    if (parsed.users && typeof parsed.users === 'object') {
        for (const [id, text2] of Object.entries(parsed.users)) {
            // Isolation guard: the model may only touch files of people who
            // actually spoke in this chunk — it cannot invent or overwrite
            // an absent user's memory.
            if (!speakers.includes(id)) { log.warn(`[ai] memory for non-speaker ${id} ignored`); continue; }
            if (typeof text2 !== 'string' || !text2.trim()) continue;
            write(userFile(id), clip(pruneExpired(text2), config.memoryScopeMaxChars));
            wrote.push(`user:${id}`);
        }
    }
    if (wrote.length) metrics.inc('memoryWrites');
    log.info(`[ai] memory write guild=${guildId} channel=${channelId} scopes=[${wrote.join(', ')}]`);
}

// ------------------------------------------------------- explicit remember
// Compaction-driven memory is a JUDGEMENT call made later, on messages being
// folded away: it can decide a fact is not worth keeping, and it does not run
// until the session is long enough. When a member says "từ giờ nhớ xưng em-sếp
// với t", none of that is acceptable — the write must happen NOW and must not
// be second-guessed. This is that path: deterministic, synchronous, appended
// to the SPEAKER'S OWN file only.
//
// Notes land in ## Core, never ## Recent: a standing instruction is a stable
// preference, and Recent bullets are pruned after memoryRecentDays.
function appendUserNote(userId, note) {
    if (!config.memoryEnabled) return { ok: false, reason: 'disabled' };
    // The note comes from member chat via the model — it enters EVERY future
    // prompt for this user, exactly the indirect-injection channel getContext()
    // sanitizes on read. Sanitize on write too so the file itself stays clean.
    const clean = guard.sanitize(String(note || '')).replace(/\s+/g, ' ').trim();
    if (clean.length < 3) return { ok: false, reason: 'empty' };
    const bullet = `- ${clip(clean, config.memoryNoteMaxChars)}`;

    const file = userFile(userId);
    const current = read(file);
    // Same fact twice is a no-op, not a duplicate bullet.
    if (current.split('\n').some((l) => l.trim().toLowerCase() === bullet.toLowerCase())) {
        return { ok: true, reason: 'already-known', text: clean };
    }

    let next;
    if (/^##\s*Core\s*$/im.test(current)) {
        // Append as the LAST Core bullet, keeping the ## Recent section intact.
        const lines = current.split('\n');
        const coreAt = lines.findIndex((l) => /^##\s*Core\s*$/i.test(l.trim()));
        let end = lines.findIndex((l, i) => i > coreAt && /^##\s/.test(l.trim()));
        if (end === -1) end = lines.length;
        while (end > coreAt + 1 && !lines[end - 1].trim()) end--; // keep the blank line before ## Recent
        lines.splice(end, 0, bullet);
        next = lines.join('\n');
    } else {
        next = current ? `## Core\n${bullet}\n\n${current}` : `## Core\n${bullet}`;
    }

    // The scope cap is a hard budget: rather than refuse the member's request,
    // make room by dropping the OLDEST dated Recent bullets — episodic trivia
    // is exactly what should lose to an explicit "remember this".
    while (next.length > config.memoryScopeMaxChars) {
        const lines = next.split('\n');
        const oldest = lines.reduce((best, l, i) => {
            const m = /^\s*-\s*\((\d{4}-\d{2}-\d{2})\)/.exec(l);
            return m && (best === -1 || m[1] < /\((\d{4}-\d{2}-\d{2})\)/.exec(lines[best])[1]) ? i : best;
        }, -1);
        if (oldest === -1) return { ok: false, reason: 'full' };
        lines.splice(oldest, 1);
        next = lines.join('\n');
    }

    write(file, next);
    metrics.inc('memoryNotes');
    log.info(`[ai] memory note user=${userId} chars=${clean.length}`);
    return { ok: true, reason: 'written', text: clean };
}

// ------------------------------------------------------------- admin CRUD
// For the /ai dashboard (localhost-only service, session-auth at the proxy).
// The name whitelist is the security-critical line: nothing outside
// data/memory/, no traversal, no non-memory files.
const FILE_RE = /^(server|channel|user)-[0-9A-Za-z_-]+\.md$/;
function assertName(file) {
    if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error('Tên file trí nhớ không hợp lệ.');
    return file;
}

function adminList() {
    let names = [];
    try { names = fs.readdirSync(MEM_DIR); } catch (_) { /* no memory yet */ }
    return names.filter((n) => FILE_RE.test(n)).sort().map((file) => {
        const content = read(file);
        const preview = content.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
        return {
            file,
            scope: file.split('-')[0],
            size: content.length,
            preview: preview.replace(/^\s*-\s*/, '').slice(0, 80),
        };
    });
}

function adminRead(file) {
    assertName(file);
    const content = read(file);
    return content || null;
}

function adminWrite(file, content) {
    assertName(file);
    if (typeof content !== 'string' || !content.trim()) throw new Error('Nội dung trống — dùng nút Xoá nếu muốn bỏ file.');
    const cap = file.startsWith('server-') ? config.memoryServerMaxChars : config.memoryScopeMaxChars;
    if (content.length > cap) throw new Error(`Nội dung quá dài (tối đa ${cap} ký tự cho file này).`);
    write(file, content);
}

function adminDelete(file) {
    assertName(file);
    try { fs.unlinkSync(path.join(MEM_DIR, file)); return true; }
    catch (_) { return false; }
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

module.exports = {
    getContext, scheduleUpdate, appendUserNote,
    adminList, adminRead, adminWrite, adminDelete,
};
