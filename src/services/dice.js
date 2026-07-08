const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const economy = require('../config/economy');
const { renderEmote, fmt, spendNgocForGame, addNgoc } = require('./currency');
const rutque = require('./rutque');
const { khodoButton } = require('./uiButtons');

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

// True win probability of a bet — used to size the hidden fortune reroll
// (rút quẻ) exactly. 216 equally likely rolls of 3 dice; SUM_WAYS counts how
// many produce each tổng.
const SUM_WAYS = { 3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21, 9: 25, 10: 27, 11: 27, 12: 25, 13: 21, 14: 15, 15: 10, 16: 6, 17: 3, 18: 1 };

function winProb(game, guesses) {
    if (game === 'tong') return guesses.reduce((s, g) => s + (SUM_WAYS[g] || 0), 0) / 216;
    return 1 - Math.pow((6 - new Set(guesses).size) / 6, 3);
}

// Spread a fortune bonus across the winning cửa pro-rata (remainder to the
// last one) so per-cửa payouts, metrics and the wallet all add up exactly.
function distributeBonus(results, bonus) {
    const winners = results.filter(r => r.payout > 0);
    if (!winners.length) return;
    const totalW = winners.reduce((s, r) => s + r.payout, 0);
    let rem = bonus;
    for (let i = 0; i < winners.length; i++) {
        const share = i === winners.length - 1 ? rem : Math.floor(bonus * winners[i].payout / totalW);
        winners[i].payout += share;
        rem -= share;
    }
}

// Settle one multi-cửa bet end-to-end (wallet, profile, metrics; a single
// cửa is just N=1) and return the roll + per-cửa results. Shared by the
// !tong/!mat commands, the replay buttons and auto mode so the bookkeeping
// lives in one place. `metrics` and `profile` are passed in by the caller to
// keep this module free of those dependencies.
function settleMultiBet({ guildId, userId, game, guesses, amountPer, viaButton, wasAllIn, metrics, profile }) {
    const totalCost = amountPer * guesses.length;
    const R = economy.RUTQUE;
    // Fortune coverage gate: a bet spanning ≥ half of all cửa (tổng 8/16 sums,
    // mặt 3/6 faces) is a near-guaranteed "win" — mặt all-6 always refunds its
    // stake — so it gets NO fortune effects at all: no reroll, no jackpot
    // boost, no reverse, no decay points.
    const totalCua = game === 'tong' ? 16 : 6;
    const fortuneEligible = guesses.length / totalCua < R.DICE_COVERAGE_MAX_RATIO;
    const mods = fortuneEligible ? rutque.getModifiers(guildId, userId) : null;

    const resolvePlay = (r) => game === 'tong'
        ? playTongMulti(r, guesses, amountPer)
        : playMatMulti(r, guesses, amountPer);

    let roll = rollDice();
    let play = resolvePlay(roll);

    // Fortune rate shift = hidden single reroll, the only honest way to bias
    // a deterministic outcome shared by every cửa of the bet. rerollPlan's q
    // makes P(win) exactly rateMult × base; only the final roll is displayed
    // (same idea as coinflip deriving the shown face from the rolled outcome).
    if (mods && mods.active && mods.rateMult !== 1) {
        const plan = rutque.rerollPlan(winProb(game, guesses), mods.rateMult);
        if ((plan.direction === 'boost' && !play.anyWon && Math.random() < plan.q)
            || (plan.direction === 'nerf' && play.anyWon && Math.random() < plan.q)) {
            roll = rollDice();
            play = resolvePlay(roll);
        }
    }

    let eventLines = [];
    let events = [];
    if (mods && mods.active && play.totalPayout > 0) {
        // Jackpot tier: mặt 3-match only (tổng is disabled by config — its
        // multiplier is player-chosen). Reverse eligibility is checked on the
        // AGGREGATE payout/stake ratio inside applyWinPayout, so e.g. a
        // 5-cửa tổng x8 hit (8 < 2×5) is excluded by design.
        const jackpotPortion = play.results.reduce((s, r) => {
            const isJackpot = game === 'tong'
                ? (r.won && r.mult >= R.JACKPOT_TIER.TONG_MIN_MULT)
                : (r.matches >= R.JACKPOT_TIER.MAT_MIN_MATCHES);
            return s + (isJackpot ? r.payout : 0);
        }, 0);
        const res = rutque.applyWinPayout(guildId, userId, {
            payout: play.totalPayout, stake: totalCost, jackpotPortion, game
        });
        const bonus = res.payout - play.totalPayout;
        if (bonus > 0) {
            distributeBonus(play.results, bonus);
            play.totalPayout = res.payout;
        }
        eventLines = res.eventLines;
        events = res.events || [];
    }

    spendNgocForGame(guildId, userId, totalCost);
    if (play.totalPayout > 0) {
        addNgoc(guildId, userId, play.totalPayout);
        profile.recordWin(guildId, userId, play.totalPayout, game === 'tong' ? 'Tổng xúc xắc' : 'Mặt xúc xắc');
    }
    profile.recordGame(guildId, userId, game, totalCost, play.totalPayout);
    for (const r of play.results) {
        if (game === 'tong') {
            metrics.recordTong({ guildId, amount: amountPer, won: r.won, mult: r.mult, payout: r.payout, guess: r.guess, viaButton, wasAllIn, userId });
        } else {
            metrics.recordMat({ guildId, amount: amountPer, won: r.won, mult: r.mult, payout: r.payout, face: r.face, matches: r.matches, viaButton, wasAllIn, userId });
        }
    }
    return { roll, play, totalCost, eventLines, events };
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
            .setDisabled(allInAmount <= 0),
        new ButtonBuilder()
            .setCustomId(`tong:auto:${userId}:${amount}:${guess}`)
            .setLabel('🔁 Auto')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAfford),
        khodoButton()
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
            .setDisabled(allInAmount <= 0),
        new ButtonBuilder()
            .setCustomId(`mat:auto:${userId}:${amount}:${face}`)
            .setLabel('🔁 Auto')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAfford),
        khodoButton()
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
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`tong:mauto:${userId}:${amountPer}:${list}`)
            .setLabel('🔁 Auto')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAffordSame),
        khodoButton()
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
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`mat:mauto:${userId}:${amountPer}:${list}`)
            .setLabel('🔁 Auto')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!canAffordSame),
        khodoButton()
    ));
    return rows;
}

// `payout`/`eventLines` are optional: a fortune effect (rút quẻ) can push the
// payout past amount×mult, with the event lines explaining why.
function formatTongResult({ displayName, guess, roll, sum, won, amount, mult, payout, eventLines = [] }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const header = `🎲 **${displayName}** — CƯỢC TỔNG · đoán **${guess}** · cược ${fmt(amount)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃ Tổng = **${sum}**`;
    if (payout == null) payout = won ? amount * mult : 0;
    let resultLine;
    if (won && mult >= TONG_BIG_WIN_MULT) {
        resultLine = `# 🎉 THẮNG x${mult} 🎉\n# **${fmt(payout)} ${ngoc}**`;
    } else if (won) {
        resultLine = `🎉 **THẮNG x${mult}** → ${fmt(payout)} ${ngoc}`;
    } else {
        resultLine = `💀 **THUA** -${fmt(amount)} ${ngoc} (bạn đoán ${guess})`;
    }
    return [header, board, resultLine, ...eventLines].join('\n');
}

function formatMatResult({ displayName, face, roll, matches, won, amount, mult, payout, eventLines = [] }) {
    const ngoc = renderEmote('ngoc');
    const facesStr = roll.map(renderFace).join(' ');
    const header = `🎲 **${displayName}** — CƯỢC XUẤT HIỆN · mặt **${face}** · cược ${fmt(amount)} ${ngoc}`;
    const board = `┃ ${facesStr} ┃ Mặt **${face}** xuất hiện: **${matches}** viên`;
    if (payout == null) payout = won ? amount * mult : 0;
    let resultLine;
    if (won && mult >= MAT_BIG_WIN_MULT) {
        resultLine = `# 🎉 THẮNG x${mult} 🎉\n# **${fmt(payout)} ${ngoc}**`;
    } else if (won) {
        resultLine = `🎉 **THẮNG x${mult}** → ${fmt(payout)} ${ngoc}`;
    } else {
        resultLine = `💀 **THUA** -${fmt(amount)} ${ngoc} (mặt ${face} không ra)`;
    }
    return [header, board, resultLine, ...eventLines].join('\n');
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

function formatTongResultMulti({ displayName, roll, sum, results, amountPer, totalCost, totalPayout, eventLines = [] }) {
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
    return [header, board, resultLine, ...eventLines].join('\n');
}

function formatMatResultMulti({ displayName, roll, results, amountPer, totalCost, totalPayout, eventLines = [] }) {
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
    return [header, board, resultLine, ...eventLines].join('\n');
}

module.exports = {
    rollDice,
    playTong,
    playMat,
    playTongMulti,
    playMatMulti,
    settleMultiBet,
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
