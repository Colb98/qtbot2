const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { renderEmote, fmt, getWallet, addNgoc, spendNgocForGame } = require('./currency');
const profile = require('./profile');

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
            .setDisabled(!canAllIn)
    );
}

const BIG_WIN_THRESHOLD = 5000;

function formatResult({ displayName, side, result, won, amount, wasAllIn = false }) {
    const ngoc = renderEmote('ngoc');
    const big = won && (wasAllIn || amount >= BIG_WIN_THRESHOLD);
    const lines = [`🪙 **${displayName}** — Kết quả: **${SIDE_LABEL[result]}**`];
    if (side) lines.push(`Bạn đoán: **${SIDE_LABEL[side]}**`);
    if (big) {
        const tag = wasAllIn ? 'ALL IN THẮNG' : 'THẮNG LỚN';
        lines.push(`## 🎉 ${tag} 🎉\n**+${fmt(amount)} ${ngoc}!**`);
    } else if (won) {
        lines.push(`🎉 Thắng! +${fmt(amount)} ${ngoc}`);
    } else {
        lines.push(`😢 Thua! -${fmt(amount)} ${ngoc}`);
    }
    return lines.join('\n');
}

function formatResultMulti({ displayName, side, plays }) {
    const ngoc = renderEmote('ngoc');
    const totalAmount = plays.reduce((a, p) => a + p.amount, 0);
    const totalPayout = plays.reduce((a, p) => a + (p.won ? p.amount * 2 : 0), 0);
    const wins = plays.filter(p => p.won).length;
    const header = side
        ? `🪙 **${displayName}** tung ${plays.length} lần · đoán **${SIDE_LABEL[side]}** (-${fmt(totalAmount)} ${ngoc})`
        : `🪙 **${displayName}** tung ${plays.length} lần (-${fmt(totalAmount)} ${ngoc})`;
    const lines = plays.map((p, i) => {
        const tag = p.won ? `✅ +${fmt(p.amount * 2)} ${ngoc}` : `❌ -${fmt(p.amount)} ${ngoc}`;
        return `\`${String(i + 1).padStart(2)}.\` ${SIDE_LABEL[p.result]} ${tag}`;
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
        const result = Math.random() < 0.5 ? 'sap' : 'ngua';
        const won = side ? (side === result) : (Math.random() < 0.5);
        const payout = won ? perFlip * 2 : 0;
        if (won) {
            addNgoc(guildId, userId, payout);
            profile.recordWin(guildId, userId, payout, 'Coinflip');
        }
        profile.recordGame(guildId, userId, 'coinflip', perFlip, payout);
        const bigWin = won && (isAll || perFlip >= BIG_WIN_THRESHOLD);
        if (metrics && metrics.recordCoinflip) {
            metrics.recordCoinflip({ guildId, amount: perFlip, won, side, viaButton, wasAllIn: isAll, bigWin, userId });
        }
        plays.push({ result, won, amount: perFlip });
    }
    if (plays.length === 0) return { error: 'no_ngoc', available: total };

    const walletAfter = getWallet(guildId, userId);
    const totalAfter = walletAfter.ngoc + (walletAfter.lockedNgoc || 0);
    const content = plays.length === 1
        ? formatResult({ displayName, side, result: plays[0].result, won: plays[0].won, amount: plays[0].amount, wasAllIn: isAll })
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
