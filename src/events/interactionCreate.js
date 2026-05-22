const { Events, MessageFlags, ActionRowBuilder, ButtonBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const log = require('../../logger');
const wordchain = require('../services/wordchain');
const arrangeCmd = require('../commands/arrange');
const { getWallet, addNgoc, addItem, renderEmote, fmt, ITEM_KEYS } = require('../services/currency');
const { rollMany, formatRollResult, ROLL_COST } = require('../services/gacha');
const { buildContinueButtons: buildCoinflipButtons, formatResult: formatCoinflipResult, tokenToSide } = require('../services/coinflip');
const dice = require('../services/dice');
const metrics = require('../services/metrics');
const economy = require('../config/economy');
const { data, saveData } = require('../state');
const { isMaintenance } = require('../services/maintenance');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (isMaintenance()) {
            if (interaction.isRepliable && interaction.isRepliable()) {
                await interaction.reply({ content: '🔧 Bot đang bảo trì, vui lòng thử lại sau ít phút.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            return;
        }
        if (interaction.isButton()) {
            try {
                if (interaction.customId.startsWith('arrange_')) {
                    await arrangeCmd.handleButton(interaction);
                } else if (interaction.customId.startsWith('cf:')) {
                    await handleCoinflipButton(interaction);
                } else if (interaction.customId.startsWith('tong:')) {
                    await handleDiceButton(interaction, 'tong');
                } else if (interaction.customId.startsWith('mat:')) {
                    await handleDiceButton(interaction, 'mat');
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
                            const n = Math.floor(w.ngoc / ROLL_COST);
                            if (n <= 0) {
                                return interaction.editReply({ content: '❌ Không đủ ngọc để quay.', components: [disabledRow] });
                            }
                            const cost = n * ROLL_COST;
                            addNgoc(guildId, userId, -cost);

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
                            const counts = rollMany(n, wallet.pity);
                            for (const k of ITEM_KEYS) {
                                if (counts[k] > 0) addItem(guildId, userId, k, counts[k]);
                            }
                            saveData();
                            const result = formatRollResult(counts);
                            await shakeMsg.edit({ content: `**${member.displayName}** quay ${fmt(n)} lần (-${fmt(cost)} ${renderEmote('ngoc')}):\n${result}`, attachments: [] }).catch(e => log.error('gacha edit error', e));
                        } catch (e) {
                            log.error('gacha_all confirm error:', e);
                        }
                    }
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

async function handleCoinflipButton(interaction) {
    const [, action, ownerUserId, amountStr, sideToken] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    const side = tokenToSide(sideToken);
    const guildId = interaction.guildId;
    const wallet = getWallet(guildId, ownerUserId);

    let amount;
    if (action === 'allin') {
        amount = Math.min(wallet.ngoc, economy.COINFLIP_MAX_BET);
    } else {
        amount = Math.min(parseInt(amountStr, 10), economy.COINFLIP_MAX_BET);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (wallet.ngoc < amount) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(wallet.ngoc)} ngọc, không đủ cược ${fmt(amount)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('cf defer error:', e));

    const disabledRow = new ActionRowBuilder();
    if (interaction.message.components[0]) {
        for (const btn of interaction.message.components[0].components) {
            const newBtn = ButtonBuilder.from(btn.toJSON());
            newBtn.setDisabled(true);
            disabledRow.addComponents(newBtn);
        }
        await interaction.editReply({ components: [disabledRow] }).catch(e => log.error('cf disable error:', e));
    }

    const result = Math.random() < 0.5 ? 'sap' : 'ngua';
    const won = side ? (side === result) : (Math.random() < 0.5);
    addNgoc(guildId, ownerUserId, won ? amount : -amount);

    const wasAllIn = action === 'allin';
    const bigWin = won && (wasAllIn || amount >= 5000);
    metrics.recordCoinflip({ amount, won, side, viaButton: true, wasAllIn, bigWin });

    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;
    const newWallet = getWallet(guildId, ownerUserId);
    const content = formatCoinflipResult({ displayName, side, result, won, amount, wasAllIn });
    const components = newWallet.ngoc > 0 ? [buildCoinflipButtons(ownerUserId, amount, side, newWallet.ngoc)] : [];
    await interaction.followUp({ content, components }).catch(e => log.error('cf followUp error:', e));
}

async function handleDiceButton(interaction, game) {
    const [, action, ownerUserId, amountStr, guessStr] = interaction.customId.split(':');
    if (interaction.user.id !== ownerUserId) {
        return interaction.reply({ content: 'Đây không phải lượt của bạn.', flags: MessageFlags.Ephemeral });
    }
    const guess = parseInt(guessStr, 10);
    const guildId = interaction.guildId;
    const wallet = getWallet(guildId, ownerUserId);
    const maxBet = game === 'tong' ? economy.TONG_MAX_BET : economy.MAT_MAX_BET;

    let amount;
    if (action === 'allin') {
        amount = Math.min(wallet.ngoc, maxBet);
    } else {
        amount = Math.min(parseInt(amountStr, 10), maxBet);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return interaction.reply({ content: 'Bạn không có ngọc để chơi.', flags: MessageFlags.Ephemeral });
    }
    if (wallet.ngoc < amount) {
        return interaction.reply({ content: `Bạn chỉ có ${fmt(wallet.ngoc)} ngọc, không đủ cược ${fmt(amount)}.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate().catch(e => log.error('dice defer error:', e));

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

    const roll = dice.rollDice();
    const member = await interaction.guild.members.fetch(ownerUserId).catch(() => null);
    const displayName = member ? member.displayName : interaction.user.username;

    let content;
    let components;
    const wasAllIn = action === 'allin';
    if (game === 'tong') {
        const { sum, won, mult } = dice.playTong(roll, guess);
        addNgoc(guildId, ownerUserId, won ? amount * (mult - 1) : -amount);
        metrics.recordTong({ amount, won, mult, guess, viaButton: true, wasAllIn });
        const newWallet = getWallet(guildId, ownerUserId);
        content = dice.formatTongResult({ displayName, guess, roll, sum, won, amount, mult });
        components = newWallet.ngoc > 0 ? dice.buildTongButtons(ownerUserId, amount, guess, newWallet.ngoc) : [];
    } else {
        const { matches, won, mult } = dice.playMat(roll, guess);
        addNgoc(guildId, ownerUserId, won ? amount * (mult - 1) : -amount);
        metrics.recordMat({ amount, won, mult, face: guess, matches, viaButton: true, wasAllIn });
        const newWallet = getWallet(guildId, ownerUserId);
        content = dice.formatMatResult({ displayName, face: guess, roll, matches, won, amount, mult });
        components = newWallet.ngoc > 0 ? dice.buildMatButtons(ownerUserId, amount, guess, newWallet.ngoc) : [];
    }

    await interaction.followUp({ content, components }).catch(e => log.error('dice followUp error:', e));
}
