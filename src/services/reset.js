// Server reset — one-time wealth compression at a season boundary.
// See season2_reset_spec.md. Triggered manually by an admin (!server_reset),
// never on a cron. Per guild, idempotent via data.reset[guildId].
//
// For each wallet:
//   • ngọc (ví + khoá + két) is compressed on the RESET.LADDER carry curve and
//     returned as free ngọc; locked ngọc and the bank are zeroed.
//   • live Thiên Thưởng is moved into frozen `tt_legacy` (unlocked later by
//     wagering — !doitt); resetWager is zeroed so pre-reset wagering doesn't
//     grant a head start.
//   • slot pity / streak state is cleared for a clean slate.
const fs = require('fs');
const { data, saveData, flushSync, DATA_PATH } = require('../state');
const economy = require('../config/economy');
const { getWallet } = require('./currency');
const log = require('../../logger');

// Bracketed marginal carry-over. Each bracket carries `rate` of the slice of
// `total` that falls between the previous cap and its own `upTo`.
function ladderCarry(total, ladder = economy.RESET.LADDER) {
    let carried = 0;
    let prev = 0;
    for (const b of ladder) {
        if (total <= prev) break;
        const slice = Math.min(total, b.upTo) - prev;
        carried += slice * b.rate;
        prev = b.upTo;
    }
    return Math.floor(carried);
}

function hasReset(guildId) {
    return !!(data.reset && data.reset[guildId]);
}

// Copy data.json to a timestamped .bak (flush first so it's current). Throws on
// failure — callers should abort the reset if the backup can't be written.
function backupDataFile() {
    flushSync();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${DATA_PATH}.pre-reset-${stamp}.bak`;
    fs.copyFileSync(DATA_PATH, dest);
    return dest;
}

// Preview the aggregate effect without mutating anything.
function previewReset(guildId) {
    const guildWallets = (data.wallet && data.wallet[guildId]) || {};
    let wallets = 0, ngocBefore = 0, ngocAfter = 0, ttMoved = 0;
    for (const w of Object.values(guildWallets)) {
        if (!w) continue;
        const base = (w.ngoc || 0) + (w.lockedNgoc || 0)
            + (w.bank ? (w.bank.ngoc || 0) + (w.bank.locked || 0) : 0);
        const tt = (w.items && w.items.thienthuong || 0)
            + (w.lockedItems && w.lockedItems.thienthuong || 0);
        ngocBefore += base;
        ngocAfter += ladderCarry(base);
        ttMoved += tt;
        wallets++;
    }
    return { wallets, ngocBefore, ngocAfter, ttMoved };
}

function applyServerReset(guildId, { force = false } = {}) {
    data.reset = data.reset || {};
    if (data.reset[guildId] && !force) return { ok: false, reason: 'already-applied' };

    const guildWallets = (data.wallet && data.wallet[guildId]) || {};
    let wallets = 0, ngocBefore = 0, ngocAfter = 0, ttMoved = 0;
    for (const userId of Object.keys(guildWallets)) {
        const w = getWallet(guildId, userId); // normalizes/backfills the shape
        const base = w.ngoc + w.lockedNgoc + (w.bank.ngoc || 0) + (w.bank.locked || 0);
        const carried = ladderCarry(base);
        ngocBefore += base;
        ngocAfter += carried;
        w.ngoc = carried;
        w.lockedNgoc = 0;
        w.bank = { ngoc: 0, locked: 0, snapshot: 0 };

        const tt = (w.items.thienthuong || 0) + (w.lockedItems.thienthuong || 0);
        w.items.tt_legacy = (w.items.tt_legacy || 0) + tt;
        w.items.thienthuong = 0;
        w.lockedItems.thienthuong = 0;
        ttMoved += tt;

        w.resetWager = 0;
        w.slotPity = 0;
        w.slotStreakTotalBet = 0;
        w.slotStreakMaxBet = 0;
        w.slotPityThreshold = 0;
        wallets++;
    }

    const seasonId = require('./season').getCurrentSeasonId();
    data.reset[guildId] = { appliedAt: Date.now(), seasonId };
    saveData();
    log.info(`reset: guild ${guildId} — ${wallets} wallets, ngọc ${ngocBefore} → ${ngocAfter}, TT frozen ${ttMoved}`);
    return { ok: true, wallets, ngocBefore, ngocAfter, ttMoved };
}

module.exports = { ladderCarry, hasReset, backupDataFile, previewReset, applyServerReset };
