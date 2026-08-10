// Automatic session compaction: folds older messages into a rolling structured
// summary via the same provider router, keeping the recent tail verbatim.
// Scheduled as a follow-up task on the session's own queue right after a
// response is sent — so it never delays a reply and never races a generation.
const log = require('../logger');
const { config } = require('./config');
const { generateChatResponse } = require('./providers');
const sessions = require('./sessions');
const { enqueue, QueueFullError } = require('./queue');

// Structured schema: freeform summaries drop odd-shaped details; forcing fixed
// sections makes the model check each category (§9 of the integration plan).
const SUMMARIZE_SYSTEM = `Bạn là công cụ tóm tắt hội thoại Discord (nhiều người nói chuyện với bot QT).
Gộp "tóm tắt trước đó" (nếu có) với đoạn hội thoại mới thành MỘT bản tóm tắt duy nhất, theo đúng các mục:
- Người tham gia: ai đang chat, vai trò/đặc điểm đáng nhớ
- Chủ đề: đang bàn gì, diễn biến chính
- Quyết định / kết luận: những gì đã chốt
- Chưa xong: câu hỏi hoặc việc còn dang dở
- Đùa / biệt danh: joke nội bộ, cách gọi riêng đang dùng
- Thông tin đáng nhớ khác

Bỏ mục nào không có gì. Viết ngắn gọn bằng tiếng Việt, gạch đầu dòng, tối đa ~300 từ.
Chỉ trả về bản tóm tắt, không thêm lời dẫn.`;

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
            content: (prev ? `## Tóm tắt trước đó\n${prev}\n\n` : '') +
                `## Đoạn hội thoại cần gộp vào tóm tắt\n${transcriptOf(old)}`,
        },
    ], { maxTokens: config.summaryMaxTokens });

    if (sessions.applyCompaction(sessionKey, summary)) {
        log.info(`[ai] compacted session=${sessionKey} folded=${old.length} kept=${keep.length} ` +
            `summaryChars=${summary.length} took=${Date.now() - started}ms`);
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
