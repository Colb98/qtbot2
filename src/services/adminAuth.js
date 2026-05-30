// Authentication for the admin web panel.
//
// Two kinds of accounts:
//   - root: a single bootstrap account whose credentials come from the
//     ADMIN_USER / ADMIN_PASS environment variables. Only root may manage other
//     accounts. Never persisted to disk.
//   - admin: accounts created by root from the panel, stored (salted+hashed)
//     in data.json under data.webAdmins. They can edit economy values but cannot
//     manage accounts.
//
// Sessions are in-memory (cleared on restart) and carried by an httpOnly cookie.
const crypto = require('crypto');
const { data, saveData } = require('../state');
const log = require('../../logger');

const ROOT_USER = process.env.ADMIN_USER || '';
const ROOT_PASS = process.env.ADMIN_PASS || '';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const SCRYPT_KEYLEN = 64;

const sessions = new Map(); // token -> { username, role, expires }

function rootEnabled() {
    return ROOT_USER.length > 0 && ROOT_PASS.length > 0;
}

function accountsStore() {
    if (!data.webAdmins) data.webAdmins = {};
    return data.webAdmins;
}

function safeStrEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, s, SCRYPT_KEYLEN).toString('hex');
    return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHash) {
    let derived;
    try {
        derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    } catch (e) {
        return false;
    }
    return safeStrEqual(derived, expectedHash);
}

function pruneExpired() {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (s.expires <= now) sessions.delete(token);
    }
}

function createSession(username, role) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, role, expires: Date.now() + SESSION_TTL_MS });
    return token;
}

// Returns a session token on success, or null on bad credentials.
function login(username, password) {
    if (!username || !password) return null;
    if (rootEnabled() && safeStrEqual(username, ROOT_USER)) {
        return safeStrEqual(password, ROOT_PASS) ? createSession(ROOT_USER, 'root') : null;
    }
    const acc = accountsStore()[username];
    if (acc && verifyPassword(password, acc.salt, acc.hash)) {
        return createSession(username, 'admin');
    }
    return null;
}

function getSession(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expires <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    return { username: s.username, role: s.role };
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function destroyUserSessions(username) {
    for (const [token, s] of sessions) {
        if (s.username === username) sessions.delete(token);
    }
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function createAccount(username, password, createdBy) {
    if (!USERNAME_RE.test(username || '')) {
        throw new Error('Tên đăng nhập phải dài 3-32 ký tự (chữ, số, _ . -).');
    }
    if (!password || String(password).length < 6) {
        throw new Error('Mật khẩu phải dài ít nhất 6 ký tự.');
    }
    if (rootEnabled() && safeStrEqual(username, ROOT_USER)) {
        throw new Error('Tên đăng nhập trùng với tài khoản gốc.');
    }
    const store = accountsStore();
    if (store[username]) {
        throw new Error('Tài khoản đã tồn tại.');
    }
    const { salt, hash } = hashPassword(password);
    store[username] = { salt, hash, createdBy: createdBy || null, createdAt: new Date().toISOString() };
    saveData();
    log.info(`adminAuth: account "${username}" created by "${createdBy}"`);
}

function deleteAccount(username) {
    const store = accountsStore();
    if (!store[username]) throw new Error('Không tìm thấy tài khoản.');
    delete store[username];
    destroyUserSessions(username);
    saveData();
    log.info(`adminAuth: account "${username}" deleted`);
}

function changePassword(username, newPassword) {
    if (!newPassword || String(newPassword).length < 6) {
        throw new Error('Mật khẩu phải dài ít nhất 6 ký tự.');
    }
    const store = accountsStore();
    if (!store[username]) throw new Error('Không tìm thấy tài khoản.');
    const { salt, hash } = hashPassword(newPassword);
    store[username].salt = salt;
    store[username].hash = hash;
    destroyUserSessions(username);
    saveData();
    log.info(`adminAuth: password changed for "${username}"`);
}

function listAccounts() {
    const store = accountsStore();
    return Object.keys(store).map(username => ({
        username,
        createdBy: store[username].createdBy || null,
        createdAt: store[username].createdAt || null
    }));
}

module.exports = {
    rootEnabled,
    login,
    getSession,
    destroySession,
    createAccount,
    deleteAccount,
    changePassword,
    listAccounts,
    SESSION_TTL_MS
};
