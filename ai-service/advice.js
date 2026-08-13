// Member-set standing advice ("Hãy luôn tra web nếu không chắc", ...), added
// from Discord via `!ai rule <text>` by authorized users. Per-guild, persisted
// under ai-service/data/, injected into every prompt for that guild. Hard caps
// on count and length keep it from eating the context window. This is guidance
// for conversation only — it grants no capabilities (§21 still holds).
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { stripInvisible } = require('./guard');

const DATA_DIR = path.join(__dirname, 'data');
const MAX_ITEMS = parseInt(process.env.AI_ADVICE_MAX_ITEMS, 10) || 20;
const MAX_LEN = parseInt(process.env.AI_ADVICE_MAX_LEN, 10) || 300;

const fileFor = (guildId) => path.join(DATA_DIR, `advice-${String(guildId).replace(/[^0-9A-Za-z_-]/g, '')}.json`);

function load(guildId) {
    try {
        const raw = JSON.parse(fs.readFileSync(fileFor(guildId), 'utf8'));
        return Array.isArray(raw.items) ? raw.items : [];
    } catch (_) { return []; }
}

function save(guildId, items) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fileFor(guildId), JSON.stringify({ items }, null, 2));
}

function list(guildId) {
    return load(guildId);
}

function add(guildId, text, author) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('Nội dung quy tắc trống.');
    if (t.length > MAX_LEN) throw new Error(`Quy tắc quá dài (tối đa ${MAX_LEN} ký tự).`);
    const items = load(guildId);
    if (items.length >= MAX_ITEMS) throw new Error(`Đã đủ ${MAX_ITEMS} quy tắc — xoá bớt bằng \`!ai rule xoa <số>\` trước.`);
    items.push({ text: t, author: String(author || '').slice(0, 60), ts: Date.now() });
    save(guildId, items);
    log.info(`[ai] advice added guild=${guildId} count=${items.length}`);
    return items;
}

function remove(guildId, index) {
    const items = load(guildId);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
    items.splice(index, 1);
    save(guildId, items);
    log.info(`[ai] advice removed guild=${guildId} count=${items.length}`);
    return items;
}

// Advice is permission-gated and whitespace-collapsed at add() time; the
// invisible-char strip here covers hidden payloads in already-stored items.
function renderForPrompt(guildId) {
    const items = load(guildId);
    if (!items.length) return '';
    return '## Member-set rules (via `!ai rule`) — follow them\n' +
        items.map((i) => `- ${stripInvisible(i.text)}`).join('\n');
}

module.exports = { list, add, remove, renderForPrompt };
