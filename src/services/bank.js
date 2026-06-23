// Ngọc "két an toàn" (safe / bank). Players park ngọc here to protect it from
// accidental spending: banked ngọc is NEVER included in any spendable-balance
// check (games, exchange, gifts), but IS counted toward the !topngoc total.
//
// Each wallet carries `w.bank = { ngoc, locked, snapshot }`:
//   • ngoc / locked — banked free vs locked ngọc, kept split so a withdrawal
//     restores the exact locked-ness the ngọc went in with (locked ngọc earns
//     no bond when re-gifted, so we must not launder it into free ngọc).
//   • snapshot — bank total captured at the previous daily interest tick.
//
// Interest accrues once per GMT+7 day on min(snapshot, currentTotal): the LOWER
// of the balance at the start of the day and the balance now. Parking ngọc only
// briefly (deposit then withdraw before the next tick) therefore earns nothing.
// Flat rate (economy.BANK.INTEREST_RATE), no cap. Interest is paid as free ngọc.

const log = require('../../logger');
const { data, saveData } = require('../state');
const economy = require('../config/economy');
const { getWallet, todayStr } = require('./currency');

function bankedTotal(w) {
    if (!w || !w.bank) return 0;
    return (w.bank.ngoc || 0) + (w.bank.locked || 0);
}

// Move ngọc from the wallet into the safe. Free ngọc is taken first, then
// locked. `amount` may be a positive integer or the string 'all'.
function deposit(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    const freeAvail = w.ngoc;
    const lockedAvail = w.lockedNgoc;
    const avail = freeAvail + lockedAvail;
    const amt = amount === 'all' ? avail : amount;
    if (!Number.isInteger(amt) || amt <= 0) return { ok: false, error: 'bad_amount' };
    if (amt > avail) return { ok: false, error: 'insufficient', have: avail };

    const fromFree = Math.min(amt, freeAvail);
    const fromLocked = amt - fromFree;
    w.ngoc -= fromFree;
    w.lockedNgoc -= fromLocked;
    w.bank.ngoc += fromFree;
    w.bank.locked += fromLocked;
    saveData();
    return { ok: true, deposited: amt, fromFree, fromLocked, bank: bankedTotal(w), wallet: w.ngoc + w.lockedNgoc };
}

// Move ngọc from the safe back into the wallet. Free banked ngọc is returned
// first (usable right away), locked banked ngọc returns to lockedNgoc.
function withdraw(guildId, userId, amount) {
    const w = getWallet(guildId, userId);
    const bankFree = w.bank.ngoc;
    const bankLocked = w.bank.locked;
    const avail = bankFree + bankLocked;
    const amt = amount === 'all' ? avail : amount;
    if (!Number.isInteger(amt) || amt <= 0) return { ok: false, error: 'bad_amount' };
    if (amt > avail) return { ok: false, error: 'insufficient', have: avail };

    const fromFree = Math.min(amt, bankFree);
    const fromLocked = amt - fromFree;
    w.bank.ngoc -= fromFree;
    w.bank.locked -= fromLocked;
    w.ngoc += fromFree;
    w.lockedNgoc += fromLocked;
    saveData();
    return { ok: true, withdrawn: amt, toFree: fromFree, toLocked: fromLocked, bank: bankedTotal(w), wallet: w.ngoc + w.lockedNgoc };
}

// Walk every wallet and pay one day of interest on min(snapshot, current bank
// total), then roll the snapshot forward to the post-interest total (the start
// balance for the next day). Does NOT persist — caller saves.
function accrueInterestAll() {
    const rate = economy.BANK.INTEREST_RATE || 0;
    let users = 0, totalInterest = 0, changed = false;
    const wallets = data.wallet || {};
    for (const guildId of Object.keys(wallets)) {
        const g = wallets[guildId];
        for (const userId of Object.keys(g)) {
            const w = g[userId];
            if (!w || !w.bank) continue;
            const b = w.bank;
            const cur = (b.ngoc || 0) + (b.locked || 0);
            const base = Math.min(b.snapshot || 0, cur);
            const interest = base > 0 ? Math.floor(base * rate) : 0;
            if (interest > 0) {
                b.ngoc += interest;
                users++;
                totalInterest += interest;
            }
            const newSnap = cur + interest;
            if (b.snapshot !== newSnap) { b.snapshot = newSnap; changed = true; }
        }
    }
    if (changed) saveData();
    return { users, totalInterest };
}

// Pay interest at most once per GMT+7 day. The date guard means the 00:00 cron
// and the post-boot catch-up can both call this safely without double-paying.
function runDailyInterest() {
    data.bankInterest = data.bankInterest || {};
    const today = todayStr();
    if (data.bankInterest.lastRunDate === today) return { skipped: true };
    data.bankInterest.lastRunDate = today;
    const res = accrueInterestAll();
    saveData();
    log.info(`bank interest (${today}): paid ${res.totalInterest} ngọc to ${res.users} user(s)`);
    return res;
}

module.exports = {
    bankedTotal,
    deposit,
    withdraw,
    accrueInterestAll,
    runDailyInterest
};
