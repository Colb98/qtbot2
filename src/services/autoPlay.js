const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const log = require('../../logger');
const economy = require('../config/economy');
const { getWallet, renderEmote, fmt } = require('./currency');
const slot = require('./slot');
const coinflip = require('./coinflip');
const dice = require('./dice');
const profile = require('./profile');
const metrics = require('./metrics');
const { isBlockedByMaintenance } = require('./maintenance');

// Auto mode for the casino games: repeat the player's last bet once per
// AUTO_PLAY.INTERVAL_MS (the next round fires when the previous one is
// settled AND the interval since its start has elapsed), editing a single
// session message in place. One session per user — starting a new auto
// anywhere stops the previous one. A session ends on Stop, after MAX_ROUNDS,
// when the wallet can't cover the next round, or during maintenance.
// Sessions are in-memory only and do not survive a restart.

const sessions = new Map(); // userId -> session

// Auto mode intentionally hides running totals and per-round net so the player
// can't track P&L at a glance — they have to check `!khodo`. Only the last few
// round result blocks are shown, and net/aggregate lines are stripped from each.
const HISTORY_SIZE = 5;

const GAME_LABEL = { slot: 'Slot', coinflip: 'Coinflip', tong: 'Cược Tổng', mat: 'Cược Mặt' };

const STOP_REASON_TEXT = {
    user: 'đã dừng theo yêu cầu',
    broke: 'không đủ ngọc cho vòng tiếp theo',
    replaced: 'bạn đã bắt đầu phiên auto khác',
    maintenance: 'bot đang bảo trì',
    error: 'gặp lỗi khi cập nhật kết quả'
};

function cfg() {
    return economy.AUTO_PLAY;
}

function isActive(userId) {
    return sessions.has(userId);
}

function totalNgoc(guildId, userId) {
    const w = getWallet(guildId, userId);
    return w.ngoc + (w.lockedNgoc || 0);
}

function roundCost(session) {
    const p = session.params;
    if (session.game === 'slot') return p.amount * p.rolls;
    if (session.game === 'coinflip') return p.amount * p.flips;
    return p.amountPer * p.guesses.length;
}

function buildStopRow(userId, stopping = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`auto:stop:${userId}`)
            .setLabel(stopping ? 'Đang dừng…' : '⏹️ Dừng Auto')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(stopping)
    );
}

function betLabel(session) {
    const p = session.params;
    if (session.game === 'slot') return `${fmt(p.amount)}${p.rolls > 1 ? ` x${p.rolls}` : ''}`;
    if (session.game === 'coinflip') return `${fmt(p.amount)}${p.flips > 1 ? ` x${p.flips}` : ''}`;
    return p.guesses.length > 1 ? `${fmt(p.amountPer)} × ${p.guesses.length} cửa` : fmt(p.amountPer);
}

function headerLine(session) {
    return `🔁 **AUTO ${GAME_LABEL[session.game]}** · vòng **${session.round}/${session.maxRounds}** · cược **${betLabel(session)}** ${renderEmote('ngoc')}/vòng`;
}

function historySection(session) {
    return session.history.join('\n');
}

function compactRoundLine(session, bet, payout) {
    const net = payout - bet;
    const sign = net >= 0 ? '+' : '−';
    return `\`V${String(session.round).padStart(2)}\` cược ${fmt(bet)} → nhận ${fmt(payout)} ${renderEmote('ngoc')} (${sign}${fmt(Math.abs(net))})`;
}

function pushHistory(session, line) {
    session.history.push(line);
    while (session.history.length > HISTORY_SIZE) session.history.shift();
}

async function editSession(session, content, components) {
    try {
        await session.message.edit({ content, components });
        return true;
    } catch (e) {
        log.warn(`autoPlay: session message edit failed (${e.message})`);
        return false;
    }
}

// ── Big-win keepsakes ──────────────────────────────────────────────────────
// The session message is edited in place, so a rare hit would be overwritten
// by the next round. Wins at/above AUTO_PLAY.KEEP_MIN_MULT[game] are posted
// as their own message (pinging the player) so they're never missed and stay
// shareable after the auto sequence moves on.

function keepMinMult(game) {
    const k = cfg().KEEP_MIN_MULT || {};
    return Number.isFinite(k[game]) ? k[game] : Infinity;
}

function postKeepsake(session, content) {
    session.channel.send({
        content,
        allowedMentions: { users: [session.userId] }
    }).catch(e => log.warn(`autoPlay: keepsake send failed (${e.message})`));
}

function keepsakeHeader(session) {
    return `🏆 <@${session.userId}> trúng lớn ở vòng **${session.round}** AUTO ${GAME_LABEL[session.game]}!`;
}

// ── Per-game round executors ───────────────────────────────────────────────
// Each plays exactly one round (wallet/profile/metrics included via the game
// services) and returns { block, bet, payout } or { error }.

async function playSlotRound(session) {
    const p = session.params;
    const resolved = slot.resolveMultiRoll({
        guildId: session.guildId, userId: session.userId,
        requestedAmount: p.amount, isAll: false, rolls: p.rolls, metrics
    });
    if (resolved.error) return { error: resolved.error };
    const plays = resolved.plays;
    const ngocE = renderEmote('ngoc');
    const anim = renderEmote('slotanim');

    const totalAmount = plays.reduce((a, x) => a + x.amount, 0);
    const totalPayout = plays.reduce((a, x) => a + x.payout, 0);
    const reels = plays.map(x => x.spinResult.map(k => renderEmote(slot.SYMBOLS[k].emote)));

    // Column-by-column reveal: col1 → col3 → (col2 + result via runLoop's edit).
    // Matches the cadence of slot.runMultiRoll so manual and auto rounds feel the same.
    const renderReels = (states) => plays.length === 1
        ? `[ ${states[0][0]} | ${states[0][1]} | ${states[0][2]} ]`
        : states.map((s, i) => `\`${String(i + 1).padStart(2)}.\` ${s[0]} | ${s[1]} | ${s[2]}`).join('\n');
    const stateAnim = reels.map(() => [anim, anim, anim]);
    const state1 = reels.map(s => [s[0], anim, anim]);
    const state2 = reels.map(s => [s[0], anim, s[2]]);
    const editReels = (st) => {
        const parts = [headerLine(session)];
        if (session.history.length) parts.push(historySection(session));
        parts.push(renderReels(st));
        return editSession(session, parts.join('\n\n'), [buildStopRow(session.userId, session.stopRequested)]);
    };
    await editReels(stateAnim);
    await new Promise(r => setTimeout(r, 500));
    await editReels(state1);
    await new Promise(r => setTimeout(r, 500));
    await editReels(state2);
    await new Promise(r => setTimeout(r, 750));
    let block;
    if (plays.length === 1) {
        block = `[ ${reels[0][0]} | ${reels[0][1]} | ${reels[0][2]} ] (-${fmt(totalAmount)} ${ngocE})\n` +
            slot.formatResultLine({ mult: plays[0].mult, payout: plays[0].payout, outcomeName: plays[0].outcomeName });
    } else {
        const lines = plays.map((x, i) =>
            `\`${String(i + 1).padStart(2)}.\` ${reels[i][0]} | ${reels[i][1]} | ${reels[i][2]} — ${slot.formatResultShort({ mult: x.mult, payout: x.payout, outcomeName: x.outcomeName })}`);
        const net = totalPayout - totalAmount;
        const sign = net >= 0 ? '+' : '−';
        lines.push(`**Vòng này:** cược ${fmt(totalAmount)} → thắng ${fmt(totalPayout)} ${ngocE} (${sign}${fmt(Math.abs(net))})`);
        block = lines.join('\n');
    }

    const bigPlays = plays.filter(x => x.mult >= keepMinMult('slot'));
    if (bigPlays.length > 0) {
        const lines = [keepsakeHeader(session)];
        for (const x of bigPlays) {
            const s = x.spinResult.map(k => renderEmote(slot.SYMBOLS[k].emote));
            lines.push(`[ ${s[0]} | ${s[1]} | ${s[2]} ] (cược ${fmt(x.amount)} ${ngocE})`);
            lines.push(slot.formatResultLine({ mult: x.mult, payout: x.payout, outcomeName: x.outcomeName }));
        }
        postKeepsake(session, lines.join('\n'));
    }

    return { block, bet: totalAmount, payout: totalPayout };
}

function playCoinflipRound(session) {
    const p = session.params;
    const res = coinflip.runMultiFlip({
        guildId: session.guildId, userId: session.userId, displayName: session.displayName,
        side: p.side, isAll: false, requestedAmount: p.amount, flips: p.flips,
        viaButton: true, metrics
    });
    if (res.error) return { error: res.error };
    const bet = res.plays.reduce((a, x) => a + x.amount, 0);
    const payout = res.plays.reduce((a, x) => a + (x.won ? x.amount * 2 : 0), 0);
    return { block: res.content, bet, payout };
}

function playDiceRound(session) {
    const p = session.params;
    const { roll, play, totalCost } = dice.settleMultiBet({
        guildId: session.guildId, userId: session.userId, game: session.game,
        guesses: p.guesses, amountPer: p.amountPer, viaButton: true, wasAllIn: false,
        metrics, profile
    });
    const displayName = session.displayName;
    let block;
    if (p.guesses.length === 1) {
        const r = play.results[0];
        block = session.game === 'tong'
            ? dice.formatTongResult({ displayName, guess: r.guess, roll, sum: play.sum, won: r.won, amount: p.amountPer, mult: r.mult })
            : dice.formatMatResult({ displayName, face: r.face, roll, matches: r.matches, won: r.won, amount: p.amountPer, mult: r.mult });
    } else {
        block = session.game === 'tong'
            ? dice.formatTongResultMulti({ displayName, roll, sum: play.sum, results: play.results, amountPer: p.amountPer, totalCost, totalPayout: play.totalPayout })
            : dice.formatMatResultMulti({ displayName, roll, results: play.results, amountPer: p.amountPer, totalCost, totalPayout: play.totalPayout });
    }

    const bigWins = play.results.filter(r => r.won && r.mult >= keepMinMult(session.game));
    if (bigWins.length > 0) {
        const ngocE = renderEmote('ngoc');
        const facesStr = roll.map(dice.renderFace).join(' ');
        const lines = [keepsakeHeader(session)];
        for (const r of bigWins) {
            const hit = session.game === 'tong'
                ? `Tổng = **${play.sum}** · cửa **${r.guess}**`
                : `mặt **${r.face}** ra **${r.matches}** viên`;
            lines.push(`┃ ${facesStr} ┃ ${hit}\n# 🎉 THẮNG x${r.mult} 🎉\ncược ${fmt(p.amountPer)} → **+${fmt(r.payout)} ${ngocE}**`);
        }
        postKeepsake(session, lines.join('\n'));
    }

    return { block, bet: totalCost, payout: play.totalPayout };
}

function playRound(session) {
    if (session.game === 'slot') return playSlotRound(session);
    if (session.game === 'coinflip') return playCoinflipRound(session);
    return playDiceRound(session);
}

// ── Session lifecycle ──────────────────────────────────────────────────────

// Interruptible inter-round wait: requestStop wakes it early so Stop feels
// immediate instead of lagging up to a full interval.
function waitInterval(session, ms) {
    return new Promise(resolve => {
        session._wake = () => { session._wake = null; resolve(); };
        session._wakeTimer = setTimeout(() => session._wake && session._wake(), ms);
    });
}

function requestStop(userId, reason = 'user') {
    const session = sessions.get(userId);
    if (!session || session.stopRequested) return false;
    session.stopRequested = true;
    session.stopReason = reason;
    if (session._wakeTimer) clearTimeout(session._wakeTimer);
    if (session._wake) session._wake();
    return true;
}

// Stop only if `messageId` is the live session's message — a Stop button on a
// stale message (older replaced session, pre-restart leftovers) must not kill
// the user's current session.
function requestStopFromMessage(userId, messageId) {
    const session = sessions.get(userId);
    if (!session || !session.message || session.message.id !== messageId) return false;
    return requestStop(userId, 'user');
}

// Normal replay buttons (which include Auto again) for the final message.
function buildResumeComponents(session) {
    const total = totalNgoc(session.guildId, session.userId);
    if (total <= 0) return [];
    const p = session.params;
    if (session.game === 'slot') {
        return [slot.buildContinueButtons(session.userId, p.amount, total, p.rolls)];
    }
    if (session.game === 'coinflip') {
        return [coinflip.buildContinueButtons(session.userId, p.amount, p.side, total, p.flips)];
    }
    if (p.guesses.length === 1) {
        const build = session.game === 'tong' ? dice.buildTongButtons : dice.buildMatButtons;
        return build(session.userId, p.amountPer, p.guesses[0], total);
    }
    const build = session.game === 'tong' ? dice.buildTongButtonsMulti : dice.buildMatButtonsMulti;
    return build(session.userId, p.amountPer, p.guesses, total);
}

async function finalize(session) {
    if (sessions.get(session.userId) === session) sessions.delete(session.userId);
    const reason = session.stopReason || 'user';
    const reasonText = reason === 'cap'
        ? `đã chạy đủ ${session.maxRounds} vòng`
        : (STOP_REASON_TEXT[reason] || STOP_REASON_TEXT.user);
    const parts = [`🔁 **AUTO ${GAME_LABEL[session.game]}** — ⏹️ ${reasonText} (${session.round} vòng · cược **${betLabel(session)}**/vòng)`];
    if (session.history.length) parts.push(historySection(session));
    await editSession(session, parts.join('\n\n'), buildResumeComponents(session));
}

async function runLoop(session) {
    try {
        while (true) {
            if (session.stopRequested) break;
            if (session.round >= session.maxRounds) { session.stopReason = 'cap'; break; }
            if (isBlockedByMaintenance(session.userId, session.guild)) { session.stopReason = 'maintenance'; break; }
            if (totalNgoc(session.guildId, session.userId) < roundCost(session)) { session.stopReason = 'broke'; break; }

            const roundStart = Date.now();
            session.round += 1;
            const res = await playRound(session);
            if (res.error) { session.round -= 1; session.stopReason = 'broke'; break; }
            // Show the just-finished round in full, with prior rounds collapsed
            // above it as one-line summaries. After the edit we collapse THIS
            // round too — the next round's animation will show it as a compact
            // line, keeping the message short enough to fit Discord's 2000-char
            // limit even after many rounds.
            const finalView = [headerLine(session)];
            if (session.history.length) finalView.push(historySection(session));
            finalView.push(res.block);
            const shown = await editSession(
                session,
                finalView.join('\n\n'),
                [buildStopRow(session.userId, session.stopRequested)]
            );
            if (!shown) { session.stopReason = session.stopReason || 'error'; break; }
            pushHistory(session, compactRoundLine(session, res.bet, res.payout));

            const waitMs = cfg().INTERVAL_MS - (Date.now() - roundStart);
            if (waitMs > 0 && !session.stopRequested) await waitInterval(session, waitMs);
        }
    } catch (e) {
        log.error('autoPlay: loop error', e);
        session.stopReason = 'error';
    }
    await finalize(session);
}

// Start (or replace) the user's auto session. Round 1 plays immediately.
// params: slot { amount, rolls } · coinflip { amount, side, flips } ·
// tong/mat { amountPer, guesses } (single cửa = one-element guesses).
// maxRounds: player-chosen round count, clamped to AUTO_PLAY.MAX_ROUNDS.
async function startAuto({ game, channel, guildId, userId, displayName, params, maxRounds }) {
    if (sessions.has(userId)) requestStop(userId, 'replaced');
    const session = {
        game, guildId, guild: channel.guild, channel, userId, displayName, params,
        maxRounds: (Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= cfg().MAX_ROUNDS)
            ? maxRounds : cfg().MAX_ROUNDS,
        round: 0, history: [],
        stopRequested: false, stopReason: null,
        message: null, _wake: null, _wakeTimer: null
    };
    sessions.set(userId, session);
    session.message = await channel.send({
        content: `🔁 **AUTO ${GAME_LABEL[game]}** — bắt đầu: cược **${betLabel(session)}** ${renderEmote('ngoc')}/vòng, mỗi ${Math.round(cfg().INTERVAL_MS / 1000)}s, tối đa ${session.maxRounds} vòng…`,
        components: [buildStopRow(userId)]
    }).catch(e => { log.warn('autoPlay: send session message failed', e); return null; });
    if (!session.message) {
        if (sessions.get(userId) === session) sessions.delete(userId);
        return false;
    }
    runLoop(session);
    return true;
}

module.exports = {
    startAuto,
    requestStop,
    requestStopFromMessage,
    isActive,
    buildStopRow
};
