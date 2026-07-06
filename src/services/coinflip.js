const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { renderEmote, fmt, getWallet, addNgoc, spendNgocForGame } = require('./currency');
const profile = require('./profile');
const rutque = require('./rutque');

const SIDE_LABEL = { sap: 'Sấp', ngua: 'Ngửa' };
const COINFLIP_MAX_FLIPS = 5;

function sideToToken(side) {
    return side || 'free';
}

function tokenToSide(token) {
    return token === 'free' ? null : token;
}

// Continue-buttons. `flips` keeps the chosen number of flips across replays;
// each preset stake is per-flip so affordability scales by `flips`, mirroring
// the slot multi-roll buttons.
function buildContinueButtons(userId, lastAmount, side, walletNgoc, flips = 1) {
    const sideToken = sideToToken(side);
    const allInPerFlip = Math.min(Math.floor(walletNgoc / flips), economy.COINFLIP_MAX_BET);
    const halfRaw = Math.floor(lastAmount / 2);
    const half = Math.max(1, halfRaw);
    const doubleTarget = lastAmount * 2;
    const doubleBet = Math.min(doubleTarget, economy.COINFLIP_MAX_BET);

    const canAgain = walletNgoc >= lastAmount * flips;
    const canHalf = halfRaw >= 1 && walletNgoc >= half * flips;
    const canDouble = doubleBet > lastAmount && walletNgoc >= doubleBet * flips;
    const canAllIn = allInPerFlip > 0;

    const suffix = flips > 1 ? ` x${flips}` : '';

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cf:again:${userId}:${lastAmount}:${sideToken}:${flips}`)
            .setLabel(`Tiếp (${fmt(lastAmount)}${suffix})`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAgain),
        new ButtonBuilder()
            .setCustomId(`cf:half:${userId}:${half}:${sideToken}:${flips}`)
            .setLabel(`x0.5 (${fmt(half)}${suffix})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canHalf),
        new ButtonBuilder()
            .setCustomId(`cf:double:${userId}:${doubleBet}:${sideToken}:${flips}`)
            .setLabel(`x2 (${fmt(doubleBet)}${suffix})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canDouble),
        new ButtonBuilder()
            .setCustomId(`cf:allin:${userId}:${allInPerFlip}:${sideToken}:${flips}`)
            .setLabel(`ALL IN (${fmt(allInPerFlip)}${suffix})`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canAllIn),
        new ButtonBuilder()
            .setCustomId(`cf:auto:${userId}:${lastAmount}:${sideToken}:${flips}`)
            .setLabel('🔁 Auto')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canAgain)
    );
}

const BIG_WIN_THRESHOLD = 5000;

// `payout` may exceed the flat 2x when a fortune effect fired (rút quẻ);
// falls back to amount*2 for callers that don't carry it.
function payoutOf(p) {
    if (p.payout != null) return p.payout;
    return p.won ? p.amount * 2 : 0;
}

function formatResult({ displayName, side, result, won, amount, payout, wasAllIn = false, eventLines = [] }) {
    const ngoc = renderEmote('ngoc');
    const big = won && (wasAllIn || amount >= BIG_WIN_THRESHOLD);
    const net = (payout != null ? payout : (won ? amount * 2 : 0)) - (won ? amount : 0);
    const lines = [`🪙 **${displayName}** — Kết quả: **${SIDE_LABEL[result]}**`];
    if (side) lines.push(`Bạn đoán: **${SIDE_LABEL[side]}**`);
    if (big) {
        const tag = wasAllIn ? 'ALL IN THẮNG' : 'THẮNG LỚN';
        lines.push(`## 🎉 ${tag} 🎉\n**+${fmt(net)} ${ngoc}!**`);
    } else if (won) {
        lines.push(`🎉 Thắng! +${fmt(net)} ${ngoc}`);
    } else {
        lines.push(`😢 Thua! -${fmt(amount)} ${ngoc}`);
    }
    lines.push(...eventLines);
    return lines.join('\n');
}

function formatResultMulti({ displayName, side, plays }) {
    const ngoc = renderEmote('ngoc');
    const totalAmount = plays.reduce((a, p) => a + p.amount, 0);
    const totalPayout = plays.reduce((a, p) => a + payoutOf(p), 0);
    const wins = plays.filter(p => p.won).length;
    const header = side
        ? `🪙 **${displayName}** tung ${plays.length} lần · đoán **${SIDE_LABEL[side]}** (-${fmt(totalAmount)} ${ngoc})`
        : `🪙 **${displayName}** tung ${plays.length} lần (-${fmt(totalAmount)} ${ngoc})`;
    const lines = plays.flatMap((p, i) => {
        const tag = p.won ? `✅ +${fmt(payoutOf(p))} ${ngoc}` : `❌ -${fmt(p.amount)} ${ngoc}`;
        const row = `\`${String(i + 1).padStart(2)}.\` ${SIDE_LABEL[p.result]} ${tag}`;
        return (p.eventLines && p.eventLines.length) ? [row, ...p.eventLines] : [row];
    });
    const net = totalPayout - totalAmount;
    const sign = net >= 0 ? '+' : '−';
    lines.push(`**Tổng:** thắng ${wins}/${plays.length} · cược ${fmt(totalAmount)} → nhận ${fmt(totalPayout)} ${ngoc} (${sign}${fmt(Math.abs(net))})`);
    return [header, ...lines].join('\n');
}

// Resolve N independent flips at the same per-flip stake, applying wallet /
// payout / metrics side-effects, and return ready-to-send content + buttons.
// Shared by the !coinflip message command and the continue-buttons handler.
function runMultiFlip({ guildId, userId, displayName, side, isAll, requestedAmount, flips = 1, viaButton = false, metrics }) {
    const w = getWallet(guildId, userId);
    const total = w.ngoc + (w.lockedNgoc || 0);

    let perFlip;
    if (isAll) {
        perFlip = Math.min(Math.floor(total / flips), economy.COINFLIP_MAX_BET);
        if (perFlip <= 0) return { error: 'no_ngoc', available: total };
    } else {
        perFlip = Math.min(requestedAmount, economy.COINFLIP_MAX_BET);
        if (total < perFlip * flips) return { error: 'insufficient', needed: perFlip * flips, available: total };
    }

    const plays = [];
    for (let i = 0; i < flips; i++) {
        const cur = getWallet(guildId, userId);
        if ((cur.ngoc + (cur.lockedNgoc || 0)) < perFlip) break; // safety
        spendNgocForGame(guildId, userId, perFlip);
        // Fortune is re-read every flip: a Đại Cát decay proc mid-sequence
        // must already debuff the remaining flips.
        const mods = rutque.getModifiers(guildId, userId);
        // Win is rolled against the configured rate (shifted by today's quẻ);
        // the shown face is derived from it (or rolled freely when no side
        // was guessed) so the display always matches the outcome.
        const winRate = Math.min(economy.COINFLIP_WIN_RATE * mods.rateMult, economy.RUTQUE.COINFLIP_MAX_WIN_RATE);
        const won = Math.random() < winRate;
        const result = side
            ? (won ? side : (side === 'sap' ? 'ngua' : 'sap'))
            : (Math.random() < 0.5 ? 'sap' : 'ngua');
        let payout = won ? perFlip * 2 : 0;
        let eventLines = [];
        if (won) {
            // Coinflip has no jackpot tier — only reverse/decay can apply.
            ({ payout, eventLines } = rutque.applyWinPayout(guildId, userId, { payout, stake: perFlip, game: 'coinflip' }));
            addNgoc(guildId, userId, payout);
            profile.recordWin(guildId, userId, payout, 'Coinflip');
        }
        profile.recordGame(guildId, userId, 'coinflip', perFlip, payout);
        const bigWin = won && (isAll || perFlip >= BIG_WIN_THRESHOLD);
        if (metrics && metrics.recordCoinflip) {
            metrics.recordCoinflip({ guildId, amount: perFlip, won, payout, side, viaButton, wasAllIn: isAll, bigWin, userId });
        }
        plays.push({ result, won, amount: perFlip, payout, eventLines });
    }
    if (plays.length === 0) return { error: 'no_ngoc', available: total };

    const walletAfter = getWallet(guildId, userId);
    const totalAfter = walletAfter.ngoc + (walletAfter.lockedNgoc || 0);
    const content = plays.length === 1
        ? formatResult({ displayName, side, result: plays[0].result, won: plays[0].won, amount: plays[0].amount, payout: plays[0].payout, wasAllIn: isAll, eventLines: plays[0].eventLines })
        : formatResultMulti({ displayName, side, plays });
    const components = totalAfter > 0 ? [buildContinueButtons(userId, perFlip, side, totalAfter, plays.length)] : [];
    return { content, components, perFlip, plays };
}

module.exports = {
    buildContinueButtons,
    formatResult,
    formatResultMulti,
    runMultiFlip,
    sideToToken,
    tokenToSide,
    COINFLIP_MAX_FLIPS
};
