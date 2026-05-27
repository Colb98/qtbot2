const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { getWallet, addNgoc, spendNgocForGame, fmt, renderEmote } = require('./currency');
const { saveData } = require('../state');
const profile = require('./profile');

const SYMBOLS = {
    M1: { emote: 'cao' },
    M2: { emote: 'thienthuong' },
    M3: { emote: 'ngoc' },
    M4: { emote: 'kythuong' },
    M5: { emote: 'dieu' },
    M6: { emote: 'nhuom' }
};
const REELS = 3;
const ALL_SYMBOLS = Object.keys(SYMBOLS);

// kind:
//   '3x'   — 3 reels giống nhau (symbol từ `symbol` hoặc random từ `symbols`)
//   '2x'   — 2 reels giống nhau, reel 3 khác (random từ phần còn lại)
//   'thua' — 3 reels khác nhau hoàn toàn
const POOL = [
    { name: 'MEGA Jackpot',         mult: 150,  weight: 1,    kind: '3x', symbol: 'M1' },
    { name: 'Jackpot Thiên Thưởng', mult: 40,   weight: 4,    kind: '3x', symbol: 'M2' },
    { name: 'Jackpot Ngọc',         mult: 18,   weight: 9,    kind: '3x', symbol: 'M3' },
    { name: 'Mini Jackpot',         mult: 10,   weight: 58,   kind: '2x', symbol: 'M1' },
    { name: '2x Cáo',               mult: 6,    weight: 65,   kind: '2x', symbol: 'M2' },
    { name: '2x Vua',               mult: 3,    weight: 122,  kind: '2x', symbol: 'M3' },
    { name: 'An Ủi To',             mult: 2,    weight: 192,  kind: '3x', symbol: 'M4' },
    { name: 'Hoàn Vốn',             mult: 1,    weight: 695,  kind: '3x', symbols: ['M5', 'M6'] },
    { name: 'Nhỏ x0.5',             mult: 0.5,  weight: 615,  kind: '2x', symbol: 'M4' },
    { name: 'Nhỏ x0.25',            mult: 0.25, weight: 365,  kind: '2x', symbols: ['M5', 'M6'] },
    { name: 'Thua',                 mult: 0,    weight: 1230, kind: 'thua' }
];

const _totalWeight = POOL.reduce((a, p) => a + p.weight, 0);

function pickOutcome() {
    let r = Math.random() * _totalWeight;
    for (const p of POOL) {
        r -= p.weight;
        if (r < 0) return p;
    }
    return POOL[POOL.length - 1];
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildReels(outcome) {
    if (outcome.kind === '3x') {
        const sym = outcome.symbol || pickRandom(outcome.symbols);
        return [sym, sym, sym];
    }
    if (outcome.kind === '2x') {
        const sym = outcome.symbol || pickRandom(outcome.symbols);
        const others = ALL_SYMBOLS.filter(s => s !== sym);
        const filler = pickRandom(others);
        return shuffle([sym, sym, filler]);
    }
    // thua: pick 3 phần tử khác nhau hoàn toàn từ 6 symbols, random thứ tự
    const pool = shuffle(ALL_SYMBOLS.slice()).slice(0, REELS);
    return pool;
}

const PITY_THRESHOLD = 20;

function pickFromPool(pool) {
    const totalW = pool.reduce((a, p) => a + p.weight, 0);
    let r = Math.random() * totalW;
    for (const p of pool) {
        r -= p.weight;
        if (r < 0) return p;
    }
    return pool[pool.length - 1];
}

function spin(pityCount = 0) {
    let outcome;
    let pityTriggered = false;
    if (pityCount >= PITY_THRESHOLD) {
        outcome = pickFromPool(POOL.filter(p => p.mult >= 3));
        pityTriggered = true;
    } else {
        outcome = pickOutcome();
    }
    const result = buildReels(outcome);
    return { result, mult: outcome.mult, name: outcome.name, pityTriggered };
}

function playSlot({ guildId, userId, requestedAmount, isAllIn = false }) {
    const w = getWallet(guildId, userId);
    const totalNgoc = w.ngoc + (w.lockedNgoc || 0);
    let amount;
    if (isAllIn) {
        amount = Math.min(totalNgoc, economy.SLOT_MAX_BET);
    } else {
        amount = Math.min(requestedAmount, economy.SLOT_MAX_BET);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return { error: 'no_ngoc' };
    }
    if (totalNgoc < amount) {
        return { error: 'insufficient', shortBy: amount - totalNgoc, available: totalNgoc };
    }

    const slotPityBefore = w.slotPity || 0;
    const slotStreakMaxBet = w.slotStreakMaxBet || 0;
    const pityCapApplied = slotPityBefore >= PITY_THRESHOLD && slotStreakMaxBet > 0 && amount > slotStreakMaxBet * economy.SLOT_PITY_CAP_MULT;
    if (slotPityBefore >= PITY_THRESHOLD && slotStreakMaxBet > 0) {
        amount = Math.min(amount, slotStreakMaxBet * economy.SLOT_PITY_CAP_MULT);
        if (amount <= 0) amount = 1;
    }
    spendNgocForGame(guildId, userId, amount);

    const { result: spinResult, mult, name: outcomeName } = spin(slotPityBefore);
    const payout = Math.round(amount * mult);
    if (payout > 0) {
        addNgoc(guildId, userId, payout);
        profile.recordWin(guildId, userId, payout, 'Slot');
    }

    const walletAfter = getWallet(guildId, userId);
    if (mult <= 1) {
        walletAfter.slotPity = slotPityBefore + 1;
        walletAfter.slotStreakMaxBet = Math.max(slotStreakMaxBet, amount);
    } else {
        walletAfter.slotPity = 0;
        walletAfter.slotStreakMaxBet = 0;
    }
    saveData();

    return {
        amount, payout, mult, outcomeName, spinResult,
        pityTriggered: slotPityBefore >= PITY_THRESHOLD,
        pityCapApplied,
        walletAfter
    };
}

function formatResultLine({ mult, payout, outcomeName }) {
    const ngocEmote = renderEmote('ngoc');
    if (mult >= 18) {
        return `# 🌟 ${outcomeName.toUpperCase()} — x${mult} 🌟\n**Bạn thắng ${fmt(payout)} ${ngocEmote}!**`;
    }
    if (mult >= 6) {
        return `## 🎉 ${outcomeName.toUpperCase()} — x${mult} 🎉\n**Bạn thắng ${fmt(payout)} ${ngocEmote}!**`;
    }
    if (mult > 1) {
        return `🎉 **${outcomeName}** (x${mult})! Bạn thắng **${fmt(payout)}** ${ngocEmote}.`;
    }
    if (mult === 1) {
        return `💰 **${outcomeName}**! Bạn thắng **${fmt(payout)}** ${ngocEmote}.`;
    }
    if (mult > 0) {
        return `😬 **${outcomeName}** (x${mult}). Bạn thắng **${fmt(payout)}** ${ngocEmote}.`;
    }
    return `😢 **${outcomeName}**! Tiếc quá, không trúng gì.`;
}

function formatResultShort({ mult, payout, outcomeName }) {
    if (mult === 0) return 'Thua';
    const ngocEmote = renderEmote('ngoc');
    if (mult >= 6) return `**${outcomeName} — x${mult}** (+${fmt(payout)} ${ngocEmote})`;
    return `x${mult} (+${fmt(payout)} ${ngocEmote})`;
}

function buildContinueButtons(userId, lastAmount, walletNgoc) {
    const allInAmount = Math.min(walletNgoc, economy.SLOT_MAX_BET);
    const halfRaw = Math.floor(lastAmount / 2);
    const half = Math.max(1, halfRaw);
    const doubleTarget = lastAmount * 2;
    const doubleBet = Math.min(doubleTarget, economy.SLOT_MAX_BET);

    const canAgain = walletNgoc >= lastAmount;
    const canHalf = halfRaw >= 1 && walletNgoc >= half;
    const canDouble = walletNgoc >= doubleBet && doubleBet > lastAmount;
    const canAllIn = allInAmount > 0;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`slot:tiep:${userId}:${lastAmount}`)
            .setLabel(`Tiếp (${fmt(lastAmount)})`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAgain),
        new ButtonBuilder()
            .setCustomId(`slot:half:${userId}:${half}`)
            .setLabel(`x0.5 (${fmt(half)})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canHalf),
        new ButtonBuilder()
            .setCustomId(`slot:double:${userId}:${doubleBet}`)
            .setLabel(`x2 (${fmt(doubleBet)})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canDouble),
        new ButtonBuilder()
            .setCustomId(`slot:allin:${userId}:${allInAmount}`)
            .setLabel(`ALL IN (${fmt(allInAmount)})`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canAllIn)
    );
}

module.exports = { SYMBOLS, REELS, POOL, spin, PITY_THRESHOLD, playSlot, formatResultLine, formatResultShort, buildContinueButtons };
