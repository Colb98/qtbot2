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

const MEMORY_SYSTEM = `Bạn là bộ phận GHI NHỚ DÀI HẠN của bot QT trong một server Discord.
Nhiệm vụ: VIẾT LẠI toàn bộ các file ghi nhớ, gộp thêm thông tin đáng giữ từ đoạn hội thoại mới.

CHỈ giữ thông tin ổn định, hữu ích lâu dài: sở thích, nghề nghiệp, ngôn ngữ hay dùng,
biệt danh, joke nội bộ lặp lại, sự kiện/hoạt động dài hạn của server.
KHÔNG giữ chuyện vặt một lần (hôm nay ăn gì, một câu đùa lẻ, chi tiết tạm thời).
Không có gì mới đáng giữ cho một file thì trả lại nguyên văn file cũ.
Mỗi file: gạch đầu dòng, tối đa ~120 từ.

Trả về DUY NHẤT một JSON đúng cú pháp, không thêm chữ nào khác:
{"server": "<file ghi nhớ server>", "channel": "<file ghi nhớ kênh>", "users": {"<userId>": "<file ghi nhớ người đó>"}}
Trong "users" chỉ được phép có những userId xuất hiện trong đoạn hội thoại.`;

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
        { role: 'user', content: `## Ghi nhớ hiện tại\n${JSON.stringify(current)}\n\n## Đoạn hội thoại vừa diễn ra\n${transcript}` },
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
