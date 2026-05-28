const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { renderEmote, fmt } = require('./currency');

const FACE_UNICODE = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };

const TONG_PAYOUTS = {
    3: 200, 4: 70, 5: 36, 6: 21, 7: 14, 8: 10, 9: 8, 10: 8,
    11: 8, 12: 8, 13: 10, 14: 14, 15: 21, 16: 36, 17: 70, 18: 200
};
const TONG_BIG_WIN_MULT = 10;

const MAT_PAYOUTS = { 0: 0, 1: 2, 2: 4, 3: 6 };
const MAT_BIG_WIN_MULT = 4;

function rollDice() {
    return [
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6)
    ];
}

function renderFace(face) {
    const emote = renderEmote(`dice${face}`);
    if (emote && !emote.startsWith(':')) return emote;
    return FACE_UNICODE[face];
}

function playTong(roll, guess) {
    const sum = roll[0] + roll[1] + roll[2];
    const won = sum === guess;
    const mult = won ? TONG_PAYOUTS[guess] : 0;
    return { sum, won, mult };
}

function playMat(roll, face) {
    const matches = roll.filter(d => d === face).length;
    const mult = MAT_PAYOUTS[matches] || 0;
    return { matches, won: matches >= 1, mult };
}

// Multi-cửa variants: same per-bet rules applied independently to each
// guess. `amountPer` is staked on every guess; total cost = amountPer × N.
function playTongMulti(roll, guesses, amountPer) {
    const sum = roll[0] + roll[1] + roll[2];
    const results = guesses.map(guess => {
        const won = sum === guess;
        const mult = won ? TONG_PAYOUTS[guess] : 0;
        return { guess, won, mult, payout: won ? amountPer * mult : 0 };
    });
    const totalPayout = results.reduce((s, r) => s + r.payout, 0);
    return { sum, results, totalPayout, anyWon: results.some(r => r.won) };
}

function playMatMulti(roll, faces, amountPer) {
    const results = faces.map(face => {
        const matches = roll.filter(d => d === face).length;
        const mult = MAT_PAYOUTS[matches] || 0;
        const won = matches >= 1;
        return { face, matches, won, mult, payout: won ? amountPer * mult : 0 };
    });
    const totalPayout = results.reduce((s, r) => s + r.payout, 0);
    return { results, totalPayout, anyWon: results.some(r => r.won) };
}

function buildTongButtons(userId, amount, guess, walletNgoc) {
    const canAfford = walletNgoc >= amount;
    const allInAmount = Math.min(walletNgoc, economy.TONG_MAX_BET);
    const sumRows = [
        [3, 4, 5, 6, 7],
        [8, 9, 10, 11, 12],
        [13, 14, 15, 16, 17],
        [18]
    ];
    const rows = sumRows.map(rowSums => {
        const row = new ActionRowBuilder();
        for (const s of rowSums) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`tong:bet:${userId}:${amount}:${s}`)
                    .setLabel(`${s} (x${TONG_PAYOUTS[s]})`)
                    .setStyle(s === guess ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(!canAfford)
            );
        }
        return row;
    });
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`tong:again:${userId}:${amount}:${guess}`)
            .setLabel(`🎲 Chơi lại (${fmt(amount)})`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canAfford),
        new ButtonBuilder()
            .setCustomId(`tong:allin:${userId}:${allInAmount}:${guess}`)
            .setLabel(`💰 All-in (${fmt(allInAmount)})`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(allInAmount <= 0)
    ));
    return rows;
}

function buildMatButtons(userId, amount, face, walletNgoc) {
    const canAfford = walletNgoc >= amount;
    const allInAmount = Math.min(walletNgoc, economy.MAT_MAX_BET);
    const faceRows = [[1, 2, 3], [4, 5, 6]];
    const rows = faceRows.map(rowFaces => {
        const row = new ActionRowBuilder();
        for (const f of rowFaces) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`mat:bet:${userId}:${amount}:${f}`)
                    .setLabel(`Mặt ${f}`)
                    .setStyle(f === face ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(!canAfford)
            );
        }
        return row;
    });
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mat:again:${userId}:${amount}:${face}`)
            .setLabel(`🎲 Chơi lại (${fmt(amount)})`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canAfford),
        new ButtonBuilder()
            .setCustomId(`mat:allin:${userId}:${allInAmount}:${face}`)
            .setLabel(`💰 All-in (${fmt(allInAmount)})`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(allInAmount <= 0)
    ));
    return rows;
}

// Multi-cửa button layouts. The single-cửa bet grid is preserved (clicking a
// single sum/face plays a one-cửa bet of `amountPer`), and the action row
// carries multi-cửa replay: Tiếp (same cửa, same stake), All-in (same cửa,
// stake bumped to min(maxBet, floor(wallet/N))), and Đổi cửa (modal entry).
// The guess list is encoded with '.' since ':' is the customId field sep.
function buildTongButtonsMulti(userId, amountPer, guesses, walletNgoc) {
    const guessSet = new Set(guesses);
    const nBets = guesses.length;
    const totalCost = amountPer * nBets;
    const canAffordSame = walletNgoc >= totalCost;
    const allInPer = Math.min(Math.floor(walletNgoc / nBets), economy.TONG_MAX_BET);
    const list = guesses.join('.');
    const sumRows = [[3, 4, 5, 6, 7], [8, 9, 10, 11, 12], [13, 14, 15, 16, 17], [18]];
    const rows = sumRows.map(rowSums => {
        const row = new ActionRowBuilder();
        for (const s of rowSums) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`tong:bet:${userId}:${amountPer}:${s}`)
                    .setLabel(`${s} (x${TONG_PAYOUTS[s]})`)
                    .setStyle(guessSet.has(s) ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(walletNgoc < amountPer)
            );
        }
        return row;
    });
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`tong:mcont:${userId}:${amountPer}:${list}`)
            .setLabel(`🎲 Tiếp (${nBets} cửa · ${fmt(totalCost)})`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canAffordSame),
        new ButtonBuilder()
            .setCustomId(`tong:mallin:${userId}:${list}`)
            .setLabel(`💰 All-in (${fmt(allInPer)}/cửa)`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(allInPer <= 0),
        new ButtonBuilder()
            .setCustomId(`tong:medit:${userId}:${amountPer}`)
            .setLabel('✏️ Đổi cửa')
            .setStyle(ButtonStyle.Secondary)
    ));
    return rows;
}

function buildMatButtonsMulti(userId, amountPer, guesses, walletNgoc) {
    const guessSet = new Set(guesses);
    const nBets = guesses.length;
    const totalCost = amountPer * nBets;
    const canAffordSame = walletNgoc >= totalCost;
    const allInPer = Math.min(Math.floor(walletNgoc / nBets), economy.MAT_MAX_BET);
    const list = guesses.join('.');
    const faceRows = [[1, 2, 3], [4, 5, 6]];
    const rows = faceRows.map(rowFaces => {
        const row = new ActionRowBuilder();
        for (const f of rowFaces) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`mat:bet:${userId}:${amountPer}:${f}`)
                    .setLabel(`Mặt ${f}`)
                    .setStyle(guessSet.has(f) ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(walletNgoc < amountPer)
            );
        }
        return row;
    });
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mat:mcont:${userId}:${amountPer}:${list}`)
            .setLabel(`🎲 Tiếp (${nBets} cửa · ${fmt(totalCost)})`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(!canAffordSame),
        new ButtonBuilder()
            .setCustomId(`mat:mallin:${userId}:${list}`)
            .setLabel(`💰 All-in (${fmt(allInPer)}/cửa)`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(allInPer <= 0),
        new ButtonBuilder()
            .setCustomId(`mat:medit:${userId}:${amountPer}`)
            .setLabel('✏️ Đổi cửa')
            .setStyle(ButtonStyle.Secondary)
    ));
    return rows;
}

function formatTongResult({ displayName, guess, roll, sum, won, amount, mult }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const header = `🎲 **${displayName}** — CƯỢC TỔNG · đoán **${guess}** · cược ${fmt(amount)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃ Tổng = **${sum}**`;
    const payout = amount * mult;
    let resultLine;
    if (won && mult >= TONG_BIG_WIN_MULT) {
        resultLine = `# 🎉 THẮNG x${mult} 🎉\n# **${fmt(payout)} ${ngoc}**`;
    } else if (won) {
        resultLine = `🎉 **THẮNG x${mult}** → ${fmt(payout)} ${ngoc}`;
    } else {
        resultLine = `💀 **THUA** -${fmt(amount)} ${ngoc} (bạn đoán ${guess})`;
    }
    return [header, board, resultLine].join('\n');
}

function formatMatResult({ displayName, face, roll, matches, won, amount, mult }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const header = `🎲 **${displayName}** — CƯỢC XUẤT HIỆN · mặt **${face}** · cược ${fmt(amount)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃ Mặt **${face}** xuất hiện: **${matches}** viên`;
    const payout = amount * mult;
    let resultLine;
    if (won && mult >= MAT_BIG_WIN_MULT) {
        resultLine = `# 🎉 THẮNG x${mult} 🎉\n# **${fmt(payout)} ${ngoc}**`;
    } else if (won) {
        resultLine = `🎉 **THẮNG x${mult}** → ${fmt(payout)} ${ngoc}`;
    } else {
        resultLine = `💀 **THUA** -${fmt(amount)} ${ngoc} (mặt ${face} không ra)`;
    }
    return [header, board, resultLine].join('\n');
}

// ── Multi-cửa result formatters ─────────────────────────────────────────────
function formatMultiWinLine(breakdown, hasBigWin, totalPayout, totalCost) {
    const ngoc = renderEmote('ngoc');
    const net = totalPayout - totalCost;
    const netStr = `${net >= 0 ? '+' : ''}${fmt(net)} ${ngoc}`;
    if (hasBigWin) {
        return `# 🎉 THẮNG ${fmt(totalPayout)} ${ngoc} 🎉\n${breakdown}\nNet: **${netStr}**`;
    }
    return `🎉 **THẮNG** ${breakdown} → tổng ${fmt(totalPayout)} ${ngoc} · net **${netStr}**`;
}

function formatTongResultMulti({ displayName, roll, sum, results, amountPer, totalCost, totalPayout }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const guesses = results.map(r => r.guess);
    const header = `🎲 **${displayName}** — CƯỢC TỔNG · cửa **${guesses.join(', ')}** · ${fmt(amountPer)} ${ngoc}/cửa · tổng cược ${fmt(totalCost)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃ Tổng = **${sum}**`;
    const wins = results.filter(r => r.won);
    let resultLine;
    if (wins.length > 0) {
        const breakdown = wins.map(r => `cửa ${r.guess} (x${r.mult}) → ${fmt(r.payout)} ${ngoc}`).join(' · ');
        const hasBigWin = wins.some(r => r.mult >= TONG_BIG_WIN_MULT);
        resultLine = formatMultiWinLine(breakdown, hasBigWin, totalPayout, totalCost);
    } else {
        resultLine = `💀 **THUA** -${fmt(totalCost)} ${ngoc} (tổng ${sum}, không trúng cửa nào)`;
    }
    return [header, board, resultLine].join('\n');
}

function formatMatResultMulti({ displayName, roll, results, amountPer, totalCost, totalPayout }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const faces = results.map(r => r.face);
    const header = `🎲 **${displayName}** — CƯỢC XUẤT HIỆN · mặt **${faces.join(', ')}** · ${fmt(amountPer)} ${ngoc}/cửa · tổng cược ${fmt(totalCost)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃`;
    const wins = results.filter(r => r.won);
    let resultLine;
    if (wins.length > 0) {
        const breakdown = wins.map(r => `mặt ${r.face} ×${r.matches} (x${r.mult}) → ${fmt(r.payout)} ${ngoc}`).join(' · ');
        const hasBigWin = wins.some(r => r.mult >= MAT_BIG_WIN_MULT);
        resultLine = formatMultiWinLine(breakdown, hasBigWin, totalPayout, totalCost);
    } else {
        resultLine = `💀 **THUA** -${fmt(totalCost)} ${ngoc} (không mặt nào trong [${faces.join(', ')}] xuất hiện)`;
    }
    return [header, board, resultLine].join('\n');
}

module.exports = {
    rollDice,
    playTong,
    playMat,
    playTongMulti,
    playMatMulti,
    buildTongButtons,
    buildMatButtons,
    buildTongButtonsMulti,
    buildMatButtonsMulti,
    formatTongResult,
    formatMatResult,
    formatTongResultMulti,
    formatMatResultMulti,
    renderFace,
    TONG_PAYOUTS,
    MAT_PAYOUTS,
    TONG_BIG_WIN_MULT,
    MAT_BIG_WIN_MULT
};
