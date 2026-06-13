const log = require('../../logger');
const client = require('../client');
const { data, saveData } = require('../state');
const { getWallet, addNgoc, spendNgocForGame, renderEmote, fmt } = require('./currency');
const LOTTERY = require('../config/lottery');
const profile = require('./profile');
const { chunkMessage } = require('../utils');

function ensureRoot(guildId) {
    if (!data.lottery) data.lottery = {};
    if (!data.lottery[guildId]) {
        data.lottery[guildId] = {
            notificationChannelId: null,
            pool: LOTTERY.SEED_POOL,
            reserveFund: 0,
            tickets: []
        };
    }
    const g = data.lottery[guildId];
    if (typeof g.pool !== 'number') g.pool = LOTTERY.SEED_POOL;
    // The seed is the pool's floor: the pool only ever resets to SEED_POOL then
    // grows, so it's never legitimately below it. This also rebases the live pool
    // when SEED_POOL is raised (e.g. 40k → 100k) — the carried-over value bumps
    // up to the new base on first access after deploy, no manual migration needed.
    if (g.pool < LOTTERY.SEED_POOL) g.pool = LOTTERY.SEED_POOL;
    if (typeof g.reserveFund !== 'number') g.reserveFund = 0;
    if (!Array.isArray(g.tickets)) g.tickets = [];
    return g;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

function parseNumbers(parts) {
    const nums = [];
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (!Number.isInteger(n)) return null;
        nums.push(n);
    }
    return nums;
}

function validateNumbers(nums) {
    if (!Array.isArray(nums) || nums.length !== LOTTERY.NUMBERS_PER_TICKET) return false;
    const seen = new Set();
    for (const n of nums) {
        if (!Number.isInteger(n)) return false;
        if (n < 1 || n > LOTTERY.NUMBER_POOL_MAX) return false;
        if (seen.has(n)) return false;
        seen.add(n);
    }
    return true;
}

function randomNumbers() {
    const pool = [];
    for (let i = 1; i <= LOTTERY.NUMBER_POOL_MAX; i++) pool.push(i);
    // Fisher-Yates partial shuffle for first k items
    for (let i = 0; i < LOTTERY.NUMBERS_PER_TICKET; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, LOTTERY.NUMBERS_PER_TICKET).sort((a, b) => a - b);
}

function sortNumbers(nums) {
    return [...nums].sort((a, b) => a - b);
}

function countMatches(ticket, winning) {
    const set = new Set(winning);
    let c = 0;
    for (const n of ticket) if (set.has(n)) c++;
    return c;
}

function fmtNumbers(nums) {
    return sortNumbers(nums).map(n => `**${n}**`).join(' · ');
}

// ── Buying tickets ──────────────────────────────────────────────────────────

function userTicketsThisDraw(guildId, userId) {
    const g = ensureRoot(guildId);
    return g.tickets.filter(t => t.userId === userId);
}

// Buy a single ticket. Returns { ok, error?, ticket?, newPool, newCount }
function buyTicket(guildId, userId, numbers) {
    const g = ensureRoot(guildId);
    if (!validateNumbers(numbers)) {
        return { ok: false, error: 'invalid_numbers' };
    }
    const existing = userTicketsThisDraw(guildId, userId).length;
    if (existing >= LOTTERY.MAX_TICKETS_PER_DRAW) {
        return { ok: false, error: 'limit_reached', existing };
    }
    const w = getWallet(guildId, userId);
    const totalNgoc = w.ngoc + (w.lockedNgoc || 0);
    if (totalNgoc < LOTTERY.TICKET_PRICE) {
        return { ok: false, error: 'insufficient', have: totalNgoc };
    }
    spendNgocForGame(guildId, userId, LOTTERY.TICKET_PRICE);
    g.pool += LOTTERY.POOL_SHARE;
    g.reserveFund += LOTTERY.CONSOLATION_SHARE;
    const ticket = { userId, numbers: sortNumbers(numbers), boughtAt: Date.now() };
    g.tickets.push(ticket);
    saveData();
    return { ok: true, ticket, newPool: g.pool, newCount: existing + 1 };
}

// Buy multiple random ("bao") tickets up to limit.
// Returns { ok, error?, bought: [tickets], newPool, newCount }
function buyRandomTickets(guildId, userId, count) {
    const g = ensureRoot(guildId);
    const existing = userTicketsThisDraw(guildId, userId).length;
    const room = LOTTERY.MAX_TICKETS_PER_DRAW - existing;
    if (room <= 0) return { ok: false, error: 'limit_reached', existing };
    const want = Math.min(count, room);
    const w = getWallet(guildId, userId);
    const totalNgoc = w.ngoc + (w.lockedNgoc || 0);
    const totalCost = want * LOTTERY.TICKET_PRICE;
    if (totalNgoc < totalCost) {
        return { ok: false, error: 'insufficient', have: totalNgoc, need: totalCost };
    }
    const bought = [];
    for (let i = 0; i < want; i++) {
        const numbers = randomNumbers();
        spendNgocForGame(guildId, userId, LOTTERY.TICKET_PRICE);
        g.pool += LOTTERY.POOL_SHARE;
        g.reserveFund += LOTTERY.CONSOLATION_SHARE;
        const ticket = { userId, numbers, boughtAt: Date.now() };
        g.tickets.push(ticket);
        bought.push(ticket);
    }
    saveData();
    return { ok: true, bought, newPool: g.pool, newCount: existing + want };
}

// ── Draw execution ──────────────────────────────────────────────────────────

// Runs a draw for one guild. Returns the result for announcement.
function runDraw(guildId) {
    const g = ensureRoot(guildId);
    const winningNumbers = randomNumbers();
    const ticketCount = g.tickets.length;
    const buckets = { 4: [], 3: [], 2: [] };

    for (const t of g.tickets) {
        const matches = countMatches(t.numbers, winningNumbers);
        if (matches >= 2) buckets[matches].push(t);
    }

    const jackpotWinners = buckets[4];
    const winners3 = buckets[3];
    const winners2 = buckets[2];

    const poolBeforeDraw = g.pool;
    let jackpotPerWinner = 0;
    let jackpotTotalPaid = 0;
    let poolReset = false;

    if (jackpotWinners.length > 0) {
        jackpotPerWinner = Math.floor(g.pool / jackpotWinners.length);
        jackpotTotalPaid = jackpotPerWinner * jackpotWinners.length;
        for (const t of jackpotWinners) {
            addNgoc(guildId, t.userId, jackpotPerWinner);
            profile.recordWin(guildId, t.userId, jackpotPerWinner, 'Xổ Số');
        }
        // Reset pool to seed (backfilled from gacha sink — practically just refilled)
        g.pool = LOTTERY.SEED_POOL;
        poolReset = true;
    }

    let consolationPaid = 0;
    for (const t of winners3) {
        addNgoc(guildId, t.userId, LOTTERY.PRIZE_3_OF_4);
        consolationPaid += LOTTERY.PRIZE_3_OF_4;
    }
    for (const t of winners2) {
        addNgoc(guildId, t.userId, LOTTERY.PRIZE_2_OF_4);
        consolationPaid += LOTTERY.PRIZE_2_OF_4;
    }
    g.reserveFund -= consolationPaid;
    // If reserve dipped negative, leave it negative — the next draws will replenish.
    // Backfill from gacha sink in spirit (no separate sink tracker).

    // Clear tickets for next draw
    g.tickets = [];
    saveData();

    return {
        guildId,
        winningNumbers,
        ticketCount,
        jackpotWinners: jackpotWinners.map(t => ({ userId: t.userId, numbers: t.numbers })),
        jackpotPerWinner,
        jackpotTotalPaid,
        poolBeforeDraw,
        poolReset,
        newPool: g.pool,
        winners3: winners3.map(t => ({ userId: t.userId, numbers: t.numbers })),
        winners2: winners2.map(t => ({ userId: t.userId, numbers: t.numbers })),
        consolationPaid,
        reserveFundAfter: g.reserveFund
    };
}

// ── Refund ────────────────────────────────────────────────────────────────

// Refund tickets in the current (not-yet-drawn) batch: return TICKET_PRICE per
// ticket to each buyer as ngọc, reverse the pool/reserve accumulation those
// tickets caused, and remove them from the draw. Pass onlyUserId to refund just
// one person; omit it to refund everyone. Used after a balance change (e.g. pool
// resize invalidates already-bought numbers) or as a manual chữa-cháy tool.
// Refunds go to spendable ngọc — we don't track how much was paid from locked
// ngọc at buy time, so refunds may unlock a bit; acceptable for an admin tool.
// Returns { refundedTickets, refundedNgoc, perUser: [{userId,count,ngoc}], poolAfter }.
function refundCurrentDraw(guildId, onlyUserId = null) {
    const g = ensureRoot(guildId);
    const keep = [];
    const refund = [];
    for (const t of g.tickets) {
        if (onlyUserId && t.userId !== onlyUserId) keep.push(t);
        else refund.push(t);
    }
    const perUserMap = new Map();
    let refundedNgoc = 0;
    for (const t of refund) {
        addNgoc(guildId, t.userId, LOTTERY.TICKET_PRICE);
        refundedNgoc += LOTTERY.TICKET_PRICE;
        g.pool -= LOTTERY.POOL_SHARE;
        g.reserveFund -= LOTTERY.CONSOLATION_SHARE;
        const e = perUserMap.get(t.userId) || { userId: t.userId, count: 0, ngoc: 0 };
        e.count += 1;
        e.ngoc += LOTTERY.TICKET_PRICE;
        perUserMap.set(t.userId, e);
    }
    // Pool should never fall below seed (the carried-over balance before this
    // draw is always ≥ seed); clamp defensively against odd/double-refund states.
    if (g.pool < LOTTERY.SEED_POOL) g.pool = LOTTERY.SEED_POOL;
    g.tickets = keep;
    saveData();
    return {
        refundedTickets: refund.length,
        refundedNgoc,
        perUser: Array.from(perUserMap.values()),
        poolAfter: g.pool
    };
}

// ── Announce ────────────────────────────────────────────────────────────────

async function announceDraw(result) {
    const g = ensureRoot(result.guildId);
    const channelId = g.notificationChannelId;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const ngoc = renderEmote('ngoc');
    const nextTs = nextDrawUnix();
    const winNumStr = fmtNumbers(result.winningNumbers);
    const lines = [];
    lines.push(`# 🎰 KẾT QUẢ XỔ SỐ TÍCH LŨY 🎰`);
    lines.push(`## Số trúng: ${winNumStr}`);
    lines.push(`-# Tổng vé bán đợt này: **${fmt(result.ticketCount)}**`);
    lines.push('');

    if (result.jackpotWinners.length > 0) {
        if (result.jackpotWinners.length === 1) {
            const w = result.jackpotWinners[0];
            lines.push(`# 🏆 JACKPOT! 🏆`);
            lines.push(`## <@${w.userId}> trúng **${fmt(result.jackpotPerWinner)}** ${ngoc}`);
            lines.push(`> Vé: ${fmtNumbers(w.numbers)} (4/4)`);
        } else {
            lines.push(`# 🏆 JACKPOT — ${result.jackpotWinners.length} người trúng! 🏆`);
            lines.push(`## Mỗi người: **${fmt(result.jackpotPerWinner)}** ${ngoc}`);
            for (const w of result.jackpotWinners) {
                lines.push(`> <@${w.userId}> — ${fmtNumbers(w.numbers)} (4/4)`);
            }
        }
        lines.push('');
    }

    if (result.winners3.length > 0 || result.winners2.length > 0) {
        lines.push(`### 🎉 Giải phụ`);
        for (const w of result.winners3) {
            lines.push(`- <@${w.userId}> — **${fmt(LOTTERY.PRIZE_3_OF_4)}** ${ngoc} · 3/4 · ${fmtNumbers(w.numbers)}`);
        }
        for (const w of result.winners2) {
            lines.push(`- <@${w.userId}> — **${fmt(LOTTERY.PRIZE_2_OF_4)}** ${ngoc} · 2/4 · ${fmtNumbers(w.numbers)}`);
        }
        lines.push('');
    } else if (result.jackpotWinners.length === 0) {
        lines.push(`-# Đợt này không có ai trúng. Pool tiếp tục tích lũy!`);
        lines.push('');
    }

    lines.push(`---`);
    lines.push(`💰 Pool đợt sau: **${fmt(result.newPool)}** ${ngoc}${result.poolReset ? ' *(reset sau jackpot)*' : ''}`);
    lines.push(`⏰ Đợt sau: <t:${nextTs}:F> (<t:${nextTs}:R>)`);
    lines.push(`🎟️ Mua vé: \`!xoso bao\` · \`!xoso <4 số 1-${LOTTERY.NUMBER_POOL_MAX}>\``);

    // Big draws (lots of jackpot/3of4/2of4 winners) easily blow past Discord's
    // 2000-char message limit, so split on blank-line / line boundaries.
    const chunks = chunkMessage(lines.join('\n'));
    for (const chunk of chunks) {
        await channel.send({ content: chunk, allowedMentions: { users: [] } })
            .catch(e => log.warn('lottery: announce send failed', e));
    }
}

// ── Schedule ────────────────────────────────────────────────────────────────

// Compute unix seconds for the next 10:00 or 22:00 Asia/Ho_Chi_Minh.
function nextDrawUnix() {
    const VN_OFFSET = 7 * 3600 * 1000;
    const nowVn = new Date(Date.now() + VN_OFFSET);
    const h = nowVn.getUTCHours();
    const target = new Date(nowVn);
    target.setUTCMinutes(0, 0, 0);
    if (h < LOTTERY.DRAW_HOURS[0]) {
        target.setUTCHours(LOTTERY.DRAW_HOURS[0]);
    } else if (h < LOTTERY.DRAW_HOURS[1]) {
        target.setUTCHours(LOTTERY.DRAW_HOURS[1]);
    } else {
        target.setUTCDate(target.getUTCDate() + 1);
        target.setUTCHours(LOTTERY.DRAW_HOURS[0]);
    }
    return Math.floor((target.getTime() - VN_OFFSET) / 1000);
}

let _cronTasks = [];
function scheduleDraws() {
    if (_cronTasks.length > 0) return;
    let cron;
    try { cron = require('node-cron'); }
    catch (e) { log.warn('lottery: node-cron not available, draws disabled', e); return; }

    for (const hour of LOTTERY.DRAW_HOURS) {
        const expr = `0 ${hour} * * *`;
        const task = cron.schedule(expr, async () => {
            try { await runAllDraws(); }
            catch (e) { log.error('lottery: draw cron error', e); }
        }, { timezone: LOTTERY.TIMEZONE });
        _cronTasks.push(task);
        log.info(`lottery: scheduled draw — ${expr} ${LOTTERY.TIMEZONE}`);
    }
}

async function runAllDraws() {
    if (!data.lottery) return;
    for (const guildId of Object.keys(data.lottery)) {
        try {
            const result = runDraw(guildId);
            await announceDraw(result);
        } catch (e) {
            log.error(`lottery: draw failed for guild ${guildId}`, e);
        }
    }
}

// ── Channel admin ───────────────────────────────────────────────────────────

function setNotificationChannel(guildId, channelId) {
    const g = ensureRoot(guildId);
    g.notificationChannelId = channelId;
    saveData();
}

function getNotificationChannelId(guildId) {
    const g = ensureRoot(guildId);
    return g.notificationChannelId;
}

// ── Read accessors ──────────────────────────────────────────────────────────

function getPool(guildId) {
    return ensureRoot(guildId).pool;
}

// Admin override of the current jackpot pool. Clamps to the seed floor (the pool
// can never sit below the base jackpot). Returns { before, after, floored }.
function setPool(guildId, amount) {
    const g = ensureRoot(guildId);
    const before = g.pool;
    g.pool = Math.max(amount, LOTTERY.SEED_POOL);
    saveData();
    return { before, after: g.pool, floored: amount < LOTTERY.SEED_POOL };
}

function getTicketCount(guildId) {
    return ensureRoot(guildId).tickets.length;
}

module.exports = {
    LOTTERY,
    ensureRoot,
    parseNumbers,
    validateNumbers,
    randomNumbers,
    sortNumbers,
    fmtNumbers,
    buyTicket,
    buyRandomTickets,
    userTicketsThisDraw,
    refundCurrentDraw,
    runDraw,
    runAllDraws,
    announceDraw,
    nextDrawUnix,
    scheduleDraws,
    setNotificationChannel,
    getNotificationChannelId,
    getPool,
    setPool,
    getTicketCount
};
