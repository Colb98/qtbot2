const { data, saveData } = require('../state');

// VNGGames giftcode portal (giftcode.vnggames.com/vn/redeem/A70). Redeeming by
// role ID needs no login; the portal's captcha is checked client-side only.
const API_BASE = 'https://vgrapi-sea.vnggames.com/coordinator/api/v1/code';
const GAME_CODE = 'A70';
const REGION = 'VN';
const SUCCESS_CODE = 1;
const TIMEOUT_MS = 15000;
// Error codes seen from the API; anything else falls back to its own message.
const ERROR_MESSAGES = {
    2106: 'mã không tồn tại',
    2113: 'không tìm thấy nhân vật hoặc server',
    2117: 'nhân vật đã nhập mã này rồi (hoặc mã đã hết lượt)'
};

function ensureStore() {
    if (!data.giftcode) data.giftcode = {};
    return data.giftcode;
}

// Codes someone already redeemed for everyone: { [CODE]: { by, at, count } }.
function ensureClaims() {
    if (!data.giftcodeClaims) data.giftcodeClaims = {};
    return data.giftcodeClaims;
}

function claimKey(code) {
    return code.toUpperCase();
}

function getClaim(code) {
    return ensureClaims()[claimKey(code)] || null;
}

// Synchronous check-and-set, so two users redeeming the same code at once
// can't both win the share.
function tryClaim(code, discordId) {
    const claims = ensureClaims();
    const key = claimKey(code);
    if (claims[key]) return false;
    claims[key] = { by: discordId, at: Date.now(), count: 0 };
    saveData();
    return true;
}

function setClaimCount(code, count) {
    const claim = getClaim(code);
    if (!claim) return;
    claim.count = count;
    saveData();
}

// Every saved character as [discordId, role].
function listRoles() {
    return Object.entries(ensureStore());
}

function getRole(discordId) {
    return ensureStore()[discordId] || null;
}

function saveRole(discordId, role) {
    ensureStore()[discordId] = { ...role, savedAt: Date.now() };
    saveData();
}

function removeRole(discordId) {
    const store = ensureStore();
    if (!store[discordId]) return false;
    delete store[discordId];
    saveData();
    return true;
}

async function request(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            'X-Client-Region': REGION,
            Origin: 'https://giftcode.vnggames.com',
            Referer: 'https://giftcode.vnggames.com/',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        // Non-JSON error page; handled below.
    }
    if (!json) throw new Error(`HTTP ${res.status}`);
    return {
        ok: res.ok && json.errorCode === SUCCESS_CODE,
        errorCode: json.errorCode,
        message: ERROR_MESSAGES[json.errorCode] || json.message || json.description || `HTTP ${res.status}`,
        data: json.data
    };
}

function normalizeRole(r) {
    return {
        roleId: String(r.roleId ?? ''),
        roleName: r.roleName ?? '',
        level: r.level ?? '',
        userId: String(r.userId ?? ''),
        serverId: String(r.serverId ?? ''),
        serverName: r.serverName ?? ''
    };
}

async function listServers() {
    const res = await request(`/server?gameCode=${GAME_CODE}`);
    if (!res.ok) throw new Error(res.message);
    return (res.data || [])
        .filter(s => Number(s.status) === 1)
        .map(s => ({ serverId: String(s.serverId), serverName: s.serverName }));
}

// Returns every character matching the role ID (one per server it exists on).
async function findRoles(roleId, serverId) {
    const params = new URLSearchParams({ gameCode: GAME_CODE, roleId });
    if (serverId) params.set('serverId', serverId);
    const res = await request(`/role-by-roleid?${params}`);
    if (!res.ok) return { roles: [], message: res.message };
    return { roles: (res.data || []).map(normalizeRole) };
}

async function redeem(role, code) {
    return request('/redeem', {
        method: 'POST',
        body: {
            userId: role.userId,
            serverId: role.serverId,
            gameCode: GAME_CODE,
            roleId: role.roleId,
            roleName: role.roleName,
            level: role.level,
            code
        }
    });
}

module.exports = {
    getRole, saveRole, removeRole, listRoles, listServers, findRoles, redeem,
    getClaim, tryClaim, setClaimCount
};
