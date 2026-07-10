// Validated read/write facade for the web inventory editor.
//
// Wallets are live shared state: changes made here are immediately visible to
// bot commands, then persisted through state.saveData(). Only explicitly
// whitelisted numeric fields can be read or changed.
const log = require('../../logger');
const { data, saveData } = require('../state');
const { getWallet, ITEM_KEYS, ITEM_LABELS } = require('./currency');

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const CURRENCY_FIELDS = [
    { path: 'nganphieu', label: 'Ngân phiếu', group: 'Tiền tệ' },
    { path: 'ngoc', label: 'Ngọc (dùng được)', group: 'Tiền tệ', allowNegative: true },
    { path: 'lockedNgoc', label: 'Ngọc khoá', group: 'Tiền tệ' },
    { path: 'bank.ngoc', label: 'Ngọc trong két', group: 'Tiền tệ' },
    { path: 'bank.locked', label: 'Ngọc khoá trong két', group: 'Tiền tệ' }
];

const ITEM_FIELDS = ITEM_KEYS.flatMap(key => [
    { path: `items.${key}`, label: ITEM_LABELS[key] || key, group: 'Vật phẩm', itemKey: key, locked: false },
    { path: `lockedItems.${key}`, label: `${ITEM_LABELS[key] || key} (khoá)`, group: 'Vật phẩm khoá', itemKey: key, locked: true }
]);

const PROGRESS_FIELDS = [
    { path: 'pity.kt', label: 'Pity Kỳ Thưởng', group: 'Pity & tiến trình' },
    { path: 'pity.tt', label: 'Pity Thiên Thưởng', group: 'Pity & tiến trình' },
    { path: 'slotPity', label: 'Slot pity', group: 'Pity & tiến trình' },
    { path: 'slotStreakMaxBet', label: 'Chuỗi cược tối đa slot', group: 'Pity & tiến trình' },
    { path: 'resetWager', label: 'Cược tích luỹ đổi TT cũ', group: 'Pity & tiến trình' }
];

const FIELD_DEFS = [...CURRENCY_FIELDS, ...ITEM_FIELDS, ...PROGRESS_FIELDS];
const FIELD_BY_PATH = new Map(FIELD_DEFS.map(field => [field.path, field]));

function validateId(value, label) {
    const id = String(value || '').trim();
    if (!SAFE_ID_RE.test(id) || FORBIDDEN_IDS.has(id)) {
        throw new Error(`${label} không hợp lệ.`);
    }
    return id;
}

function getPath(obj, path) {
    return path.split('.').reduce((node, key) => node[key], obj);
}

function setPath(obj, path, value) {
    const parts = path.split('.');
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
    node[parts[parts.length - 1]] = value;
}

function fieldDefinitions() {
    return FIELD_DEFS.map(field => ({ ...field, allowNegative: !!field.allowNegative }));
}

function emptyWallet() {
    return {
        nganphieu: 0,
        ngoc: 0,
        lockedNgoc: 0,
        items: Object.fromEntries(ITEM_KEYS.map(key => [key, 0])),
        lockedItems: Object.fromEntries(ITEM_KEYS.map(key => [key, 0])),
        pity: { kt: 0, tt: 0 },
        bank: { ngoc: 0, locked: 0, snapshot: 0 },
        slotPity: 0,
        slotStreakMaxBet: 0,
        resetWager: 0
    };
}

function inventorySnapshot(guildId, userId) {
    const gid = validateId(guildId, 'Guild ID');
    const uid = validateId(userId, 'User ID');
    const existed = !!(data.wallet && data.wallet[gid] && data.wallet[gid][uid]);
    // Browsing a Discord member must not create/persist an empty wallet.
    const wallet = existed ? getWallet(gid, uid) : emptyWallet();
    const values = {};
    for (const field of FIELD_DEFS) values[field.path] = getPath(wallet, field.path);
    return { guildId: gid, userId: uid, existed, values };
}

function validateValue(field, raw) {
    if (typeof raw !== 'number') {
        throw new Error(`${field.label} phải là số nguyên an toàn.`);
    }
    const value = raw;
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${field.label} phải là số nguyên an toàn.`);
    }
    if (!field.allowNegative && value < 0) {
        throw new Error(`${field.label} không thể nhỏ hơn 0.`);
    }
    return value;
}

// Apply absolute values. `expected` contains the values seen by the editor and
// prevents silently overwriting a field that changed in the bot meanwhile.
function applyChanges(guildId, userId, changes, expected, actor) {
    const gid = validateId(guildId, 'Guild ID');
    const uid = validateId(userId, 'User ID');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new Error('Danh sách thay đổi không hợp lệ.');
    }
    const entries = Object.entries(changes);
    if (!entries.length) throw new Error('Không có thay đổi để lưu.');
    if (entries.length > FIELD_DEFS.length) throw new Error('Có quá nhiều trường thay đổi.');
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        throw new Error('Thiếu giá trị gốc; hãy tải lại kho đồ rồi thử lại.');
    }

    const wallet = getWallet(gid, uid);
    const prepared = [];
    for (const [path, raw] of entries) {
        const field = FIELD_BY_PATH.get(path);
        if (!field) throw new Error(`Không thể sửa trường: ${path}`);
        const oldValue = getPath(wallet, path);
        if (!Object.prototype.hasOwnProperty.call(expected, path)) {
            throw new Error(`Thiếu giá trị gốc của ${field.label}; hãy tải lại rồi thử lại.`);
        }
        const expectedValue = validateValue(field, expected[path]);
        if (oldValue !== expectedValue) {
            throw new Error(`${field.label} vừa thay đổi trong bot (${expectedValue} → ${oldValue}). Hãy tải lại rồi thử lại.`);
        }
        const newValue = validateValue(field, raw);
        if (oldValue !== newValue) prepared.push({ path, label: field.label, oldValue, newValue });
    }
    if (!prepared.length) throw new Error('Không có thay đổi để lưu.');

    for (const change of prepared) setPath(wallet, change.path, change.newValue);
    saveData();

    const who = actor && actor.username ? actor.username : 'unknown';
    const summary = prepared.map(c => `${c.path}:${c.oldValue}->${c.newValue}`).join(', ');
    log.info(`[inventory-admin] admin=${who} guild=${gid} user=${uid} ${summary}`);

    return { applied: prepared, inventory: inventorySnapshot(gid, uid) };
}

function statePlayerIds(guildId) {
    const gid = validateId(guildId, 'Guild ID');
    const ids = new Set();
    const wallets = data.wallet && data.wallet[gid];
    const registrations = data.registrations && data.registrations[gid];
    for (const id of Object.keys(wallets || {})) ids.add(id);
    for (const id of Object.keys(registrations || {})) ids.add(id);
    return Array.from(ids).filter(id => SAFE_ID_RE.test(id) && !FORBIDDEN_IDS.has(id));
}

function stateGuildIds() {
    const ids = new Set();
    for (const id of Array.isArray(data.guildId) ? data.guildId : []) ids.add(String(id));
    for (const id of Object.keys(data.wallet || {})) ids.add(id);
    for (const id of Object.keys(data.registrations || {})) ids.add(id);
    return Array.from(ids).filter(id => SAFE_ID_RE.test(id) && !FORBIDDEN_IDS.has(id));
}

module.exports = {
    fieldDefinitions,
    inventorySnapshot,
    applyChanges,
    statePlayerIds,
    stateGuildIds,
    validateId
};
