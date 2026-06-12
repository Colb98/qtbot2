const { Events, MessageFlags, ActionRowBuilder, ButtonBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const path = require('path');
const log = require('../../logger');
const wordchain = require('../services/wordchain');
const wordchainEng = require('../services/wordchainEng');
const wordchainViet = require('../services/wordchainViet');
const vuaTiengViet = require('../services/vuaTiengViet');
const flashMath = require('../services/flashMath');
const mathBoss = require('../services/mathBoss');
const arrangeCmd = require('../commands/arrange');
const profileCmd = require('../commands/profile');
const { getWallet, addNgoc, addItem, spendNgocForGame, renderEmote, buildKhodoView, fmt, ITEM_KEYS } = require('../services/currency');
const { rollMany, formatRollResult, ROLL_COST } = require('../services/gacha');
const { tokenToSide, runMultiFlip: runCoinflipMulti } = require('../services/coinflip');
const { runMultiRoll: runSlotMultiRoll, SLOT_MAX_ROLLS } = require('../services/slot');
const dice = require('../services/dice');
const autoPlay = require('../services/autoPlay');
const metrics = require('../services/metrics');
const economy = require('../config/economy');
const { data, saveData } = require('../state');
const { checkGameCooldown, BUTTON_GAME_COOLDOWN_MS } = require('../utils');
const { isBlockedByMaintenance } = require('../services/maintenance');
const profile = require('../services/profile');
const season = require('../services/season');
const exchange = require('../services/exchange');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (isBlockedByMaintenance(interaction.user.id, interaction.guild)) {
            if (interaction.isRepliable && interaction.isRepliable()) {
                await interaction.reply({ content: '🔧 Bot đang bảo trì, vui lòng thử lại sau ít phút.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            return;
        }
        if (interaction.isStringSelectMenu()) {
            try {
                if (interaction.customId.startsWith('profile:')) {
                    await profileCmd.handleComponent(interaction);
                } else if (interaction.customId.startsWith('doi:') || interaction.customId.startsWith('pg:')) {
                    await exchange.handleComponent(interaction);
                }
            } catch (e) {
                log.error('Error in select menu interaction:', e);
            }
            return;
        }
        if (interaction.isModalSubmit && interaction.isModalSubmit()) {
            try {
                if (interaction.customId.startsWith('profile:')) {
                    await profileCmd.handleComponent(interaction);
                } else if (interaction.customId.startsWith('tong:meditsub:')) {
                    await handleDiceModal(interaction, 'tong');
                } else if (interaction.customId.startsWith('mat:meditsub:')) {
                    await handleDiceModal(interaction, 'mat');
                }
            } catch (e) {
                log.error('Error in modal submit interaction:', e);
            }
            return;
        }
        if (interaction.isButton()) {
            try {
                if (interaction.customId.startsWith('profile:')) {
                    await profileCmd.handleComponent(interaction);
                    return;
                }
                if (interaction.customId.startsWith('doi:') || interaction.customId.startsWith('pg:')) {
                    await exchange.handleComponent(interaction);
                    return;
                }
                if (interaction.customId.startsWith('arrange_')) {
                    await arrangeCmd.handleButton(interaction);
                } else if (interaction.customId.startsWith('cf:')) {
                    await handleCoinflipButton(interaction);
                } else if (interaction.customId.startsWith('tong:')) {
                    await handleDiceButton(interaction, 'tong');
                } else if (interaction.customId.startsWith('mat:')) {
                    await handleDiceButton(interaction, 'mat');
                } else if (interaction.customId.startsWith('slot:')) {
                    await handleSlotButton(interaction);
                } else if (interaction.customId.startsWith('auto:')) {
                    await handleAutoStopButton(interaction);
                } else if (interaction.customId.startsWith('gacha_all_')) {
                    const parts = interaction.customId.split(':');
                    const actionPart = interaction.customId.split('_')[2];
                    const action = actionPart.split(':')[0];
                    const userId = parts[1];

                    if (interaction.user.id !== userId) {
                        return interaction.reply({ content: 'Không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
                    }

                    await interaction.deferUpdate().catch(e => log.error('defer error:', e));

                    const disabledRow = new ActionRowBuilder();
                    if (interaction.message.components[0]) {
                        for (const btn of interaction.message.components[0].components) {
                            const newBtn = ButtonBuilder.from(btn.toJSON());
                            newBtn.setDisabled(true);
                            disabledRow.addComponents(newBtn);
                        }
                    }

                    if (action === 'cancel') {
                        return interaction.editReply({ content: '❌ Đã huỷ gacha all.', components: [disabledRow] });
                    }

                    if (action === 'confirm') {
                        try {
                            const guildId = interaction.guildId;
                            const member = await interaction.guild.members.fetch(userId);
                            const w = getWallet(guildId, userId);
                            const totalNgocGacha = w.ngoc + (w.lockedNgoc || 0);
                            const n = Math.floor(totalNgocGacha / economy.GACHA.ROLL_COST);
                            if (n <= 0) {
                                return interaction.editReply({ content: '❌ Không đủ ngọc để quay.', components: [disabledRow] });
                            }
                            const cost = n * economy.GACHA.ROLL_COST;
                            spendNgocForGame(guildId, userId, cost);

                            // Disable buttons on the confirm message
                            await interaction.editReply({ components: [disabledRow] });

                            // Send shake message as a new follow-up
                            let shakeMsg;
                            const shakeEmoteId = data.ingameEmoteIds && data.ingameEmoteIds.shake_tt;
                            if (shakeEmoteId) {
                                shakeMsg = await interaction.followUp({ content: renderEmote('shake_tt').repeat(Math.min(n, 5)) });
                            } else {
                                const gifPath = path.resolve('emotes/ingame/shake_tt.gif');
                                shakeMsg = await interaction.followUp({ files: [new AttachmentBuilder(gifPath)] });
                            }

                            await new Promise(r => setTimeout(r, 2000));

                            const wallet = getWallet(guildId, userId);
                            const gachaMeta = {};
                            const counts = rollMany(n, wallet.pity, gachaMeta);
                            for (const k of ITEM_KEYS) {
                                if (counts[k] > 0) addItem(guildId, userId, season.mapGachaKey(k), counts[k]);
                            }
                            if (counts.cao > 0 || counts.thienthuong > 0) season.bumpScoreTime(guildId, userId);
                            saveData();
                            metrics.recordGacha({ guildId, rolls: n, cost, counts, userId, ...gachaMeta });
                            profile.recordGacha(guildId, userId, n, counts);
                            const result = formatRollResult(counts);
                            await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
                        } catch (e) {
                            log.error('gacha_all confirm error:', e);
                        }
                    }
                } else if (interaction.customId.startsWith('wce_')) {
                    await wordchainEng.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('wcv_')) {
                    await wordchainViet.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('vtv_')) {
                    await vuaTiengViet.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('fm_')) {
                    await flashMath.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('boss_')) {
                    await mathBoss.handleButtonInteraction(interaction);
                } else if (interaction.customId.startsWith('khodo:')) {
                    await handleKhodoButton(interaction);
                } else {
                    await wordchain.handleButtonInteraction(interaction);
                }
            } catch (e) {
                log.error('Error in button interaction:', e);
            }
            return;
        }
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction.client.commands.get(interaction.commandName);
        if (!cmd) {
            log.warn(`Unknown slash command: ${interaction.commandName}`);
            return;
        }
        try {
            await cmd.execute(interaction);
        } catch (e) {
            log.error(`Error in command ${interaction.commandName}:`, e);
            const errorReply = { content: 'Lệnh gặp lỗi.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorReply).catch(() => { });
            } else {
                await interaction.reply(errorReply).catch(() => { });
            }
        }
    }
};

// Shared replay-button cooldown: same per-user map as the text commands but a
// shorter window, so spamming buttons (or stacking several reply messages and
// clicking across all of them) can't multiply the play rate.
function rejectIfOnButtonCooldown(interaction) {
    const cd = checkGameCooldown(interaction.user.id, BUTTON_GAME_COOLDOWN_MS);
    if (!cd.onCooldown) return false;
    const secLeft = Math.ceil(cd.msLeft / 1000);
    interaction.reply({ content: `⏳ Vui lòng chờ ${secLeft}s trước khi chơi tiếp.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
}

// Stop button on an auto-play session message. Owner-only, and only the live
// session's own message counts — stale Stop buttons (replaced session, bot
// restart) just get their components cleared.
async function handleAutoStopButton(interaction) {
    const [, action, ownerUserId] = interaction.customId.split(':');
    if (action !== 'stop') return;
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải phiên auto của bạn.', flags: MessageFlags.Ephemeral });
    }
    // Show "stopping" feedback first so the loop's final edit lands after it.
    await interaction.update({ components: [autoPlay.buildStopRow(ownerUserId, true)] }).catch(() => {});
    if (!autoPlay.requestStopFromMessage(ownerUserId, interaction.message.id)) {
        await interaction.message.edit({ components: [] }).catch(() => {});
    }
}

async function handleCoinflipButton(interaction) {
    const parts = interaction.customId.split(':');
    const [, action, ownerUserId, amountStr, sideToken] = parts;
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    if (rejectIfOnButtonCooldown(interaction)) return;
    const side = tokenToSide(sideToken);
    const flips = parts[5] ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;
    const guildId = interaction.guildId;
    const isAll = action === 'allin';

    // Pre-flight affordability check so we can reply ephemerally before deferring.
    const wallet = getWallet(guildId, ownerUserId);
    const totalNgocCf = wallet.ngoc + (wallet.lockedNgoc || 0);
    const perFlip = isAll
        ? Math.min(Math.floor(totalNgocCf / flips), economy.COINFLIP_MAX_BET)
        : Math.min(parseInt(amountStr, 10), economy.COINFLIP_MAX_BET);
    if (!Number.isInteger(perFlip) || perFlip <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (totalNgocCf < perFlip * flips) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(totalNgocCf)} ngọc, không đủ cược ${fmt(perFlip * flips)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('cf defer error:', e));

    const disabledRows = (interaction.message.components || []).map(rowComp => {
        const ar = new ActionRowBuilder();
        for (const btn of rowComp.components) {
            ar.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
        }
        return ar;
    });
    if (disabledRows.length) {
        await interaction.editReply({ components: disabledRows }).catch(e => log.error('cf disable error:', e));
    }

    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    if (action === 'auto') {
        await autoPlay.startAuto({
            game: 'coinflip', channel: interaction.channel, guildId,
            userId: ownerUserId, displayName,
            params: { amount: perFlip, side, flips }
        });
        return;
    }

    const res = runCoinflipMulti({
        guildId, userId: ownerUserId, displayName,
        side, isAll, requestedAmount: perFlip, flips, viaButton: true, metrics
    });
    if (res.error) {
        return interaction.followUp({ content: 'Không đủ ngọc để chơi.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await interaction.followUp({ content: res.content, components: res.components }).catch(e => log.error('cf followUp error:', e));
}

// Disable every button on the message that triggered `interaction`.
async function disableMessageButtons(interaction) {
    const disabledRows = (interaction.message.components || []).map(rowComp => {
        const ar = new ActionRowBuilder();
        for (const btn of rowComp.components) {
            ar.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
        }
        return ar;
    });
    if (disabledRows.length) {
        await interaction.editReply({ components: disabledRows }).catch(e => log.error('dice disable error:', e));
    }
}

// Play a multi-cửa bet and post the aggregate result + multi buttons.
async function runDiceMultiBet(interaction, game, guesses, amountPer, wasAllIn) {
    const guildId = interaction.guildId;
    const ownerUserId = interaction.user.id;
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;
    const { roll, play, totalCost } = dice.settleMultiBet({
        guildId, userId: ownerUserId, game, guesses, amountPer,
        viaButton: true, wasAllIn, metrics, profile
    });

    const newWallet = getWallet(guildId, ownerUserId);
    const totalAfter = newWallet.ngoc + (newWallet.lockedNgoc || 0);
    const content = game === 'tong'
        ? dice.formatTongResultMulti({ displayName, roll, sum: play.sum, results: play.results, amountPer, totalCost, totalPayout: play.totalPayout })
        : dice.formatMatResultMulti({ displayName, roll, results: play.results, amountPer, totalCost, totalPayout: play.totalPayout });
    const buildMulti = game === 'tong' ? dice.buildTongButtonsMulti : dice.buildMatButtonsMulti;
    const components = totalAfter > 0 ? buildMulti(ownerUserId, amountPer, guesses, totalAfter) : [];
    await interaction.followUp({ content, components }).catch(e => log.error('dice multi followUp error:', e));
}

// Open the "Đổi cửa" modal for manual entry of a new set of cửa.
async function showDiceMultiModal(interaction, game, amountPer) {
    const isTong = game === 'tong';
    const modal = new ModalBuilder()
        .setCustomId(`${game}:meditsub:${interaction.user.id}:${amountPer}`)
        .setTitle(isTong ? 'Cược nhiều tổng' : 'Cược nhiều mặt');
    const input = new TextInputBuilder()
        .setCustomId('guesses')
        .setLabel(isTong ? 'Các tổng 3-18, cách nhau dấu cách' : 'Các mặt 1-6, cách nhau dấu cách')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(isTong ? '10 11 12' : '5 6')
        .setRequired(true)
        .setMaxLength(60);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal).catch(e => log.warn(`dice modal failed: ${e.message}`));
}

// Modal submit → parse the typed cửa and replay a multi-bet at the same stake.
async function handleDiceModal(interaction, game) {
    const parts = interaction.customId.split(':');
    const ownerUserId = parts[2];
    const amountPer = parseInt(parts[3], 10);
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    if (rejectIfOnButtonCooldown(interaction)) return;
    const guildId = interaction.guildId;
    const isTong = game === 'tong';
    const guessMin = isTong ? 3 : 1;
    const guessMax = isTong ? 18 : 6;
    const maxBet = isTong ? economy.TONG_MAX_BET : economy.MAT_MAX_BET;

    const raw = interaction.fields.getTextInputValue('guesses') || '';
    const tokens = raw.trim().split(/[\s,]+/).filter(Boolean);
    const guesses = [];
    for (const t of tokens) {
        const g = parseInt(t, 10);
        if (!Number.isInteger(g) || g < guessMin || g > guessMax) {
            return interaction.reply({ content: `${isTong ? 'Tổng' : 'Mặt'} phải là số nguyên từ ${guessMin} đến ${guessMax}.`, flags: MessageFlags.Ephemeral });
        }
        guesses.push(g);
    }
    if (guesses.length === 0) {
        return interaction.reply({ content: 'Vui lòng nhập ít nhất 1 cửa.', flags: MessageFlags.Ephemeral });
    }
    if (new Set(guesses).size !== guesses.length) {
        return interaction.reply({ content: `Các ${isTong ? 'tổng' : 'mặt'} cược phải khác nhau (không trùng).`, flags: MessageFlags.Ephemeral });
    }
    const amt = Math.min(amountPer, maxBet);
    if (!Number.isInteger(amt) || amt <= 0) {
        return interaction.reply({ content: 'Mức cược không hợp lệ.', flags: MessageFlags.Ephemeral });
    }
    const wallet = getWallet(guildId, ownerUserId);
    const totalNgocDice = wallet.ngoc + (wallet.lockedNgoc || 0);
    if (totalNgocDice < amt * guesses.length) {
        return interaction.reply({ content: `Bạn cần ${fmt(amt * guesses.length)} ngọc (${fmt(amt)} × ${guesses.length} cửa) nhưng chỉ có ${fmt(totalNgocDice)}.`, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate().catch(() => {});
    return runDiceMultiBet(interaction, game, guesses, amt, false);
}

async function handleDiceButton(interaction, game) {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const ownerUserId = parts[2];
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guildId;
    const maxBet = game === 'tong' ? economy.TONG_MAX_BET : economy.MAT_MAX_BET;

    // ── Multi-cửa actions ──────────────────────────────────────────────────
    if (action === 'medit') {
        const amountPer = parseInt(parts[3], 10);
        return showDiceMultiModal(interaction, game, amountPer);
    }
    if (rejectIfOnButtonCooldown(interaction)) return;

    // ── Auto mode (single-cửa `auto` / multi-cửa `mauto`) ──────────────────
    if (action === 'auto' || action === 'mauto') {
        const amountPer = Math.min(parseInt(parts[3], 10) || 0, maxBet);
        const guesses = (action === 'auto' ? [parts[4]] : (parts[4] || '').split('.'))
            .map(Number).filter(Number.isInteger);
        if (!guesses.length || amountPer <= 0) {
            return interaction.reply({ content: 'Cược không hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        const w = getWallet(guildId, ownerUserId);
        if ((w.ngoc + (w.lockedNgoc || 0)) < amountPer * guesses.length) {
            return interaction.reply({ content: `Bạn không đủ ngọc để chạy auto (cần ${fmt(amountPer * guesses.length)}/vòng).`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(e => log.error('dice defer error:', e));
        await disableMessageButtons(interaction);
        const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
        const displayName = member ? member.displayName : interaction.user.username;
        await autoPlay.startAuto({
            game, channel: interaction.channel, guildId,
            userId: ownerUserId, displayName,
            params: { amountPer, guesses }
        });
        return;
    }

    if (action === 'mcont' || action === 'mallin') {
        const w = getWallet(guildId, ownerUserId);
        const total = w.ngoc + (w.lockedNgoc || 0);
        let guesses, amountPer, wasAllIn;
        if (action === 'mcont') {
            amountPer = parseInt(parts[3], 10);
            guesses = (parts[4] || '').split('.').map(Number).filter(Number.isFinite);
            wasAllIn = false;
        } else {
            guesses = (parts[3] || '').split('.').map(Number).filter(Number.isFinite);
            amountPer = guesses.length ? Math.min(Math.floor(total / guesses.length), maxBet) : 0;
            wasAllIn = true;
        }
        if (!guesses.length || !Number.isInteger(amountPer) || amountPer <= 0) {
            return interaction.reply({ content: 'Bạn không đủ ngọc để chơi.', flags: MessageFlags.Ephemeral });
        }
        if (total < amountPer * guesses.length) {
            return interaction.reply({ content: `Bạn chỉ có ${fmt(total)} ngọc, không đủ cược ${fmt(amountPer * guesses.length)}.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate().catch(e => log.error('dice defer error:', e));
        await disableMessageButtons(interaction);
        return runDiceMultiBet(interaction, game, guesses, amountPer, wasAllIn);
    }

    // ── Single-cửa actions (bet / again / allin) — original behavior ────────
    const amountStr = parts[3];
    const guessStr = parts[4];
    const guess = parseInt(guessStr, 10);
    const wallet = getWallet(guildId, ownerUserId);

    const totalNgocDice = wallet.ngoc + (wallet.lockedNgoc || 0);
    let amount;
    if (action === 'allin') {
        amount = Math.min(totalNgocDice, maxBet);
    } else {
        amount = Math.min(parseInt(amountStr, 10), maxBet);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (totalNgocDice < amount) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(totalNgocDice)} ngọc, không đủ cược ${fmt(amount)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('dice defer error:', e));
    await disableMessageButtons(interaction);

    const roll = dice.rollDice();
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    let content;
    let components;
    const wasAllIn = action === 'allin';
    if (game === 'tong') {
        const { sum, won, mult } = dice.playTong(roll, guess);
        spendNgocForGame(guildId, ownerUserId, amount);
        const tongPayout = won ? amount * mult : 0;
        if (won) {
            addNgoc(guildId, ownerUserId, tongPayout);
            profile.recordWin(guildId, ownerUserId, tongPayout, 'Tổng xúc xắc');
        }
        profile.recordGame(guildId, ownerUserId, 'tong', amount, tongPayout);
        metrics.recordTong({ guildId, amount, won, mult, guess, viaButton: true, wasAllIn, userId: ownerUserId });
        const newWallet = getWallet(guildId, ownerUserId);
        const totalAfterTong = newWallet.ngoc + (newWallet.lockedNgoc || 0);
        content = dice.formatTongResult({ displayName, guess, roll, sum, won, amount, mult });
        components = totalAfterTong > 0 ? dice.buildTongButtons(ownerUserId, amount, guess, totalAfterTong) : [];
    } else {
        const { matches, won, mult } = dice.playMat(roll, guess);
        spendNgocForGame(guildId, ownerUserId, amount);
        const matPayout = won ? amount * mult : 0;
        if (won) {
            addNgoc(guildId, ownerUserId, matPayout);
            profile.recordWin(guildId, ownerUserId, matPayout, 'Mặt xúc xắc');
        }
        profile.recordGame(guildId, ownerUserId, 'mat', amount, matPayout);
        metrics.recordMat({ guildId, amount, won, mult, face: guess, matches, viaButton: true, wasAllIn, userId: ownerUserId });
        const newWallet = getWallet(guildId, ownerUserId);
        const totalAfterMat = newWallet.ngoc + (newWallet.lockedNgoc || 0);
        content = dice.formatMatResult({ displayName, face: guess, roll, matches, won, amount, mult });
        components = totalAfterMat > 0 ? dice.buildMatButtons(ownerUserId, amount, guess, totalAfterMat) : [];
    }

    await interaction.followUp({ content, components }).catch(e => log.error('dice followUp error:', e));
}

async function handleSlotButton(interaction) {
    const [, action, ownerUserId, amountStr, rollsStr] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guildId;
    const isAllIn = action === 'allin';
    const requestedAmount = isAllIn ? null : parseInt(amountStr, 10);
    if (!isAllIn && (!Number.isInteger(requestedAmount) || requestedAmount <= 0)) {
        return interaction.reply({ content: 'Số ngọc không hợp lệ.', flags: MessageFlags.Ephemeral });
    }
    const rolls = rollsStr ? parseInt(rollsStr, 10) : 1;
    if (!Number.isInteger(rolls) || rolls < 1 || rolls > SLOT_MAX_ROLLS) {
        return interaction.reply({ content: 'Số lượt không hợp lệ.', flags: MessageFlags.Ephemeral });
    }
    if (rejectIfOnButtonCooldown(interaction)) return;

    await interaction.deferUpdate().catch(e => log.error('slot defer error:', e));

    const disabledRows = (interaction.message.components || []).map(rowComp => {
        const ar = new ActionRowBuilder();
        for (const btn of rowComp.components) {
            ar.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
        }
        return ar;
    });
    if (disabledRows.length) {
        await interaction.editReply({ components: disabledRows }).catch(e => log.error('slot disable error:', e));
    }

    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    if (action === 'auto') {
        await autoPlay.startAuto({
            game: 'slot', channel: interaction.channel, guildId,
            userId: ownerUserId, displayName,
            params: { amount: Math.min(requestedAmount, economy.SLOT_MAX_BET), rolls }
        });
        return;
    }

    const result = await runSlotMultiRoll({
        guildId, userId: ownerUserId, displayName,
        requestedAmount, isAll: isAllIn, rolls,
        sendInitial: (content) => interaction.followUp({ content }),
        log, metrics
    });
    if (result.error === 'no_ngoc') {
        return interaction.followUp({ content: 'Bạn không có ngọc để chơi slot.', flags: MessageFlags.Ephemeral });
    }
    if (result.error === 'insufficient') {
        return interaction.followUp({
            content: `Bạn cần ${fmt(result.needed || requestedAmount)} ngọc nhưng chỉ có ${fmt(result.available)}.`,
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleKhodoButton(interaction) {
    const [, action, ownerUserId] = interaction.customId.split(':');
    if (action !== 'all') return;
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải kho đồ của bạn.', flags: MessageFlags.Ephemeral });
    }
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;
    const { embed } = buildKhodoView(interaction.guildId, ownerUserId, displayName, true);
    // content: '' clears the old text on messages sent before the embed format.
    await interaction.update({ content: '', embeds: [embed], components: [] }).catch(e => log.error('khodo update error', e));
}
