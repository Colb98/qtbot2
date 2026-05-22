const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { renderEmote, fmt } = require('./currency');

const SIDE_LABEL = { sap: 'Sấp', ngua: 'Ngửa' };

function sideToToken(side) {
    return side || 'free';
}

function tokenToSide(token) {
    return token === 'free' ? null : token;
}

function buildContinueButtons(userId, lastAmount, side, walletNgoc) {
    const sideToken = sideToToken(side);
    const allInAmount = Math.min(walletNgoc, economy.COINFLIP_MAX_BET);
    const halfRaw = Math.floor(lastAmount / 2);
    const half = Math.max(1, halfRaw);
    const doubleTarget = lastAmount * 2;
    const doubleBet = Math.min(doubleTarget, economy.COINFLIP_MAX_BET);

    const canAgain = walletNgoc >= lastAmount;
    const canHalf = halfRaw >= 1 && walletNgoc >= half;
    const canDouble = walletNgoc >= doubleTarget;
    const canAllIn = allInAmount > 0;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cf:again:${userId}:${lastAmount}:${sideToken}`)
            .setLabel(`Tiếp (${fmt(lastAmount)})`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAgain),
        new ButtonBuilder()
            .setCustomId(`cf:half:${userId}:${half}:${sideToken}`)
            .setLabel(`x0.5 (${fmt(half)})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canHalf),
        new ButtonBuilder()
            .setCustomId(`cf:double:${userId}:${doubleBet}:${sideToken}`)
            .setLabel(`x2 (${fmt(doubleBet)})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canDouble),
        new ButtonBuilder()
            .setCustomId(`cf:allin:${userId}:${allInAmount}:${sideToken}`)
            .setLabel(`ALL IN (${fmt(allInAmount)})`)
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

module.exports = {
    buildContinueButtons,
    formatResult,
    sideToToken,
    tokenToSide
};
